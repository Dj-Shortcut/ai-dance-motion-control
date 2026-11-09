import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Miniflare} from 'miniflare';
import {mintR2Input,isR2InputUrl,r2InputsConfig} from './rig-r2-inputs.mjs';
import {createClosedVideoWorker} from './closed-video-worker.mjs';
import {createCloudMediaService} from './cloud-media-service.mjs';
import {signSitesBridgeRequest} from './sites-bridge-protocol.mjs';
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

let recoveryMedia;
function recoveryFiles(){
 // New local pixels only. Real delivery verification must hold exact bytes,
 // including a valid O3-sized video, rather than trusting mocked uploadOwned.
 return recoveryMedia??=Promise.all([
  readFile(new URL('./test/fixtures/input.jpg',import.meta.url)),
  promisify(execFile)('ffmpeg',['-hide_banner','-v','error','-nostdin','-f','lavfi','-i','color=c=blue:s=720x720:r=30:d=5','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{encoding:'buffer',maxBuffer:16*1024*1024,timeout:20000}).then(r=>r.stdout)
 ]);
}
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function workerRecoveryFixture(failure){
 const f=await fixture();
 try{
  for(const name of ['0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql','0006_sites_bridge.sql','0007_chatgpt_approvals.sql'])for(const sql of (await readFile('closed-payment-migrations/'+name,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await f.db.prepare(sql).run();
  const origin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co',secret='x'.repeat(40);
  await f.db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('site-test-1','test',origin,project,'','').run();
  await f.db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(project+'/auth/v1','owner',owner).run();
  const [imageBytes,videoBytes]=await recoveryFiles(),records=new Map(),manifests=new Map(),mediaCalls=[],reads=[];let copies=0;
  for(const [id,kind,bytes,width,height] of [[image,'image',imageBytes,640,480],[video,'video',videoBytes,720,720]]){
   const manifest={id,ownerId:owner,kind,mime:kind==='image'?'image/jpeg':'video/mp4',sha256:await hash(bytes),size:bytes.length,width,height,expiresAt:Date.now()+60000,...(kind==='video'?{durationSeconds:5,fps:30}:{})};
   manifests.set(id,manifest);records.set(`rig-inputs/${owner}/${id}`,{bytes:new Uint8Array(bytes),customMetadata:{manifest:JSON.stringify(manifest)}});
  }
  await f.db.prepare('UPDATE rig_generation_quotes SET input_json=? WHERE id=?').bind(JSON.stringify({...f.input,refs:[image,video].map(id=>({id,kind:manifests.get(id).kind,sha256:manifests.get(id).sha256}))}),quote).run();
  const bucket={
   async put(key,bytes,options){copies++;assert.match(key,/^rig-inputs\/provider\/[a-f0-9]{64}\.(jpg|mp4)$/);assert.equal(options.onlyIf.get('if-none-match'),'*');if(records.has(key))return null;records.set(key,{bytes:new Uint8Array(bytes),httpMetadata:options.httpMetadata,customMetadata:options.customMetadata});return {key};},
   async get(key){const item=records.get(key);return item?{body:new Response(item.bytes).body,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata}:null;},
   async head(){throw Error('Recovery must not store or read a generated result');}
  };
  const unused=()=>{throw Error('Recovery must not normalize media');};
  const service=createCloudMediaService({secret,bucket,images:{input:unused},video:{input:unused},enabled:true});
  const media={async fetch(req){
   const u=new URL(req.url);assert.equal(u.origin,'https://rig-media.internal');assert.equal(req.headers.get('authorization'),'Bearer '+secret);assert.equal(req.headers.get('x-rig-user'),owner);assert.equal(req.redirect,'manual');
   mediaCalls.push({path:u.pathname,method:req.method,body:req.method==='POST'?await req.clone().json():null});return service(req);
  }};
  Object.assign(f.env,{RIG_PUBLIC_ORIGIN:origin,SUPABASE_URL:project,RIG_TEST_ENVIRONMENT_ID:'site-test-1',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_SPONSORED_ENABLED:'yes',RIG_CLOSED_VIDEO_ENABLED:'yes',FAL_KEY:'fixture-no-network',RIG_MEDIA_SECRET:secret,RIG_MEDIA:media,BUCKET:bucket,RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_VERSION:'fixture',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_SITES_BRIDGE_ENABLED:'yes',RIG_SITES_BRIDGE_ORIGIN:'https://rig-bridge.example.workers.dev',RIG_SITES_PRODUCER_ORIGIN:'https://rig.example.chatgpt.site',RIG_SITES_PROJECT_ID:'appgprj_12345678901234567890123456789012',RIG_SITES_BRIDGE_KEY:'a'.repeat(64),CLOSED_IDENTITY_SERVICE:{fetch(){throw Error('Signed recovery must not dispatch Google identity');}}});
  const worker=createClosedVideoWorker(),path='/api/generations/'+jobId+'/verify-inputs';
  const call=async(subject='native-owner',data={})=>worker.fetch(await signSitesBridgeRequest({env:f.env,subject,path,method:'POST',headers:{'content-type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))}),f.env);
  const session=await worker.fetch(await signSitesBridgeRequest({env:f.env,subject:'native-owner',path:'/api/session'}),f.env);assert.equal(session.status,200);
  await f.db.prepare('UPDATE rig_sites_identities SET user_id=? WHERE user_id=?').bind(owner,(await session.json()).userId).run();
  const config=r2InputsConfig(f.env);
  const fetcher=async(url,init={})=>{
   const u=new URL(url),key=u.pathname.slice(('/'+config.bucket+'/').length),kind=key.endsWith('.jpg')?'image':'video',headers=new Headers(init.headers),range=headers.get('range');
   assert.equal(isR2InputUrl(url,{config,key,kind}),true,'default worker recovery must wire the R2 factory');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.deepEqual([...headers.keys()],range?['range']:[],'R2 receives no provider or identity credentials');
   const item=records.get(key);assert.ok(item);assert.equal(Object.keys(item.customMetadata??{}).length,0);assert.equal(item.httpMetadata.cacheControl,'private, no-store');reads.push({kind,key,range});
   const bytes=new Uint8Array(item.bytes);
   if(kind==='video'&&failure===(range?'range-denied':'full-denied'))return new Response(null,{status:403});
   if(kind==='video'&&failure===(range?'range-corrupt':'full-corrupt'))bytes[0]^=1;
   const responseHeaders={'content-type':item.httpMetadata.contentType};
   if(range){const match=/^bytes=0-(\d+)$/.exec(range);assert.ok(match);const count=Number(match[1])+1;responseHeaders['content-length']=String(count);responseHeaders['content-range']=`bytes 0-${count-1}/${bytes.length}`;
    if(kind==='image'&&failure==='refreeze')await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(owner).run();
    return new Response(bytes.slice(0,count),{status:206,headers:responseHeaders});
   }
   responseHeaders['content-length']=String(bytes.length);return new Response(bytes,{status:200,headers:responseHeaders});
  };
  return {...f,call,fetcher,reads,mediaCalls,manifests,counts:()=>({copies,reads:reads.length,media:mediaCalls.length})};
 }catch(error){await f.mf.dispose();throw error;}
}
test('default signed worker recovery verifies real private-media copies with complete and ranged R2 reads before issuing its receipt',async()=>{
 const f=await workerRecoveryFixture(),originalFetch=globalThis.fetch;globalThis.fetch=f.fetcher;
 try{
  const before=await snapshot(f.db);
  assert.equal((await f.call('other')).status,403);assert.equal((await f.call('native-owner',{confirmed:true})).status,400);assert.deepEqual(f.counts(),{copies:0,reads:0,media:0});
  const response=await f.call();assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.verified,true);assert.equal(receipt.readbackVerified,true);assert.equal(receipt.rangeVerified,true);assert.equal(receipt.modelQueueCalled,false);
  assert.deepEqual(f.reads.map(({kind,range})=>[kind,range]),[['image',null],['image','bytes=0-63'],['video',null],['video','bytes=0-63']]);
  assert.deepEqual(f.mediaCalls.filter(c=>c.method==='POST'),[image,video].map(id=>({path:'/v1/provider-inputs/'+id,method:'POST',body:{jobId,sha256:f.manifests.get(id).sha256}})));
  assert.equal(f.counts().copies,2);assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first()).requests,2);
  const count=f.counts();assert.equal((await(await f.call()).json()).alreadyAttempted,true);assert.deepEqual(f.counts(),count);assert.doesNotMatch(JSON.stringify(receipt),/https|X-Amz|secret|Signature/);
 }finally{globalThis.fetch=originalFetch;await f.mf.dispose();}
});
for(const [failure,stage] of [['full-denied','r2_metadata'],['full-corrupt','r2_integrity'],['range-denied','r2_range'],['range-corrupt','r2_range']])test(`worker recovery ${failure} consumes its attempt without issuing a verified receipt`,async()=>{
 const f=await workerRecoveryFixture(failure),originalFetch=globalThis.fetch;globalThis.fetch=f.fetcher;
 try{
  const before=await snapshot(f.db),response=await f.call();assert.equal(response.status,503);const receipt=await response.json();assert.equal(receipt.verified,false);assert.equal(receipt.readbackVerified,false);assert.equal(receipt.rangeVerified,false);assert.equal(receipt.stage,stage);assert.equal(receipt.asset,'video');
  assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first()).requests,1);
  const count=f.counts(),replay=await(await f.call()).json();assert.equal(replay.alreadyAttempted,true);assert.equal(replay.verified,false);assert.deepEqual(f.counts(),count);assert.doesNotMatch(JSON.stringify(receipt),/https|X-Amz|secret|Signature/);
 }finally{globalThis.fetch=originalFetch;await f.mf.dispose();}
});
test('refreezing the owner after image readback prevents the video copy and any verified recovery receipt',async()=>{
 const f=await workerRecoveryFixture('refreeze'),originalFetch=globalThis.fetch;globalThis.fetch=f.fetcher;
 try{
  const before=await snapshot(f.db),response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).verified,false);assert.deepEqual(f.counts(),{copies:1,reads:2,media:4});assert.deepEqual(await snapshot(f.db),before);
  assert.equal((await f.db.prepare('SELECT requests FROM rig_rate_limits WHERE bucket=?').bind(r2InputVerificationBucket(jobId)).first()).requests,1);assert.equal((await f.call()).status,409);
  await f.db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').bind(owner).run();const count=f.counts(),replay=await(await f.call()).json();assert.equal(replay.alreadyAttempted,true);assert.equal(replay.verified,false);assert.deepEqual(f.counts(),count);
 }finally{globalThis.fetch=originalFetch;await f.mf.dispose();}
});
