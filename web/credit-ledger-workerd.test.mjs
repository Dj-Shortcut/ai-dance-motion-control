// Local ephemeral workerd/D1 only: no provider requests or real money.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createD1GenerationStores} from './d1.mjs';
import {auditTestCreditLedger} from './credit-ledger-audit.mjs';
import {Miniflare} from 'miniflare';
const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
const db=await mf.getD1Database('DB');
const sql=(await readFile(new URL('./cloudflare-migrations/0001_test_baseline.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');
for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
after(async()=>mf.dispose());
const stores=createD1GenerationStores(db,{mode:'test'});
async function fund(user,amount=200){await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind(`fund:${user}`,user,amount).run()}
async function quote(user,price=150){return stores.quotes.create({userId:user,model:'fixture',input:{},priceCents:price,pricingVersion:'test',durationSeconds:3})}
async function begin(user,q,key,price=150){return stores.jobs.begin({userId:user,quoteId:q.id,idempotencyKey:key,quote:{priceCents:price}})}
async function entries(id){return (await db.prepare('SELECT event_id,delta FROM rig_ledger WHERE event_id IN (?,?,?) ORDER BY event_id').bind(`reserve:${id}`,`release:${id}`,`settle:${id}`).all()).results}

test('parallel repeated intent reserves once, distinct quotes cannot overspend',async()=>{
 await fund('raceA');const q=await quote('raceA');
 const same=await Promise.all([begin('raceA',q,'same'),begin('raceA',q,'same')]);
 assert.deepEqual(same.map(x=>x.kind).sort(),['created','existing']);
 assert.equal(same[0].job.id,same[1].job.id);assert.equal((await entries(same[0].job.id)).length,1);
 await fund('raceB');const a=await quote('raceB'),b=await quote('raceB');
 const different=await Promise.all([begin('raceB',a,'first'),begin('raceB',b,'second')]);
 assert.equal(different.filter(x=>x.kind==='created').length,1);
 assert.equal((await db.prepare('SELECT SUM(delta) AS n FROM rig_ledger WHERE user_id=?').bind('raceB').first()).n,50);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rig_generation_jobs WHERE user_id=?').bind('raceB').first()).n,1);
});

test('atomic batch failure cannot leave an orphan reservation',async()=>{
 await fund('outage');const q=await quote('outage');
 const failing={prepare:q=>db.prepare(q),batch:async statements=>db.batch([statements[0],db.prepare('INSERT INTO nonexistent_failure_table VALUES(1)')])};
 const broken=createD1GenerationStores(failing,{mode:'test'});
 await assert.rejects(broken.jobs.begin({userId:'outage',quoteId:q.id,idempotencyKey:'break',quote:{priceCents:150}}));
 assert.equal((await db.prepare('SELECT SUM(delta) AS n FROM rig_ledger WHERE user_id=?').bind('outage').first()).n,200);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rig_generation_jobs WHERE user_id=?').bind('outage').first()).n,0);
});

test('lost database response after commit recovers the same reservation and one release',async()=>{
 await fund('lost');const q=await quote('lost');let lose=true;
 const intermittent={prepare:q=>db.prepare(q),batch:async statements=>{const result=await db.batch(statements);if(lose){lose=false;throw Error('Simulated lost reply')}return result}};
 const flaky=createD1GenerationStores(intermittent,{mode:'test'});
 await assert.rejects(flaky.jobs.begin({userId:'lost',quoteId:q.id,idempotencyKey:'attempt',quote:{priceCents:150}}));
 const recovered=await begin('lost',q,'attempt');assert.equal(recovered.kind,'existing');
 assert.deepEqual((await entries(recovered.job.id)).map(x=>Number(x.delta)),[-150]);
 assert.equal(await stores.jobs.authorizeDispatch('lost',recovered.job.id),true);await stores.jobs.markSubmitted('lost',recovered.job.id,'request-lost');
 const claim=await stores.jobs.claimPoll('lost',recovered.job.id);lose=true;
 await assert.rejects(flaky.jobs.markProviderFailed('lost',recovered.job.id,'request-lost',claim.token));
 await stores.jobs.markProviderFailed('lost',recovered.job.id,'request-lost',claim.token);
 assert.deepEqual((await entries(recovered.job.id)).map(x=>Number(x.delta)).sort((a,b)=>a-b),[-150,150]);
});

test('explicit failure releases only once, ambiguous submission stays reserved',async()=>{
 await fund('refund');const q=await quote('refund');const {job}=await begin('refund',q,'attempt');
 await Promise.all([stores.jobs.markPreparationFailed('refund',job.id),stores.jobs.markPreparationFailed('refund',job.id)]);
 assert.deepEqual((await entries(job.id)).map(x=>Number(x.delta)).sort((a,b)=>a-b),[-150,150]);
 await assert.rejects(stores.jobs.markSubmitted('refund',job.id,'request-valid'));
 await fund('ambiguous');const q2=await quote('ambiguous');const j2=(await begin('ambiguous',q2,'attempt')).job;
 await stores.jobs.markUnknown('ambiguous',j2.id);
 await assert.rejects(stores.jobs.markPreparationFailed('ambiguous',j2.id));
 assert.deepEqual((await entries(j2.id)).map(x=>Number(x.delta)),[-150]);
 assert.deepEqual((await auditTestCreditLedger({db,user:'ambiguous'})).findings[0].problems,['outcome_requires_review']);
});
test('generic refund confirmation reads exact owned ledger proof without creating or releasing credit',async()=>{
 const user='generic-proof';await fund(user);const q=await quote(user),{job}=await begin(user,q,'attempt');
 assert.equal(await stores.jobs.authorizeDispatch(user,job.id),true);await stores.jobs.markSubmitted(user,job.id,'generic-request');
 assert.equal(await stores.jobs.confirmFailureRefund(user,job.id,'generic-request'),false);
 const claim=await stores.jobs.claimPoll(user,job.id);await stores.jobs.markProviderFailed(user,job.id,'generic-request',claim.token);
 const before=await entries(job.id);
 assert.equal(await stores.jobs.confirmFailureRefund(user,job.id,'generic-request'),true);
 assert.equal(await stores.jobs.confirmFailureRefund('another-owner',job.id,'generic-request'),false);
 assert.equal(await stores.jobs.confirmFailureRefund(user,job.id,'wrong-request'),false);
 assert.deepEqual(await entries(job.id),before);
 await db.prepare('UPDATE rig_ledger SET delta=1 WHERE event_id=?').bind(`release:${job.id}`).run();
 assert.equal(await stores.jobs.confirmFailureRefund(user,job.id,'generic-request'),false);
 await db.prepare('UPDATE rig_ledger SET delta=150 WHERE event_id=?').bind(`release:${job.id}`).run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,0)').bind(`settle:${job.id}`,user).run();
 assert.equal(await stores.jobs.confirmFailureRefund(user,job.id,'generic-request'),false);
 const prepUser='prep-proof';await fund(prepUser);const prep=(await begin(prepUser,await quote(prepUser),'attempt')).job;
 await stores.jobs.markPreparationFailed(prepUser,prep.id);assert.equal(await stores.jobs.confirmFailureRefund(prepUser,prep.id,null),true);
});

test('racing success and failure settle or release once, never both',async()=>{
 await fund('settle');const q=await quote('settle');const {job}=await begin('settle',q,'attempt');
 assert.equal(await stores.jobs.authorizeDispatch('settle',job.id),true);await stores.jobs.markSubmitted('settle',job.id,'request-ok');
 const claim=await stores.jobs.claimPoll('settle',job.id);assert.equal(claim.kind,'acquired');
 await Promise.allSettled([stores.jobs.markCompleted('settle',job.id,'request-ok',`rig-results/${job.id}.mp4`,claim.token),stores.jobs.markProviderFailed('settle',job.id,'request-ok',claim.token)]);
 const jobResult=await stores.jobs.getOwned('settle',job.id),rows=await entries(job.id);
 assert.ok(['completed','failed'].includes(jobResult.state));
 assert.equal(rows.filter(x=>x.event_id.startsWith('settle:')).length+(rows.filter(x=>x.event_id.startsWith('release:')).length),1);
 assert.equal((await auditTestCreditLedger({db,user:'settle'})).findings.length,0);
});

test('freezing before the atomic dispatch decision prevents submission and allows one release',async()=>{
 await fund('frozen');const q=await quote('frozen');const {job}=await begin('frozen',q,'attempt');
 await db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind('frozen','fixture').run();
 assert.equal(await stores.jobs.authorizeDispatch('frozen',job.id),false);
 await assert.rejects(stores.jobs.markSubmitted('frozen',job.id,'request-should-not-exist'));
 await stores.jobs.markPreparationFailed('frozen',job.id);
 assert.deepEqual((await entries(job.id)).map(x=>Number(x.delta)).sort((a,b)=>a-b),[-150,150]);
});

test('a dispatch decision that wins a freeze remains reserved and cannot authorize twice',async()=>{
 await fund('already-authorized');const q=await quote('already-authorized');const {job}=await begin('already-authorized',q,'attempt');
 assert.equal(await stores.jobs.authorizeDispatch('already-authorized',job.id),true);
 await db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind('already-authorized','fixture').run();
 assert.equal(await stores.jobs.authorizeDispatch('already-authorized',job.id),false);
 await assert.rejects(stores.jobs.markPreparationFailed('already-authorized',job.id));
 assert.deepEqual((await entries(job.id)).map(x=>Number(x.delta)),[-150]);
 // The external POST can still happen after the freeze when authorization won.
 await stores.jobs.markSubmitted('already-authorized',job.id,'request-authorized');
});

test('releasing a poll lease cannot erase a dispatch marker or allow a refund',async()=>{
 await fund('marker');const q=await quote('marker');const {job}=await begin('marker',q,'attempt');
 assert.equal(await stores.jobs.authorizeDispatch('marker',job.id),true);
 await assert.rejects(stores.jobs.releasePoll('marker',job.id,'dispatch-authorized'));
 await stores.jobs.releasePoll('marker',job.id,crypto.randomUUID());
 const before=await db.prepare('SELECT state,poll_token FROM rig_generation_jobs WHERE id=?').bind(job.id).first();
 assert.equal(before.state,'submitting');assert.equal(before.poll_token,'dispatch-authorized');
 await assert.rejects(stores.jobs.markPreparationFailed('marker',job.id));
 assert.deepEqual((await entries(job.id)).map(x=>Number(x.delta)),[-150]);
 await stores.jobs.markSubmitted('marker',job.id,'request-ok');
 const claim=await stores.jobs.claimPoll('marker',job.id);assert.equal(claim.kind,'acquired');
 await stores.jobs.releasePoll('marker',job.id,claim.token);
 assert.equal((await db.prepare('SELECT poll_token FROM rig_generation_jobs WHERE id=?').bind(job.id).first()).poll_token,null);
 await fund('notqueued');const q2=await quote('notqueued');const j2=(await begin('notqueued',q2,'attempt')).job,token=crypto.randomUUID();
 await db.prepare('UPDATE rig_generation_jobs SET poll_token=? WHERE id=?').bind(token,j2.id).run();
 await stores.jobs.releasePoll('notqueued',j2.id,token);
 assert.equal((await db.prepare('SELECT poll_token FROM rig_generation_jobs WHERE id=?').bind(j2.id).first()).poll_token,token);
});

test('concurrent freeze and dispatch decision serialize without releasing an authorized attempt',async()=>{
 await fund('freeze-race');const q=await quote('freeze-race');const {job}=await begin('freeze-race',q,'attempt');
 const [authorized]=await Promise.all([stores.jobs.authorizeDispatch('freeze-race',job.id),db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind('freeze-race','fixture').run()]);
 assert.equal(typeof authorized,'boolean');
 if(authorized)await assert.rejects(stores.jobs.markPreparationFailed('freeze-race',job.id));
 else await stores.jobs.markPreparationFailed('freeze-race',job.id);
 const rows=await entries(job.id);
 assert.equal(rows.filter(x=>x.event_id.startsWith('release:')).length,authorized?0:1);
});

test('audit reports corrupt and orphan records without repairing them and rejects live database',async()=>{
 await fund('corrupt');const q=await quote('corrupt');const {job}=await begin('corrupt',q,'attempt');
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('reserve:orphan','corrupt',-1).run();
 await db.prepare('DELETE FROM rig_ledger WHERE event_id=?').bind(`reserve:${job.id}`).run();
 const report=await auditTestCreditLedger({db,user:'corrupt'});
 assert.ok(report.findings[0].problems.includes('invalid_reservation'));
 assert.deepEqual(report.orphanedEntries,['reserve:orphan']);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE user_id=?').bind('corrupt').first()).n,2);
 await db.prepare("UPDATE rig_payment_environment SET mode='live' WHERE id=1").run();
 await assert.rejects(auditTestCreditLedger({db,user:'corrupt'}));
 await assert.rejects(stores.jobs.markSubmitted('corrupt',job.id,'provider'));
 await db.prepare("UPDATE rig_payment_environment SET mode='test' WHERE id=1").run();
});
test('real D1 isolates a proven subject failure by owner and immutable image and rejects stale motion reservations atomically',async()=>{
 const user='subject-owner',other='subject-other',sha='a'.repeat(64),changed='b'.repeat(64),image='image',video='video';
 const input=(hash,quality)=>({data:{imageId:image,videoId:video,quality},refs:[{id:image,kind:'image',sha256:hash},{id:video,kind:'video',sha256:'c'.repeat(64)}]});
 const createQuote=async(u,quality,hash=sha)=>{const model=quality==='edit-standard'?'fal-ai/kling-video/o3/standard/video-to-video/edit':`fal-ai/kling-video/v3/${quality}/motion-control`,body=input(hash,quality);const q=await stores.quotes.create({userId:u,model,input:body,priceCents:125,pricingVersion:'test',durationSeconds:5});return {...q,model,input:body,priceCents:125}};
 await fund(user,500);await fund(other,500);
 const standard=await createQuote(user,'standard'),pro=await createQuote(user,'pro'),o3=await createQuote(user,'edit-standard'),different=await createQuote(other,'pro');
 const rejected=await createQuote(user,'pro');
 await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,failure_code,created_at) VALUES(?,?,?,?,125,'failed','known-request','provider_subject_not_detected',?)").bind('subject-failed',user,rejected.id,'old',Date.now()).run();
 assert.equal(await stores.jobs.hasKnownSubjectRejection(user,sha),true);assert.equal(await stores.jobs.hasKnownSubjectRejection(user,changed),false);assert.equal(await stores.jobs.hasKnownSubjectRejection(other,sha),false);
 for(const q of [standard,pro])assert.equal((await stores.jobs.begin({userId:user,quoteId:q.id,idempotencyKey:'attempt-'+q.input.data.quality,quote:q})).kind,'subject_rejected');
 assert.equal((await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(user).first()).n,500);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_generation_jobs WHERE user_id=? AND state='submitting'").bind(user).first()).n,0);
 assert.equal((await stores.jobs.begin({userId:user,quoteId:o3.id,idempotencyKey:'edit',quote:o3})).kind,'created');
 assert.equal((await stores.jobs.begin({userId:other,quoteId:different.id,idempotencyKey:'other',quote:different})).kind,'created');
});
