// Real local D1 transactions; all provider traffic is an injected in-process fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {closedPaymentWithFetch} from './closed-test-payment.mjs';

const SITE='https://rig.example.chatgpt.site',HOOK='https://rig-api.example.workers.dev/api/payments/webhook',PROFILE='pfl_ADMISSION';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc';
const FAL_KEY='fixture-fal-billing-not-a-real-key';
class PreDispatchFailure extends Error {}
async function migrate(db,path){const triggers=[],sql=(await readFile(new URL(path,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'').replace(/CREATE TRIGGER\b[\s\S]*?\n\s*END\s*;/gi,statement=>{triggers.push(statement);return '';});for(const statement of [...sql.split(';').map(value=>value.trim()).filter(Boolean),...triggers])await db.prepare(statement).run();}
async function fixture({admission,withAdmission=true,stock=500}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'funding-admission'}});
 try{
  const db=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
  await db.prepare('CREATE TABLE fixture_funding_stock(id INTEGER PRIMARY KEY,credits INTEGER NOT NULL CHECK(credits>=0))').run();await db.prepare('INSERT INTO fixture_funding_stock VALUES(1,?)').bind(stock).run();await db.prepare('CREATE TABLE fixture_admission_attempts(order_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_id TEXT NOT NULL)').run();
  const env={DB:db,RIG_MOLLIE_MODE:'live',MOLLIE_API_KEY:'live_fixture',RIG_MOLLIE_PROFILE_ID:PROFILE,RIG_PUBLIC_ORIGIN:SITE,RIG_WEBHOOK_URL:HOOK,RIG_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]'};
  const calls=[],admissions=[],payments=new Map();let created=0;
  const network=async(input,init={})=>{
   const url=new URL(input instanceof Request?input.url:String(input)),method=init.method||'GET';assert.equal(url.origin,'https://api.mollie.com','no real or unrelated provider can be contacted');assert.equal(new Headers(init.headers).get('authorization'),'Bearer live_fixture');calls.push({path:url.pathname,method});
   if(url.pathname==='/v2/payments'&&method==='POST'){
    created++;const body=JSON.parse(init.body),order=await db.prepare('SELECT id,state,credits FROM rig_orders WHERE id=?').bind(body.metadata.order_id).first();assert.ok(order,'the committed order must exist before a provider POST');assert.equal(order.state,'creating');if(withAdmission&&!admission)assert.ok(await db.prepare('SELECT 1 FROM fixture_admission_attempts WHERE order_id=?').bind(order.id).first(),'all admission statements must already be committed before the provider POST');
    const payment={id:'tr_Admit'+String(created).padStart(6,'0'),mode:'live',profileId:PROFILE,status:'open',amount:body.amount,metadata:body.metadata,_links:{checkout:{href:'https://www.mollie.com/checkout/funding-fixture'}}};payments.set(payment.id,payment);return Response.json(payment,{status:201});
   }
   assert.equal(method,'GET');const match=/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/.exec(url.pathname);assert.ok(match,'only an existing attributed payment may be read');assert.ok(payments.has(match[1]));return match[2]?Response.json({_embedded:{[match[2]]:[]}}):Response.json(payments.get(match[1]));
  };
  const stockAdmission=async({env,userId,orderId,requestId,pkg})=>({before:[env.DB.prepare('INSERT INTO fixture_admission_attempts VALUES(?,?,?)').bind(orderId,userId,requestId)],gate:{sql:"COALESCE((SELECT credits FROM fixture_funding_stock WHERE id=1),0)-COALESCE((SELECT SUM(credits) FROM rig_orders WHERE state IN ('creating','open','unknown','credit_pending_review','paid')),0)>=?",params:[pkg.credits]}});
  const orderAdmission=async context=>{admissions.push({userId:context.userId,orderId:context.orderId,requestId:context.requestId,pkg:{...context.pkg}});return admission?admission(context):stockAdmission(context);};
  const payment=closedPaymentWithFetch(network,PreDispatchFailure,{allowLive:true,...(withAdmission?{orderAdmission}:{})});
  const request=(path,data)=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const create=({userId=ALICE,requestId=crypto.randomUUID(),extra={}}={})=>payment(request('/api/payments/create',{packageId:'five',requestId,...extra}),env,userId);
  const count=table=>db.prepare('SELECT COUNT(*) n FROM '+table).first().then(row=>row.n);
  const balance=userId=>db.prepare('SELECT COALESCE(SUM(delta),0) balance FROM rig_ledger WHERE user_id=?').bind(userId).first().then(row=>row.balance);
  const webhook=id=>payment(new Request(HOOK,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+id}),env,null);
  return {mf,db,env,network,payment,request,create,calls,admissions,payments,count,balance,webhook,get created(){return created;}};
 }catch(error){await mf.dispose();throw error;}
}

