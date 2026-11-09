// Cross-layer route and identity regression tests. Local D1 only; no provider
// payment, generation, account change, or outbound network is permitted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {sitesPath,sitesPaymentPath,sitesAdministrationPath,signSitesBridgeRequest,sitesCanonical,sitesDigest,sitesHmac,SITE_HEADER_NAMES} from './sites-bridge-protocol.mjs';
import {authenticateProductionSites} from './production-bridge-auth.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
import {createRigSitesApp} from './rig-sites-app.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',KEY='ac'.repeat(32),PROFILE='pfl_ROUTETEST';
const id='12345678-1234-4123-8123-123456789abc',requestId='customer-purchase-route-0001';
const adminReads=['/api/owner/accounting','/api/owner/accounting?month=2026-11',...['purchases','credit-events','costs','estimates'].map(kind=>'/api/owner/accounting/export/'+kind+'.csv?month=2026-11'),'/api/owner/recovery','/api/owner/support'];
const adminWrites=['/api/owner/accounting/documents','/api/owner/recovery/notes','/api/owner/recovery/payments/'+id+'/adopt'];
const customerReads=['/api/payments/orders/'+requestId+'/receipt','/api/payments/support-requests','/api/payments/support-requests/'+id+'/confirmation'];
const signedEnv={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY};
const sign=(subject,path,method='GET',body='')=>signSitesBridgeRequest({env:signedEnv,subject,path,method,headers:method==='POST'?{'content-type':'application/json'}:{},body:new TextEncoder().encode(body)});
// Deliberately bypass the producer allowlist so the consumer must independently
// reject a cryptographically valid but unsupported path or method.
async function rawSigned(subject,path,method='GET',body=''){
 const headers=new Headers(method==='POST'?{'content-type':'application/json',origin:SITE}:{}),time=String(Date.now()),nonce=crypto.randomUUID().replaceAll('-',''),subjectHash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0'+subject)),digest=await sitesDigest(new TextEncoder().encode(body));
 const signature=await sitesHmac(KEY,sitesCanonical({env:signedEnv,method,path,subjectHash,time,nonce,digest,headers}));
 for(const [field,value]of Object.entries({site:PROJECT,subject:subjectHash,time,nonce,digest,signature}))headers.set(SITE_HEADER_NAMES[field],value);
 return new Request(BRIDGE+path,{method,headers,...(method==='POST'?{body}:{})});
}
async function migrate(db){const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db);await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('route-fixture','live',PROJECT,SITE,BRIDGE,PROFILE,BRIDGE+'/api/payments/webhook').run();
  const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'route-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY,RIG_PRODUCTION_VIDEO_ENABLED:'no',RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE};
  const users={};for(const subject of ['owner','alice','bob'])users[subject]=(await authenticateProductionSites(await sign(subject,'/api/session'),env)).userId;env.RIG_PRODUCTION_OWNER_USER_ID=users.owner;
  let outbound=0,videos=0,bridgeCalls=0;const privateWorker=createProductionCommerceWorker({network:async()=>{outbound++;throw Error('No outbound provider calls allowed');},videoFactory:async()=>{videos++;throw Error('No video service for administration');}});
  const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<main>RIG</main>'},fetchImpl:request=>{bridgeCalls++;return privateWorker.fetch(request,env);}});
  const browser=(subject,path,{method='GET',data,headers={},extraEnv={}}={})=>app.fetch(new Request(SITE+path,{method,headers:{'oai-authenticated-user-id':subject,'x-rig-expected-user':users[subject],...(method==='POST'?{origin:SITE,'content-type':'application/json'}:{}),...headers},...(method==='POST'?{body:JSON.stringify(data??{})}:{})}),{...env,...extraEnv});
  const order=async({subject='alice',state='paid',reference=requestId}={})=>{const orderId=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,?,500,500,?,?)').bind(orderId,users[subject],reference,'five',state==='paid'?'tr_'+orderId.replaceAll('-',''):null,state).run();if(state==='paid')await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,500)').bind('credit:'+orderId,users[subject],orderId).run();return orderId;};
  return {mf,db,legacy,env,users,privateWorker,app,browser,order,stats:()=>({outbound,videos,bridgeCalls})};
 }catch(error){await mf.dispose();throw error;}
}

