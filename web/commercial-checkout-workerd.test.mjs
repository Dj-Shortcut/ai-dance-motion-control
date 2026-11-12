import {testCheckoutFunding} from './funding-test-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {prepareCommercialCheckout,commercialCheckoutRequired,commercialPackageData} from './commercial-checkout.mjs';
import {COMMERCE_VERSION,merchant} from './commerce-profile.mjs';
import {commerceDocument} from './commerce-documents.mjs';
import {createProductionPayment} from './production-payment.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',PROFILE='pfl_COMMERCE';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',NOW=Date.parse('2026-11-09T18:00:00Z'),BASE='/api/payments/create';
const packages=[{id:'five',amountCents:500,credits:500},{id:'ten',amountCents:1000,credits:1000}];
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
  // Keep the additive migration executable before the parent fresh-schema sync.
  const columns=(await db.prepare('PRAGMA table_info(rig_purchase_acceptances)').all()).results;
  if(!columns.some(column=>column.name==='package_id')){if(columns.length)await db.prepare('DROP TABLE rig_purchase_acceptances').run();await migrate(db,'./production-migrations/0010_commercial_acceptance.sql');}
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('commerce-fixture','live',PROJECT,SITE,BRIDGE,PROFILE,BRIDGE+'/api/payments/webhook').run();
  const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'commerce-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:JSON.stringify(packages),RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes'};
  const body=(extra={})=>({packageId:'five',requestId:crypto.randomUUID(),commerce:{version:COMMERCE_VERSION,accepted:true,customerType:'consumer',country:'NL'},...extra});
  const request=(data=body(),{path=BASE,origin=SITE,method='POST',headers={},raw}={})=>new Request(origin+path,{method,headers:{origin:SITE,'content-type':'application/json',...headers},...(method==='POST'?{body:raw??JSON.stringify(data)}:{})});
  const call=(data=body(),{extraEnv={},userId=ALICE,now=NOW,...options}={})=>prepareCommercialCheckout(request(data,options),{...env,...extraEnv},{userId,now});
  const rows=()=>db.prepare('SELECT * FROM rig_purchase_acceptances ORDER BY user_id,request_id').all().then(x=>x.results);
  const money=async()=>({orders:(await db.prepare('SELECT * FROM rig_orders').all()).results,ledger:(await db.prepare('SELECT * FROM rig_ledger').all()).results});
  return {mf,db,legacy,env,body,request,call,rows,money};
 }catch(error){await mf.dispose();throw error;}
}
const status=result=>result.response?.status??200;

