import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleOwnerRecovery} from './owner-recovery.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';

const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
async function migrate(db,file){for(const sql of (await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 await migrate(db,'./production-schema.sql');
 if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_owner_recovery_events'").first())await migrate(db,'./production-migrations/0007_owner_recovery.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('recovery-fixture','live',PROJECT,SITE,BRIDGE,'pfl_RECOVERY',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_TESTONLY',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_RECOVERY',RIG_PRODUCTION_ENVIRONMENT_ID:'recovery-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 const now=Date.now();await installTestOwnerCredential(db,OWNER,{now});
 const payments=new Map(),requests=[];let paymentHook=null,profile={id:'pfl_RECOVERY',status:'verified'};
 const network=async(input,init={})=>{
  const url=new URL(String(input));requests.push({url:url.href,method:init.method??'GET'});
  assert.equal(url.origin,'https://api.mollie.com');assert.equal(init.method??'GET','GET','No provider mutation is allowed');assert.equal(new Headers(init.headers).get('authorization'),'Bearer live_TESTONLY');
  if(url.pathname==='/v2/profiles/me')return Response.json(profile);
  const match=/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/.exec(url.pathname);assert.ok(match,'Unexpected provider path');
  const record=payments.get(match[1]);if(!record)return Response.json({error:'not found'},{status:404});
  if(match[2])return Response.json({_embedded:{[match[2]]:record[match[2]]??[]}});
  if(paymentHook)await paymentHook();return Response.json(record);
 };
 async function order({state='unknown',paymentId=null,user=CUSTOMER,createdAt=new Date(now-600000).toISOString().slice(0,19).replace('T',' ')}={}){
  const id=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,'intent-'+id,'five',500,500,paymentId,state,createdAt).run();return id;
 }
 async function job(){
  const quote=crypto.randomUUID(),id=crypto.randomUUID();await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at,funding_kind) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(quote,CUSTOMER,'fal-ai/kling-video/o3/standard/video-to-video/edit',JSON.stringify({prompt:'PRIVATE PROMPT NEVER IN SUPPORT QUEUE',refs:[{url:'https://private-input.invalid/secret'}]}),175,'fixture',5,now+600000,now,'credits').run();
  await db.prepare('INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,CUSTOMER,quote,crypto.randomUUID(),175,'unknown',now).run();
  await db.prepare('INSERT OR IGNORE INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,500)').bind('fixture-credit',CUSTOMER).run();await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,-175)').bind('reserve:'+id,CUSTOMER).run();return id;
 }
 function providerPayment(orderId,id='tr_Recovery001',patch={}){const value={id,profileId:'pfl_RECOVERY',mode:'live',status:'paid',metadata:{order_id:orderId},amount:{currency:'EUR',value:'5.00'},...patch};payments.set(id,value);return value;}
 const request=(path,data,headers={})=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{origin:SITE,'content-type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const call=(path='/api/owner/recovery',data,{userId=OWNER,extraEnv={},headers={}}={})=>handleOwnerRecovery(request(path,data,headers),{...env,...extraEnv},{userId,now,network});
 const cases=async()=>{const response=await call();assert.equal(response.status,200,await response.clone().text());return response.json();};
 const caseFor=async(kind,id)=>(await cases()).cases.find(item=>item.kind===kind&&item.id===id);
 const proof=(operation,payload)=>verificationFor(db,OWNER,operation,payload,now,{env});
 const ledger=async()=> (await db.prepare('SELECT event_id,user_id,order_id,delta FROM rig_ledger ORDER BY event_id').all()).results;
 return {mf,db,env,now,requests,payments,order,job,providerPayment,call,cases,caseFor,proof,ledger,setProfile:value=>{profile=value;},setPaymentHook:fn=>{paymentHook=fn;}};
}
const note=(item,patch={})=>({idempotencyKey:crypto.randomUUID(),kind:item.kind,caseId:item.id,expectedVersion:item.version,status:'waiting-provider',note:'Requested provider investigation; no outcome claimed.',...patch});
const adoption=(item,id='tr_Recovery001')=>({idempotencyKey:crypto.randomUUID(),expectedVersion:item.version,providerPaymentId:id});
const adoptionProof=(f,id,payload)=>f.proof('recovery-payment',{orderId:id,...payload});
const adoptionPath=id=>'/api/owner/recovery/payments/'+id+'/adopt';

test('recovery queue is owner-only, bounded and contains no provider credentials, prompts or private media',async()=>{
 const f=await fixture();try{
  const order=await f.order(),job=await f.job();await f.order({state:'creating',user:'u-32345678-1234-4123-8123-123456789abc',createdAt:new Date(f.now).toISOString().slice(0,19).replace('T',' ')});
  const response=await f.call();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const data=await response.json();
  assert.deepEqual(data.counts,{payment:1,generation:1});assert.equal(data.cases.length,2);assert.ok(data.cases.every(c=>/^[a-f0-9]{64}$/.test(c.version)&&c.fundingLocked===true));assert.ok(data.cases.some(c=>c.id===order));assert.ok(data.cases.some(c=>c.id===job));
  assert.equal(data.cases.find(c=>c.id===order).createdAt,Math.floor((f.now-600000)/1000)*1000);assert.equal(data.cases.find(c=>c.id===job).createdAt,f.now);
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE PROMPT|private-input|live_TESTONLY/);assert.equal(f.requests.length,0);
  assert.equal((await f.call(undefined,undefined,{userId:CUSTOMER})).status,403);assert.equal((await f.call(undefined,undefined,{extraEnv:{PRODUCTION_DB:f.env.DB}})).status,503);assert.equal((await f.call('/api/owner/recovery?user=other')).status,403);
 }finally{await f.mf.dispose();}
});

test('an investigation note needs a fresh exact proof, is append-only and never changes or hides unknown funding',async()=>{
 const f=await fixture();try{
  const id=await f.job(),item=await f.caseFor('generation',id),payload=note(item,{status:'reviewed'}),before=await f.ledger();
  assert.equal((await f.call('/api/owner/recovery/notes',payload)).status,428);
  const verification=await f.proof('recovery-note',payload);let response=await f.call('/api/owner/recovery/notes',{...payload,verification});assert.equal(response.status,201,await response.clone().text());const result=await response.json();assert.equal(result.fundingChanged,false);
  response=await f.call('/api/owner/recovery/notes',{...payload,verification});assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);
  assert.equal((await f.call('/api/owner/recovery/notes',{...payload,note:'Changed after signed approval',verification})).status,409);
  assert.deepEqual(await f.ledger(),before);assert.equal((await f.db.prepare('SELECT state FROM rig_generation_jobs WHERE id=?').bind(id).first()).state,'unknown');
  const still=await f.caseFor('generation',id);assert.equal(still.fundingLocked,true);assert.equal(still.notes[0].status,'reviewed');assert.equal(f.requests.length,0);
  assert.equal((await f.call('/api/owner/recovery/events/'+result.id+'/update',{note:'erase history'})).status,404);
  const second=note(still,{note:'Provider still investigating; prior note retained.'}),secondProof=await f.proof('recovery-note',second);
  assert.equal((await f.call('/api/owner/recovery/notes',{...second,verification:secondProof})).status,201);
  assert.equal((await f.db.prepare('SELECT note FROM rig_owner_recovery_events WHERE id=?').bind(result.id).first()).note,payload.note);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,2);
 }finally{await f.mf.dispose();}
});