test('commerce protocol admits exact method/path pairs and only one unencoded accounting month',async()=>{
 for(const path of adminReads){assert.equal(sitesAdministrationPath(path,'GET'),true,path);assert.equal(sitesPath(path,'GET'),true,path);assert.equal(sitesPath(path,'POST'),false,path);}
 for(const path of adminWrites){assert.equal(sitesAdministrationPath(path,'POST'),true,path);assert.equal(sitesPath(path,'POST'),true,path);assert.equal(sitesPath(path,'GET'),false,path);}
 for(const path of customerReads){assert.equal(sitesPaymentPath(path,'GET'),true,path);assert.equal(sitesPath(path,'GET'),true,path);assert.equal(sitesPath(path,'POST'),path==='/api/payments/support-requests',path);}
 assert.equal(sitesPaymentPath('/api/payments/support-requests','POST'),true);
 const rejected=[['/api/owner/accounting?month=2026-13','GET'],['/api/owner/accounting?month=2026-11&month=2026-10','GET'],['/api/owner/accounting?month=2026%2D11','GET'],['/api/owner/accounting?user=someone','GET'],['/api/owner/accounting/export/orders.csv','GET'],['/api/owner/recovery?owner=true','GET'],['/api/owner/support?user=alice','GET'],['/api/owner/recovery/notes?confirm=true','POST'],['/api/owner/recovery/payments/'+id+'/adopt?confirm=true','POST'],['/api/payments/orders/'+requestId+'/receipt?user=owner','GET'],['/api/payments/support-requests?user=alice','GET'],['/api/payments/support-requests/'+id+'/confirmation?download=1','GET'],['/api/payments/support-requests/'+id+'/confirmation','DELETE'],['/api/owner/accounting','PUT'],['/api/owner/accounting/../recovery','GET'],['//evil.invalid/api/owner/accounting','GET']];
 rejected.push(['/api/payments/support-requests/'+'-'.repeat(36)+'/confirmation','GET']);
 for(const [path,method]of rejected){assert.equal(sitesPath(path,method),false,path);await assert.rejects(sign('alice',path,method),undefined,path);}
});

test('signed administration needs independent allowFinance and never acquires a generation lease',async()=>{
 const f=await fixture();try{
  const legacyFinanceWrites=['/api/owner/finance/expenses','/api/owner/finance/policy'];
  for(const path of [...adminReads,...adminWrites,'/api/owner/finance?month=2026-11',...legacyFinanceWrites]){
   const method=adminWrites.includes(path)||legacyFinanceWrites.includes(path)?'POST':'GET',body=method==='POST'?'{}':'';
   for(const options of [{},{allowGeneration:true},{allowSecurity:true}])assert.equal(await authenticateProductionSites(await sign('owner',path,method,body),f.env,options),null,path);
   const auth=await authenticateProductionSites(await sign('owner',path,method,body),f.env,{allowFinance:true,leaseFactory:()=>{throw Error('No media lease');}});assert.equal(auth.userId,f.users.owner);assert.equal(auth.request.url,SITE+path);assert.equal(auth.lease,null);assert.equal(await auth.request.text(),body);
  }
  for(const path of customerReads){const auth=await authenticateProductionSites(await sign('alice',path),f.env);assert.equal(auth.userId,f.users.alice,path);}
  assert.equal(f.stats().outbound,0);
 }finally{await f.mf.dispose();}
});

test('consumer independently rejects correctly signed unsupported routes, tampering and replay',async()=>{
 const f=await fixture();try{
  const rejected=[['/api/owner/accounting?month=2026-11&user=bob','GET'],['/api/owner/accounting/export/secret.csv','GET'],['/api/owner/recovery?resolved=1','GET'],['/api/owner/recovery/notes','GET'],['/api/owner/support','POST'],['/api/payments/orders/'+requestId+'/receipt','POST'],['/api/payments/support-requests?user=bob','GET'],['/api/payments/support-requests/'+id+'/confirmation','POST']];
  for(const [path,method]of rejected)assert.equal(await authenticateProductionSites(await rawSigned('alice',path,method,method==='POST'?'{}':''),f.env,{allowFinance:true,allowGeneration:true,allowSecurity:true}),null,path);
  const signed=await sign('owner','/api/owner/accounting'),replay=signed.clone();assert.ok(await authenticateProductionSites(signed,f.env,{allowFinance:true}));assert.equal(await authenticateProductionSites(replay,f.env,{allowFinance:true}),null);
  const original=await sign('owner','/api/owner/accounting?month=2026-11'),tampered=new Request(BRIDGE+'/api/owner/accounting?month=2026-10',{headers:original.headers});assert.equal(await authenticateProductionSites(tampered,f.env,{allowFinance:true}),null);
  const support=await sign('alice','/api/payments/support-requests','POST','{}');assert.equal(await authenticateProductionSites(new Request(support,{body:'{"userId":"owner"}'}),f.env),null);
  const post=await sign('owner','/api/owner/recovery/notes','POST','{}');post.headers.set('origin','https://evil.invalid');assert.equal(await authenticateProductionSites(post,f.env,{allowFinance:true}),null);
  assert.equal(f.stats().outbound,0);
 }finally{await f.mf.dispose();}
});

