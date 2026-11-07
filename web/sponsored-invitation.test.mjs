import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {Miniflare} from 'miniflare';
const alice='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
 const db=await mf.getD1Database('DB');
 for(const f of ['closed-payment-migrations/0001_test_baseline.sql','closed-payment-migrations/0005_sponsored_invitation.sql']){
  const sql=(await readFile(f,'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run();
 }
 return {mf,db};
}
async function job(db,user,amount){
 const id=crypto.randomUUID(),quote=crypto.randomUUID(),now=Date.now();
 await db.batch([
  db.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?, ?,?,'test',3,?,?)").bind(quote,user,'fixture','{}',amount,now+60000,now),
  db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,'submitting',?)").bind(id,user,quote,crypto.randomUUID(),amount,now),
  db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('reserve:'+id,user,-amount)
 ]);return id;
}
test('opaque voucher is hashed at rest and exactly one of two users can claim it',async()=>{
 const {mf,db}=await fixture();let now=100000;
 try{
  const store=createSponsoredInvitationStore(db,{clock:()=>now});const {code}=await store.issue({expiresAt:now+60000});
  assert.match(code,/^[A-Za-z0-9_-]{43}$/);const row=await db.prepare('SELECT * FROM rig_sponsored_invitation').first();assert.match(row.code_hash,/^[a-f0-9]{64}$/);assert.notEqual(row.code_hash,code);assert.equal(JSON.stringify(row).includes(code),false);
  await assert.rejects(store.issue({expiresAt:now+60000}));
  const results=await Promise.all([store.redeem(alice,code),store.redeem(bob,code)]);assert.equal(results.filter(x=>x.state==='redeemed').length,1);assert.equal(results.filter(x=>x.state==='unavailable').length,1);
  const winner=results[0].state==='redeemed'?alice:bob,loser=winner===alice?bob:alice;
  now+=120000;assert.deepEqual(await store.redeem(winner,code),{state:'redeemed',amountCents:500});assert.deepEqual(await store.redeem(loser,code),{state:'unavailable'});
  assert.deepEqual(await store.eligibility(winner),{state:'eligible',remainingCents:500});assert.equal((await store.eligibility(loser)).state,'unavailable');
  const credits=await db.prepare("SELECT user_id,delta FROM rig_ledger WHERE event_id='sponsored-invitation:1'").first();assert.equal(credits.user_id,winner);assert.equal(credits.delta,500);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
 }finally{await mf.dispose()}
});
test('expired, frozen and non-test redemptions fail closed without crediting the ledger',async()=>{
 const {mf,db}=await fixture();let now=100000;
 try{
  const store=createSponsoredInvitationStore(db,{clock:()=>now});const {code}=await store.issue({expiresAt:now+500});
  await db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?, 'fixture')").bind(alice).run();assert.equal((await store.redeem(alice,code)).state,'unavailable');
  now+=500;assert.equal((await store.redeem(bob,code)).state,'unavailable');assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  await db.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();now-=400;assert.equal((await store.redeem(bob,code)).state,'unavailable');
 }finally{await mf.dispose()}
});
test('only voucher recipient reserves owner job and concurrent outstanding reservations cannot exceed 500 cents',async()=>{
 const {mf,db}=await fixture();let now=100000;
 try{
  const store=createSponsoredInvitationStore(db,{clock:()=>now});const {code}=await store.issue({expiresAt:now+50000});await store.redeem(alice,code);
  const a=await job(db,alice,300),b=await job(db,alice,300),other=await job(db,bob,100);
  assert.equal((await store.reserveForJob(bob,other)).state,'unavailable');assert.equal((await store.reserveForJob(bob,a)).state,'unavailable');
  const results=await Promise.all([store.reserveForJob(alice,a),store.reserveForJob(alice,b)]);assert.equal(results.filter(x=>x.state==='reserved').length,1);
  const reserved=results[0].state==='reserved'?a:b;assert.deepEqual(await store.reserveForJob(alice,reserved),{state:'reserved',amountCents:300});
  assert.deepEqual(await store.eligibility(alice),{state:'eligible',remainingCents:200});
  await db.prepare("UPDATE rig_generation_jobs SET state='unknown' WHERE id=?").bind(reserved).run();now+=365*24*60*60*1000;
  assert.equal((await store.reserveForJob(alice,reserved===a?b:a)).state,'unavailable');assert.equal((await db.prepare('SELECT SUM(amount_cents) n FROM rig_sponsored_reservations').first()).n,300);
 }finally{await mf.dispose()}
});
test('only a verified pre-dispatch refund releases capacity, once; unknown or paid work remains reserved',async()=>{
 const {mf,db}=await fixture();let now=100000;
 try{
  const store=createSponsoredInvitationStore(db,{clock:()=>now});const {code}=await store.issue({expiresAt:now+50000});await store.redeem(alice,code);
  const first=await job(db,alice,300);assert.equal((await store.reserveForJob(alice,first)).state,'reserved');
  assert.equal((await store.releasePreparationFailure(alice,first)).state,'unavailable');
  assert.equal((await store.releasePreparationFailure(bob,first)).state,'unavailable');
  // A failed job without the matching, exact ledger refund remains locked.
  await db.prepare("UPDATE rig_generation_jobs SET state='failed',failure_code='preparation_failed' WHERE id=?").bind(first).run();
  assert.equal((await store.releasePreparationFailure(alice,first)).state,'unavailable');
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('release:'+first,alice,299).run();
  assert.equal((await store.releasePreparationFailure(alice,first)).state,'unavailable');
  await db.prepare('UPDATE rig_ledger SET delta=300 WHERE event_id=?').bind('release:'+first).run();
  await db.prepare("UPDATE rig_generation_jobs SET poll_token='dispatch-authorized' WHERE id=?").bind(first).run();
  assert.equal((await store.releasePreparationFailure(alice,first)).state,'unavailable');
  await db.prepare('DELETE FROM rig_ledger WHERE event_id=?').bind('release:'+first).run();
  await db.prepare('UPDATE rig_generation_jobs SET poll_token=NULL WHERE id=?').bind(first).run();
  await db.prepare("UPDATE rig_generation_jobs SET state='submitting',failure_code=NULL WHERE id=?").bind(first).run();
  const jobs=createD1GenerationStores(db,{mode:'test',dispatchMode:'sponsored'}).jobs;
  await jobs.markPreparationFailed(alice,first);
  const both=await Promise.all([store.releasePreparationFailure(alice,first),store.releasePreparationFailure(alice,first)]);
  assert.deepEqual(both,[{state:'released'},{state:'released'}]);assert.deepEqual(await store.eligibility(alice),{state:'eligible',remainingCents:500});
  assert.equal((await store.reserveForJob(alice,first)).state,'unavailable');
  const second=await job(db,alice,400);assert.equal((await store.reserveForJob(alice,second)).state,'reserved');
  await db.prepare("UPDATE rig_generation_jobs SET state='unknown' WHERE id=?").bind(second).run();
  assert.equal((await store.releasePreparationFailure(alice,second)).state,'unavailable');
  await db.prepare("UPDATE rig_generation_jobs SET state='failed',failure_code='provider_failed',fal_request_id='fal-id' WHERE id=?").bind(second).run();
  assert.equal((await store.releasePreparationFailure(alice,second)).state,'unavailable');assert.deepEqual(await store.eligibility(alice),{state:'eligible',remainingCents:100});
 }finally{await mf.dispose()}
});
