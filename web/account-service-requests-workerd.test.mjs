import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {handleAccountServiceRequest,handleOwnerAccountServiceRequests} from './account-service-requests.mjs';
import {signSitesBridgeRequest,sitesDigest} from './sites-bridge-protocol.mjs';
import {nativePkceChallenge} from './native-auth.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc',ALICE='u-22345678-1234-4123-8123-123456789abc',BOB='u-32345678-1234-4123-8123-123456789abc',KEY='ab'.repeat(32),NOW=Date.parse('2026-11-20T14:00:00Z');
const BASE='/api/account-deletion-requests',QUEUE='/api/owner/account-service-requests';
const bindings={RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'no',MOLLIE_LIVE_API_KEY:'live_FIXTURE',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_ACCOUNTREQUEST',RIG_PRODUCTION_ENVIRONMENT_ID:'account-request-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY,RIG_PRODUCTION_OWNER_USER_ID:OWNER,RIG_NATIVE_ANDROID_SIGNING_SHA256:Array(32).fill('BA').join(':')};
const producer={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY};
const bundle=await build({stdin:{contents:`import {createProductionCommerceWorker} from './production-commerce-worker.mjs';export default createProductionCommerceWorker({network:async()=>{throw Error('No provider network in account request fixture')},videoFactory:async()=>{throw Error('Account requests must not instantiate generation')}});`,resolveDir:new URL('.',import.meta.url).pathname},bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
async function migration(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run()}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'},bindings});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 for(const file of ['production-schema.sql','production-migrations/0019_native_auth.sql','production-migrations/0020_account_service_requests.sql'])await migration(db,file);
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('account-request-fixture','live',PROJECT,SITE,BRIDGE,'pfl_ACCOUNTREQUEST',BRIDGE+'/api/payments/webhook').run();
 for(const [subject,user] of [['owner',OWNER],['alice',ALICE],['bob',BOB]]){
  const hash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0'+subject));
  await db.prepare('INSERT INTO rig_sites_identities VALUES(?,?,?,?)').bind(PROJECT,hash,user,NOW).run();
 }
 const env={...bindings,PRODUCTION_DB:db,DB:legacy};
 const req=(path,data,{origin=SITE,mime='application/json',method=data===undefined?'GET':'POST',headers={}}={})=>new Request(SITE+path,{method,headers:{...(data===undefined?{}:{origin,'content-type':mime}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const call=(path=BASE,data,{userId=ALICE,extraEnv={},...opts}={})=>handleAccountServiceRequest(req(path,data,opts),{...env,...extraEnv},{userId,now:NOW});
 const owner=(path=QUEUE,userId=OWNER)=>handleOwnerAccountServiceRequests(req(path),env,{userId});
 const report=(id,reason='unsafe',details='')=>({path:`/api/generations/${id}/reports`,body:{requestId:crypto.randomUUID(),reason,details}});
 async function job({user=ALICE,state='completed',result='private/result.mp4'}={}){
  const q=crypto.randomUUID(),id=crypto.randomUUID();await db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}',100,'fixture',6,?,?)").bind(q,user,'minimax/h3-max/recast',NOW+60000,NOW).run();
  await db.prepare('INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,result_key,created_at) VALUES(?,?,?,?,100,?,?,?)').bind(id,user,q,crypto.randomUUID(),state,result,NOW).run();return id;
 }
 async function preserved(){const out={};for(const table of ['rig_orders','rig_ledger','rig_frozen_accounts','rig_generation_quotes','rig_generation_jobs','rig_native_sessions','rig_customer_credentials','rig_owner_security_challenges']){
  if(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first())out[table]=(await db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()).results;
 }return out}
 async function signed(path,data,subject='alice'){
  const r=await signSitesBridgeRequest({env:producer,subject,path,method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'content-type':'application/json'},body:data===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(data))});
  return mf.dispatchFetch(r.url,{method:r.method,headers:r.headers,...(data===undefined?{}:{body:await r.arrayBuffer()})});
 }
 async function native(subject='alice'){
  const verifier='v'.repeat(43),challenge=await nativePkceChallenge(verifier),issued=await signed('/api/internal/native-auth/authorize',{challenge},subject);assert.equal(issued.status,201,await issued.clone().text());
  const code=(await issued.json()).code,r=await mf.dispatchFetch(BRIDGE+'/api/native/auth/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,codeVerifier:verifier})});assert.equal(r.status,200);return (await r.json()).accessToken;
 }
 const nativeCall=(path,data,token,headers={})=>mf.dispatchFetch(BRIDGE+'/api/native'+path.replace(/^\/api/,''),{method:data===undefined?'GET':'POST',headers:{...(token?{authorization:'Bearer '+token}:{}),...(data===undefined?{}:{'content-type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 return {mf,db,legacy,env,req,call,owner,job,report,preserved,signed,native,nativeCall};
}

test('deletion receipt is durable and leaves identity, sessions, video and money unchanged',async()=>{
 const f=await fixture();try{
  await f.job();const before=await f.preserved(),body={requestId:crypto.randomUUID()},r=await f.call(BASE,body);assert.equal(r.status,201,await r.clone().text());const v=await r.json();
  assert.equal(v.type,'account-deletion');assert.equal(v.status,'pending');assert.equal(v.createdAt,NOW);assert.equal(v.actionPerformed,false);assert.match(v.acknowledgement,/nog niet gewijzigd/);assert.equal(v.replayed,false);
  assert.deepEqual(await f.preserved(),before);const list=await(await f.call()).json();assert.equal(list.requests.length,1);assert.equal(list.requests[0].id,v.id);assert.equal(list.limit,20);assert.doesNotMatch(JSON.stringify(list),/request_hash|userId|email|subject/);
  assert.equal(r.headers.get('cache-control'),'private, no-store');
 }finally{await f.mf.dispose()}
});
test('concurrent retries and reopened dialogs share one case while each accepted key binds its exact body',async()=>{
 const f=await fixture();try{
  const job=await f.job(),p=f.report(job,'unsafe','Een gevaarlijke scène.');
  const results=await Promise.all([f.call(p.path,p.body),f.call(p.path,p.body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);const receipts=await Promise.all(results.map(r=>r.json()));assert.equal(receipts[0].id,receipts[1].id);
  const alias={...p.body,requestId:crypto.randomUUID()},r=await f.call(p.path,alias);assert.equal(r.status,200);assert.equal((await r.json()).id,receipts[0].id);
  assert.equal((await f.call(p.path,{...alias,details:'Ander verzoek'})).status,409);
  assert.equal((await f.call(BASE,{requestId:p.body.requestId})).status,409);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_service_requests').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_service_request_keys').first()).n,2);
  const d=await Promise.all([f.call(BASE,{requestId:crypto.randomUUID()}),f.call(BASE,{requestId:crypto.randomUUID()})]);assert.deepEqual(d.map(r=>r.status).sort(),[200,201]);assert.equal((await d[0].json()).id,(await d[1].json()).id);
 }finally{await f.mf.dispose()}
});
test('only an owned completed stored video can be reported and reporting performs no generation or moderation side effect',async()=>{
 const f=await fixture();try{
  const own=await f.job(),other=await f.job({user:BOB}),queued=await f.job({state:'queued',result:null}),empty=await f.job({result:null});const before=await f.preserved();
  for(const id of [other,crypto.randomUUID()]){const p=f.report(id);assert.equal((await f.call(p.path,p.body)).status,404)}
  for(const id of [queued,empty]){const p=f.report(id);assert.equal((await f.call(p.path,p.body)).status,409)}
  const p=f.report(own,'violence','Dit wil ik melden.');const r=await f.call(p.path,p.body);assert.equal(r.status,201);const v=await r.json();assert.equal(v.jobId,own);assert.equal(v.type,'video-report');assert.equal(v.actionPerformed,false);
  assert.deepEqual(await f.preserved(),before);assert.deepEqual((await(await f.call()).json()).requests,[]);
  assert.equal((await f.owner(QUEUE,ALICE)).status,403);const list=await(await f.owner()).json();assert.equal(list.requests.length,1);assert.equal(list.requests[0].userId,ALICE);assert.equal(list.requests[0].details,p.body.details);assert.equal(list.requests[0].reason,'violence');
 }finally{await f.mf.dispose()}
});
test('missing identity, crossed tenants, origins, query tricks and malformed input fail before receipt creation',async()=>{
 const f=await fixture();try{
  const good={requestId:crypto.randomUUID()},job=await f.job(),p=f.report(job);
  assert.equal((await f.call(BASE,good,{userId:null})).status,401);
  assert.equal((await f.call(BASE,good,{userId:'u-42345678-1234-4123-8123-123456789abc'})).status,401);
  assert.equal((await f.call(BASE,good,{extraEnv:{PRODUCTION_DB:f.legacy}})).status,503);
  assert.equal((await f.call(BASE,good,{extraEnv:{RIG_PRODUCTION_SITE_ORIGIN:'https://attacker.invalid'}})).status,503);
  assert.equal((await f.call(BASE,good,{origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.call(BASE+'?user=other',good)).status,404);
  for(const body of [{requestId:[good.requestId]},{...good,userId:BOB},{...good,confirmDelete:true},{requestId:'not-a-uuid'}])assert.equal((await f.call(BASE,body)).status,400);
  await f.db.prepare('DELETE FROM rig_rate_limits').run();
  for(const patch of [{reason:'approved'},{details:null},{details:'x'.repeat(1001)},{details:'bad\u0000control'},{details:'\u202ebidi'},{details:'https://other.invalid/private'},{details:'www.other.invalid'},{userId:BOB}])assert.equal((await f.call(p.path,{...p.body,...patch})).status,400,JSON.stringify(patch));
  assert.equal((await f.call(BASE,good,{mime:'text/plain'})).status,400);
  const malformed=new Request(SITE+BASE,{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:'{'});assert.equal((await handleAccountServiceRequest(malformed,f.env,{userId:ALICE,now:NOW})).status,400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_service_requests').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('own list is scoped and bounded, pending queue pages oldest first and never exposes another site',async()=>{
 const f=await fixture();try{
  await f.db.prepare('INSERT INTO rig_account_profiles VALUES(?,?,?,?,?)').bind(PROJECT,ALICE,'Alice','alice@example.test',NOW).run();
  const made=await(await f.call(BASE,{requestId:crypto.randomUUID()})).json();await f.call(BASE,{requestId:crypto.randomUUID()},{userId:BOB});
  const own=await(await f.call()).json();assert.equal(own.requests.length,1);assert.equal(own.requests[0].id,made.id);
  for(let i=1;i<=55;i++)await f.db.prepare("INSERT INTO rig_account_service_requests(id,site_id,user_id,type,job_id,reason,details,request_hash,status,created_at) VALUES(?,?,?,'account-deletion',NULL,NULL,'',?,'pending',?)").bind(crypto.randomUUID(),PROJECT,ALICE,String(i).padStart(64,'0'),NOW+i).run();
  await f.db.prepare("INSERT INTO rig_account_service_requests(id,site_id,user_id,type,job_id,reason,details,request_hash,status,created_at) VALUES(?,?,?,'account-deletion',NULL,NULL,'',?,'pending',?)").bind(crypto.randomUUID(),'appgprj_foreign',BOB,'f'.repeat(64),NOW-1).run();
  const page=await(await f.owner()).json();assert.equal(page.requests.length,50);assert.equal(page.limit,50);assert.equal(page.requests[0].createdAt,NOW);assert.ok(page.nextCursor);assert.equal(page.requests.find(x=>x.userId===ALICE).email,'alice@example.test');
  const next=await(await f.owner(QUEUE+'?cursor='+page.nextCursor)).json();assert.equal(next.requests.length,7);assert.equal(next.nextCursor,null);assert.ok(next.requests.every(x=>x.createdAt>=page.requests.at(-1).createdAt));
  assert.equal((await(await f.call()).json()).requests.length,20);
  assert.equal((await handleOwnerAccountServiceRequests(f.req(QUEUE),{...f.env,RIG_PRODUCTION_OWNER_USER_ID:undefined},{userId:OWNER})).status,403);
  assert.equal((await f.owner(QUEUE+'?cursor=001.'+crypto.randomUUID())).status,400);
 }finally{await f.mf.dispose()}
});
test('request rate limits bound writes without preventing own receipt reads; missing migration fails closed',async()=>{
 const f=await fixture();try{
  for(let i=0;i<12;i++)assert.ok([200,201].includes((await f.call(BASE,{requestId:crypto.randomUUID()})).status));
  assert.equal((await f.call(BASE,{requestId:crypto.randomUUID()})).status,429);assert.equal((await f.call()).status,200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_service_requests').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_account_service_request_keys').first()).n,12);
  await f.db.prepare('DROP TABLE rig_account_service_request_keys').run();await f.db.prepare('DROP TABLE rig_account_service_requests').run();assert.equal((await f.call()).status,503);assert.equal((await f.owner()).status,503);
 }finally{await f.mf.dispose()}
});
test('actual private worker accepts signed and native requests without generation, owner-role expansion or forged identity',async()=>{
 const f=await fixture();try{
  assert.equal((await f.mf.dispatchFetch(BRIDGE+BASE,{method:'POST',headers:{origin:SITE,'content-type':'application/json','oai-authenticated-user-id':ALICE},body:JSON.stringify({requestId:crypto.randomUUID()})})).status,401);
  const signed=await f.signed(BASE,{requestId:crypto.randomUUID()});assert.equal(signed.status,201,await signed.clone().text());
  const token=await f.native(),job=await f.job(),p=f.report(job,'other','Graag beoordelen.');
  assert.equal((await f.nativeCall(BASE,undefined,token)).status,200);
  const made=await f.nativeCall(p.path,p.body,token);assert.equal(made.status,201,await made.clone().text());assert.equal((await made.json()).jobId,job);
  assert.equal((await f.nativeCall(BASE,{requestId:crypto.randomUUID()},undefined,{'oai-authenticated-user-id':ALICE})).status,401);
  assert.equal((await f.nativeCall(QUEUE,undefined,token)).status,404);
  assert.equal((await f.signed(QUEUE,undefined,'bob')).status,403);
  const list=await f.signed(QUEUE,undefined,'owner');assert.equal(list.status,200,await list.clone().text());assert.equal((await list.json()).requests.length,2);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,1);
 }finally{await f.mf.dispose()}
});