test('expired case versions and wrong origins cannot record a note or clear a case',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=note(item),verification=await f.proof('recovery-note',payload);
  assert.equal((await f.call('/api/owner/recovery/notes',{...payload,verification},{headers:{origin:'https://attacker.invalid'}})).status,403);
  await f.db.prepare("UPDATE rig_orders SET state='expired' WHERE id=?").bind(id).run();assert.equal((await f.call('/api/owner/recovery/notes',{...payload,verification})).status,409);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,0);assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});

test('Mollie payment adoption checks profile, mode, exact order and amount; only verified paid recovery awards credit',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload),provider=f.providerPayment(id);
  for(const patch of [{mode:'test'},{profileId:'pfl_OTHER'},{metadata:{order_id:crypto.randomUUID()}},{amount:{currency:'USD',value:'5.00'}},{amount:{currency:'EUR',value:'50.00'}}]){
   f.payments.set(provider.id,{...provider,...patch});const response=await f.call(adoptionPath(id),{...payload,verification});assert.equal(response.status,409,JSON.stringify(patch));assert.equal((await f.db.prepare('SELECT payment_id FROM rig_orders WHERE id=?').bind(id).first()).payment_id,null);assert.deepEqual(await f.ledger(),[]);
  }
  f.payments.set(provider.id,provider);let response=await f.call(adoptionPath(id),{...payload,verification});assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.linked,true);assert.equal(result.reconciled,true);assert.equal(result.creditConfirmed,true);assert.equal(result.orderState,'paid');
  response=await f.call(adoptionPath(id),{...payload,verification});assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);
  assert.deepEqual((await f.ledger()).map(row=>row.delta),[500]);assert.ok(f.requests.every(req=>req.method==='GET'));assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('session alone cannot adopt a payment; a frozen account and a reversal are never advertised as usable credit',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item);f.providerPayment(id);
  assert.equal((await f.call(adoptionPath(id),payload)).status,428);assert.deepEqual(await f.ledger(),[]);
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'manual review')").bind(CUSTOMER).run();const verification=await adoptionProof(f,id,payload);
  const response=await f.call(adoptionPath(id),{...payload,verification});assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.creditConfirmed,false);assert.equal(result.reviewRequired,true);assert.equal(result.orderState,'credit_pending_review');assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});