test('valid customer bridge cannot access owner reports, private identities or sensitive mutations',async()=>{
 const f=await fixture();try{
  await f.order({subject:'bob',state:'unknown',reference:'BOB_PRIVATE_UNKNOWN_1234'});
  assert.equal((await f.app.fetch(new Request(SITE+'/api/owner/accounting'),f.env)).status,401);
  assert.equal((await f.privateWorker.fetch(new Request(BRIDGE+'/api/owner/accounting',{headers:{'oai-authenticated-user-id':'owner','x-rig-owner':'true'}}),f.env)).status,401);
  const overview=await f.browser('owner','/api/owner/recovery');assert.equal(overview.status,200);const ownerText=await overview.text();assert.match(ownerText,new RegExp(f.users.bob));
  for(const path of [...adminReads,...adminWrites]){
   const method=adminWrites.includes(path)?'POST':'GET',response=await f.browser('alice',path,{method,data:{ownerId:f.users.owner},headers:{'x-rig-owner':'true','x-rig-user':f.users.owner,authorization:'Bearer forged',cookie:'owner=true'}});assert.equal(response.status,403,path+' '+await response.clone().text());const text=await response.text();assert.doesNotMatch(text,new RegExp(f.users.bob+'|'+f.users.owner+'|BOB_PRIVATE_UNKNOWN|live_fixture|request_hash|seller_json'));
  }
  for(const path of ['/api/owner/accounting','/api/owner/support'])assert.equal((await f.browser('owner',path)).status,200,path);
  assert.deepEqual(f.stats(),{outbound:0,videos:0,bridgeCalls:f.stats().bridgeCalls});assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_documents').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('customer receipts and withdrawal confirmations are owned through Site and signed private service',async()=>{
 const f=await fixture();try{
  const orderId=await f.order(),receiptPath='/api/payments/orders/'+requestId+'/receipt';
  let response=await f.browser('alice',receiptPath);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('content-disposition'),/^attachment/);assert.match(response.headers.get('content-security-policy')??'',/default-src 'none'/);const receipt=await response.text();assert.match(receipt,new RegExp(orderId));assert.doesNotMatch(receipt,new RegExp(f.users.bob+'|'+f.users.owner+'|live_fixture|request_hash|seller_json'));
  response=await f.browser('bob',receiptPath);assert.equal(response.status,404);assert.doesNotMatch(await response.text(),new RegExp(orderId));
  const payload={idempotencyKey:crypto.randomUUID(),orderRequestId:requestId,kind:'withdrawal',message:'ALICE_PRIVATE: <script>own text</script>'};
  response=await f.browser('alice','/api/payments/support-requests',{method:'POST',data:payload});assert.equal(response.status,201,await response.clone().text());const made=await response.json();assert.equal(made.monetaryActionPerformed,false);
  response=await f.browser('alice',made.confirmationPath);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')??'',/default-src 'none'/);assert.equal(response.headers.get('x-frame-options'),'DENY');const confirmation=await response.text();assert.match(confirmation,/ALICE_PRIVATE/);assert.match(confirmation,/&lt;script&gt;/);assert.doesNotMatch(confirmation,/<script>/);
  response=await f.browser('bob',made.confirmationPath);assert.equal(response.status,404);assert.doesNotMatch(await response.text(),/ALICE_PRIVATE/);
  const bob=await(await f.browser('bob','/api/payments/support-requests')).json();assert.deepEqual(bob.requests,[]);const alice=await(await f.browser('alice','/api/payments/support-requests')).json();assert.equal(alice.requests.length,1);assert.doesNotMatch(JSON.stringify(alice),new RegExp(f.users.bob+'|'+f.users.owner+'|payment_id|request_hash'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger').first()).n,500);assert.equal(f.stats().outbound,0);assert.equal(f.stats().videos,0);
 }finally{await f.mf.dispose();}
});

test('Site requires the bound account for writes and blocks all new commercial routes in test realm',async()=>{
 const f=await fixture();try{
  await f.order();const payload={idempotencyKey:crypto.randomUUID(),orderRequestId:requestId,kind:'withdrawal',message:''};
  for(const headers of [{'x-rig-expected-user':''},{'x-rig-expected-user':f.users.owner},{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'}])assert.equal((await f.browser('alice','/api/payments/support-requests',{method:'POST',data:payload,headers})).status,403);
  const before=f.stats().bridgeCalls;
  for(const path of [...adminReads,...adminWrites,...customerReads,'/api/payments/support-requests']){
   const method=adminWrites.includes(path)?'POST':'GET',response=await f.browser('alice',path,{method,extraEnv:{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'}});assert.equal(response.status,404,path);
  }
  assert.equal(f.stats().bridgeCalls,before);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_support_requests').first()).n,0);
  for(const extraEnv of [{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'},{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_wrong'}]){
   assert.equal((await f.privateWorker.fetch(await sign('owner','/api/owner/accounting'),{...f.env,...extraEnv})).status,503);
   assert.equal((await f.privateWorker.fetch(await sign('alice','/api/payments/orders/'+requestId+'/receipt'),{...f.env,...extraEnv})).status,503);
  }
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();assert.equal((await f.privateWorker.fetch(await sign('owner','/api/owner/recovery'),f.env)).status,503);assert.equal(f.stats().outbound,0);
 }finally{await f.mf.dispose();}
});