test('required flag activates exact current commerce metadata; disabled rollout leaves original body untouched',async()=>{
 const req=new Request(SITE+BASE,{method:'POST',body:'old-body'}),result=await prepareCommercialCheckout(req,{});
 assert.equal(result.request,req);assert.equal(req.bodyUsed,false);assert.equal(commercialCheckoutRequired({}),false);assert.equal(commercialCheckoutRequired({RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes'}),true);
 assert.deepEqual(commercialPackageData({}),{});const value=commercialPackageData({RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes'}).commerce;
 assert.equal(value.required,true);assert.equal(value.version,COMMERCE_VERSION);assert.deepEqual(value.countries,['BE','NL']);assert.equal(value.customerType,'consumer');assert.equal(value.currency,'EUR');assert.equal(value.termsPath,'/voorwaarden');assert.equal(value.merchant.legalName,merchant.legalName);
});

test('exact acceptance stores immutable seller, current terms and server price without creating money or payments',async()=>{
 const f=await fixture();try{
  const data=f.body(),text=JSON.stringify(data),result=await f.call(data,{headers:{'content-length':String(Buffer.byteLength(text))}});assert.equal(status(result),200,result.response&&await result.response.text());
  assert.deepEqual(await result.request.json(),{packageId:'five',requestId:data.requestId});assert.equal(result.request.headers.get('content-length'),null);assert.equal(result.request.headers.get('origin'),SITE);
  const [saved]=await f.rows();assert.equal(saved.user_id,ALICE);assert.equal(saved.version,COMMERCE_VERSION);assert.equal(saved.buyer_country,'NL');assert.equal(saved.customer_type,'consumer');assert.equal(saved.package_id,'five');assert.equal(saved.amount_cents,500);assert.equal(saved.credits,500);assert.equal(saved.currency,'EUR');assert.deepEqual(JSON.parse(saved.seller_json),merchant);assert.equal(saved.terms_text,await commerceDocument('/voorwaarden').text());assert.equal(saved.created_at,NOW);assert.match(saved.request_hash,/^[0-9a-f]{64}$/);
  assert.equal(status(await f.call(data,{now:NOW+999999})),200);assert.deepEqual(await f.rows(),[saved]);assert.deepEqual(await f.money(),{orders:[],ledger:[]});assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rig_purchase_acceptances'").first()).n,0);
 }finally{await f.mf.dispose();}
});

test('wrong country/type/unchecked/stale version and extra fields cannot store an acceptance',async()=>{
 const f=await fixture();try{
  const base=f.body();const wrongCommerce=[null,[],{}, {...base.commerce,country:'US'}, {...base.commerce,country:'nl'}, {...base.commerce,country:['NL']}, {...base.commerce,customerType:'business'}, {...base.commerce,accepted:false}, {...base.commerce,accepted:'true'}, {...base.commerce,version:'old'}, {...base.commerce,version:1}, {...base.commerce,agreedAt:NOW}];
  for(const commerce of wrongCommerce)assert.equal(status(await f.call({...base,commerce})),400,JSON.stringify(commerce));
  for(const patch of [{commerce:undefined},{requestId:123456789012},{requestId:'old-request-code'},{packageId:5},{amountCents:1},{userId:BOB},{ownerApproved:true}])assert.equal(status(await f.call({...base,...patch})),400,JSON.stringify(patch));
  assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
 }finally{await f.mf.dispose();}
});

test('trusted identity, origin, method, JSON type and bounded body are required before storage',async()=>{
 const f=await fixture();try{
  const data=f.body();for(const userId of [null,ALICE.slice(2),{},[ALICE],{toString:()=>ALICE}])assert.equal(status(await f.call(data,{userId})),401);
  for(const options of [{origin:'https://evil.invalid'},{headers:{origin:'https://evil.invalid'}},{headers:{'sec-fetch-site':'cross-site'}}])assert.equal(status(await f.call(data,options)),options.origin?404:403);
  assert.equal(status(await f.call(data,{path:BASE+'?package=five'})),404);assert.equal(status(await f.call(data,{method:'GET'})),405);
  for(const headers of [{'content-type':'text/plain'},{'content-type':'application/jsonp'},{'content-length':'99999'},{'content-length':'not-a-number'},{'content-length':'2'}])assert.equal(status(await f.call(data,{headers})),400,JSON.stringify(headers));
  for(const raw of ['{','null','[]','1',JSON.stringify({...data,extra:'é'.repeat(8192)})])assert.equal(status(await f.call(data,{raw})),400);
  for(const now of [NaN,0,-1,1.5,Infinity])assert.equal(status(await f.call(data,{now})),503);
  assert.deepEqual(await f.rows(),[]);
 }finally{await f.mf.dispose();}
});

test('genuine positive server package and a live pinned database are required, with no tax inference',async()=>{
 const f=await fixture();try{
  const data=f.body();assert.equal(status(await f.call({...data,packageId:'nonexistent'})),400);
  for(const value of [[],[{id:'five',amountCents:0,credits:500}],[{id:'five',amountCents:500,credits:0}],[{id:'five',amountCents:1.5,credits:500}],[{id:'five',amountCents:500,credits:-1}],[packages[0],packages[0]],null])assert.equal(status(await f.call(data,{extraEnv:{RIG_PRODUCTION_PACKAGES:JSON.stringify(value)}})),503,JSON.stringify(value));
  for(const extraEnv of [{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'},{RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_wrong'},{MOLLIE_LIVE_API_KEY:'test_fixture'}])assert.equal(status(await f.call(data,{extraEnv})),503);
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();assert.equal(status(await f.call(data)),503);assert.deepEqual(await f.rows(),[]);
  await f.db.prepare("UPDATE rig_payment_environment SET mode='live'").run();assert.equal(status(await f.call(data)),200);assert.doesNotMatch(JSON.stringify(await f.rows()),/vat_treatment|tax_classification|invoice_number|oss/);
 }finally{await f.mf.dispose();}
});

test('frozen wallet denies acceptance before any storage and changing prices cannot overwrite a prior snapshot',async()=>{
 const f=await fixture();try{
  const data=f.body();await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'review').run();assert.equal(status(await f.call(data)),403);assert.deepEqual(await f.rows(),[]);
  await f.db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').bind(ALICE).run();assert.equal(status(await f.call(data)),200);const original=await f.rows();
  assert.equal(status(await f.call({...data,commerce:{...data.commerce,country:'BE'}})),409);assert.equal(status(await f.call({...data,packageId:'ten'})),409);
  assert.equal(status(await f.call(data,{extraEnv:{RIG_PRODUCTION_PACKAGES:JSON.stringify([{id:'five',amountCents:501,credits:500}])}})),409);
  assert.deepEqual(await f.rows(),original);assert.equal(status(await f.call(data,{userId:BOB})),200);assert.equal((await f.rows()).length,2);
 }finally{await f.mf.dispose();}
});

test('racing identical requests share one immutable snapshot; conflicting races cannot both pass',async()=>{
 const f=await fixture();try{
  const same=f.body(),identical=await Promise.all([f.call(same),f.call(same),f.call(same)]);assert.deepEqual(identical.map(status),[200,200,200]);assert.equal((await f.rows()).length,1);
  const conflict=f.body(),competing=await Promise.all([f.call(conflict),f.call({...conflict,commerce:{...conflict.commerce,country:'BE'}})]);assert.deepEqual(competing.map(status).sort(),[200,409]);assert.equal((await f.rows()).length,2);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
 }finally{await f.mf.dispose();}
});

function beforeInsertDatabase(db,before){return {prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('INSERT INTO rig_purchase_acceptances'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async run(){await before();return bound.run();}};}};}};}
test('SQL insertion rechecks a freeze or mode change occurring after preflight; missing storage fails closed',async()=>{
 const f=await fixture();try{
  for(const mutate of [()=>f.db.prepare('INSERT OR IGNORE INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'raced').run(),()=>f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run()]){
   const proxied=beforeInsertDatabase(f.db,mutate);assert.equal(status(await f.call(f.body(),{extraEnv:{PRODUCTION_DB:proxied}})),503);assert.deepEqual(await f.rows(),[]);await f.db.prepare('DELETE FROM rig_frozen_accounts').run();await f.db.prepare("UPDATE rig_payment_environment SET mode='live'").run();
  }
  await f.db.prepare('DROP TABLE rig_purchase_acceptances').run();assert.equal(status(await f.call()),503);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
 }finally{await f.mf.dispose();}
});

test('acceptance SQL rejects unsupported country, business type, false currency and invalid monetary snapshots',async()=>{
 const f=await fixture();try{
  const data=f.body();assert.equal(status(await f.call(data)),200);const [saved]=await f.rows();
  const insert=(patch={})=>{const row={...saved,request_id:crypto.randomUUID(),...patch},keys=Object.keys(row);return f.db.prepare('INSERT INTO rig_purchase_acceptances('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>row[key])).run();};
  for(const patch of [{buyer_country:'FR'},{customer_type:'business'},{currency:'USD'},{amount_cents:0},{amount_cents:1.1},{credits:0},{credits:1.1},{seller_json:'[]'},{seller_json:'{broken'},{request_hash:'z'.repeat(64)},{created_at:0}])await assert.rejects(insert(patch));
  assert.equal((await f.rows()).length,1);
 }finally{await f.mf.dispose();}
});

function fakePayments(f){
 const calls=[];let created=0;
 const payment=createProductionPayment({...testCheckoutFunding,transport:async(input,init={})=>{
  const url=new URL(input);assert.equal(url.origin,'https://api.mollie.com');assert.equal(new Headers(init.headers).get('authorization'),'Bearer live_fixture');calls.push({path:url.pathname,method:init.method??'GET'});
  if(url.pathname==='/v2/profiles/me'&&(init.method??'GET')==='GET')return Response.json({id:PROFILE});
  assert.equal(url.pathname,'/v2/payments');assert.equal(init.method,'POST');created++;const body=JSON.parse(init.body);
  const acceptance=await f.db.prepare('SELECT * FROM rig_purchase_acceptances WHERE user_id=?').bind(ALICE).first();assert.ok(acceptance);assert.equal(acceptance.amount_cents,500);assert.equal(body.amount.value,'5.00');
  return Response.json({id:'tr_Fixture0001',profileId:PROFILE,mode:'live',status:'open',amount:body.amount,metadata:body.metadata,_links:{checkout:{href:'https://www.mollie.com/checkout/fixture'}}},{status:201});
 }});
 return {payment,calls,get created(){return created;},call:(data,{path=BASE,method='POST',headers={}}={})=>payment.user(f.request(data,{path,method,headers}),f.env,ALICE)};
}
test('production payment limiter precedes acceptance insertion and all blocked input stays away from the provider',async()=>{
 const f=await fixture();try{
  const fake=fakePayments(f);for(let i=0;i<12;i++)assert.equal((await fake.call(f.body({commerce:{}}))).status,400);
  assert.equal((await fake.call(f.body())).status,429);assert.deepEqual(await f.rows(),[]);assert.deepEqual(fake.calls,[]);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
  await f.db.prepare('DELETE FROM rig_rate_limits').run();await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'review').run();assert.equal((await fake.call(f.body())).status,403);assert.deepEqual(await f.rows(),[]);assert.deepEqual(fake.calls,[]);
 }finally{await f.mf.dispose();}
});

test('real payment composition forwards stripped verified request only once and never grants credit on open checkout',async()=>{
 const f=await fixture();try{
  const fake=fakePayments(f),data=f.body(),response=await fake.call(data);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).checkoutUrl,'https://www.mollie.com/checkout/fixture');
  assert.equal(fake.created,1);assert.equal((await f.rows()).length,1);const money=await f.money();assert.equal(money.orders.length,1);assert.equal(money.orders[0].state,'open');assert.equal(money.orders[0].amount_cents,500);assert.deepEqual(money.ledger,[]);
  const snapshot=await f.rows();assert.equal((await fake.call(data)).status,409);assert.equal(fake.created,1);assert.deepEqual(await f.rows(),snapshot);
  const packageReply=await fake.call(undefined,{path:'/api/payments/packages',method:'GET'});assert.equal(packageReply.status,200);const value=await packageReply.json();assert.equal(value.commerce.version,COMMERCE_VERSION);assert.equal(value.commerce.required,true);assert.equal(value.mode,'live');assert.doesNotMatch(JSON.stringify(value),/live_fixture|request_hash|seller_json|tax_classification/);
 }finally{await f.mf.dispose();}
});