test('simultaneous duplicate adoption cannot double-credit or attach the provider payment to another order',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload);f.providerPayment(id);
  const responses=await Promise.all([f.call(adoptionPath(id),{...payload,verification}),f.call(adoptionPath(id),{...payload,verification})]);assert.ok(responses.some(r=>r.status===200));assert.ok(responses.every(r=>[200,409].includes(r.status)));assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
  const other=await f.order(),otherItem=await f.caseFor('payment',other),otherPayload=adoption(otherItem),otherProof=await adoptionProof(f,other,otherPayload);
  f.providerPayment(other); // Even changed metadata cannot reuse an ID bound to another order.
  assert.equal((await f.call(adoptionPath(other),{...otherPayload,verification:otherProof})).status,409);assert.equal((await f.db.prepare('SELECT payment_id FROM rig_orders WHERE id=?').bind(other).first()).payment_id,null);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('an open verified payment awards no credit until a later verified paid response',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload);f.providerPayment(id,'tr_Recovery001',{status:'open',_links:{checkout:{href:'https://www.mollie.com/checkout/test-only-existing'}}});
  let response=await f.call(adoptionPath(id),{...payload,verification}),result=await response.json();assert.equal(response.status,200);assert.equal(result.orderState,'open');assert.equal(result.creditConfirmed,false);assert.deepEqual(await f.ledger(),[]);
  f.providerPayment(id);response=await f.call(adoptionPath(id),{...payload,verification});result=await response.json();assert.equal(response.status,200);assert.equal(result.replayed,true);assert.equal(result.creditConfirmed,true);assert.deepEqual((await f.ledger()).map(row=>row.delta),[500]);
  assert.ok(f.requests.every(req=>req.method==='GET'));
 }finally{await f.mf.dispose();}
});

test('a reconciliation outage keeps a verified provider ID and can recover that same payment without creating another',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload);f.providerPayment(id);let reads=0;f.setPaymentHook(()=>{if(++reads>1)throw Error('Lost read-only reconciliation response');});
  let response=await f.call(adoptionPath(id),{...payload,verification}),result=await response.json();assert.equal(response.status,200);assert.equal(result.linked,true);assert.equal(result.reconciled,false);assert.equal(result.creditConfirmed,false);assert.deepEqual(await f.ledger(),[]);
  assert.equal((await f.db.prepare('SELECT payment_id FROM rig_orders WHERE id=?').bind(id).first()).payment_id,payload.providerPaymentId);
  assert.equal((await f.caseFor('payment',id)).state,'unknown');
  f.setPaymentHook(null);response=await f.call(adoptionPath(id),{...payload,verification});result=await response.json();assert.equal(response.status,200);assert.equal(result.replayed,true);assert.equal(result.reconciled,true);assert.equal(result.creditConfirmed,true);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('a provider-confirmed refund reverses a prior credited purchase once and keeps the account under review',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload);f.providerPayment(id,'tr_Recovery001',{refunds:[{id:'re_Fixture001'}]});
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,500)').bind('credit:'+id,CUSTOMER,id).run();
  for(let i=0;i<2;i++){const response=await f.call(adoptionPath(id),{...payload,verification}),result=await response.json();assert.equal(response.status,200);assert.equal(result.creditConfirmed,false);assert.equal(result.orderState,'reversal_review');assert.equal(result.reviewRequired,true);}
  assert.deepEqual((await f.ledger()).map(row=>row.delta),[500,-500]);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_frozen_accounts').first()).n,1);assert.ok(f.requests.every(req=>req.method==='GET'));
 }finally{await f.mf.dispose();}
});

test('a case changed during provider verification cannot be adopted or logged as a successful mutation',async()=>{
 const f=await fixture();try{
  const id=await f.order(),item=await f.caseFor('payment',id),payload=adoption(item),verification=await adoptionProof(f,id,payload);f.providerPayment(id);
  f.setPaymentHook(()=>f.db.prepare("UPDATE rig_orders SET state='expired' WHERE id=?").bind(id).run());
  const response=await f.call(adoptionPath(id),{...payload,verification});assert.equal(response.status,409);assert.equal((await f.db.prepare('SELECT payment_id FROM rig_orders WHERE id=?').bind(id).first()).payment_id,null);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_recovery_events').first()).n,0);assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});
