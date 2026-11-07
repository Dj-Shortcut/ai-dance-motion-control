import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createInputVerification,INPUT_VERIFICATION_JOB as jobId,inputVerificationBucket} from './rig-input-verification.mjs';
import {createClosedVideoWorker} from './closed-video-worker.mjs';
import {signSitesBridgeRequest} from './sites-bridge-protocol.mjs';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image='11111111-1111-4111-8111-111111111111',video='22222222-2222-4222-8222-222222222222',quote='33333333-3333-4333-8333-333333333333';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit',origin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co';
const digest='a'.repeat(64);
async function fixture(){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 for(const name of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql','0005_sponsored_invitation.sql','0006_sites_bridge.sql','0007_chatgpt_approvals.sql'])for(const sql of (await readFile('closed-payment-migrations/'+name,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('site-test-1','test',origin,project,'','').run();
 await db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(project+'/auth/v1','owner',owner).run();
 const input={data:{imageId:image,videoId:video,quality:'edit-standard',faceId:null,angleIds:[],keepSound:true},refs:[{id:image,kind:'image',sha256:digest},{id:video,kind:'video',sha256:digest}],prompt:'Edit @Video1 using @Image1'};
 await db.prepare('INSERT INTO rig_generation_quotes VALUES(?,?,?,?,?,?,?,?,?)').bind(quote,owner,model,JSON.stringify(input),100,'test',5,Date.now()+60000,Date.now()).run();
 await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,failure_code,created_at) VALUES(?,?,?,?,100,'failed','request-test','provider_input_unavailable',?)").bind(jobId,owner,quote,'original-test',Date.now()).run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?),(?,?,?)').bind('reserve:'+jobId,owner,-100,'release:'+jobId,owner,100).run();
 await db.prepare('INSERT INTO rig_rate_limits VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',1794071832522).run();
 const calls=[],getOwned=async(_,id)=>{calls.push(['read',id]);return {id,verified:true,kind:id===video?'video':'image',sha256:digest,...(id===video?{durationVerified:true,durationSeconds:5,width:720,height:1280,fps:30}:{})}};
 const uploadOwned=async(_,id,sha)=>{calls.push(['upload',id,sha]);return {verified:true,kind:id===video?'video':'image',url:'https://v3b.fal.media/files/b/test/'+id+'.mp4?identity=do-not-return-this'}};
 const assets={getOwned,uploadOwned};
 const create=(options={})=>createInputVerification({db,ownerUserId:owner,makeAssets:()=>assets,verifyTenant:async()=>true,...options});
 const env={DB:db,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,SUPABASE_URL:project,RIG_TEST_ENVIRONMENT_ID:'site-test-1',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_VIDEO_OWNER_USER_ID:owner,RIG_SPONSORED_ENABLED:'yes',RIG_CLOSED_VIDEO_ENABLED:'yes',FAL_KEY:'fixture-no-network',RIG_MEDIA_SECRET:'x'.repeat(40),RIG_MEDIA:{fetch(){throw Error('No actual provider or media request expected')}},BUCKET:{get(){},put(){},head(){}},RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_VERSION:'fixture',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_SITES_BRIDGE_ENABLED:'yes',RIG_SITES_BRIDGE_ORIGIN:'https://rig-bridge.example.workers.dev',RIG_SITES_PRODUCER_ORIGIN:'https://rig.example.chatgpt.site',RIG_SITES_PROJECT_ID:'appgprj_12345678901234567890123456789012',RIG_SITES_BRIDGE_KEY:'a'.repeat(64),CLOSED_IDENTITY_SERVICE:{fetch(){throw Error('No Google identity dispatch')}}};
 return {mf,db,create,calls,assets,env};
}
test('one durable proof verifies both immutable inputs, replays only its receipt and changes no credit/job/dispatch marker',async()=>{
 const f=await fixture();try{
  const before=(await f.db.prepare('SELECT * FROM rig_generation_jobs').all()).results,ledger=(await f.db.prepare('SELECT * FROM rig_ledger').all()).results;
  const run=f.create(),first=await run({userId:owner,jobId});assert.equal(first.status,200);assert.deepEqual(await first.json(),{state:'verified',verified:true,imageVerified:true,videoVerified:true,readbackVerified:true,alreadyAttempted:false});
  assert.deepEqual(f.calls.map(c=>c[0]),['read','read','upload','upload']);
  const next=await run({userId:owner,jobId});assert.equal((await next.json()).alreadyAttempted,true);assert.equal(f.calls.length,4);
  assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(inputVerificationBucket(jobId)).first()).requests,2);
  assert.deepEqual((await f.db.prepare('SELECT * FROM rig_generation_jobs').all()).results,before);assert.deepEqual((await f.db.prepare('SELECT * FROM rig_ledger').all()).results,ledger);
  assert.deepEqual(await f.db.prepare('SELECT window_start,requests FROM rig_rate_limits WHERE bucket=?').bind('rig-closed-video-global-one-attempt-v1').first(),{window_start:1794071832522,requests:1});
 }finally{await f.mf.dispose()}
});
test('concurrent duplicate calls can never upload a second time',async()=>{
 const f=await fixture();try{const run=f.create();const responses=await Promise.all([run({userId:owner,jobId}),run({userId:owner,jobId})]);assert.equal(f.calls.filter(c=>c[0]==='upload').length,2);const receipts=await Promise.all(responses.map(r=>r.json()));assert.equal(receipts.filter(r=>r.alreadyAttempted).length,1);}finally{await f.mf.dispose()}
});
test('untrusted users, other jobs, freeze, unfunded failure, wrong failure code or tenant cannot transfer bytes',async()=>{
 const f=await fixture();try{
  const run=f.create();assert.equal((await run({userId:other,jobId})).status,403);assert.equal((await run({userId:owner,jobId:quote})).status,403);
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'test')").bind(owner).run();assert.equal((await run({userId:owner,jobId})).status,409);await f.db.prepare('DELETE FROM rig_frozen_accounts').run();
  await f.db.prepare("UPDATE rig_generation_jobs SET failure_code='provider_failed'").run();assert.equal((await run({userId:owner,jobId})).status,409);await f.db.prepare("UPDATE rig_generation_jobs SET failure_code='provider_input_unavailable'").run();
  await f.db.prepare('DELETE FROM rig_ledger WHERE event_id=?').bind('release:'+jobId).run();assert.equal((await run({userId:owner,jobId})).status,409);
  assert.equal((await f.create({verifyTenant:async()=>false})({userId:owner,jobId})).status,503);assert.equal(f.calls.length,0);
  assert.equal(await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(inputVerificationBucket(jobId)).first(),null);
 }finally{await f.mf.dispose()}
});
test('changed private hash or invalid O3 metadata fails before either upload and consumes its one attempt',async()=>{
 const f=await fixture();try{
  const original=f.assets.getOwned;f.assets.getOwned=async(...args)=>{const asset=await original(...args);return asset.kind==='video'?{...asset,width:718}:asset};
  const run=f.create(),first=await run({userId:owner,jobId});assert.equal(first.status,503);assert.equal((await first.json()).stage,'video_metadata');assert.equal(f.calls.filter(c=>c[0]==='upload').length,0);
  assert.equal((await (await run({userId:owner,jobId})).json()).alreadyAttempted,true);assert.equal(f.calls.length,2);
 }finally{await f.mf.dispose()}
});
test('provider failure exposes only a fixed stage and status, never a credential URL, and can never be retried',async()=>{
 const f=await fixture();try{
  f.assets.uploadOwned=async()=>{throw Object.assign(Error('secret https://private.invalid/?token=credential'),{rigInputStage:'signed_read',rigInputHttpStatus:403})};
  const run=f.create(),response=await run({userId:owner,jobId});assert.equal(response.status,503);const body=await response.text();assert.match(body,/signed_read/);assert.match(body,/"httpStatus":403/);assert.doesNotMatch(body,/secret|https|token|credential/);
  const next=await run({userId:owner,jobId});assert.deepEqual(await next.json(),{state:'started_or_uncertain',verified:false,imageVerified:false,videoVerified:false,readbackVerified:false,alreadyAttempted:true});
 }finally{await f.mf.dispose()}
});
test('the worker exposes recovery only to signed owner with strict empty JSON and blocks every queue host',async()=>{
 const f=await fixture();try{
  const worker=createClosedVideoWorker({recoveryAssetsFactory:options=>{assert.rejects(options.providerFetch('https://queue.fal.run/fal-ai/kling-video',{method:'POST'}),/Queue is unavailable/);return f.assets}});
  const sign=(subject,path,body={})=>signSitesBridgeRequest({env:f.env,subject,path,method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(body))});
  const session=await signSitesBridgeRequest({env:f.env,subject:'native-owner',path:'/api/session'}),first=await worker.fetch(session,f.env),native=(await first.json()).userId;
  await f.db.prepare('UPDATE rig_sites_identities SET user_id=? WHERE user_id=?').bind(owner,native).run();
  const path='/api/generations/'+jobId+'/verify-inputs';
  assert.equal((await worker.fetch(new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}),f.env)).status,404);
  assert.equal((await worker.fetch(await sign('other',path),f.env)).status,403);
  assert.equal((await worker.fetch(await sign('native-owner',path,{confirmed:true}),f.env)).status,400);
  const good=await worker.fetch(await sign('native-owner',path),f.env);assert.equal(good.status,200);assert.equal((await good.json()).verified,true);
 }finally{await f.mf.dispose()}
});
test('gateway proof route requires the signed owner and exact empty JSON',async()=>{
 const f=await fixture();try{
  let calls=0;const worker=createClosedVideoWorker({gatewayVerificationFactory:({env,verifyTenant,mintProofInput})=>async({userId,jobId})=>{calls++;assert.equal(env,f.env);assert.equal(userId,owner);assert.equal(jobId,'a5db90b7-7558-40bf-a013-2e121d056f2d');assert.equal(await verifyTenant(env),true);assert.equal(typeof mintProofInput,'function');return Response.json({verified:true})}});
  const sign=(subject,path,body={})=>signSitesBridgeRequest({env:f.env,subject,path,method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(body))});
  const session=await signSitesBridgeRequest({env:f.env,subject:'native-owner',path:'/api/session'}),first=await worker.fetch(session,f.env),native=(await first.json()).userId;
  await f.db.prepare('UPDATE rig_sites_identities SET user_id=? WHERE user_id=?').bind(owner,native).run();
  const path='/api/generations/a5db90b7-7558-40bf-a013-2e121d056f2d/verify-gateway';
  assert.equal((await worker.fetch(new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}),f.env)).status,404);
  assert.equal((await worker.fetch(await sign('other',path),f.env)).status,403);
  assert.equal((await worker.fetch(await sign('native-owner',path,{confirm:true}),f.env)).status,400);
  const result=await worker.fetch(await sign('native-owner',path),f.env);assert.equal(result.status,200);assert.equal((await result.json()).verified,true);assert.equal(calls,1);
 }finally{await f.mf.dispose()}
});
