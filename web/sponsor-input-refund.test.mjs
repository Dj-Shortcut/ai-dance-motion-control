import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';import {createD1GenerationStores} from './d1.mjs';
import {Miniflare} from 'miniflare';
const owner='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='u-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const job='11111111-1111-4111-8111-111111111111',job2='22222222-2222-4222-8222-222222222222',job3='33333333-3333-4333-8333-333333333333',fal='request-123';
async function migrate(db,file){const sql=(await readFile(file,'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
test('D1 sponsor input rejection releases exact ledger and allowance once; ambiguous or generic failures stay locked',async()=>{
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response()}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'sponsor-input-refund'}});
 try{
  const db=await mf.getD1Database('DB');for(const f of ['0001_test_baseline.sql','0005_sponsored_invitation.sql'])await migrate(db,`closed-payment-migrations/${f}`);
  const store=createSponsoredInvitationStore(db),code=(await store.issue({expiresAt:Date.now()+60000})).code;assert.equal((await store.redeem(owner,code)).state,'redeemed');
  async function make(id,req){const now=Date.now();await db.prepare('INSERT INTO rig_generation_quotes VALUES(?,?,?,?,?,?,?,?,?)').bind(`q-${id}`,owner,'model','{}',100,'v1',5,now+60000,now).run();await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,created_at) VALUES(?,?,?,?,?,'queued',?,?)").bind(id,owner,`q-${id}`,`key-${id}`,100,req,now).run();await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind(`reserve:${id}`,owner,-100).run();await db.prepare('INSERT INTO rig_sponsored_reservations(job_id,user_id,amount_cents,created_at) VALUES(?,?,?,?)').bind(id,owner,100,now).run()}
  const jobs=createD1GenerationStores(db,{mode:'test',dispatchMode:'sponsored'}).jobs;await make(job,fal);
  assert.deepEqual(await store.eligibility(owner),{state:'eligible',remainingCents:400});
  assert.equal((await store.releaseInputFailure(owner,job,fal)).state,'unavailable');
  let lease=await jobs.claimPoll(owner,job);assert.equal(lease.kind,'acquired');
  let failed=await jobs.markProviderFailed(owner,job,fal,lease.token,'provider_input_unavailable');assert.equal(failed.failureCode,'provider_input_unavailable');
  assert.equal((await db.prepare("SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?").bind(owner).first()).n,500);
  assert.equal((await store.releaseInputFailure(other,job,fal)).state,'unavailable');assert.equal((await store.releaseInputFailure(owner,job,'wrong-request')).state,'unavailable');
  assert.ok((await Promise.all([store.releaseInputFailure(owner,job,fal),store.releaseInputFailure(owner,job,fal)])).every(x=>x.state==='released'));
  assert.equal(await jobs.confirmInputFailureRefund(owner,job,fal),true);assert.deepEqual(await store.eligibility(owner),{state:'eligible',remainingCents:500});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?').bind(`release:${job}`).first()).n,1);
  await make(job2,'generic-123');lease=await jobs.claimPoll(owner,job2);failed=await jobs.markProviderFailed(owner,job2,'generic-123',lease.token);assert.equal(failed.failureCode,'provider_failed');
  assert.equal((await store.releaseInputFailure(owner,job2,'generic-123')).state,'unavailable');assert.equal(await jobs.confirmInputFailureRefund(owner,job2,'generic-123'),false);assert.deepEqual(await store.eligibility(owner),{state:'eligible',remainingCents:400});
  await make(job3,'subject-123');lease=await jobs.claimPoll(owner,job3);failed=await jobs.markProviderFailed(owner,job3,'subject-123',lease.token,'provider_subject_not_detected');assert.equal(failed.failureCode,'provider_subject_not_detected');
  assert.equal(await jobs.confirmInputFailureRefund(owner,job3,'subject-123'),true);assert.equal((await store.releaseInputFailure(owner,job3,'wrong')).state,'unavailable');
  assert.ok((await Promise.all([store.releaseInputFailure(owner,job3,'subject-123'),store.releaseInputFailure(owner,job3,'subject-123')])).every(x=>x.state==='released'));
  assert.deepEqual(await store.eligibility(owner),{state:'eligible',remainingCents:400});assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?').bind(`release:${job3}`).first()).n,1);
 }finally{await mf.dispose()}
});
