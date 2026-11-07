import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {mintR2Input} from './rig-r2-inputs.mjs';
import {createR2InputVerification,R2_INPUT_VERIFICATION_JOB as jobId,r2InputVerificationBucket} from './rig-r2-verification.mjs';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image='11111111-1111-4111-8111-111111111111',video='22222222-2222-4222-8222-222222222222',quote='33333333-3333-4333-8333-333333333333';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit',sha='a'.repeat(64);
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 for(const name of ['0001_test_baseline.sql','0005_sponsored_invitation.sql'])for(const sql of (await readFile('closed-payment-migrations/'+name,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 const input={data:{imageId:image,videoId:video,quality:'edit-standard',faceId:null,angleIds:[],steadyCamera:false,keepSound:true},refs:[{id:image,kind:'image',sha256:sha},{id:video,kind:'video',sha256:sha}],prompt:'Edit @Video1 using @Image1'};
 await db.prepare('INSERT INTO rig_generation_quotes VALUES(?,?,?,?,?,?,?,?,?)').bind(quote,owner,model,JSON.stringify(input),100,'test',5,Date.now()+60000,Date.now()).run();
 await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,failure_code,finalized_at,created_at) VALUES(?,?,?,?,100,'failed',?,'provider_input_unavailable',?,?)").bind(jobId,owner,quote,'failed-request','01a1b764-c147-77f2-abf6-56276ee54a57',Date.now(),Date.now()).run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?),(?,?,?),(?,?,?)').bind('fund',owner,500,'reserve:'+jobId,owner,-100,'release:'+jobId,owner,100).run();
 await db.prepare('INSERT INTO rig_rate_limits VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',123).run();
 const env={DB:db,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_VIDEO_OWNER_USER_ID:owner,RIG_R2_INPUTS_ENABLED:'yes',RIG_R2_INPUTS_ACCOUNT_ID:'a'.repeat(32),RIG_R2_INPUTS_BUCKET:'rig-test-inputs',RIG_R2_INPUTS_ACCESS_KEY_ID:'b'.repeat(32),RIG_R2_INPUTS_SECRET_ACCESS_KEY:'c'.repeat(64)};
 const calls=[],assets={
  async getOwned(user,id){calls.push(['read',user,id]);return {id,kind:id===video?'video':'image',verified:true,sha256:sha,width:720,height:1280,...(id===video?{durationVerified:true,durationSeconds:5,fps:30}:{})}},
  async uploadOwned(user,id,digest,context){calls.push(['copy',user,id,digest,context]);return {kind:id===video?'video':'image',verified:true,url:await mintR2Input({config:{accountId:env.RIG_R2_INPUTS_ACCOUNT_ID,bucket:env.RIG_R2_INPUTS_BUCKET,accessKeyId:env.RIG_R2_INPUTS_ACCESS_KEY_ID,secretAccessKey:env.RIG_R2_INPUTS_SECRET_ACCESS_KEY},key:'rig-inputs/provider/'+(id===video?'d':'e').repeat(64)+(id===video?'.mp4':'.jpg')})}}
 };
 const create=(patch={})=>createR2InputVerification({env,verifyTenant:async()=>true,makeAssets:({r2Inputs})=>{assert.equal(r2Inputs.bucket,env.RIG_R2_INPUTS_BUCKET);return assets},...patch});
 return {mf,db,env,assets,calls,create,input};
}
async function snapshot(db){return {jobs:(await db.prepare('SELECT * FROM rig_generation_jobs ORDER BY id').all()).results,ledger:(await db.prepare('SELECT * FROM rig_ledger ORDER BY event_id').all()).results,gift:(await db.prepare('SELECT * FROM rig_sponsored_invitation').all()).results,marker:await db.prepare('SELECT * FROM rig_rate_limits WHERE bucket=?').bind('rig-closed-video-global-one-attempt-v1').first()};}
test('the exact refunded owner job verifies both immutable inputs once without changing jobs, ledger, gift or dispatch marker',async()=>{
 const f=await fixture();try{
  const before=await snapshot(f.db),run=f.create(),r=await run({userId:owner,jobId});assert.equal(r.status,200);const body=await r.json();
  assert.deepEqual(body,{state:'verified',verified:true,imageVerified:true,videoVerified:true,readbackVerified:true,rangeVerified:true,alreadyAttempted:false,modelQueueCalled:false,ledgerMutationPerformed:false,dispatchMarkerReset:false});
  assert.deepEqual(f.calls.map(c=>c[0]),['read','read','copy','copy']);for(const c of f.calls.filter(c=>c[0]==='copy'))assert.deepEqual(c[4],{jobId,model});
  assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first()).requests,2);
  assert.equal((await (await run({userId:owner,jobId})).json()).alreadyAttempted,true);assert.equal(f.calls.length,4);
  assert.doesNotMatch(JSON.stringify(body),/https|signed_url|accessKey|secretAccess|Signature/);
 }finally{await f.mf.dispose()}
});
test('concurrent requests cannot copy either asset a second time',async()=>{
 const f=await fixture();try{const run=f.create(),responses=await Promise.all([run({userId:owner,jobId}),run({userId:owner,jobId})]),bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(f.calls.filter(c=>c[0]==='copy').length,2);assert.equal(bodies.filter(b=>b.alreadyAttempted).length,1);assert.equal(bodies.filter(b=>b.verified&&!b.alreadyAttempted).length,1);}finally{await f.mf.dispose()}
});
test('other users/jobs, disabled R2, tenant mismatch and a frozen owner never copy inputs',async()=>{
 const f=await fixture();try{
  const run=f.create();assert.equal((await run({userId:other,jobId})).status,403);assert.equal((await run({userId:owner,jobId:quote})).status,403);
  f.env.RIG_R2_INPUTS_ENABLED='no';assert.equal((await run({userId:owner,jobId})).status,503);f.env.RIG_R2_INPUTS_ENABLED='yes';
  assert.equal((await f.create({verifyTenant:async()=>false})({userId:owner,jobId})).status,503);
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(owner).run();assert.equal((await run({userId:owner,jobId})).status,409);
  assert.equal(f.calls.length,0);assert.equal(await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first(),null);
 }finally{await f.mf.dispose()}
});
test('a missing refund, settled job, wrong provider request or changed immutable quote cannot authorize the proof',async()=>{
 for(const mutation of ["DELETE FROM rig_ledger WHERE event_id='release:'||?","INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('settle:'||?,'"+owner+"',0)","UPDATE rig_generation_jobs SET fal_request_id='other' WHERE id=?","UPDATE rig_generation_jobs SET state='queued' WHERE id=?"]){
  const f=await fixture();try{await f.db.prepare(mutation).bind(jobId).run();assert.equal((await f.create()({userId:owner,jobId})).status,409);assert.equal(f.calls.length,0);}finally{await f.mf.dispose()}
 }
 const f=await fixture();try{const original=f.assets.getOwned;f.assets.getOwned=async(...args)=>{const result=await original(...args);await f.db.prepare('UPDATE rig_generation_quotes SET input_json=? WHERE id=?').bind(JSON.stringify({...f.input,prompt:'Changed'}),quote).run();return result};assert.equal((await f.create()({userId:owner,jobId})).status,503);assert.equal(f.calls.filter(c=>c[0]==='copy').length,0);}finally{await f.mf.dispose()}
});
test('wrong source metadata, foreign signed URLs and unsafe errors stay consumed and never leak details',async()=>{
 for(const mode of ['metadata','foreign','error']){
  const f=await fixture();try{
   if(mode==='metadata'){const read=f.assets.getOwned;f.assets.getOwned=async(...args)=>({...await read(...args),sha256:'f'.repeat(64)})}
   else if(mode==='foreign')f.assets.uploadOwned=async()=>({kind:'image',verified:true,url:'https://private.invalid/?secret=hidden'});
   else f.assets.uploadOwned=async()=>{throw Object.assign(Error('secret https://private.invalid/?credential=hidden'),{rigInputStage:'r2_read',rigInputHttpStatus:403})};
   const run=f.create(),r=await run({userId:owner,jobId});assert.equal(r.status,503);const body=await r.text();assert.doesNotMatch(body,/https|credential|secret|hidden/);if(mode==='error'){assert.match(body,/r2_read/);assert.match(body,/"httpStatus":403/)}
   const calls=f.calls.length,next=await run({userId:owner,jobId});assert.equal((await next.json()).alreadyAttempted,true);assert.equal(f.calls.length,calls);assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first()).requests,1);
  }finally{await f.mf.dispose()}
 }
});
test('another active owner job prevents even claiming the proof',async()=>{
 const f=await fixture();try{
  const otherQuote='44444444-4444-4444-8444-444444444444',active='55555555-5555-4555-8555-555555555555';
  await f.db.prepare('INSERT INTO rig_generation_quotes SELECT ?,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at FROM rig_generation_quotes WHERE id=?').bind(otherQuote,quote).run();
  await f.db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,100,'unknown',?)").bind(active,owner,otherQuote,'active-fixture',Date.now()).run();
  assert.equal((await f.create()({userId:owner,jobId})).status,409);assert.equal(f.calls.length,0);assert.equal(await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first(),null);
 }finally{await f.mf.dispose()}
});
