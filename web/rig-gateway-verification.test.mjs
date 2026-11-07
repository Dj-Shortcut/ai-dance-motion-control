import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createGatewayVerification,authorizeGatewayProof,GATEWAY_PROOF_JOB as job,gatewayProofBucket} from './rig-gateway-verification.mjs';
import {mintProofProviderInput,handleProviderInput} from './rig-provider-inputs.mjs';
import {Miniflare} from 'miniflare';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image='11111111-1111-4111-8111-111111111111',video='22222222-2222-4222-8222-222222222222',quote='33333333-3333-4333-8333-333333333333';
const model='fal-ai/kling-video/o3/standard/video-to-video/edit',fal='01a1b727-0a43-7331-b508-6b03cfd8bcfb';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response()}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 for(const name of ['0001_test_baseline.sql'])for(const sql of (await readFile('closed-payment-migrations/'+name,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
 const imageBytes=new Uint8Array(96).fill(17),videoBytes=new Uint8Array(128).fill(29),ih=await hash(imageBytes),vh=await hash(videoBytes);
 const input={data:{imageId:image,videoId:video,quality:'edit-standard',faceId:null,angleIds:[],steadyCamera:false},refs:[{id:image,kind:'image',sha256:ih},{id:video,kind:'video',sha256:vh}]};
 await db.prepare('INSERT INTO rig_generation_quotes VALUES(?,?,?,?,?,?,?,?,?)').bind(quote,owner,model,JSON.stringify(input),100,'fixture',5,Date.now()+60000,Date.now()).run();
 await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,failure_code,created_at) VALUES(?,?,?,?,100,'failed',?,'provider_input_unavailable',?)").bind(job,owner,quote,'already-failed',fal,Date.now()).run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?),(?,?,?)').bind('reserve:'+job,owner,-100,'release:'+job,owner,100).run();
 await db.prepare('INSERT INTO rig_rate_limits VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',123456789).run();
 const calls=[],urls=[],now=Date.now(),env={DB:db,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_VIDEO_OWNER_USER_ID:owner,RIG_SITES_BRIDGE_ORIGIN:'https://rig-bridge.example.workers.dev',RIG_MEDIA_SECRET:'fixture-private-secret'.repeat(3)};
 env.RIG_MEDIA={async fetch(req){calls.push(req.url);assert.equal(req.headers.get('authorization'),'Bearer '+env.RIG_MEDIA_SECRET);assert.equal(req.headers.get('x-rig-user'),owner);assert.equal(new URL(req.url).origin,'https://rig-media.internal');const isImage=req.url.endsWith(image);assert.ok(isImage||req.url.endsWith(video));const bytes=isImage?imageBytes:videoBytes;return new Response(bytes,{headers:{'content-type':isImage?'image/jpeg':'video/mp4','content-length':String(bytes.length),'x-rig-asset-kind':isImage?'image':'video','x-rig-sha256':isImage?ih:vh,'x-rig-width':'720','x-rig-height':'1280','x-rig-fps':'30','x-rig-duration-seconds':'4.97'}})}};
 const transport=async(url,init)=>{urls.push(url);assert.equal(init.redirect,'manual');assert.deepEqual(Object.keys(init.headers??{}).filter(k=>k.toLowerCase()!=='range'),[]);return handleProviderInput(new Request(url,init),env,{verifyTenant:async()=>true,authorizeProof:authorizeGatewayProof,now})};
 const create=(options={})=>createGatewayVerification({env,verifyTenant:async()=>true,mintProofInput:mintProofProviderInput,fetchImpl:transport,clock:()=>now,...options});
 return {mf,db,env,calls,urls,now,create,input,transport};
}
test('real D1 proof checks both public GET, HEAD and byte ranges then revokes diagnostic links without changing credit/job/dispatch',async()=>{
 const f=await fixture();try{
  const jobs=(await f.db.prepare('SELECT * FROM rig_generation_jobs').all()).results,ledger=(await f.db.prepare('SELECT * FROM rig_ledger').all()).results;
  const run=f.create(),first=await run({userId:owner,jobId:job});assert.equal(first.status,200);const value=await first.json();assert.equal(value.verified,true);assert.equal(value.headVerified,true);assert.equal(value.rangeVerified,true);assert.equal(value.modelQueueCalled,false);assert.equal(f.urls.length,6);assert.equal(f.calls.length,8);
  assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(gatewayProofBucket()).first()).requests,2);
  assert.equal((await handleProviderInput(new Request(f.urls[0]),f.env,{verifyTenant:async()=>true,authorizeProof:authorizeGatewayProof,now:f.now})).status,404);
  assert.equal((await (await run({userId:owner,jobId:job})).json()).alreadyAttempted,true);assert.equal(f.urls.length,6);
  assert.deepEqual((await f.db.prepare('SELECT * FROM rig_generation_jobs').all()).results,jobs);assert.deepEqual((await f.db.prepare('SELECT * FROM rig_ledger').all()).results,ledger);
  assert.deepEqual(await f.db.prepare('SELECT window_start,requests FROM rig_rate_limits WHERE bucket=?').bind('rig-closed-video-global-one-attempt-v1').first(),{window_start:123456789,requests:1});
  assert.doesNotMatch(JSON.stringify(value),/https:|provider-inputs|secret|sha256/);
 }finally{await f.mf.dispose()}
});
test('concurrent proof requests consume one claim and never repeat file transfers',async()=>{
 const f=await fixture();try{const run=f.create(),responses=await Promise.all([run({userId:owner,jobId:job}),run({userId:owner,jobId:job})]);const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values.filter(x=>x.alreadyAttempted).length,1);assert.equal(f.urls.length,6);assert.equal(f.calls.length,8);}finally{await f.mf.dispose()}
});
test('wrong account, job, provider request, missing refund, model, active work and freeze cannot claim or transfer',async()=>{
 const f=await fixture();try{
  const run=f.create();assert.equal((await run({userId:other,jobId:job})).status,403);assert.equal((await run({userId:owner,jobId:quote})).status,403);
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(owner).run();assert.equal((await run({userId:owner,jobId:job})).status,409);await f.db.prepare('DELETE FROM rig_frozen_accounts').run();
  await f.db.prepare("UPDATE rig_generation_jobs SET fal_request_id='wrong'").run();assert.equal((await run({userId:owner,jobId:job})).status,409);await f.db.prepare('UPDATE rig_generation_jobs SET fal_request_id=?').bind(fal).run();
  await f.db.prepare("UPDATE rig_generation_jobs SET state='queued'").run();assert.equal((await run({userId:owner,jobId:job})).status,409);await f.db.prepare("UPDATE rig_generation_jobs SET state='failed'").run();
  await f.db.prepare("UPDATE rig_generation_quotes SET model='other'").run();assert.equal((await run({userId:owner,jobId:job})).status,409);await f.db.prepare('UPDATE rig_generation_quotes SET model=?').bind(model).run();
  await f.db.prepare('DELETE FROM rig_ledger WHERE event_id=?').bind('release:'+job).run();assert.equal((await run({userId:owner,jobId:job})).status,409);
  assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);assert.equal(await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(gatewayProofBucket()).first(),null);
 }finally{await f.mf.dispose()}
});
test('an uncertain or redirected proof is never retried and cannot leak a credential error',async()=>{
 const f=await fixture();try{
  const run=f.create({fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://secret.invalid/token'}})}),first=await run({userId:owner,jobId:job});assert.equal(first.status,503);const value=await first.json();assert.equal(value.stage,'image_gateway');assert.equal(value.verified,false);assert.doesNotMatch(JSON.stringify(value),/secret|https:|token/);
  assert.equal((await (await run({userId:owner,jobId:job})).json()).alreadyAttempted,true);assert.equal(f.calls.length,2);
  assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(gatewayProofBucket()).first()).requests,1);
 }finally{await f.mf.dispose()}
});
test('proof authorization requires its exact active claim and expires or revokes immediately',async()=>{
 const f=await fixture();try{
  const token={scope:'proof',jobId:job,issuedAt:f.now,exp:f.now+300000};assert.equal(await authorizeGatewayProof({env:f.env,token,now:f.now}),null);
  await f.db.prepare('INSERT INTO rig_rate_limits VALUES(?,?,1)').bind(gatewayProofBucket(),f.now).run();assert.equal((await authorizeGatewayProof({env:f.env,token,now:f.now})).user_id,owner);
  for(const bad of [{...token,jobId:quote},{...token,scope:'generation'},{...token,exp:f.now+300001},{...token,issuedAt:f.now+1,exp:f.now+300001}])assert.equal(await authorizeGatewayProof({env:f.env,token:bad,now:f.now}),null);
  assert.equal(await authorizeGatewayProof({env:f.env,token,now:f.now+300000}),null);
  await f.db.prepare('UPDATE rig_rate_limits SET requests=2 WHERE bucket=?').bind(gatewayProofBucket()).run();assert.equal(await authorizeGatewayProof({env:f.env,token,now:f.now}),null);
 }finally{await f.mf.dispose()}
});
