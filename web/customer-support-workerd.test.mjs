import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleCustomerSupport,ownerSupportCases} from './customer-support.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc',ALICE='u-22345678-1234-4123-8123-123456789abc',BOB='u-32345678-1234-4123-8123-123456789abc';
const BASE='/api/payments/support-requests',NOW=Date.parse('2026-11-09T17:00:00Z');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='rig_customer_support_requests'").first())await migrate(db,'./production-migrations/0009_customer_support.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('support-fixture','live',PROJECT,SITE,BRIDGE,'pfl_SUPPORT',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_SUPPORT',RIG_PRODUCTION_ENVIRONMENT_ID:'support-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 async function order({user=ALICE,state='paid',requestId=crypto.randomUUID(),paid=state==='paid'}={}){
  const id=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,requestId,'five',500,500,paid?'tr_'+id.replaceAll('-',''):null,state,'2025-01-01 00:00:00').run();
  if(paid)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,500)').bind('credit:'+id,user,id).run();return {id,requestId};
 }
 const request=(path=BASE,data,{headers={},method=data===undefined?'GET':'POST'}={})=>new Request(SITE+path,{method,headers:{...(data===undefined?{}:{origin:SITE,'content-type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const call=(path=BASE,data,{userId=ALICE,extraEnv={},...options}={})=>handleCustomerSupport(request(path,data,options),{...env,...extraEnv},{userId,now:NOW});
 const payload=(o,extra={})=>({idempotencyKey:crypto.randomUUID(),orderRequestId:o.requestId,kind:'withdrawal',message:'',...extra});
 const money=async()=>{const names=['rig_orders','rig_ledger','rig_frozen_accounts','rig_cancel_requests','rig_finance_expenses'];const out={};for(const table of names)out[table]=(await db.prepare('SELECT * FROM '+table).all()).results;return out;};
 return {mf,db,legacy,env,order,payload,request,call,money};
}

test('received withdrawal is durable, download-ready and never a refund or a ledger mutation',async()=>{
 const f=await fixture();try{
  const o=await f.order(),data=f.payload(o,{message:'Ik wil mijn aankoop herroepen.'}),before=await f.money();
  const response=await f.call(BASE,data);assert.equal(response.status,201,await response.clone().text());const value=await response.json();
  assert.equal(value.state,'received');assert.equal(value.refundDecision,'not_decided');assert.equal(value.monetaryActionPerformed,false);assert.equal(value.replayed,false);assert.equal(value.orderStateAtRequest,'paid');assert.equal(value.amountCents,500);assert.equal(value.createdAt,new Date(NOW).toISOString());assert.match(value.acknowledgement,/nog geen beslissing/);
  assert.deepEqual(await f.money(),before);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_support_requests').first()).n,1);
  const receipt=await f.call(value.confirmationPath);assert.equal(receipt.status,200);assert.equal(receipt.headers.get('content-type'),'text/html; charset=utf-8');assert.match(receipt.headers.get('content-disposition'),/^attachment; filename="RIG-verzoek-/);assert.equal(receipt.headers.get('cache-control'),'private, no-store');const html=await receipt.text();assert.match(html,/geen factuur, creditnota of bevestiging van terugbetaling/);assert.match(html,/geen geld teruggestort/);assert.match(html,/wettelijke rechten/);assert.doesNotMatch(html,/<script|live_fixture|user_id|request_hash/);
 }finally{await f.mf.dispose();}
});

test('racing retries create exactly one immutable receipt and changed payload cannot reuse its key',async()=>{
 const f=await fixture();try{
  const o=await f.order(),data=f.payload(o,{message:'Exact original\nmessage'});
  const results=await Promise.all([f.call(BASE,data),f.call(BASE,data)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);const [a,b]=await Promise.all(results.map(r=>r.json()));assert.equal(a.id,b.id);
  assert.equal((await f.call(BASE,{...data,message:data.message+' '})).status,409);
  await f.db.prepare("UPDATE rig_orders SET state='reversal_review' WHERE id=?").bind(o.id).run();const replay=await f.call(BASE,data);assert.equal(replay.status,200);const value=await replay.json();assert.equal(value.id,a.id);assert.equal(value.orderStateAtRequest,'paid');assert.equal(value.replayed,true);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_support_requests').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('customer isolation applies to creation, lists and downloadable confirmations',async()=>{
 const f=await fixture();try{
  const alice=await f.order(),bob=await f.order({user:BOB});
  assert.equal((await f.call(BASE,f.payload(bob))).status,404);
  const aliceData=f.payload(alice,{message:'Alice private message'}),made=await(await f.call(BASE,aliceData)).json();
  const missing=await f.call(made.confirmationPath,undefined,{userId:BOB});assert.equal(missing.status,404);assert.doesNotMatch(await missing.text(),/Alice private/);
  await f.call(BASE,f.payload(bob,{message:'Bob private message'}),{userId:BOB});
  const list=await(await f.call()).json();assert.equal(list.requests.length,1);assert.equal(list.requests[0].id,made.id);assert.doesNotMatch(JSON.stringify(list),/Bob private|paymentId|userId|request_hash/);
  const reused=await f.call(BASE,{...f.payload(bob),idempotencyKey:aliceData.idempotencyKey},{userId:BOB});assert.equal(reused.status,201);
 }finally{await f.mf.dispose();}
});

test('withdrawal is not silently refused by age, consumption or account freeze; all known states can ask payment help',async()=>{
 const f=await fixture();try{
  const old=await f.order();await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,-500)').bind('fixture-full-consumption',ALICE).run();await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'fixture freeze').run();
  assert.equal((await f.call(BASE,f.payload(old))).status,201);
  for(const state of ['creating','open','unknown','credit_pending_review','failed','expired','reversal_review']){
   const o=await f.order({state});const response=await f.call(BASE,f.payload(o,{kind:'payment-help',message:state}));assert.equal(response.status,201,state+' '+await response.clone().text());await f.db.prepare("UPDATE rig_orders SET state='expired' WHERE id=?").bind(o.id).run();
  }
  const open=await f.order({state:'open'}),rejected=await f.call(BASE,f.payload(open));assert.equal(rejected.status,409);assert.match((await rejected.json()).error,/geen beslissing over je wettelijke rechten/);
 }finally{await f.mf.dispose();}
});

test('request parsing, signed-user prerequisites, route and origin boundaries fail closed',async()=>{
 const f=await fixture();try{
  const o=await f.order(),data=f.payload(o);
  assert.equal((await f.call(BASE,data,{userId:null})).status,401);
  for(const extraEnv of [{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'},{RIG_PRODUCTION_SITE_ORIGIN:'https://attacker.invalid'}])assert.equal((await f.call(BASE,data,{extraEnv})).status,503);
  assert.equal((await f.call(BASE,data,{headers:{origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await f.call(BASE+'?user=other',data)).status,404);assert.equal((await f.call(BASE+'/not-a-uuid/confirmation')).status,404);
  for(const patch of [{kind:'refund-approved'},{idempotencyKey:'bad'},{orderRequestId:123456789012},{message:'x'.repeat(1001)},{message:'nul\u0000control'},{ownerId:OWNER},{amountCents:500}])assert.equal((await f.call(BASE,{...data,...patch})).status,400,JSON.stringify(patch));
  const malformed=new Request(SITE+BASE,{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:'{'});assert.equal((await handleCustomerSupport(malformed,f.env,{userId:ALICE,now:NOW})).status,400);
  const wrongMime=new Request(SITE+BASE,{method:'POST',headers:{origin:SITE,'content-type':'text/plain'},body:JSON.stringify(data)});assert.equal((await handleCustomerSupport(wrongMime,f.env,{userId:ALICE,now:NOW})).status,400);
  const badLength=new Request(SITE+BASE,{method:'POST',headers:{origin:SITE,'content-type':'application/json','content-length':'99999'},body:'{}'});assert.equal((await handleCustomerSupport(badLength,f.env,{userId:ALICE,now:NOW})).status,400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_support_requests').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('confirmation escapes untrusted text and own list stays bounded and newest first',async()=>{
 const f=await fixture();try{
  const o=await f.order(),created=await(await f.call(BASE,f.payload(o,{message:'<script>alert("x")</script> & \"quote\"\nSecond line'}))).json();
  const html=await(await f.call(created.confirmationPath)).text();assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp;/);assert.doesNotMatch(html,/<script>/);
  for(let i=0;i<25;i++)await f.db.prepare("INSERT INTO rig_customer_support_requests(id,user_id,order_id,order_request_id,idempotency_key,kind,message,request_hash,order_state_at_request,amount_cents,credits,created_at) VALUES(?,?,?,?,?,'payment-help',?,?,'paid',500,500,?)").bind(crypto.randomUUID(),ALICE,o.id,o.requestId,crypto.randomUUID(),'Fixture '+i,'a'.repeat(64),NOW+i+1).run();
  const value=await(await f.call()).json();assert.equal(value.requests.length,20);assert.equal(value.requests[0].message,'Fixture 24');assert.equal(value.requests.at(-1).message,'Fixture 5');
 }finally{await f.mf.dispose();}
});

test('owner queue requires the pinned owner and never changes or resolves the immutable request',async()=>{
 const f=await fixture();try{
  const o=await f.order();const value=await(await f.call(BASE,f.payload(o,{message:'Review me'}))).json();
  assert.equal((await ownerSupportCases(f.env,{userId:ALICE,now:NOW})).status,403);assert.equal((await ownerSupportCases({...f.env,RIG_PRODUCTION_OWNER_USER_ID:undefined},{userId:OWNER,now:NOW})).status,403);assert.equal((await ownerSupportCases(f.env,{userId:OWNER,now:NOW,limit:1000})).status,400);
  const before=await f.money(),response=await ownerSupportCases(f.env,{userId:OWNER,now:NOW,limit:1});assert.equal(response.status,200);const queue=await response.json();assert.equal(queue.cases.length,1);assert.equal(queue.cases[0].id,value.id);assert.equal(queue.cases[0].userId,ALICE);assert.equal(queue.cases[0].currentOrderState,'paid');assert.match(queue.cases[0].paymentId,/^tr_/);assert.equal(queue.cases[0].refundDecision,'not_decided');assert.deepEqual(await f.money(),before);
 }finally{await f.mf.dispose();}
});

test('the existing payment limiter bounds request creation and absent support storage fails closed',async()=>{
 const f=await fixture();try{
  const o=await f.order();for(let i=0;i<12;i++)assert.equal((await f.call(BASE,f.payload(o,{kind:'payment-help'}))).status,201);
  assert.equal((await f.call(BASE,f.payload(o))).status,429);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_customer_support_requests').first()).n,12);
  await f.db.prepare('DELETE FROM rig_rate_limits').run();await f.db.prepare('DROP TABLE rig_customer_support_requests').run();assert.equal((await f.call()).status,503);assert.equal((await f.call(BASE,f.payload(o))).status,503);assert.equal((await ownerSupportCases(f.env,{userId:OWNER,now:NOW})).status,503);
 }finally{await f.mf.dispose();}
});
