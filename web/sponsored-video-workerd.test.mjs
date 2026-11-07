import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {build} from 'esbuild';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';import {createD1GenerationStores} from './d1.mjs';
import {Miniflare} from 'miniflare';
const origin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',tester='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='u-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function migrate(db,file){const sql=(await readFile(file,'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
test('one authenticated invitee is bounded by 500 cents through the actual private video worker',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.sponsor-video-'));let mf;
 try{
  for(const [input,out] of [['sponsored-video-workerd-fixture.mjs','main.mjs'],['cloud-media-workerd-fixture.mjs','media.mjs']])await build({entryPoints:[input],outfile:join(dir,out),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  const identity=`export default {fetch(req){const a=req.headers.get('authorization');const id=a==='Bearer a.b.c'?'${owner}':a==='Bearer d.e.f'?'${tester}':a==='Bearer g.h.i'?'${other}':null;return id?Response.json({userId:id}):new Response(null,{status:401})}}`;
  const vars={LOCAL_FIXTURE:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_TEST_ENVIRONMENT_ID:'closed-test-1',SUPABASE_URL:project,RIG_VIDEO_OWNER_USER_ID:owner,RIG_SPONSORED_ENABLED:'yes',RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fake-no-network',RIG_PRICE_STANDARD:'25',RIG_PRICE_PRO:'50',RIG_PRICE_VERSION:'fixture-1',RIG_CLOSED_VIDEO_MAX_CENTS:'300',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'500000'};
  mf=new Miniflare({cf:false,workers:[{name:'main',modules:true,scriptPath:join(dir,'main.mjs'),compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'closed-video'},r2Buckets:{BUCKET:'closed-video'},serviceBindings:{CLOSED_IDENTITY_SERVICE:'identity',RIG_MEDIA:'media'}},{name:'identity',modules:true,script:identity,compatibilityDate:'2026-01-01'},{name:'media',modules:true,scriptPath:join(dir,'media.mjs'),compatibilityDate:'2026-01-01',r2Buckets:{BUCKET:'closed-video'}}]});
  const db=await mf.getD1Database('DB','main');for(const file of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql','0005_sponsored_invitation.sql'])await migrate(db,`closed-payment-migrations/${file}`);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-test-1','test',origin,project,'','').run();
  for(const user of [owner,tester,other])await db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(`${project}/auth/v1`,user.slice(2),user).run();
  await db.prepare('CREATE TABLE rig_fixture_trace(event TEXT)').run();await db.prepare('CREATE TABLE rig_fixture_fal_dispatch(id TEXT PRIMARY KEY)').run();await db.prepare('CREATE TABLE rig_fixture_fal_mode(id INTEGER PRIMARY KEY,mode TEXT NOT NULL)').run();await db.prepare("INSERT INTO rig_fixture_fal_mode VALUES(1,'ok')").run();
  await db.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',Date.now()).run();
  await db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('other-fake-funds',?,1000),('tester-extra-fake-funds',?,1000)").bind(other,tester).run();
  const send=(path,token='d.e.f',opts={})=>mf.dispatchFetch(origin+path,{...opts,headers:{authorization:`Bearer ${token}`,...(opts.method==='POST'?{origin}:{}),...opts.headers}});
  const json=(path,obj,token='d.e.f')=>send(path,token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});
  assert.deepEqual(await (await send('/api/video-config','g.h.i',{'headers':{'oai-authenticated-user-id':owner}})).json(),{enabled:false});
  const store=createSponsoredInvitationStore(db),{code}=await store.issue({expiresAt:Date.now()+60000});
  assert.deepEqual(await (await json('/api/sponsor-invitations/redeem',{code},'a.b.c')).json(),{state:'owner',message:'Deze uitnodiging is voor je tester. Deel de link met hem.'});
  const redeemResponse=await send('/api/sponsor-invitations/redeem','d.e.f',{method:'POST',headers:{'content-type':'application/json','x-fixture-no-fal':'1'},body:JSON.stringify({code})});
  assert.equal(redeemResponse.status,200,await redeemResponse.clone().text());
  assert.deepEqual(await redeemResponse.json(),{state:'redeemed',amountCents:500});
  assert.deepEqual(await (await send('/api/video-config','d.e.f',{headers:{'x-fixture-no-fal':'1'}})).json(),{enabled:false});
  assert.deepEqual(await (await json('/api/sponsor-invitations/redeem',{code})).json(),{state:'redeemed',amountCents:500});
  assert.deepEqual(await (await json('/api/sponsor-invitations/redeem',{code},'g.h.i')).json(),{state:'unavailable'});
  assert.deepEqual(await (await send('/api/video-config')).json(),{enabled:true,funding:'sponsored'});assert.deepEqual(await (await send('/api/video-config','g.h.i')).json(),{enabled:false});
  const image=await readFile('test/fixtures/input.jpg'),video=await readFile('test/fixtures/silent.mp4');
  async function upload(kind,data){const response=await send('/api/assets','d.e.f',{method:'POST',headers:{'content-type':kind==='image'?'image/jpeg':'video/mp4','x-rig-asset-kind':kind,...(kind==='video'?{'x-rig-duration-seconds':'4','x-rig-keep-sound':'false'}:{})},body:data});assert.equal(response.status,201,await response.clone().text());return (await response.json()).id}
  let imageId=await upload('image',image);const videoId=await upload('video',video);
  async function quote(quality='standard'){await db.prepare('UPDATE rig_rate_limits SET window_start=0 WHERE bucket=?').bind(`generation:${tester}`).run();const r=await json('/api/generation-quotes',{imageId,videoId,quality,keepSound:false,steadyCamera:false});assert.equal(r.status,201,await r.clone().text());return r.json()}
  // A job with ledger funds alone cannot authorize sponsored dispatch.
  const q=await quote(),jobs=createD1GenerationStores(db,{mode:'test',dispatchMode:'sponsored'}).jobs;
  const raw=await jobs.begin({userId:tester,quoteId:q.id,idempotencyKey:'raw-no-reservation',quote:q});assert.equal(raw.kind,'created');assert.equal(await jobs.authorizeDispatch(tester,raw.job.id),false);await jobs.markPreparationFailed(tester,raw.job.id);
  // A completed, authenticated input rejection returns both ledger and sponsor
  // capacity, and a repeat status read cannot duplicate that return.
  await db.prepare("UPDATE rig_fixture_fal_mode SET mode='input-failure' WHERE id=1").run();
  const inputQuote=await quote(),inputJob=await (await json('/api/generations',{quoteId:inputQuote.id,idempotencyKey:'rejected-input-attempt'})).json();
  const failedInput=await (await send(`/api/generations/${inputJob.id}`)).json();assert.equal(failedInput.state,'failed');assert.equal(failedInput.refundConfirmed,true);
  const failedAgain=await (await send(`/api/generations/${inputJob.id}`)).json();assert.equal(failedAgain.refundConfirmed,true);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?').bind(`release:${inputJob.id}`).first()).n,1);
  assert.equal((await db.prepare('SELECT released_at IS NOT NULL n FROM rig_sponsored_reservations WHERE job_id=?').bind(inputJob.id).first()).n,1);
  assert.deepEqual(await store.eligibility(tester),{state:'eligible',remainingCents:500});
  await db.prepare("UPDATE rig_fixture_fal_mode SET mode='subject-failure' WHERE id=1").run();
  const subjectQuote=await quote('pro'),subjectJob=await (await json('/api/generations',{quoteId:subjectQuote.id,idempotencyKey:'rejected-subject-attempt'})).json();
  const subjectResult=await (await send(`/api/generations/${subjectJob.id}`)).json();assert.equal(subjectResult.state,'failed');assert.equal(subjectResult.refundConfirmed,true);
  assert.equal((await (await send(`/api/generations/${subjectJob.id}`)).json()).refundConfirmed,true);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?').bind(`release:${subjectJob.id}`).first()).n,1);
  assert.equal((await db.prepare('SELECT failure_code FROM rig_generation_jobs WHERE id=?').bind(subjectJob.id).first()).failure_code,'provider_subject_not_detected');
  assert.deepEqual(await store.eligibility(tester),{state:'eligible',remainingCents:500});
  // The exact rejected photo is blocked before any fresh paid request. The
  // remaining sponsor-budget scenarios use a different verified image hash.
  await db.prepare('UPDATE rig_rate_limits SET window_start=0 WHERE bucket=?').bind(`generation:${tester}`).run();
  const blocked=await json('/api/generation-quotes',{imageId,videoId,quality:'pro',keepSound:false,steadyCamera:false});assert.equal(blocked.status,400);assert.match((await blocked.json()).error,/menselijk bovenlichaam/);
  await db.prepare('UPDATE rig_rate_limits SET window_start=0 WHERE bucket=?').bind(`asset:${tester}`).run();
  const changedImage=Buffer.concat([image.subarray(0,2),Buffer.from([255,254,0,3,0]),image.subarray(2)]);imageId=await upload('image',changedImage);
  await db.prepare("UPDATE rig_fixture_fal_mode SET mode='ok' WHERE id=1").run();
  const over=await quote('pro');
  let firstCompletedId;
  for(let i=0;i<4;i++){
   const q=await quote();const submit={quoteId:q.id,idempotencyKey:`attempt-${i}`};
   const responses=i===0?await Promise.all([json('/api/generations',submit),json('/api/generations',submit)]):[await json('/api/generations',submit)];
   const accepted=responses.find(r=>r.status===202);assert.ok(accepted,JSON.stringify({responses:await Promise.all(responses.map(async r=>({status:r.status,body:await r.clone().text()}))),trace:(await db.prepare('SELECT event FROM rig_fixture_trace').all()).results,reservations:(await db.prepare('SELECT amount_cents FROM rig_sponsored_reservations').all()).results}));const job=await accepted.json();if(!firstCompletedId)firstCompletedId=job.id;
   assert.equal((await (await send(`/api/generations/${job.id}`)).json()).state,'completed');
   assert.equal((await send(`/api/generations/${job.id}/video`,'g.h.i')).status,503);
  }
  assert.equal((await db.prepare('SELECT SUM(amount_cents) n FROM rig_sponsored_reservations WHERE released_at IS NULL').first()).n,400);
  // Extra purchased/fake balance cannot exceed the sponsor's separate limit.
  const beforeUploads=(await db.prepare("SELECT COUNT(*) n FROM rig_fixture_trace WHERE event='POST https://rest.fal.ai/storage/upload/initiate'").first()).n;
  const denied=await json('/api/generations',{quoteId:over.id,idempotencyKey:'over-budget'});assert.equal(denied.status,409);assert.match((await denied.json()).error,/gratis testtegoed.*niet voldoende/);
  const noQuote=await json('/api/generation-quotes',{imageId,videoId,quality:'pro',keepSound:false,steadyCamera:false});assert.equal(noQuote.status,400);assert.match((await noQuote.json()).error,/gratis testtegoed.*niet voldoende/);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_fixture_trace WHERE event='POST https://rest.fal.ai/storage/upload/initiate'").first()).n,beforeUploads);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,6);
  // A proven pre-dispatch preparation failure returns both testcredit and its
  // sponsor hold. A subsequent uncertain queue result never releases either.
  await db.prepare("UPDATE rig_fixture_fal_mode SET mode='upload-failure' WHERE id=1").run();const failedQuote=await quote();const failed=await (await json('/api/generations',{quoteId:failedQuote.id,idempotencyKey:'preparation-failed'})).json();assert.equal(failed.state,'failed');assert.equal(failed.refundConfirmed,true);
  assert.equal((await db.prepare('SELECT SUM(amount_cents) n FROM rig_sponsored_reservations WHERE released_at IS NULL').first()).n,400);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_sponsored_reservations WHERE released_at IS NOT NULL').first()).n,3);
  await db.prepare("UPDATE rig_fixture_fal_mode SET mode='unknown' WHERE id=1").run();const last=await quote();const pending=await (await json('/api/generations',{quoteId:last.id,idempotencyKey:'uncertain-last'})).json();assert.equal(pending.state,'unknown');
  assert.equal((await db.prepare('SELECT SUM(amount_cents) n FROM rig_sponsored_reservations WHERE released_at IS NULL').first()).n,500);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,7);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?").bind(`release:${pending.id}`).first()).n,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_rate_limits WHERE bucket='rig-closed-video-global-one-attempt-v1'").first()).n,1);
  await db.prepare('UPDATE rig_rate_limits SET window_start=0 WHERE bucket=?').bind(`generation:${tester}`).run();
  assert.deepEqual(await (await send('/api/video-config')).json(),{enabled:true,funding:'sponsored'});
  assert.equal((await send(`/api/generations/${firstCompletedId}/video`)).status,200);
  assert.equal((await send('/api/assets','d.e.f',{method:'POST',headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:image})).status,403);
  await db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(tester).run();
  assert.deepEqual(await (await send('/api/video-config')).json(),{enabled:true,funding:'sponsored'});
  assert.equal((await send(`/api/generations/${firstCompletedId}/video`)).status,200);
  assert.equal((await send('/api/assets','d.e.f',{method:'POST',headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:image})).status,403);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
