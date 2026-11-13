// Real isolated production D1, strict default composition, injected network only.
// No funding test bypass, credentials, live provider requests or payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createProductionPayment} from './production-payment.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
import {createRigSitesApp} from './rig-sites-app.mjs';
import {handleOwnerFinance} from './owner-finance.mjs';
import {sitesFinancePath,sitesPath} from './sites-bridge-protocol.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc';
const CUSTOMER='u-22345678-1234-4123-8123-123456789abc';
const PROFILE='pfl_BOUNDARY',FAL_KEY='fixture-only-fal-billing-key',FAL_ACCOUNT='private-boundary-team';
const packages=[{id:'five',amountCents:500,credits:500},{id:'ten',amountCents:1000,credits:1000},{id:'twentyfive',amountCents:2500,credits:2500}];

async function migrate(db,path){
 const triggers=[],sql=(await readFile(new URL(path,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'').replace(/CREATE TRIGGER\b[\s\S]*?\n\s*END\s*;/gi,statement=>{triggers.push(statement);return '';});
 for(const statement of sql.split(';').map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
 for(const trigger of triggers)await db.prepare(trigger).run();
}
async function fixture({migration=false,enabled=false,flag=false,billingResponse}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
  assert.notEqual(db,legacy);await migrate(db,'./production-schema.sql');
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
  await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('funding-boundary', 'live',PROJECT,SITE,BRIDGE,PROFILE,BRIDGE+'/api/payments/webhook').run();
  if(migration){
   const exists=await db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='rig_funding_policy'").first();
   if(!exists)await migrate(db,'./production-migrations/0015_funding_coverage.sql');
   await db.prepare('UPDATE rig_funding_policy SET enabled=?,expected_username=? WHERE id=1').bind(enabled?1:0,FAL_ACCOUNT).run();
  }
  const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'no',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'funding-boundary',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:JSON.stringify(packages),RIG_PRODUCTION_OWNER_USER_ID:OWNER,FAL_KEY,...(flag?{RIG_FUNDING_COVERAGE_ENABLED:'yes'}:{})};
  const calls=[],payments=new Map();
  const transport=async(input,init={})=>{
   const url=new URL(input instanceof Request?input.url:String(input)),method=init.method||'GET';calls.push({origin:url.origin,path:url.pathname,method});
   assert.equal(method,'GET','boundary tests never create a real or fixture checkout');
   if(url.origin==='https://api.fal.ai'){
    assert.equal(url.href,'https://api.fal.ai/v1/account/billing?expand=credits');
    assert.equal(new Headers(init.headers).get('authorization'),`Key ${FAL_KEY}`);
    if(billingResponse)return billingResponse();
    return Response.json({username:FAL_ACCOUNT,credits:{current_balance:8.5,currency:'USD'}});
   }
   assert.equal(url.origin,'https://api.mollie.com');
   if(url.pathname==='/v2/profiles/me')return Response.json({id:PROFILE,status:'verified'});
   if(url.pathname==='/v2/methods')return Response.json({count:1,_embedded:{methods:[{id:'wero'}]}});
   const match=url.pathname.match(/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/);
   assert.ok(match,'only fixed existing-payment paths are allowed');assert.ok(payments.has(match[1]));
   return Response.json(match[2]?{_embedded:{[match[2]]:[]}}:payments.get(match[1]));
  };
  // Intentionally no orderAdmission or coverageReader dependency injection.
  const payment=createProductionPayment({transport});
  const request=(path,data,headers={})=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{origin:SITE,'content-type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const call=(path,data,{user=CUSTOMER,extraEnv={},headers={}}={})=>payment.user(request(path,data,headers),{...env,...extraEnv},user);
  const count=async table=>(await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n;
  const seedOrder=async(user=CUSTOMER)=>{
   const id=crypto.randomUUID(),requestId=crypto.randomUUID(),paymentId='tr_BOUNDARY0001';
   await db.prepare("INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state) VALUES(?,?,?,'five',500,500,?,'open')").bind(id,user,requestId,paymentId).run();
   payments.set(paymentId,{id:paymentId,mode:'live',profileId:PROFILE,status:'paid',amount:{currency:'EUR',value:'5.00'},metadata:{order_id:id}});
   return {id,requestId,paymentId};
  };
  return {mf,db,legacy,env,payment,transport,calls,request,call,count,seedOrder};
 }catch(error){await mf.dispose();throw error;}
}
function assertPublicOnly(value){
 const text=JSON.stringify(value);assert.doesNotMatch(text,new RegExp(FAL_ACCOUNT+'|'+FAL_KEY+'|"USD"|8500000|6000000'));
 const walk=data=>{if(!data||typeof data!=='object')return;for(const [key,item]of Object.entries(data)){assert.doesNotMatch(key,/usd|username|secret|snapshot|headroom|providerBalance|providerReserved|retailLiability|newCreditCapacity|policyVersion|financeVersion|fetchedAt|expiresAt|diagnostic|httpStatus/i);walk(item);}};
 walk(value);
}

test('the strict default production payment constructor refuses missing or disabled funding before Mollie',async()=>{
 for(const setup of [{},{flag:true},{migration:true,flag:true},{migration:true,enabled:true}]){
  const f=await fixture(setup);try{
   const response=await f.call('/api/payments/create',{packageId:'five',requestId:crypto.randomUUID()});
   assert.equal(response.status,503);const value=await response.json();assert.equal(value.checkoutUrl,undefined);assertPublicOnly(value);
   assert.equal(f.calls.length,0,'unconfigured funding cannot reach Mollie or Fal');
   assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);
   assert.equal((await f.legacy.prepare('SELECT COUNT(*) n FROM sqlite_master WHERE name=\'rig_orders\'').first()).n,0,'production refuses without writing TEST');
  }finally{await f.mf.dispose();}
 }
});

test('HTTP fields and environment lookalikes cannot supply the test-only funding constructor dependencies',async()=>{
 const f=await fixture();let escaped=0;
 try{
  const bypass=async()=>{escaped++;return {before:[],gate:{sql:'1',params:[]},enabled:true,status:'ready',newCreditCapacityCents:100000000};};
  const response=await f.call('/api/payments/create',{packageId:'five',requestId:crypto.randomUUID()},{extraEnv:{orderAdmission:bypass,coverageReader:bypass,testCheckoutFunding:{orderAdmission:bypass,coverageReader:bypass},RIG_TEST_FUNDING_BYPASS:'yes'},headers:{'x-rig-owner':'yes','x-rig-funding-enabled':'yes'}});
  assert.equal(response.status,503);assert.equal(escaped,0);assert.equal(f.calls.length,0);assert.equal(await f.count('rig_orders'),0);
  const body=await f.call('/api/payments/create',{packageId:'five',requestId:crypto.randomUUID(),orderAdmission:{gate:{sql:'1',params:[]}},coverageReader:{enabled:true,status:'ready',newCreditCapacityCents:100000000},skipFunding:true});
  assert.ok([400,503].includes(body.status));assert.equal(f.calls.length,0);assert.equal(await f.count('rig_orders'),0);
  const query=await f.call('/api/payments/create?skipFunding=yes',{packageId:'five',requestId:crypto.randomUUID()});assert.equal(query.status,404);
  assert.throws(()=>createProductionPayment({transport:f.transport,orderAdmission:{}}),/Invalid funding dependency/);
  assert.throws(()=>createProductionPayment({transport:f.transport,coverageReader:true}),/Invalid funding dependency/);
 }finally{await f.mf.dispose();}
});

test('public reads disclose purchase availability, never Fal balances, account identity, keys or reserve figures',async()=>{
 for(const active of [false,true]){
  const f=await fixture({migration:true,enabled:active,flag:true});try{
   const values=new Map();
   for(const path of ['/api/session','/api/payments/balance','/api/payments/packages','/api/payments/readiness']){
    const response=await f.call(path);assert.equal(response.status,200,path);assert.equal(response.headers.get('cache-control'),'no-store');
    const value=await response.json();assertPublicOnly(value);values.set(path,value);
   }
   assert.equal(values.get('/api/session').purchasesEnabled,false,'identity reads never promise purchase availability');
   for(const path of ['/api/payments/balance','/api/payments/packages'])assert.equal(values.get(path).purchasesEnabled,active,path);
   assert.equal(values.get('/api/payments/readiness').ready,active);
   assert.deepEqual(values.get('/api/payments/packages').packages.map(pkg=>({id:pkg.id,available:pkg.available})),[{id:'five',available:active},{id:'ten',available:false},{id:'twentyfive',available:false}]);
   if(!active){assert.equal(values.get('/api/payments/packages').purchasePauseReason,'funding_unavailable');assert.equal(values.get('/api/payments/balance').purchasePauseReason,'funding_unavailable');assert.equal(values.get('/api/payments/readiness').reason,'funding_unavailable');}
   assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{await f.mf.dispose();}
 }
});

test('existing webhook and owned reconciliation credit exactly once without funding setup or a Fal balance read',async()=>{
 const f=await fixture();try{
  const order=await f.seedOrder();
  const webhook=()=>f.payment.webhook(new Request(BRIDGE+'/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+order.paymentId}),f.env);
  assert.equal((await webhook()).status,200);
  assert.equal((await f.call('/api/payments/orders/'+order.requestId+'/reconcile',{})).status,200);
  assert.equal((await webhook()).status,200);
  assert.equal((await f.db.prepare('SELECT state FROM rig_orders WHERE id=?').bind(order.id).first()).state,'paid');
  assert.equal((await f.db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(CUSTOMER).first()).amount,500);
  assert.equal(await f.count('rig_ledger'),1);assert.ok(f.calls.length>0);assert.ok(f.calls.every(call=>call.origin==='https://api.mollie.com'&&call.method==='GET'));
 }finally{await f.mf.dispose();}
});

test('the actual native Site and strict production worker keep existing accounts and reports open while new funding is unavailable',async()=>{
 const f=await fixture({migration:true,enabled:false,flag:true});try{
  Object.assign(f.env,{RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_PRODUCTION_SITES_BRIDGE_KEY:'ba'.repeat(32)});
  let videoCalls=0;
  // Real producer signing, real consumer authentication and strict defaults;
  // neither constructor receives funding test dependencies.
  const privateWorker=createProductionCommerceWorker({network:f.transport,videoFactory:async()=>{videoCalls++;throw Error('Payments and reports must not require generation');}});
  const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<main>RIG</main>'},fetchImpl:req=>privateWorker.fetch(req,f.env)});
  const browser=(subject,path,data,user)=>app.fetch(new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':subject,...(user?{'x-rig-expected-user':user}:{}),...(data===undefined?{}:{origin:SITE,'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),f.env);
  const ownerResponse=await browser('boundary-native-owner','/api/session');assert.equal(ownerResponse.status,200);const owner=await ownerResponse.json();assert.equal(owner.purchasesEnabled,false);assertPublicOnly(owner);f.env.RIG_PRODUCTION_OWNER_USER_ID=owner.userId;
  const customerResponse=await browser('boundary-native-customer','/api/session');assert.equal(customerResponse.status,200);const customer=await customerResponse.json();assert.equal(customer.purchasesEnabled,false);assert.notEqual(customer.userId,owner.userId);assertPublicOnly(customer);
  let balance=await browser('boundary-native-customer','/api/payments/balance');assert.equal(balance.status,200);let value=await balance.json();assert.equal(value.balance,0);assert.equal(value.purchasesEnabled,false);assertPublicOnly(value);
  const order=await f.seedOrder(customer.userId);
  const recovered=await browser('boundary-native-customer','/api/payments/orders/'+order.requestId+'/reconcile',{},customer.userId);assert.equal(recovered.status,200);assert.equal((await recovered.json()).state,'paid');
  balance=await browser('boundary-native-customer','/api/payments/balance');assert.equal(balance.status,200);value=await balance.json();assert.equal(value.balance,500);assert.equal(value.purchasesEnabled,false);assertPublicOnly(value);
  const report=await browser('boundary-native-owner','/api/owner/finance');assert.equal(report.status,200);assert.equal((await report.json()).income.cashReceivedCents,500);
  const funding=await browser('boundary-native-owner','/api/owner/finance/funding');assert.equal(funding.status,200);assert.equal((await funding.json()).status,'setup');
  assert.equal((await browser('boundary-native-owner','/api/owner/accounting')).status,200);
  assert.equal((await browser('boundary-native-customer','/api/owner/finance')).status,403);
  const readsBefore=f.calls.length,checkout=await browser('boundary-native-customer','/api/payments/create',{packageId:'five',requestId:crypto.randomUUID()},customer.userId);assert.equal(checkout.status,503);const refusal=await checkout.json();assert.equal(refusal.code,'funding_unavailable');assert.equal(refusal.paymentCreated,false);
  assert.equal(f.calls.length,readsBefore,'blocked checkout cannot reach Mollie or Fal');assert.equal(await f.count('rig_orders'),1);assert.equal(await f.count('rig_ledger'),1);assert.equal(videoCalls,0);assert.ok(f.calls.every(call=>call.origin==='https://api.mollie.com'&&call.method==='GET'));
 }finally{await f.mf.dispose();}
});

test('owner funding checks the trusted owner ID before database or provider access and accepts only an exact GET route',async()=>{
 const f=await fixture({migration:true,enabled:true,flag:true});try{
  let databaseReads=0;
  const deniedEnv={RIG_PRODUCTION_OWNER_USER_ID:OWNER,PRODUCTION_DB:{prepare(){databaseReads++;throw Error('Unauthorized database read');}}};
  for(const userId of [CUSTOMER,undefined,'not-a-production-user']){
   const response=await handleOwnerFinance(f.request('/api/owner/finance/funding',undefined,{'x-rig-user':OWNER}),deniedEnv,{userId,network:f.transport});assert.equal(response.status,403);
  }
  assert.equal(databaseReads,0);assert.equal(f.calls.length,0);
  for(const [path,data]of [['/api/owner/finance/funding?month=2026-11',undefined],['/api/owner/finance/funding',{}]]){
   assert.equal((await handleOwnerFinance(f.request(path,data),f.env,{userId:OWNER,network:f.transport})).status,404);
  }
  assert.equal(f.calls.length,0,'noncanonical owner routes must not read Fal');
  const response=await handleOwnerFinance(f.request('/api/owner/finance/funding'),f.env,{userId:OWNER,network:f.transport});assert.equal(response.status,200);const value=await response.json();assert.equal(value.availableUsdMicros,8500000);assert.equal(value.enabled,true);
  assert.ok(f.calls.every(call=>call.origin==='https://api.fal.ai'&&call.method==='GET'));
 }finally{await f.mf.dispose();}
 assert.equal(sitesFinancePath('/api/owner/finance/funding','GET'),true);assert.equal(sitesPath('/api/owner/finance/funding','GET'),true);
 for(const [path,method]of [['/api/owner/finance/funding','POST'],['/api/owner/finance/funding','HEAD'],['/api/owner/finance/funding?month=2026-11','GET'],['/api/owner/finance/funding?','GET'],['/api/owner/finance/funding/','GET'],['/api/owner/finance/funding#extra','GET']]){
  assert.equal(sitesFinancePath(path,method),false,path+' '+method);assert.equal(sitesPath(path,method),false,path+' '+method);
 }
});

test('real signed owner route receives only fixed billing diagnostics; anonymous/customer and every public purchase surface cannot request them',async()=>{
 const f=await fixture({migration:true,enabled:true,flag:true,billingResponse:()=>Response.json({error:FAL_KEY+' '+FAL_ACCOUNT+' arbitrary-provider-body'},{status:403})});try{
  Object.assign(f.env,{RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_PRODUCTION_SITES_BRIDGE_KEY:'ba'.repeat(32)});
  const worker=createProductionCommerceWorker({network:f.transport});
  const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<main>RIG</main>'},fetchImpl:req=>worker.fetch(req,f.env)});
  const browser=(subject,path)=>app.fetch(new Request(SITE+path,{headers:{...(subject?{'oai-authenticated-user-id':subject}:{}),'x-rig-diagnostics':'true'}}),f.env);
  const session=await browser('diagnostic-owner','/api/session');assert.equal(session.status,200);const owner=await session.json();assertPublicOnly(owner);f.env.RIG_PRODUCTION_OWNER_USER_ID=owner.userId;
  const customerSession=await browser('diagnostic-customer','/api/session');assert.equal(customerSession.status,200);assertPublicOnly(await customerSession.json());
  const response=await browser('diagnostic-owner','/api/owner/finance/funding');assert.equal(response.status,200);const value=await response.json();assert.deepEqual(value.diagnostic,{stage:'http_status',httpStatus:403});assert.equal(value.reason,'funding_unavailable');
  assert.doesNotMatch(JSON.stringify(value),new RegExp(FAL_KEY+'|'+FAL_ACCOUNT+'|arbitrary-provider-body|Authorization|api.fal.ai'));
  const customerDenied=await browser('diagnostic-customer','/api/owner/finance/funding');assert.equal(customerDenied.status,403);assertPublicOnly(await customerDenied.json());
  const reads=f.calls.length;
  assert.equal((await browser(undefined,'/api/owner/finance/funding')).status,401);
  assert.equal((await worker.fetch(new Request(BRIDGE+'/api/owner/finance/funding',{headers:{'oai-authenticated-user-id':'diagnostic-owner','x-rig-diagnostics':'true'}}),f.env)).status,401);
  assert.equal((await browser('diagnostic-owner','/api/owner/finance/funding?diagnostics=true')).status,404);
  assert.equal(f.calls.length,reads,'anonymous requests and debug query parameters cannot trigger a provider read');
  for(const path of ['/api/session','/api/payments/packages','/api/payments/balance','/api/payments/readiness']){const publicResponse=await browser('diagnostic-customer',path);assert.equal(publicResponse.status,200,path);assertPublicOnly(await publicResponse.json());}
  const checkout=await f.call('/api/payments/create',{packageId:'five',requestId:crypto.randomUUID()},{headers:{'x-rig-diagnostics':'true'}});assert.equal(checkout.status,503);const refusal=await checkout.json();assertPublicOnly(refusal);assert.equal(refusal.paymentCreated,false);
  assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);assert.ok(f.calls.every(call=>call.method==='GET'));
 }finally{await f.mf.dispose();}
});

test('production entrypoint dependency graphs never import the funding test bypass',async()=>{
 const result=await build({entryPoints:['closed-video-worker.mjs','production-ingress.mjs','rig-sites-app.mjs','production-collector.mjs'],bundle:true,write:false,outdir:'unused-funding-boundary-output',format:'esm',platform:'browser',metafile:true,logLevel:'silent'});
 assert.ok(Object.keys(result.metafile.inputs).length>20);
 assert.equal(Object.keys(result.metafile.inputs).some(path=>path.endsWith('funding-test-support.mjs')),false);
});


test('signed native sessions stay independent of stalled provider billing while purchases retain fresh fail-closed coverage',async()=>{
 let finishBilling;const stalled=new Promise(resolve=>{finishBilling=resolve;});
 const f=await fixture({migration:true,enabled:true,flag:true,billingResponse:()=>stalled});
 try{
  Object.assign(f.env,{RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_PRODUCTION_SITES_BRIDGE_KEY:'ba'.repeat(32)});
  const worker=createProductionCommerceWorker({network:f.transport,videoFactory:async()=>{throw Error('A session must not create a video service');}});
  const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<main>RIG</main>'},fetchImpl:req=>worker.fetch(req,f.env)});
  const browser=(subject,path,data,user)=>app.fetch(new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:{...(subject?{'oai-authenticated-user-id':subject}:{}),...(user?{'x-rig-expected-user':user}:{}),...(data===undefined?{}:{origin:SITE,'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),f.env);
  async function session(subject){let timer;try{return await Promise.race([browser(subject,'/api/session'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Identity waited for provider billing')),1000);})]);}finally{clearTimeout(timer);}}
  assert.equal((await browser(undefined,'/api/session')).status,401);
  const first=await session('independent-native-customer');assert.equal(first.status,200);const account=await first.json();assertPublicOnly(account);assert.equal(account.purchasesEnabled,false);assert.equal(account.balanceCents,0);
  await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('session-isolation-fixture',?,725)").bind(account.userId).run();
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture review')").bind(account.userId).run();
  const second=await session('independent-native-customer');assert.equal(second.status,200);assert.deepEqual(await second.json(),{userId:account.userId,balanceCents:725,frozen:true,currency:'EUR',mode:'live',purchasesEnabled:false,funding:'credits'});
  const other=await session('other-independent-native-customer');const otherAccount=await other.json();assert.notEqual(otherAccount.userId,account.userId);assert.equal(otherAccount.balanceCents,0);assert.equal(otherAccount.frozen,false);
  assert.equal((await browser('independent-native-customer','/api/payments/balance',undefined,otherAccount.userId)).status,403);
  assert.equal(f.calls.length,0,'session, anonymous and account-binding checks must not dispatch any provider read');
  // The same deployment still obtains actual purchase availability separately.
  // A definitive provider refusal cannot make a package or checkout available.
  finishBilling(Response.json({error:'fixture billing denied'},{status:403}));
  const publicPackages=await browser('other-independent-native-customer','/api/payments/packages');assert.equal(publicPackages.status,200);const packages=await publicPackages.json();assert.equal(packages.purchasesEnabled,false);assert.ok(packages.packages.every(p=>p.available===false));
  const balance=await browser('other-independent-native-customer','/api/payments/balance');assert.equal(balance.status,200);assert.equal((await balance.json()).purchasesEnabled,false);
  const readiness=await browser('other-independent-native-customer','/api/payments/readiness');assert.equal(readiness.status,200);assert.equal((await readiness.json()).ready,false);
  const created=await browser('other-independent-native-customer','/api/payments/create',{packageId:'five',requestId:crypto.randomUUID()},otherAccount.userId);assert.equal(created.status,503);const refused=await created.json();assert.equal(refused.paymentCreated,false);assert.equal(refused.checkoutUrl,undefined);
  assert.ok(f.calls.some(call=>call.origin==='https://api.fal.ai'),'purchase endpoints must still attempt a current funding read');assert.ok(f.calls.every(call=>call.method==='GET'),'no Mollie creation or provider generation may occur');
  assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),1);
 }finally{finishBilling(Response.json({error:'fixture cleanup'},{status:403}));await f.mf.dispose();}
});