async function coveredFixture({balance=9,key=FAL_KEY,username='fixture-team',currency='USD',scenario='ok',enabled=true}={}){
 const {prepareFundingAdmission}=await import('./funding-coverage.mjs');
 const controls={scenario,balance,username,currency,reads:0};
 const network=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));assert.equal(url.href,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(init.method||'GET','GET');controls.reads++;
  if(new Headers(init.headers).get('authorization')!==`Key ${FAL_KEY}`)return Response.json({detail:'fixture invalid key'},{status:401});
  if(controls.scenario==='unavailable')return Response.json({detail:'fixture billing unavailable'},{status:503});
  if(controls.scenario==='empty')return Response.json({});
  return Response.json({username:controls.username,credits:{current_balance:controls.balance,currency:controls.currency}});
 };
 const f=await fixture({admission:context=>prepareFundingAdmission(context.env,{userId:context.userId,orderId:context.orderId,requestId:context.requestId,pkg:context.pkg,network})});
 try{
  await migrate(f.db,'./production-migrations/0015_funding_coverage.sql');f.env.RIG_FUNDING_COVERAGE_ENABLED='yes';if(key!==null)f.env.FAL_KEY=key;
  await f.db.prepare('UPDATE rig_funding_policy SET enabled=?,expected_username=? WHERE id=1').bind(enabled?1:0,'fixture-team').run();
  return {f,controls};
 }catch(error){await f.mf.dispose();throw error;}
}

test('parallel different buyers can admit only one package against one real D1 stock unit before any Mollie POST',async()=>{
 const f=await fixture();try{
  const responses=await Promise.all([f.create({userId:ALICE}),f.create({userId:BOB})]);assert.equal(responses.filter(response=>response.status===200).length,1);assert.equal(responses.filter(response=>response.status===503).length,1);assert.equal(f.created,1);assert.equal(await f.count('rig_orders'),1);assert.equal(await f.count('rig_ledger'),0);assert.equal(await f.balance(ALICE),0);assert.equal(await f.balance(BOB),0);assert.equal(f.admissions.length,2);
  const row=await f.db.prepare('SELECT id,user_id,request_id,credits FROM rig_orders').first(),attempt=await f.db.prepare('SELECT * FROM fixture_admission_attempts WHERE order_id=?').bind(row.id).first();assert.equal(attempt.user_id,row.user_id);assert.equal(attempt.request_id,row.request_id);assert.equal(row.credits,500);
 }finally{await f.mf.dispose();}
});

test('concurrent and later repeats of the same purchase intent never admit or charge a second order',async()=>{
 const f=await fixture({stock:5000});try{
  const requestId='same-funded-intent-0001',responses=await Promise.all(Array.from({length:6},()=>f.create({requestId,extra:{credits:900000,amountCents:1}})));assert.equal(responses.filter(response=>response.status===200).length,1);assert.ok(responses.every(response=>[200,409,503].includes(response.status)));assert.equal((await f.create({requestId})).status,409);assert.equal(f.created,1);assert.equal(await f.count('rig_orders'),1);assert.equal(await f.count('rig_ledger'),0);assert.ok(f.admissions.every(value=>value.userId===ALICE&&value.requestId===requestId&&value.pkg.credits===500&&value.pkg.amountCents===500));
 }finally{await f.mf.dispose();}
});

test('an admission refusal, exception or missing result fails closed without an order, payment or credit',async()=>{
 for(const admission of [async()=>{throw Error('fixture funding check unavailable');},async()=>null,async()=>undefined,async()=>({}),async()=>({before:[],gate:{sql:'0',params:[]}})]){
  const f=await fixture({admission});try{const response=await f.create();assert.equal(response.status,503);assert.equal((await response.json()).checkoutUrl,undefined);assert.equal(f.created,0);assert.equal(f.calls.length,0);assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);}finally{await f.mf.dispose();}
 }
});

test('a failed admission statement rolls back the entire D1 batch before an order or provider request exists',async()=>{
 const f=await fixture({admission:async({env,orderId,userId,requestId})=>({before:[env.DB.prepare('INSERT INTO fixture_admission_attempts VALUES(?,?,?)').bind(orderId,userId,requestId),env.DB.prepare('INSERT INTO fixture_missing_table VALUES(1)')],gate:{sql:'1',params:[]}})});try{
  assert.equal((await f.create()).status,503);assert.equal(await f.count('fixture_admission_attempts'),0,'a genuine D1 batch failure must roll back even the earlier admission write');assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);assert.equal(f.created,0);assert.equal(f.calls.length,0);
 }finally{await f.mf.dispose();}
});

