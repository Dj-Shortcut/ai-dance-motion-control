// Isolated D1 and synthetic provider replies. No real provider/account calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {prepareFundingAdmission,readFundingCoverage} from './funding-coverage.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const pkg={id:'five',amountCents:500,credits:500},now=()=>Date.now();
async function fixture({enabled=true,flag=true,balance=100,response,oldSchema=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 const source=await readFile(new URL('./production-schema.sql',import.meta.url),'utf8'),schema=(oldSchema?source.split('-- Generation workflow foundation v2 (inactive until separately integrated).')[0]:source).replace(/^\s*--.*$/gm,'');for(const s of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 const migration=(await readFile(new URL('./production-migrations/0015_funding_coverage.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,''),[tables,...triggers]=migration.split('CREATE TRIGGER');
 for(const s of tables.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();for(const trigger of triggers)await db.prepare('CREATE TRIGGER'+trigger).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 if(enabled)await db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
 const env={DB:db,FAL_KEY:'same-generation-fixture-key',...(flag?{RIG_FUNDING_COVERAGE_ENABLED:'yes'}:{})},calls=[];
 const network=async(url,init)=>{assert.equal(url,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).get('Authorization'),'Key '+env.FAL_KEY);assert.equal(init.body,undefined);calls.push({url,method:init.method});return response?response(init):Response.json({username:'fixture-team',credits:{current_balance:balance,currency:'USD'}});};
 const args=(user=USER)=>({userId:user,orderId:crypto.randomUUID(),requestId:crypto.randomUUID(),pkg,network,now:now()});
 const prepare=a=>prepareFundingAdmission(env,a??args());
 async function insert(a,admission){return db.batch([...admission.before,db.prepare(`INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits) SELECT ?,?,?,?,?,? WHERE ${admission.gate.sql}`).bind(a.orderId,a.userId,a.requestId,a.pkg.id,a.pkg.amountCents,a.pkg.credits,...admission.gate.params)]);}
 const read=options=>readFundingCoverage(env,{network,now:now(),...options});
 return {mf,db,env,calls,network,args,prepare,insert,read};
}
async function seedOrder(db,{state='open',user='u-'+crypto.randomUUID(),credits=500,credited=false}={}){
 const id=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,state) VALUES(?,?,?,?,?,?,?)').bind(id,user,crypto.randomUUID(),'five',500,credits,state).run();
 if(credited)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,?)').bind('credit:'+id,user,id,credits).run();return {id,user};
}
async function seedCost(db,{state,usd,ageMinutes=0,ownerUsage=false}={}){
 const id=crypto.randomUUID(),q=crypto.randomUUID(),at=now()-ageMinutes*60000;
 await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(q,USER,'fixture','{}',100,'fixture-v1',5,now()+60000,at).run();
 await db.prepare('INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at,finalized_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,USER,q,crypto.randomUUID(),100,state,at,['completed','failed'].includes(state)?at:null).run();
 await db.prepare('INSERT INTO rig_generation_costs(job_id,quote_id,user_id,funding_kind,provider_estimate_usd_micros,budget_day,authorized_at,snapshot_json) VALUES(?,?,?,?,?,?,?,?)').bind(id,q,USER,'credits',usd,'fixture-day',at,'{}').run();
 if(ownerUsage)await db.prepare("INSERT INTO rig_owner_provider_usage(job_id,quote_id,user_id,estimated_usd_micros,state,created_at) VALUES(?,?,?,?,'authorized',?)").bind(id,q,USER,usd,at).run();return id;
}
test('migration is disabled and new production admission refuses disabled or missing setup without any Fal call',async()=>{
 for(const options of [{enabled:false},{flag:false}]){const f=await fixture(options);try{
  await assert.rejects(f.prepare(),error=>error.code==='funding_setup'&&error.status===503);assert.equal(f.calls.length,0);
  const status=await f.read();assert.equal(status.status,'setup');assert.equal(status.enabled,false);assert.equal(status.reason,'funding_setup');assert.equal(f.calls.length,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.mf.dispose()}}
});
test('one exact account/key-bound billing read rounds USD down, derives a conservative integer ratio and exposes no credential or account identity',async()=>{
 const f=await fixture({balance:20.0000009});try{
  const status=await f.read();assert.equal(status.status,'ready');assert.equal(status.availableUsdMicros,20000000);assert.equal(status.usdMicrosPerEuroCent,4508);assert.equal(status.bufferUsdMicros,6000000);assert.equal(status.requiredUsdMicros,6000000);assert.equal(status.providerBalanceAsOf,null);
  assert.equal(status.newCreditCapacityCents,Math.floor(14000000/4508));assert.doesNotMatch(JSON.stringify(status),/fixture-team|same-generation-fixture-key|Authorization/);
  await Promise.all([f.prepare(f.args(USER)),f.prepare(f.args(OTHER))]);assert.equal(f.calls.length,1,'concurrent/read-followed admission reuses only the same short account/key/policy-bound observation');
 }finally{await f.mf.dispose()}
});
test('SQL exposure includes positive wallets, unresolved holds, all payable orders and delayed/uncertain Fal debits without duplicating credited orders',async()=>{
 const f=await fixture({enabled:false,balance:100});try{
  await seedOrder(f.db,{state:'paid',credited:true});
  await seedOrder(f.db,{state:'open',credited:true});
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('negative-wallet','negative-owner',-10000).run();
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('positive-hold-wallet','hold-owner',500).run();
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('reserve:held-job','hold-owner',-200).run();
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,0)').bind('settle:held-job','different-owner').run();
  for(const state of ['creating','open','unknown','paid','credit_pending_review'])await seedOrder(f.db,{state});
  for(const state of ['failed','expired','canceled','reversal_review'])await seedOrder(f.db,{state});
  await seedCost(f.db,{state:'completed',usd:1000000,ageMinutes:5});await seedCost(f.db,{state:'failed',usd:2000000,ageMinutes:5});
  await seedCost(f.db,{state:'unknown',usd:3000000,ageMinutes:120,ownerUsage:true});await seedCost(f.db,{state:'submitting',usd:4000000,ageMinutes:120});await seedCost(f.db,{state:'queued',usd:5000000,ageMinutes:120});await seedCost(f.db,{state:'completed',usd:6000000,ageMinutes:120});
  const ownerQuote=crypto.randomUUID(),ownerJob=crypto.randomUUID();
  await f.db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,funding_kind,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}','owner-provider',100,'fixture-v1',5,?,?)").bind(ownerQuote,USER,'fixture',now()+60000,now()).run();
  await f.db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,100,'submitting',?)").bind(ownerJob,USER,ownerQuote,crypto.randomUUID(),now()).run();
  await f.db.prepare("INSERT INTO rig_owner_provider_usage(job_id,quote_id,user_id,estimated_usd_micros,state,created_at) VALUES(?,?,?,6000000,'authorized',?)").bind(ownerJob,ownerQuote,USER,now()).run();
  await f.db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
  const status=await f.read();assert.equal(status.positiveWalletCents,1300);assert.equal(status.heldRetailCents,200);assert.equal(status.payableOrderCents,2500);assert.equal(status.retailLiabilityCents,4000);assert.equal(status.providerReservedUsdMicros,21000000);assert.equal(status.requiredUsdMicros,45032000);assert.equal(status.headroomUsdMicros,54968000);
 }finally{await f.mf.dispose()}
});
test('two parallel customers cannot sell the same provider stock: exposure is recomputed inside each actual D1 order transaction',async()=>{
 const f=await fixture({balance:9});try{
  const a=f.args(USER),b=f.args(OTHER),prepared=await Promise.all([f.prepare(a),f.prepare(b)]);assert.equal(f.calls.length,1);
  const outcomes=await Promise.all([f.insert(a,prepared[0]),f.insert(b,prepared[1])]);assert.deepEqual(outcomes.map(x=>x.at(-1).meta.changes).sort(),[0,1]);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  const status=await f.read();assert.equal(status.payableOrderCents,500);assert.equal(status.requiredUsdMicros,8254000);
  await assert.rejects(f.prepare(f.args('u-'+crypto.randomUUID())),error=>error.code==='funding_capacity');
 }finally{await f.mf.dispose()}
});
test('an old authorization that completes now, or has no proven completion time, never releases its reserve immediately',async()=>{
 const f=await fixture({enabled:false});try{
  const recent=await seedCost(f.db,{state:'completed',usd:1000000,ageMinutes:120}),unknownFinal=await seedCost(f.db,{state:'failed',usd:2000000,ageMinutes:120});
  await f.db.prepare('UPDATE rig_generation_jobs SET finalized_at=? WHERE id=?').bind(now(),recent).run();
  await f.db.prepare('UPDATE rig_generation_jobs SET finalized_at=NULL WHERE id=?').bind(unknownFinal).run();
  await seedCost(f.db,{state:'completed',usd:4000000,ageMinutes:120});
  assert.equal((await f.db.prepare('SELECT provider_reserved_usd_micros n FROM rig_funding_exposure').first()).n,3000000);
  await f.db.prepare('UPDATE rig_generation_jobs SET finalized_at=? WHERE id IN (?,?)').bind(now()-120*60000,recent,unknownFinal).run();
  assert.equal((await f.db.prepare('SELECT provider_reserved_usd_micros n FROM rig_funding_exposure').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('funding migration and atomic sales admission work without the optional workflow migration, using whole confirmed quote plans',async()=>{
 const f=await fixture({enabled:false,oldSchema:true});try{
  assert.equal(await f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rig_generation_workflows'").first(),null);
  const id=await seedCost(f.db,{state:'completed',usd:100000,ageMinutes:120});
  await f.db.prepare('UPDATE rig_generation_quotes SET input_json=? WHERE id=(SELECT quote_id FROM rig_generation_jobs WHERE id=?)').bind(JSON.stringify({providerEstimateUsdMicros:600000,workflow:{steps:[{providerEstimateUsdMicros:200000},{providerEstimateUsdMicros:500000}]}}),id).run();
  assert.equal((await f.db.prepare('SELECT provider_reserved_usd_micros n FROM rig_funding_exposure').first()).n,700000,'an unsettled terminal workflow retains its whole plan, even if its old journal or aggregate is smaller');
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,0)').bind('settle:'+id,OTHER).run();
  assert.equal((await f.db.prepare('SELECT provider_reserved_usd_micros n FROM rig_funding_exposure').first()).n,700000,'another account cannot finalize this job');
  await f.db.prepare('UPDATE rig_ledger SET user_id=? WHERE event_id=?').bind(USER,'settle:'+id).run();
  assert.equal((await f.db.prepare('SELECT provider_reserved_usd_micros n FROM rig_funding_exposure').first()).n,0);
  await seedOrder(f.db,{state:'failed'});
  await f.db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
  const a=f.args(),prepared=await f.prepare(a);assert.equal((await f.insert(a,prepared)).at(-1).meta.changes,1);
  assert.equal((await f.read()).status,'ready');
 }finally{await f.mf.dispose()}
});
test('activated policy makes a legacy insertion fail closed, while disabled migration and existing-order reconciliation remain untouched',async()=>{
 const f=await fixture({enabled:false});try{
  const old=await seedOrder(f.db,{state:'open'});await f.db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
  await assert.rejects(seedOrder(f.db),/RIG_FUNDING_COVERAGE_REQUIRED/);
  await f.db.batch([f.db.prepare("UPDATE rig_orders SET state='paid' WHERE id=?").bind(old.id),f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,500)').bind('credit:'+old.id,old.user,old.id)]);
  assert.equal((await f.db.prepare('SELECT SUM(delta) balance FROM rig_ledger WHERE user_id=?').bind(old.user).first()).balance,500);
 }finally{await f.mf.dispose()}
});
test('changing any finance field or funding policy between account read and order insertion invalidates the admission',async()=>{
 const f=await fixture({balance:1000});try{
  for(const column of ['eur_per_usd_micros','provider_vat_bps','payment_fee_bps','failure_buffer_bps','preparation_cents','min_margin_bps','daily_provider_limit_usd_micros','min_price_cents','min_pro_price_cents']){
   const a=f.args(),prepared=await f.prepare(a);await f.db.prepare(`UPDATE rig_finance_policy SET ${column}=${column}+1 WHERE id=1`).run();
   assert.equal((await f.insert(a,prepared)).at(-1).meta.changes,0,column+' cannot change after the bound balance observation');await f.db.prepare(`UPDATE rig_finance_policy SET ${column}=${column}-1 WHERE id=1`).run();
  }
  for(const change of ["version='different-funding'","expected_username='different-account'","buffer_usd_micros=7000000","max_snapshot_age_ms=30000"]){const a=f.args(),prepared=await f.prepare(a);await f.db.prepare('UPDATE rig_funding_policy SET '+change+' WHERE id=1').run();assert.equal((await f.insert(a,prepared)).at(-1).meta.changes,0);await f.db.prepare("UPDATE rig_funding_policy SET version='rig-funding-v1',expected_username='fixture-team',buffer_usd_micros=6000000,max_snapshot_age_ms=60000 WHERE id=1").run();}
  const a=f.args(),prepared=await f.prepare(a);await f.db.prepare("UPDATE rig_finance_policy SET version='different-finance' WHERE id=1").run();assert.equal((await f.insert(a,prepared)).at(-1).meta.changes,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('expired observations and order identity/package substitutions cannot cross the insertion gate',async()=>{
 const f=await fixture();try{
  const a=f.args(),stale=await f.prepare({...a,now:now()-120000});assert.equal((await f.insert(a,stale)).at(-1).meta.changes,0);
  for(const substitute of [{userId:OTHER},{orderId:crypto.randomUUID()},{requestId:crypto.randomUUID()},{pkg:{...pkg,credits:1000}},{pkg:{...pkg,amountCents:1000}},{pkg:{...pkg,id:'other'}}]){
   const original=f.args(),prepared=await f.prepare(original);await assert.rejects(f.insert({...original,...substitute},prepared),/RIG_FUNDING_COVERAGE_REQUIRED/);
  }
 }finally{await f.mf.dispose()}
});
test('wrong account, currency, permission, redirect, malformed amount/body and oversized data refuse without leaking provider text',async()=>{
 const replies=[()=>Response.json({username:'another-team',credits:{current_balance:100,currency:'USD'}}),()=>Response.json({username:'fixture-team',credits:{current_balance:100,currency:'EUR'}}),()=>Response.json({error:'same-generation-fixture-key'},{status:403}),()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid'}}),()=>Response.json({username:'fixture-team',credits:{current_balance:'100',currency:'USD'}}),()=>Response.json({username:'fixture-team',credits:{current_balance:-1,currency:'USD'}}),()=>new Response('{"username":',{headers:{'content-type':'application/json'}}),()=>Response.json({padding:'x'.repeat(17000)})];
 for(const response of replies){const f=await fixture({response});try{await assert.rejects(f.prepare(),error=>error.code==='funding_unavailable'&&!error.message.includes('same-generation-fixture-key'));assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_funding_snapshots').first()).n,0);}finally{await f.mf.dispose()}}
});
test('a stalled provider stream has a finite deadline and is canceled without ever admitting a sale',async()=>{
 let canceled=false;const f=await fixture({response:()=>new Response(new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled=true}}),{headers:{'content-type':'application/json'}})});try{
  await assert.rejects(f.prepare(),error=>error.code==='funding_unavailable');assert.equal(canceled,true);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
 }finally{await f.mf.dispose()}
});
