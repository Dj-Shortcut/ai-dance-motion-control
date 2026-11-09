import test from 'node:test';
import assert from 'node:assert/strict';
import {createRigSitesApp} from './rig-sites-app.mjs';
import {sitesCanonical,sitesHmac,sitesPaymentPath} from './sites-bridge-protocol.mjs';

test('owner finance routes use native identity, a signed exact month and no browser-supplied role',async()=>{
 const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',bridge='https://rig-api.shortcut-computerguy.workers.dev',project='appgprj_6aeec13b50448191b88da670dac8aa98',key='a'.repeat(64),owner='u-11111111-1111-4111-8111-111111111111',calls=[];
 const env={RIG_SITES_PROJECT_ID:project,RIG_SITES_PRODUCER_ORIGIN:origin,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:bridge,RIG_PRODUCTION_SITES_BRIDGE_KEY:key};
 const app=createRigSitesApp({fetchImpl:async req=>{
  calls.push(req);const url=new URL(req.url),h=req.headers;
  const signature=await sitesHmac(key,sitesCanonical({env:{RIG_SITES_PROJECT_ID:project,RIG_SITES_PRODUCER_ORIGIN:origin,RIG_SITES_BRIDGE_ORIGIN:bridge},method:req.method,path:url.pathname+url.search,subjectHash:h.get('x-rig-sites-subject'),time:h.get('x-rig-sites-time'),nonce:h.get('x-rig-sites-nonce'),digest:h.get('x-rig-sites-body-sha256'),headers:h}));
  assert.equal(h.get('x-rig-sites-signature'),signature);
  for(const name of ['authorization','cookie','x-rig-owner','x-rig-user'])assert.equal(h.get(name),null);
  if(url.pathname==='/api/session')return Response.json({userId:owner,balanceCents:0,currency:'EUR',mode:'live',purchasesEnabled:true,funding:'credits'});
  assert.equal(url.pathname+url.search,'/api/owner/finance?month=2026-11');return Response.json({currency:'EUR',income:{cashReceivedCents:2500}},{headers:{'set-cookie':'forbidden=value'}});
 }});
 const url=origin+'/api/owner/finance?month=2026-11';
 assert.equal((await app.fetch(new Request(url),env)).status,401);assert.equal(calls.length,0);
 const response=await app.fetch(new Request(url,{headers:{'oai-authenticated-user-id':'native-owner-subject',authorization:'Bearer forged',cookie:'private=forged','x-rig-owner':'true'}}),env);
 assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json()).income.cashReceivedCents,2500);
 const forbidden=await app.fetch(new Request(origin+'/api/owner/finance/expenses',{method:'POST',headers:{origin,'oai-authenticated-user-id':'native-owner-subject','x-rig-expected-user':'u-22222222-2222-4222-8222-222222222222','content-type':'application/json'},body:'{}'}),env);assert.equal(forbidden.status,403);assert.equal(calls.length,3);
 const wrongRealm=await app.fetch(new Request(url,{headers:{'oai-authenticated-user-id':'native-owner-subject'}}),{...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'no'});assert.equal(wrongRealm.status,404);
});
const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const bridge='https://rig-chatgpt-ingress.shortcut-computerguy.workers.dev';
const owner='u-63e2e668-eeb1-43af-a35c-6998a1de7879';
const env={RIG_SITES_PRODUCER_ORIGIN:origin,RIG_SITES_BRIDGE_ORIGIN:bridge,RIG_SITES_PROJECT_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_SITES_BRIDGE_KEY:'a'.repeat(64),RIG_EDIT_ENABLED:'yes'};
function fixture(){const calls=[];let approvalStatus=201;const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<h1>RIG</h1>','/multiuser/app.js':'/* RIG app */','/multiuser/style.css':'body{}'},fetchImpl:async req=>{calls.push(req);assert.equal(new URL(req.url).origin,bridge);assert.equal(req.headers.get('authorization'),null);assert.equal(req.headers.get('cookie'),null);assert.equal(req.headers.get('oai-authenticated-user-id'),null);assert.match(req.headers.get('x-rig-sites-signature'),/^[a-f0-9]{64}$/);const path=new URL(req.url).pathname;if(path==='/api/session')return Response.json({userId:owner,balanceCents:500,frozen:false});if(path==='/api/generation-quotes')return Response.json({id:'abc',priceCents:100,currency:'EUR'},{status:201});if(path==='/api/chatgpt/quote-approvals')return Response.json(approvalStatus===201?{approvalToken:'A'.repeat(43),idempotencyKey:'rigchatgpt_abc'}:{error:'Insufficient'},{status:approvalStatus});return Response.json({enabled:true,funding:'owner'})}});return {app,calls,setApprovalStatus:value=>{approvalStatus=value}};}
const request=(path,options={})=>new Request(origin+path,options);
const identity={'oai-authenticated-user-id':'native-subject','x-rig-expected-user':owner};
test('native API refuses anonymous callers and account changes before write dispatch',async()=>{
 const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/video-config'),env)).status,401);assert.equal(calls.length,0);
 const headers={...identity,origin,'content-type':'application/json','x-rig-expected-user':'u-00000000-0000-4000-8000-000000000000'};
 assert.equal((await app.fetch(request('/api/generations',{method:'POST',headers,body:'{}'}),env)).status,403);assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).pathname,'/api/session');
});
test('browser writes require same origin and bound account, and cannot mint approvals directly',async()=>{
 for(const headers of [identity,{...identity,origin:'https://evil.invalid'},{'oai-authenticated-user-id':'native-subject',origin}]){const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/generations',{method:'POST',headers,body:'{}'}),env)).status,403);assert.ok(calls.length<=1)}
 const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/chatgpt/quote-approvals',{method:'POST',headers:{...identity,origin},body:'{}'}),env)).status,404);assert.equal(calls.length,0);
});
test('native quotes receive an account-bound confirmation and never leak client credentials to relay',async()=>{
 const {app,calls}=fixture();const response=await app.fetch(request('/api/generation-quotes',{method:'POST',headers:{...identity,origin,'content-type':'application/json',authorization:'Bearer browser-value',cookie:'secret=value'},body:'{}'}),env);
 assert.equal(response.status,201);assert.deepEqual(await response.json(),{id:'abc',priceCents:100,currency:'EUR',approvalToken:'A'.repeat(43),idempotencyKey:'rigchatgpt_abc'});assert.equal(calls.length,3);
});
test('over-budget quote remains visible without a generation capability',async()=>{
 const {app,setApprovalStatus}=fixture();setApprovalStatus(409);const response=await app.fetch(request('/api/generation-quotes',{method:'POST',headers:{...identity,origin},body:'{}'}),env);assert.equal(response.status,201);assert.deepEqual(await response.json(),{id:'abc',priceCents:100,currency:'EUR'});
});
test('native Site reuses central balance but exposes no checkout path',async()=>{
 const {app}=fixture();const response=await app.fetch(request('/api/payments/balance',{headers:identity}),env);assert.deepEqual(await response.json(),{balance:500,frozen:false,currency:'EUR',mode:'test',purchasesEnabled:false});assert.equal((await app.fetch(request('/api/payments/create',{method:'POST',headers:{...identity,origin},body:'{}'}),env)).status,404);
});
test('production native payments use their own signed realm and production account only',async()=>{
 const productionBridge='https://rig-api.shortcut-computerguy.workers.dev',productionUser='u-11111111-1111-4111-8111-111111111111',key='b'.repeat(64),calls=[];
 const configured={...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:productionBridge,RIG_PRODUCTION_SITES_BRIDGE_KEY:key};
 const app=createRigSitesApp({fetchImpl:async req=>{
  calls.push(req);assert.equal(new URL(req.url).origin,productionBridge);
  const h=req.headers,path=new URL(req.url).pathname;
  assert.equal(h.get('authorization'),null);assert.equal(h.get('cookie'),null);assert.equal(h.get('x-rig-expected-user'),null);
  const signature=await sitesHmac(key,sitesCanonical({env:{...env,RIG_SITES_BRIDGE_ORIGIN:productionBridge},method:req.method,path,subjectHash:h.get('x-rig-sites-subject'),time:h.get('x-rig-sites-time'),nonce:h.get('x-rig-sites-nonce'),digest:h.get('x-rig-sites-body-sha256'),headers:h}));
  assert.equal(h.get('x-rig-sites-signature'),signature);
  if(path==='/api/session')return Response.json({userId:productionUser,balanceCents:0,frozen:false,currency:'EUR',mode:'live',purchasesEnabled:true,funding:'credits'});
  if(path==='/api/payments/create'){assert.equal(h.get('origin'),origin);assert.deepEqual(await req.json(),{packageId:'small',requestId:'purchase-intent-0001'});return Response.json({checkoutUrl:'https://www.mollie.com/checkout/purchase'})}
  return Response.json({packages:[{id:'small',amountCents:500,credits:500}],currency:'EUR',mode:'live',purchasesEnabled:true});
 }});
 const session=await app.fetch(request('/api/session',{headers:{'oai-authenticated-user-id':'native-subject'}}),configured);assert.equal((await session.json()).userId,productionUser);assert.equal(calls.length,1);
 const headers={...identity,'x-rig-expected-user':productionUser,origin,'content-type':'application/json',authorization:'browser-secret',cookie:'browser=private'};
 const packages=await app.fetch(request('/api/payments/packages',{headers}),configured);assert.equal((await packages.json()).packages[0].credits,500);
 const result=await app.fetch(request('/api/payments/create',{method:'POST',headers,body:JSON.stringify({packageId:'small',requestId:'purchase-intent-0001'})}),configured);assert.equal(result.status,200);assert.equal((await result.json()).checkoutUrl,'https://www.mollie.com/checkout/purchase');
 const before=calls.length;assert.equal((await app.fetch(request('/api/payments/create',{method:'POST',headers:{...headers,'x-rig-expected-user':owner},body:'{}'}),configured)).status,403);assert.equal(calls.length,before+1);assert.equal(new URL(calls.at(-1).url).pathname,'/api/session');
});
test('production purchase configuration and realm failures never fall back to test credit',async()=>{
 const {app,calls}=fixture();
 for(const bad of [
  {...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes'},
  {...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://evil.invalid',RIG_PRODUCTION_SITES_BRIDGE_KEY:'b'.repeat(64)}
 ])assert.equal((await app.fetch(request('/api/payments/balance',{headers:identity}),bad)).status,503);
 assert.equal(calls.length,0);
 const configured={...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://rig-api.shortcut-computerguy.workers.dev',RIG_PRODUCTION_SITES_BRIDGE_KEY:'b'.repeat(64)};
 const wrongRealm=createRigSitesApp({fetchImpl:async()=>Response.json({userId:owner,balanceCents:500,mode:'test',currency:'EUR',purchasesEnabled:false})});
 assert.equal((await wrongRealm.fetch(request('/api/payments/balance',{headers:identity}),configured)).status,503);
});
test('payment route allowlist excludes webhook, queries and reconciliation by GET',()=>{
 for(const [path,method] of [['/api/payments/packages','GET'],['/api/payments/orders/request-intent-0001','GET'],['/api/payments/create','POST'],['/api/payments/orders/request-intent-0001/reconcile','POST']])assert.equal(sitesPaymentPath(path,method),true);
 for(const [path,method] of [['/api/payments/webhook','POST'],['/api/payments/create','GET'],['/api/payments/orders/request-intent-0001','POST'],['/api/payments/orders/request-intent-0001/reconcile','GET'],['/api/payments/packages?mode=live','GET'],['/api/payments/orders/short/reconcile','POST']])assert.equal(sitesPaymentPath(path,method),false);
});
test('Mollie return query opens the studio without accepting payment claims or arbitrary queries',async()=>{
 const {app,calls}=fixture();const response=await app.fetch(request('/?payment=return'),env);assert.equal(response.status,200);assert.equal(await response.text(),'<h1>RIG</h1>');assert.equal(calls.length,0);
 for(const path of ['/?payment=paid','/?payment=return&amount=500','/?payment=return&payment=return','/multiuser/?payment=return','/api/payments/balance?payment=return'])assert.equal((await app.fetch(request(path),env)).status,404);
 assert.equal(calls.length,0);
});
test('Facebook share links and inert campaign tags open the same studio without backend dispatch',async()=>{
 const {app,calls}=fixture();
 const fbclid='synthetic_facebook_click_'+ 'A'.repeat(180)+'_aem_test_only';
 for(const path of [
  '/?fbclid='+fbclid,
  '/multiuser/?fbclid='+fbclid+'&utm_source=facebook',
  '/?utm_source=facebook&utm_medium=social&utm_campaign=dog_band&utm_term=music&utm_content=shared_reel',
  '/?fbclid=first&fbclid=second&utm_source=facebook&utm_source=shared',
  '/?fbclid=%3Cscript%3Ealert(1)%3C%2Fscript%3E'
 ]){
  const response=await app.fetch(request(path),env);
  assert.equal(response.status,200,path);assert.equal(await response.text(),'<h1>RIG</h1>');
 }
 assert.equal(calls.length,0);
});
test('Mollie return remains an inert hint when a shared link also has tracking tags',async()=>{
 const {app,calls}=fixture();
 for(const path of ['/?payment=return&fbclid=shared&utm_source=facebook','/?fbclid=shared&payment=return&utm_campaign=rig']){
  const response=await app.fetch(request(path),env);assert.equal(response.status,200,path);assert.equal(await response.text(),'<h1>RIG</h1>');
 }
 for(const path of ['/?fbclid=shared&payment=paid','/?payment=return&payment=return&fbclid=shared','/?payment=return&amount=500&fbclid=shared','/multiuser/?payment=return&fbclid=shared','/?fbclid=shared&unknown=anything'])assert.equal((await app.fetch(request(path),env)).status,404,path);
 assert.equal(calls.length,0);
});
test('share tags never broaden API, MCP or asset query routing',async()=>{
 const {app,calls}=fixture();
 assert.equal((await app.fetch(request('/multiuser/app.js'),env)).status,200);
 assert.equal((await app.fetch(request('/multiuser/style.css'),env)).status,200);
 for(const path of ['/api/session?fbclid=shared','/api/video-config?fbclid=shared','/api/payments/packages?fbclid=shared','/api/payments/balance?utm_source=facebook','/mcp?fbclid=shared','/multiuser/app.js?fbclid=shared','/multiuser/style.css?utm_source=facebook'])assert.equal((await app.fetch(request(path,{headers:identity}),env)).status,404,path);
 assert.equal(calls.length,0);
});
test('share query processing stays bounded while ordinary tracking links remain inert',async()=>{
 const {app,calls}=fixture();
 for(const path of ['/?fbclid='+ 'A'.repeat(4096),'/?'+Array(16).fill('fbclid=shared').join('&')])assert.equal((await app.fetch(request(path),env)).status,200,path.slice(0,80));
 for(const path of ['/?fbclid='+ 'A'.repeat(4097),'/?'+Array(17).fill('fbclid=shared').join('&')])assert.equal((await app.fetch(request(path),env)).status,404,path.slice(0,80));
 assert.equal((await app.fetch(request('/?fbclid=shared',{method:'POST',body:'{}'}),env)).status,404);
 assert.equal(calls.length,0);
});
test('MCP discovery exposes real confirmation and editing only when configured',async()=>{
 const {app,calls}=fixture();const response=await app.fetch(request('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);const value=await response.json();assert.ok(value.result.tools.some(t=>t.name==='rig_confirm_generation'));assert.ok(value.result.tools.find(t=>t.name==='rig_create_quote').inputSchema.properties.quality.enum.includes('edit-standard'));assert.equal(calls.length,0);
});