test('an exhausted or unavailable admission cannot block already-attributed payment webhooks and owned recovery',async()=>{
 let unavailable=false;const f=await fixture({admission:async context=>{if(unavailable)throw Error('fixture balance unavailable');return {before:[],gate:{sql:'1',params:[]}};}});try{
  const requestId='attributed-payment-0001';assert.equal((await f.create({requestId})).status,200);const order=await f.db.prepare('SELECT * FROM rig_orders').first();unavailable=true;assert.equal((await f.create({userId:BOB})).status,503);assert.equal(f.created,1);f.payments.get(order.payment_id).status='paid';
  const replies=await Promise.all([f.webhook(order.payment_id),f.webhook(order.payment_id)]);assert.ok(replies.every(response=>response.status===200));assert.equal(await f.balance(ALICE),500);assert.equal(await f.balance(BOB),0);assert.equal(await f.count('rig_ledger'),1);
  const admissions=f.admissions.length,recovered=await f.payment(f.request(`/api/payments/orders/${requestId}/reconcile`,{}),f.env,ALICE);assert.equal(recovered.status,200);assert.equal((await recovered.json()).state,'paid');assert.equal(f.admissions.length,admissions,'status recovery must not request a new purchase admission');assert.equal(f.created,1);assert.equal(await f.count('rig_ledger'),1);
 }finally{await f.mf.dispose();}
});

test('legacy payment compositions without an optional admission retain their existing behavior',async()=>{
 const f=await fixture({withAdmission:false,stock:0});try{assert.equal((await f.create()).status,200);assert.equal(f.admissions.length,0);assert.equal(f.created,1);assert.equal(await f.count('rig_orders'),1);assert.equal(await f.count('rig_ledger'),0);}finally{await f.mf.dispose();}
});

test('the actual funding policy admits only one concurrent five-euro purchase against a nine-dollar Fal balance',async()=>{
 const {f,controls}=await coveredFixture();try{
  const replies=await Promise.all([f.create({userId:ALICE}),f.create({userId:BOB})]);assert.equal(replies.filter(response=>response.status===200).length,1);assert.equal(replies.filter(response=>response.status===503).length,1);assert.equal(f.created,1);assert.equal(await f.count('rig_orders'),1);assert.equal(await f.count('rig_ledger'),0);assert.ok(controls.reads>=1&&controls.reads<=2);
 }finally{await f.mf.dispose();}
});

test('missing or wrong Fal credentials and unproven account balances refuse a checkout before Mollie or credit creation',async()=>{
 for(const options of [{key:null},{key:'fixture-other-fal-key'},{scenario:'empty'},{balance:null},{balance:0},{scenario:'unavailable'},{username:'another-fixture-team'},{currency:'EUR'},{enabled:false}]){
  const {f,controls}=await coveredFixture(options);try{
   const reply=await f.create();assert.equal(reply.status,503,JSON.stringify(options));const body=await reply.json();assert.equal(body.checkoutUrl,undefined);assert.doesNotMatch(JSON.stringify(body),/fixture-fal|fixture-team|current_balance|Authorization/);assert.equal(f.created,0);assert.equal(f.calls.length,0);assert.equal(await f.count('rig_orders'),0);assert.equal(await f.count('rig_ledger'),0);if(options.key===null||options.enabled===false)assert.equal(controls.reads,0);
  }finally{await f.mf.dispose();}
 }
});

test('a real funded order can still settle and recover exactly once when new funding admission has been disabled',async()=>{
 const {f,controls}=await coveredFixture();try{
  const requestId='funded-before-disable-0001';assert.equal((await f.create({requestId})).status,200);const order=await f.db.prepare('SELECT * FROM rig_orders').first();f.env.RIG_FUNDING_COVERAGE_ENABLED='no';delete f.env.FAL_KEY;assert.equal((await f.create({userId:BOB})).status,503);const reads=controls.reads;f.payments.get(order.payment_id).status='paid';
  const replies=await Promise.all([f.webhook(order.payment_id),f.webhook(order.payment_id)]);assert.ok(replies.every(response=>response.status===200));assert.equal(await f.balance(ALICE),500);assert.equal(await f.balance(BOB),0);assert.equal(await f.count('rig_ledger'),1);
  const reply=await f.payment(f.request(`/api/payments/orders/${requestId}/reconcile`,{}),f.env,ALICE);assert.equal(reply.status,200);assert.equal((await reply.json()).state,'paid');assert.equal(controls.reads,reads,'existing payment status never requires another funding/billing read');assert.equal(f.created,1);assert.equal(await f.count('rig_ledger'),1);
 }finally{await f.mf.dispose();}
});