test('stale consent recovers through the existing durable cancellation barrier, without an unsafe not-created claim',async()=>{
 const f=await fixture();try{
  const fake=fakePayments(f),data=f.body(),rejected=await fake.call({...data,commerce:{...data.commerce,version:'outdated-terms'}});assert.equal(rejected.status,400);const failure=await rejected.json();assert.equal(failure.code,'commerce_acceptance_required');assert.equal(Object.hasOwn(failure,'paymentNotCreated'),false);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
  const recovery=await fake.call({}, {path:'/api/payments/orders/'+data.requestId+'/reconcile'});assert.equal(recovery.status,200);assert.equal((await recovery.json()).state,'canceled');assert.ok(await f.db.prepare('SELECT 1 FROM rig_payment_cancelled_intents WHERE user_id=? AND request_id=?').bind(ALICE,data.requestId).first());
  // A delayed valid request using the old intent cannot create a payment after
  // the browser has been told cancellation was durably established.
  assert.equal((await fake.call(data)).status,409);assert.equal(fake.created,0);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
  const fresh=f.body(),response=await fake.call(fresh);assert.equal(response.status,200);assert.equal(fake.created,1);const money=await f.money();assert.equal(money.orders.length,1);assert.equal(money.orders[0].request_id,fresh.requestId);assert.equal(money.orders[0].state,'open');assert.deepEqual(money.ledger,[]);
 }finally{await f.mf.dispose();}
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function beforeOrderDatabase(db,entered,release){const watched=new WeakSet();return {
 prepare(sql){const statement=db.prepare(sql);if(!sql.startsWith('INSERT OR IGNORE INTO rig_orders('))return statement;return {bind(...args){const bound=statement.bind(...args);watched.add(bound);return bound;}};},
 async batch(statements){if(statements.some(statement=>watched.has(statement))){entered.resolve();await release.promise;}return db.batch(statements);}
};}
test('recovery cancellation wins a race after commercial acceptance but before order insertion and blocks the late provider dispatch',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let attempt;try{
  const fake=fakePayments(f),data=f.body();f.env.PRODUCTION_DB=beforeOrderDatabase(f.db,entered,release);attempt=fake.call(data);await entered.promise;
  assert.equal((await f.rows()).length,1);assert.equal((await f.money()).orders.length,0);assert.equal(fake.created,0);
  const recovery=await fake.call({}, {path:'/api/payments/orders/'+data.requestId+'/reconcile'});assert.equal(recovery.status,200);assert.equal((await recovery.json()).state,'canceled');release.resolve();assert.equal((await attempt).status,409);assert.equal(fake.created,0);assert.deepEqual(fake.calls,[]);assert.deepEqual(await f.money(),{orders:[],ledger:[]});
 }finally{release.resolve();if(attempt)await attempt;await f.mf.dispose();}
});

test('a dispatched concurrent request stays pending and cannot be canceled or duplicated after another request reports stale consent',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let attempt,created=0;try{
  const data=f.body(),payment=createProductionPayment({...testCheckoutFunding,transport:async(input,init={})=>{
   const url=new URL(input);if(url.pathname==='/v2/profiles/me')return Response.json({id:PROFILE});assert.equal(url.pathname,'/v2/payments');assert.equal(init.method,'POST');created++;entered.resolve();await release.promise;const body=JSON.parse(init.body);return Response.json({id:'tr_Race0001',profileId:PROFILE,mode:'live',status:'open',amount:body.amount,metadata:body.metadata,_links:{checkout:{href:'https://www.mollie.com/checkout/race'}}},{status:201});
  }}),call=(body,path=BASE)=>payment.user(f.request(body,{path}),f.env,ALICE);
  attempt=call(data);await entered.promise;assert.equal(created,1);assert.equal((await f.money()).orders[0].state,'creating');
  const stale=await call({...data,commerce:{...data.commerce,version:'outdated-terms'}});assert.equal(stale.status,400);assert.equal(Object.hasOwn(await stale.json(),'paymentNotCreated'),false);
  const recovery=await call({},'/api/payments/orders/'+data.requestId+'/reconcile');assert.equal(recovery.status,200);assert.equal((await recovery.json()).state,'creating');assert.equal(await f.db.prepare('SELECT 1 FROM rig_payment_cancelled_intents WHERE user_id=? AND request_id=?').bind(ALICE,data.requestId).first(),null);
  assert.equal((await call(data)).status,409);assert.equal(created,1);release.resolve();assert.equal((await attempt).status,200);assert.equal(created,1);const money=await f.money();assert.equal(money.orders.length,1);assert.equal(money.orders[0].state,'open');assert.deepEqual(money.ledger,[]);
 }finally{release.resolve();if(attempt)await attempt;await f.mf.dispose();}
});
