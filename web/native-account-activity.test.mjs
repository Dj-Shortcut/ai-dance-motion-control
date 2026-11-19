import test from 'node:test';
import assert from 'node:assert/strict';
import {createRigSitesApp,rigSitesTesting} from './rig-sites-app.mjs';
import {sitesCanonical,sitesDigest,sitesHmac} from './sites-bridge-protocol.mjs';

const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',bridge='https://rig-api.shortcut-computerguy.workers.dev',project='appgprj_6aeec13b50448191b88da670dac8aa98',key='a'.repeat(64),user='u-11111111-1111-4111-8111-111111111111';
const env={RIG_SITES_PROJECT_ID:project,RIG_SITES_PRODUCER_ORIGIN:origin,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:bridge,RIG_PRODUCTION_SITES_BRIDGE_KEY:key};
const signedEnv={...env,RIG_SITES_BRIDGE_ORIGIN:bridge};
const session={userId:user,balanceCents:0,currency:'EUR',mode:'live',purchasesEnabled:false};
const headers={'oai-authenticated-user-id':'native-subject','oai-authenticated-user-email':'visitor@example.test','oai-authenticated-user-full-name':encodeURIComponent('Zoë De Vriend'),'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'};
function fixture({activity=async()=>new Response(null,{status:204})}={}){
 const calls=[];const app=createRigSitesApp({fetchImpl:async req=>{
  const path=new URL(req.url).pathname,body=new Uint8Array(await req.clone().arrayBuffer());
  calls.push({path,method:req.method,body,headers:req.headers});
  for(const name of ['authorization','cookie','oai-authenticated-user-id','oai-authenticated-user-email','oai-authenticated-user-full-name'])assert.equal(req.headers.get(name),null);
  const digest=await sitesDigest(body);assert.equal(req.headers.get('x-rig-sites-body-sha256'),digest);
  const signature=await sitesHmac(key,sitesCanonical({env:signedEnv,method:req.method,path,subjectHash:req.headers.get('x-rig-sites-subject'),time:req.headers.get('x-rig-sites-time'),nonce:req.headers.get('x-rig-sites-nonce'),digest,headers:req.headers}));
  assert.equal(req.headers.get('x-rig-sites-signature'),signature);
  if(path==='/api/session')return Response.json(session);
  if(path==='/api/internal/account-activity')return activity(req);
  if(path==='/api/owner/users')return Response.json({users:[],nextCursor:null,totalCount:0,profileTrackingAvailable:true});
  throw Error('Unexpected route '+path);
 }});return {app,calls};
}
const req=(path='/api/session',options={})=>new Request(origin+path,{...options,headers:{...headers,...options.headers}});

test('platform profile decoding is bounded and display-only, including missing or malformed metadata',()=>{
 assert.deepEqual(rigSitesTesting.accountProfile(req()),{displayName:'Zoë De Vriend',email:'visitor@example.test'});
 for(const value of ['%E0%A4%A',encodeURIComponent('x'.repeat(121)),encodeURIComponent('Alice\tAdmin'),encodeURIComponent('Alice\u0085Admin'),encodeURIComponent('Alice\u202eAdmin')])assert.equal(rigSitesTesting.accountProfile(req('/api/session',{headers:{'oai-authenticated-user-full-name':value}})).displayName,null);
 assert.equal(rigSitesTesting.accountProfile(req('/api/session',{headers:{'oai-authenticated-user-full-name-encoding':'base64'}})).displayName,null);
 for(const email of ['not-an-email','x'.repeat(255),'a@b@c.test'])assert.equal(rigSitesTesting.accountProfile(req('/api/session',{headers:{'oai-authenticated-user-email':email}})).email,null);
 assert.deepEqual(rigSitesTesting.accountProfile(new Request(origin)),{displayName:null,email:null});
 assert.equal(rigSitesTesting.accountProfile(req('/api/session',{headers:{'oai-authenticated-user-email':'a\u0085b@example.test'}})).email,null);
});

test('a verified production session signs only native profile fields into a separate internal request',async()=>{
 const f=fixture(),response=await f.app.fetch(req(),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),session);
 assert.deepEqual(f.calls.map(x=>[x.path,x.method]),[['/api/session','GET'],['/api/internal/account-activity','POST']]);
 const activity=f.calls[1];assert.deepEqual(JSON.parse(new TextDecoder().decode(activity.body)),{displayName:'Zoë De Vriend',email:'visitor@example.test'});
 assert.equal(activity.headers.get('x-rig-sites-subject'),f.calls[0].headers.get('x-rig-sites-subject'));
});

test('anonymous and account-mismatched requests cannot record activity',async()=>{
 const f=fixture();assert.equal((await f.app.fetch(new Request(origin+'/api/session'),env)).status,401);assert.equal(f.calls.length,0);
 assert.equal((await f.app.fetch(req('/api/session',{headers:{'x-rig-expected-user':'u-22222222-2222-4222-8222-222222222222'}}),env)).status,403);
 assert.deepEqual(f.calls.map(x=>x.path),['/api/session']);
});

test('browser and tool-supplied internal routes cannot replace another profile or sign arbitrary metadata',async()=>{
 const f=fixture();
 for(const path of ['/api/internal/account-activity','/api/internal/account-activity?userId='+user,'/api/internal/other']){
  const r=await f.app.fetch(req(path,{method:'POST',headers:{origin,'x-rig-expected-user':user,'content-type':'application/json'},body:JSON.stringify({displayName:'forged',email:'forged@example.test',userId:user})}),env);
  assert.equal(r.status,404);
 }
 assert.equal(f.calls.length,0);
});

test('ordinary owner reads do not collect profile data and still forward the signed user-list route',async()=>{
 const f=fixture();const response=await f.app.fetch(req('/api/owner/users'),env);assert.equal(response.status,200);
 assert.deepEqual(f.calls.map(x=>x.path),['/api/session','/api/owner/users']);
});

test('an optional activity-store failure never makes a verified session fail or use test credit',async()=>{
 for(const activity of [async()=>{throw Error('Offline optional store')},async()=>new Response('Unavailable',{status:503})]){
  const f=fixture({activity}),response=await f.app.fetch(req(),env);assert.equal(response.status,200);assert.deepEqual(await response.json(),session);
 }
});

test('Workers background activity cannot hold the sign-in response open', {timeout:3000},async t=>{
 let finish;const held=new Promise(resolve=>{finish=resolve}),pending=[];t.after(()=>finish(new Response(null,{status:204})));
 const f=fixture({activity:()=>held}),response=await f.app.fetch(req(),env,{waitUntil:promise=>pending.push(promise)});
 assert.equal(response.status,200);assert.equal(pending.length,1);finish(new Response(null,{status:204}));await Promise.all(pending);
 assert.equal(f.calls.filter(x=>x.path==='/api/internal/account-activity').length,1);
});
