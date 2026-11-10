import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationHandler } from './generation.mjs';

const endpoint='https://rig.test';
const post=(path,data)=>new Request(endpoint+path,{method:'POST',headers:{'content-type':'application/json',origin:endpoint},body:JSON.stringify(data)});
const get=(path)=>new Request(endpoint+path);
function fixture(redirectAt=0,oversizedAt=0) {
  let caller='u1', providerCalls=0, uploadCalls=0, reserveCount=0, releaseCount=0, fail=false, submitted, terminalError=null, resultResponse=null, statusResponse=null;
  const qs=new Map(), jobs=new Map();
  const assets={image:{kind:'image',verified:true,url:'https://v3b.fal.media/files/b/fixture/image.jpg'}, video:{kind:'video',verified:true,durationVerified:true,durationSeconds:8.2,url:'https://v3b.fal.media/files/b/fixture/video.mp4'}, face:{kind:'image',verified:true,url:'https://v3b.fal.media/files/b/fixture/face.jpg'},angle:{kind:'image',verified:true,url:'https://v3b.fal.media/files/b/fixture/angle.jpg'}};
  for(const [id,asset] of Object.entries(assets)){asset.id=id;asset.sha256='a'.repeat(64)}
  const services={mode:'test',trustedOrigin:endpoint,falKey:'test-key',pricing:{standard:20,pro:30,version:'v1'},authenticate:async()=>({id:caller}),assets:{getOwned:async(u,id)=>u==='u1'?assets[id]:null,uploadOwned:async(u,id,sha)=>{assert.ok(reserveCount>0);uploadCalls++;if(u!=='u1'||!assets[id]||assets[id].sha256!==sha)throw Error('asset changed');return assets[id]}},quotes:{create:async(input)=>{const q={id:'quote1',expiresAt:Date.now()+60_000,...input};qs.set(q.id,q);return q;},getOwned:async(u,id)=>{const q=qs.get(id);return q?.userId===u?q:null;}},results:{store:async(job,url)=>`rig-results/${job.id}.mp4`,read:async()=>new Response('video')},jobs:{hasKnownSubjectRejection:async()=>false,authorizeDispatch:async()=>true,getRecent:async()=>null,getByIdempotency:async(u,key)=>jobs.get(u+':'+key)||null,claimPoll:async()=>({kind:'acquired',token:'token1'}),releasePoll:async()=>{},markCompleted:async(u,id,request,key)=>Object.assign(jobs.get(u+':attempt'),{state:'completed',resultKey:key}),markProviderFailed:async(u,id,request)=>Object.assign(jobs.get(u+':attempt'),{state:'failed'}),begin:async({userId,quoteId,idempotencyKey,quote})=>{const key=userId+':'+idempotencyKey;const existing=jobs.get(key);if(existing)return {kind:existing.quoteId===quoteId?'existing':'conflict',job:existing};const job={id:'job1',userId,state:'submitting',priceCents:quote.priceCents,quoteId};jobs.set(key,job);reserveCount++;return {kind:'created',job};},markSubmitted:async(u,id,falRequestId)=>Object.assign(jobs.get(u+':attempt'),{state:'queued',falRequestId}),markUnknown:async(u,id)=>Object.assign(jobs.get(u+':attempt'),{state:'unknown'}),markPreparationFailed:async(u,id)=>{const job=jobs.get(u+':attempt');if(job.state==='submitting'){job.state='failed';releaseCount++}return job;},getOwned:async(u,id)=>[...jobs.values()].find(j=>j.userId===u&&j.id===id)}};
  const fetcher=async(url,opts)=>{providerCalls++;assert.equal(opts.redirect,'manual');if(providerCalls===oversizedAt)return new Response('x'.repeat(65537));if(providerCalls===redirectAt)return new Response(null,{status:302,headers:{Location:'https://attacker.invalid/collect'}});if(fail)throw Error('connection');if(opts.method==='POST'){submitted={url,body:JSON.parse(opts.body),headers:opts.headers};return Response.json({request_id:'abc-123'});}if(url.endsWith('/status'))return statusResponse?statusResponse():Response.json({request_id:'abc-123',status:'COMPLETED',...(terminalError?{error:terminalError}:{})});if(resultResponse)return resultResponse();return Response.json({video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}});};
  return {assets,qs,services,handler:createGenerationHandler(services,fetcher),setUser:x=>caller=x,setFail:()=>fail=true,setTerminalError:e=>terminalError=e,setResultResponse:x=>resultResponse=x,setStatusResponse:x=>statusResponse=x,calls:()=>({providerCalls,uploadCalls,reserveCount,releaseCount,submitted})};
}
const body={imageId:'image',videoId:'video',quality:'pro',prompt:'Move',keepSound:true};
const quote=(f,b=body)=>f.handler(post('/api/generation-quotes',b));
const submit=(f,b={quoteId:'quote1',idempotencyKey:'attempt'})=>f.handler(post('/api/generations',b));
test('closed when dependencies absent and unverified duration cannot issue a quote',async()=>{assert.equal((await createGenerationHandler({})(get('/api/generations/a'))).status,503);const f=fixture();f.assets.video.durationVerified=false;assert.equal((await quote(f)).status,400);assert.equal(f.calls().providerCalls,0);});
test('quote binds configured pro price and explicitly confirmed job routes to correct v3 endpoint',async()=>{const f=fixture();let r=await quote(f,{...body,faceId:'face',angleIds:['angle']});assert.equal(r.status,201);assert.equal((await r.json()).priceCents,270);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);r=await submit(f);assert.equal(r.status,202);assert.equal((await r.json()).priceCents,270);assert.match(f.calls().submitted.url,/v3\/pro\/motion-control/);assert.equal(f.calls().submitted.headers['X-Fal-Store-IO'],'0');assert.equal(f.calls().submitted.headers['X-Fal-No-Retry'],'1');assert.equal(f.calls().submitted.headers['X-Fal-Request-Start-Timeout'],'300');assert.equal(f.calls().submitted.headers['x-app-fal-disable-fallback'],'true');assert.equal(JSON.parse(f.calls().submitted.headers['X-Fal-Object-Lifecycle-Preference']).initial_acl.default,'forbid');assert.equal(f.calls().submitted.body.elements[0].frontal_image_url,f.assets.face.url);assert.equal((await submit(f)).status,200);assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().providerCalls,1);});
test('three approved angle frames are bound in order after confirmation only',async()=>{
 const f=fixture();for(const id of ['angle2','angle3'])f.assets[id]={id,kind:'image',verified:true,sha256:'a'.repeat(64),url:`https://v3b.fal.media/files/b/fixture/${id}.jpg`};
 const r=await quote(f,{...body,faceId:'face',angleIds:['angle','angle2','angle3']});assert.equal(r.status,201);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 assert.equal(Object.hasOwn(f.qs.get('quote1').input,'providerContract'),false);
 assert.equal((await submit(f)).status,202);const payload=f.calls().submitted.body;
 assert.equal(f.calls().uploadCalls,6);assert.equal(payload.character_orientation,'video');assert.match(payload.prompt,/@Element1/);assert.deepEqual(payload.elements,[{frontal_image_url:f.assets.face.url,reference_image_urls:[f.assets.angle.url,f.assets.angle2.url,f.assets.angle3.url]}]);
});
test('wrong owner cannot see or use quote or job',async()=>{const f=fixture();await quote(f);await submit(f);f.setUser('u2');assert.equal((await submit(f)).status,409);assert.equal((await f.handler(get('/api/generations/job1'))).status,404);});
test('uncertain submissions do not resend or release funds',async()=>{const f=fixture();await quote(f);f.setFail();assert.equal((await (await submit(f)).json()).state,'unknown');assert.equal((await (await submit(f)).json()).state,'unknown');assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().providerCalls,1);});
test('freeze after reservation during media upload blocks provider submission',async()=>{
 const f=fixture();let frozen=false;const upload=f.services.assets.uploadOwned;
 f.services.assets.uploadOwned=async(...args)=>{const result=await upload(...args);frozen=true;return result};
 f.services.jobs.authorizeDispatch=async()=>!frozen;
 await quote(f);const r=await submit(f),body=await r.json();
 assert.equal(body.state,'failed');assert.equal(body.refundConfirmed,true);
 assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,1);
});
test('an uncertain dispatch decision never sends to fal or automatically releases credit',async()=>{
 const f=fixture();f.services.jobs.authorizeDispatch=async()=>{throw Error('lost database response')};
 await quote(f);const r=await submit(f),body=await r.json();
 assert.equal(body.state,'unknown');assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,0);
});
test('reject invalid prepared assets, excessive duration and non-own inherited model names',async()=>{const f=fixture();f.assets.image.sha256='invalid';assert.equal((await quote(f)).status,400);f.assets.image.sha256='a'.repeat(64);f.assets.video.durationSeconds=31;assert.equal((await quote(f)).status,400);assert.equal((await quote(f,{...body,quality:'toString'})).status,400);assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().uploadCalls,0);});
test('expired quotes cannot initiate paid submissions',async()=>{const f=fixture();await quote(f);f.qs.get('quote1').expiresAt=Date.now()-100;assert.equal((await submit(f)).status,409);assert.equal(f.calls().providerCalls,0);});

test('POST rejects absent or cross-site origin before any provider call',async()=>{const f=fixture();const req=new Request(endpoint+'/api/generation-quotes',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify(body)});assert.equal((await f.handler(req)).status,403);assert.equal(f.calls().providerCalls,0);});
test('oversized request body is rejected from stream before parsing or provider call',async()=>{const f=fixture();const req=new Request(endpoint+'/api/generation-quotes',{method:'POST',headers:{'content-type':'application/json',origin:endpoint},body:JSON.stringify({...body,prompt:'x'.repeat(9000)})});assert.equal((await f.handler(req)).status,400);assert.equal(f.calls().providerCalls,0);});

test('live mode fails closed until settlement is implemented',async()=>{const f=fixture();f.services.mode='live';assert.equal((await quote(f)).status,503);assert.equal(f.calls().providerCalls,0);});
test('finished provider result is stored privately and later accessed only by its owner',async()=>{
 const f=fixture();await quote(f);await submit(f);
 const response=await f.handler(get('/api/generations/job1'));assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'completed');assert.equal(result.videoPath,'/api/generations/job1/video');assert.equal(result.videoUrl,undefined);
 assert.equal((await f.handler(get(result.videoPath))).status,200);f.setUser('u2');assert.equal((await f.handler(get(result.videoPath))).status,404);
});
test('only explicit provider failure calls refund, and missing durable result does not report success',async()=>{
 const f=fixture();await quote(f);await submit(f);f.setTerminalError('Model failed');const r=await f.handler(get('/api/generations/job1'));assert.equal((await r.json()).state,'failed');
 const g=fixture();await quote(g);await submit(g);g.services.results.store=async()=>{throw Error('storage unavailable')};assert.equal((await g.handler(get('/api/generations/job1'))).status,503);assert.equal((await g.services.jobs.getOwned('u1','job1')).state,'queued');
});
test('concurrent status polling returns processing without duplicate result download',async()=>{
 const f=fixture();await quote(f);await submit(f);
 let held=false,downloads=0,release;let ready;const started=new Promise(r=>ready=r);const gate=new Promise(r=>release=r);
 f.services.jobs.claimPoll=async()=>held?{kind:'busy'}:(held=true,{kind:'acquired',token:'lease-1'});
 f.services.jobs.releasePoll=async()=>{held=false};
 f.services.results.store=async()=>{downloads++;ready();await gate;return 'private-key'};
 const first=f.handler(get('/api/generations/job1'));await started;
 const second=await f.handler(get('/api/generations/job1'));assert.equal(second.status,200);assert.equal((await second.json()).state,'processing');assert.equal(downloads,1);
 release();assert.equal((await (await first).json()).state,'completed');assert.equal(downloads,1);
});
test('a retry of the original submission remains recoverable after quote expiry',async()=>{
 const f=fixture();await quote(f);await submit(f);f.qs.get('quote1').expiresAt=Date.now()-1;
 assert.equal((await (await submit(f)).json()).state,'queued');assert.equal(f.calls().providerCalls,1);
 assert.equal((await submit(f,{quoteId:'other',idempotencyKey:'attempt'})).status,409);
});
test('camera setting preserves Mac prompt semantics before price is confirmed',async()=>{
 const f=fixture();assert.equal((await quote(f,{...body,steadyCamera:true})).status,201);
 const on=f.qs.get('quote1').input.prompt;assert.match(on,/tripod camera remains stationary/);assert.ok(on.endsWith('Move'));
 const g=fixture();assert.equal((await quote(g,{...body,steadyCamera:false})).status,201);assert.ok(g.qs.get('quote1').input.prompt.endsWith('Move'));assert.doesNotMatch(g.qs.get('quote1').input.prompt,/tripod/);
 assert.equal((await quote(g,{...body,steadyCamera:'yes'})).status,400);
});

test('queue submission, status and result redirects never follow or report success',async()=>{
 for(const step of [1,2,3]){
  const f=fixture(step);await quote(f);await submit(f);
  if(step===1){assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'unknown');assert.equal((await (await submit(f)).json()).state,'unknown');}
  else {assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');}
  assert.equal(f.calls().providerCalls,step);
 }
});

test('oversized queue submission or polling metadata never resubmits, refunds, or finishes a job',async()=>{
 for(const step of [1,2,3]){
  const f=fixture(0,step);let releases=0,failures=0,stores=0;
  f.services.jobs.releasePoll=async()=>{releases++};
  f.services.jobs.markProviderFailed=async()=>{failures++;throw Error('unexpected refund')};
  f.services.results.store=async()=>{stores++;throw Error('unexpected storage')};
  await quote(f);await submit(f);
  if(step===1){assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'unknown');await submit(f);assert.equal(releases,0);}
  else {assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');assert.equal(releases,1);}
  assert.equal(f.calls().providerCalls,step);assert.equal(failures,0);assert.equal(stores,0);
 }
});

test('no provider upload on quote, expired quote, insufficient credit or changed asset',async()=>{
 const f=fixture();assert.equal((await quote(f)).status,201);assert.equal(f.calls().uploadCalls,0);
 f.services.jobs.begin=async()=>({kind:'insufficient'});assert.equal((await submit(f)).status,402);assert.equal(f.calls().uploadCalls,0);
 const g=fixture();await quote(g);g.assets.image.sha256='b'.repeat(64);assert.equal((await (await submit(g)).json()).state,'failed');assert.equal(g.calls().providerCalls,0);assert.equal(g.calls().uploadCalls,1);assert.equal(g.calls().releaseCount,1);assert.equal((await (await submit(g)).json()).state,'failed');assert.equal(g.calls().releaseCount,1);
 const h=fixture();await quote(h);h.qs.get('quote1').expiresAt=Date.now()-1;assert.equal((await submit(h)).status,409);assert.equal(h.calls().uploadCalls,0);
});

test('when pre-submit refund cannot be confirmed, hold for review and do not contact queue',async()=>{
 const f=fixture();await quote(f);f.services.assets.uploadOwned=async()=>{throw Error('upload error')};f.services.jobs.markPreparationFailed=async()=>{throw Error('database error')};
 assert.equal((await (await submit(f)).json()).state,'unknown');assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,0);
});
test('fractional output is conservatively rounded up before showing the customer price',async()=>{const f=fixture();f.assets.video.durationSeconds=91/30;const r=await quote(f);assert.equal(r.status,201);const q=await r.json();assert.equal(q.durationSeconds,91/30);assert.equal(q.priceCents,4*30);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0)});

const editBody={imageId:'image',videoId:'video',quality:'edit-standard',prompt:'Replace the foreground soloist with the dog. Preserve the orchestra.',keepSound:true};
function editFixture(){const f=fixture();f.services.pricing.editStandard=20;f.services.inputGatewayOrigin='https://gateway.example';const mockedUrl=(assetId,ext)=>{const raw=JSON.stringify({v:1,jobId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',assetId,sha256:'a'.repeat(64),exp:Date.now()+300000});return 'https://gateway.example/provider-inputs/'+Buffer.from(raw).toString('base64url')+'.'+'a'.repeat(64)+'/'+assetId+'.'+ext};f.assets.image.url=mockedUrl('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','jpg');f.assets.video.url=mockedUrl('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','mp4');Object.assign(f.assets.video,{durationSeconds:5,width:1280,height:720,fps:30});return f;}
test('edit route is unavailable without an explicit configured price and rejects fixed-camera or incomplete identity controls',async()=>{
 const f=fixture();assert.equal((await quote(f,editBody)).status,503);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 const g=editFixture();for(const patch of [{angleIds:['angle']},{faceId:'face',angleIds:['angle','angle','angle','angle']},{steadyCamera:true}])assert.equal((await quote(g,{...editBody,...patch})).status,400);
 for(const patch of [{faceId:'face'},{faceId:'face',angleIds:['angle']}])assert.equal((await quote(g,{...editBody,...patch})).status,400,'historical transfer paths keep their original two-input scope');
 assert.equal(g.calls().uploadCalls,0);assert.equal(g.calls().providerCalls,0);
});
test('edit quote needs independently verified dimensions, frame rate and a 3–15 second clip',async()=>{
 for(const patch of [{width:719},{height:719},{width:undefined},{fps:undefined},{fps:22.99},{fps:60.01},{durationSeconds:15.001},{durationSeconds:2.99},{durationVerified:false}]){
  const f=editFixture();Object.assign(f.assets.video,patch);assert.equal((await quote(f,editBody)).status,400);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);assert.equal(f.qs.size,0);
 }
});
test('confirmed edit uses O3 payload, source camera and audio, with idempotent private results',async()=>{
 const f=editFixture();let r=await quote(f,editBody);assert.equal(r.status,201);const q=await r.json();assert.equal(q.priceCents,100);assert.equal(q.billedSeconds,5);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 const prompt=f.qs.get('quote1').input.prompt;assert.match(prompt,/@Video1/);assert.match(prompt,/@Image1/);assert.ok(prompt.endsWith(editBody.prompt));assert.doesNotMatch(prompt,/tripod|wide full-body|@Element1/);
 assert.equal(Object.hasOwn(f.qs.get('quote1').input,'providerContract'),false,'historical two-input probes keep their existing provider contract');
 r=await submit(f);assert.equal(r.status,202);assert.equal(f.calls().submitted.url,'https://queue.fal.run/fal-ai/kling-video/o3/standard/video-to-video/edit');
 assert.deepEqual(f.calls().submitted.body,{video_url:f.assets.video.url,image_urls:[f.assets.image.url],prompt,keep_audio:true,enable_safety_checker:true});
 assert.equal((await submit(f)).status,200);assert.equal(f.calls().providerCalls,1);assert.equal(f.calls().reserveCount,1);
 r=await f.handler(get('/api/generations/job1'));const completed=await r.json();assert.equal(completed.state,'completed');assert.equal(completed.videoPath,'/api/generations/job1/video');assert.equal(completed.videoUrl,undefined);
 f.setUser('u2');assert.equal((await f.handler(get(completed.videoPath))).status,404);
});
test('edit budget guard and provider price are checked before upload and again before dispatch',async()=>{
 const f=editFixture();let price=700000,claims=0;f.services.trialGuard={permits:async({priceCents})=>priceCents<=500,estimate:async(quality,duration)=>{assert.equal(quality,'edit-standard');assert.equal(duration,5);return price},claimOnce:async()=>{claims++;return true}};
 assert.equal((await quote(f,editBody)).status,201);assert.equal(f.calls().uploadCalls,0);price++;
 assert.equal((await (await submit(f)).json()).state,'failed');assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,1);assert.equal(claims,0);
 const g=editFixture();g.services.trialGuard={permits:async()=>false};assert.equal((await quote(g,editBody)).status,400);assert.equal(g.qs.size,0);assert.equal(g.calls().uploadCalls,0);
});
test('disabled or changed edit data cannot send media after the quote was created',async()=>{
 const f=editFixture();await quote(f,editBody);delete f.services.pricing.editStandard;assert.equal((await submit(f)).status,409);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);
 const g=editFixture();await quote(g,editBody);g.assets.video.height=719;assert.equal((await (await submit(g)).json()).state,'failed');assert.equal(g.calls().uploadCalls,0);assert.equal(g.calls().providerCalls,0);assert.equal(g.calls().releaseCount,1);
 const h=editFixture();await quote(h,editBody);h.qs.get('quote1').model='fal-ai/kling-video/v3/pro/motion-control';assert.equal((await submit(h)).status,409);assert.equal(h.calls().reserveCount,0);assert.equal(h.calls().uploadCalls,0);
});

test('O3 requires a nonblank user instruction at quote time and again for older stored quotes',async()=>{
 for(const prompt of [undefined,'','  \t\n','\u00a0\u2003']){
  const f=editFixture();assert.equal((await quote(f,{...editBody,prompt})).status,400);assert.equal(f.qs.size,0);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 }
 const old=editFixture();assert.equal((await quote(old,editBody)).status,201);old.qs.get('quote1').input.data.prompt=' \n';
 assert.equal((await submit(old)).status,409);assert.equal(old.calls().reserveCount,0);assert.equal(old.calls().uploadCalls,0);assert.equal(old.calls().providerCalls,0);
 const motion=fixture();assert.equal((await quote(motion,{...body,prompt:''})).status,201);
 const valid=editFixture();assert.equal((await quote(valid,{...editBody,prompt:'  voeg een hond toe  '})).status,201);
});

test('completed matching provider input-validation failure refunds once and reports persisted result',async()=>{
 const f=editFixture();let refunds=0;
 f.services.jobs.markProviderFailed=async(u,id,providerId,token,reason)=>{assert.deepEqual([u,id,providerId,token,reason],['u1','job1','abc-123','token1','provider_input_unavailable']);refunds++;return Object.assign(await f.services.jobs.getOwned(u,id),{state:'failed',falRequestId:providerId,failureCode:reason})};
 f.services.jobs.confirmInputFailureRefund=async()=>true;
 f.setResultResponse(()=>Response.json({detail:[{loc:['body'],msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.',type:'input_value_error'}]},{status:422}));
 await quote(f,editBody);await submit(f);let r=await f.handler(get('/api/generations/job1'));assert.equal(r.status,200);let body=await r.json();assert.equal(body.state,'failed');assert.equal(body.failureCode,'provider_input_unavailable');assert.equal(body.refundConfirmed,true);assert.equal(refunds,1);
 r=await f.handler(get('/api/generations/job1'));body=await r.json();assert.equal(body.state,'failed');assert.equal(body.failureCode,'provider_input_unavailable');assert.equal(body.refundConfirmed,true);assert.equal(refunds,1);assert.equal(f.calls().providerCalls,3);
});
test('large inline validation echoes settle only the configured owner edit and never leak or resubmit',async()=>{
 for(const enabledOwner of ['u1','other',undefined]){
  const f=editFixture();let refunds=0;
  f.services.jobs.markProviderFailed=async(u,id,providerId,_token,reason)=>{refunds++;return Object.assign(await f.services.jobs.getOwned(u,id),{state:'failed',falRequestId:providerId,failureCode:reason})};
  f.services.jobs.confirmInputFailureRefund=async()=>true;
  f.setResultResponse(()=>Response.json({request_id:'abc-123',detail:[{loc:['body'],msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.',type:'input_value_error',input:'data:video/mp4;base64,'+'A'.repeat(100000)}]},{status:422}));
  await quote(f,editBody);await submit(f);f.services.inlineO3Owner=enabledOwner;
  const response=await f.handler(get('/api/generations/job1')),result=await response.json();
  assert.doesNotMatch(JSON.stringify(result),/data:|base64|AAAA/);
  if(enabledOwner==='u1'){
   assert.equal(response.status,200);assert.equal(result.state,'failed');assert.equal(result.refundConfirmed,true);assert.equal(refunds,1);
   assert.equal((await f.handler(get('/api/generations/job1'))).status,200);assert.equal(refunds,1);assert.equal(f.calls().providerCalls,3);
  }else{assert.equal(response.status,503);assert.equal(refunds,0);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');}
 }
});
test('public jobs expose only allowlisted terminal failure codes and never imply an unconfirmed refund',async()=>{
 for(const failureCode of ['provider_input_unavailable','provider_subject_not_detected','provider_raw_failure: https://private.invalid/token','constructor',undefined]){
  const f=fixture();await quote(f);await submit(f);const job=await f.services.jobs.getOwned('u1','job1');
  Object.assign(job,{state:'failed',failureCode,providerError:'private diagnostic',providerInputUrl:'https://private.invalid/token'});
  f.services.jobs.confirmInputFailureRefund=async()=>false;
  const result=await (await f.handler(get('/api/generations/job1'))).json();
  assert.deepEqual(result,{id:'job1',state:'failed',priceCents:270,currency:'EUR',...(['provider_input_unavailable','provider_subject_not_detected'].includes(failureCode)?{failureCode}:{})});
  assert.equal(Object.hasOwn(result,'refundConfirmed'),false);assert.doesNotMatch(JSON.stringify(result),/private|token|diagnostic|abc-123/);
  job.state='unknown';assert.equal(Object.hasOwn(await (await f.handler(get('/api/generations/job1'))).json(),'failureCode'),false);
 }
});
test('generic failures report only a proven refund and remain recoverable without another provider request',async()=>{
 const f=fixture();let settled=false,proofReads=0;
 f.services.jobs.confirmFailureRefund=async(user,id,request)=>{assert.deepEqual([user,id,request],['u1','job1','abc-123']);proofReads++;return settled;};
 await quote(f);await submit(f);f.setTerminalError('private provider diagnostic');
 let result=await (await f.handler(get('/api/generations/job1'))).json();
 assert.equal(result.state,'failed');assert.equal(Object.hasOwn(result,'refundConfirmed'),false);assert.doesNotMatch(JSON.stringify(result),/diagnostic|provider_failed/);
 const before=f.calls();settled='true';result=await (await f.handler(get('/api/generations/job1'))).json();assert.equal(Object.hasOwn(result,'refundConfirmed'),false);
 settled=true;result=await (await f.handler(get('/api/generations/job1'))).json();assert.equal(result.refundConfirmed,true);
 assert.equal(proofReads,3);assert.deepEqual(f.calls(),before);
 f.setUser('u2');assert.equal((await f.handler(get('/api/generations/job1'))).status,404);assert.equal(proofReads,3);
});
test('other HTTP 422s and wrong status request IDs remain queued without refund',async()=>{
 const expected={loc:['body'],msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.',type:'input_value_error'};
 const cases=[()=>new Response('<html>422</html>',{status:422,headers:{'content-type':'text/html'}}),()=>Response.json({detail:'bad input'},{status:422}),()=>Response.json({detail:[{...expected,type:'other_error'}]},{status:422}),()=>Response.json({detail:[{...expected,loc:['other']}]},{status:422}),()=>Response.json({request_id:'wrong',detail:[expected]},{status:422}),()=>Response.json({detail:[expected,expected]},{status:422}),()=>Response.json({detail:[expected]},{status:503})];
 for(const value of cases){const f=editFixture();let refunds=0;f.services.jobs.markProviderFailed=async()=>{refunds++;throw Error('unexpected')};f.setResultResponse(value);await quote(f,editBody);await submit(f);assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');assert.equal(refunds,0)}
 const f=editFixture();let refunds=0;f.services.jobs.markProviderFailed=async()=>{refunds++;throw Error('unexpected')};f.setStatusResponse(()=>Response.json({request_id:'other',status:'COMPLETED'}));f.setResultResponse(()=>Response.json({detail:[expected]},{status:422}));await quote(f,editBody);await submit(f);assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal(refunds,0);assert.equal(f.calls().providerCalls,2);
});

test('exact observed pro subject rejection returns one proven refund, and is never resubmitted',async()=>{
 const f=fixture();let refunds=0;const message='Image recognition failed. Please make sure your image meets the requirements. Error: No complete upper body detected in the image; ensure the upper body is clearly visible.';
 f.services.jobs.markProviderFailed=async(u,id,providerId,token,reason)=>{assert.deepEqual([u,id,providerId,token,reason],['u1','job1','abc-123','token1','provider_subject_not_detected']);refunds++;return Object.assign(await f.services.jobs.getOwned(u,id),{state:'failed',falRequestId:providerId,failureCode:reason})};
 f.services.jobs.confirmInputFailureRefund=async()=>true;
 f.setResultResponse(()=>Response.json({detail:[{loc:['body'],msg:message,type:'input_value_error'}]},{status:422}));
 assert.equal((await quote(f)).status,201);assert.equal((await submit(f)).status,202);
 let r=await f.handler(get('/api/generations/job1'));assert.equal(r.status,200);let body=await r.json();assert.equal(body.state,'failed');assert.equal(body.failureCode,'provider_subject_not_detected');assert.equal(body.refundConfirmed,true);assert.equal(refunds,1);
 r=await f.handler(get('/api/generations/job1'));body=await r.json();assert.equal(body.refundConfirmed,true);assert.equal(refunds,1);assert.equal(f.calls().providerCalls,3);
});
test('subject errors with changed model, message, request ID, content-type or status remain unrefunded',async()=>{
 const msg='Image recognition failed. Please make sure your image meets the requirements. Error: No complete upper body detected in the image; ensure the upper body is clearly visible.';
 const exact={loc:['body'],msg,type:'input_value_error'};
 const cases=[()=>Response.json({detail:[{...exact,msg:msg+' extra'}]},{status:422}),()=>Response.json({detail:[{...exact,type:'other'}]},{status:422}),()=>Response.json({detail:[{...exact,loc:['other']}]},{status:422}),()=>Response.json({request_id:'wrong',detail:[exact]},{status:422}),()=>new Response(JSON.stringify({detail:[exact]}),{status:422,headers:{'content-type':'text/plain'}}),()=>Response.json({detail:[exact]},{status:500})];
 for(const response of cases){const f=fixture();let refunds=0;f.services.jobs.markProviderFailed=async()=>{refunds++;throw Error()};f.setResultResponse(response);await quote(f);await submit(f);assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal(refunds,0);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');}
 const f=fixture();let refunds=0;f.services.jobs.markProviderFailed=async()=>{refunds++;throw Error()};f.setResultResponse(()=>Response.json({detail:[exact]},{status:422}));await quote(f,{...body,quality:'standard'});await submit(f);assert.equal((await f.handler(get('/api/generations/job1'))).status,503);assert.equal(refunds,0);
});
test('known rejected subject blocks both motion prices and stale dispatch before reservation, but not O3 or another hash',async()=>{
 for(const quality of ['standard','pro']){
  const f=fixture();let blocked=false,checks=0;f.services.jobs.hasKnownSubjectRejection=async(user,sha)=>{checks++;assert.equal(user,'u1');return blocked&&sha==='a'.repeat(64)};
  assert.equal((await quote(f,{...body,quality})).status,201);blocked=true;
  const q=await quote(f,{...body,quality});assert.equal(q.status,400);const rejected=await q.json();assert.match(rejected.error,/zichtbaar menselijk bovenlichaam/);assert.equal(rejected.code,'subject_rejected');assert.equal(rejected.generationStarted,false);
  const stale=await submit(f);assert.equal(stale.status,409);const refused=await stale.json();assert.equal(refused.code,'subject_rejected');assert.equal(refused.generationStarted,false);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);assert.ok(checks>=3);
  f.assets.image.sha256='b'.repeat(64);assert.equal((await quote(f,{...body,quality})).status,201);
 }
 const edit=editFixture();edit.services.jobs.hasKnownSubjectRejection=async()=>{throw Error('must not inspect O3')};assert.equal((await quote(edit,editBody)).status,201);assert.equal((await submit(edit)).status,202);
});
test('subject lookup failure or a missing lookup fails closed before a quote or reservation',async()=>{
 for(const check of [undefined,async()=>{throw Error('database unavailable')}]){
  const f=fixture();await quote(f);f.services.jobs.hasKnownSubjectRejection=check;
  assert.equal((await quote(f)).status,503);assert.equal((await submit(f)).status,503);
  assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 }
});
test('a prior accepted job remains recoverable and is never labeled as an unstarted subject rejection',async()=>{
 const f=fixture();assert.equal((await quote(f)).status,201);assert.equal((await submit(f)).status,202);
 f.services.jobs.hasKnownSubjectRejection=async()=>true;
 const recovered=await submit(f);assert.equal(recovered.status,200);const value=await recovered.json();assert.equal(value.state,'queued');assert.equal(value.code,undefined);assert.equal(value.generationStarted,undefined);assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().providerCalls,1);
});

const temporaryPolicy='fal-temporary-links-v1';
const temporarySelection={...editBody,transferPolicy:temporaryPolicy};
const temporaryConfirmation={quoteId:'quote1',idempotencyKey:'attempt',transferConsent:temporaryPolicy};
function temporaryFixture(){
 const f=editFixture();f.services.inlineO3Owner='u1';
 for(const [id,a]of Object.entries(f.assets)){a.url=`https://v3b.fal.media/files/b/fixture/${id}.${a.kind==='video'?'mp4':'jpg'}`;a.size=32;}
 const upload=f.services.assets.uploadOwned,contexts=[];
 f.services.assets.uploadOwned=async(...args)=>{contexts.push(args[3]);return upload(...args)};
 return {...f,contexts};
}
test('text cleanup is bound before the price and sent in the same single motion or edit generation within the provider prompt limit',async()=>{
 const variants=[];
 for(const quality of ['standard','pro'])for(const steadyCamera of [false,true])for(const identity of [false,true])variants.push({quality,steadyCamera,identity});
 for(const identity of [false,true])variants.push({quality:'edit-standard',steadyCamera:false,identity});
 for(const variant of variants)for(const userPrompt of ['Maak mijn video.','a'.repeat(1900),'😀'.repeat(950)]){
  const edit=variant.quality==='edit-standard',f=edit?temporaryFixture():fixture();
  const selection={...(edit?temporarySelection:body),quality:variant.quality,steadyCamera:variant.steadyCamera,prompt:userPrompt,...(variant.identity?{faceId:'face',angleIds:['angle']}:{})};
  const response=await quote(f,selection),price=await response.json();assert.equal(response.status,201);
  assert.equal(price.priceCents,edit?100:variant.quality==='pro'?270:180);
  const stored=f.qs.get('quote1').input;
  assert.equal(stored.data.prompt,userPrompt);assert.ok(stored.prompt.length<=2500);assert.equal(stored.prompt.isWellFormed(),true);
  assert.match(stored.prompt,/Remove all visible text, letters, captions, subtitles, app interfaces, logos and overlays/);
  assert.match(stored.prompt,/preserving the subject, movement, camera and audio/);
  if(edit){assert.match(stored.prompt,/@Video1/);assert.match(stored.prompt,/@Element1/);assert.doesNotMatch(stored.prompt,/@Image1/);assert.ok(stored.prompt.endsWith(userPrompt));}
  else if(variant.steadyCamera)assert.match(stored.prompt,/tripod camera remains stationary/);
  else assert.ok(stored.prompt.endsWith(userPrompt));
  if(variant.identity)assert.match(stored.prompt,/@Element1/);
  assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
  assert.equal((await submit(f,edit?temporaryConfirmation:undefined)).status,202);
  assert.equal(f.calls().submitted.body.prompt,stored.prompt);assert.ok(f.calls().submitted.body.prompt.length<=2500);assert.equal(f.calls().providerCalls,1);assert.equal(f.calls().reserveCount,1);
  assert.equal((await submit(f,edit?temporaryConfirmation:undefined)).status,200);assert.equal(f.calls().providerCalls,1);
 }
});
test('temporary Fal links are offered only for an explicitly requested O3 quote without uploading',async()=>{
 const f=temporaryFixture();const response=await quote(f,temporarySelection),q=await response.json();
 assert.equal(response.status,201);assert.equal(q.transferPolicy,temporaryPolicy);assert.equal(q.transferConsentRequired,true);
 assert.equal(f.qs.get('quote1').input.data.transferPolicy,temporaryPolicy);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().providerCalls,0);
 for(const policy of ['public','private',true,null,{},'fal-temporary-links-v2']){
  const invalid=temporaryFixture();assert.equal((await quote(invalid,{...temporarySelection,transferPolicy:policy})).status,400);assert.equal(invalid.qs.size,0);
 }
 for(const quality of ['standard','pro']){
  const motion=fixture();assert.equal((await quote(motion,{...body,quality,transferPolicy:temporaryPolicy})).status,400);assert.equal(motion.qs.size,0);
 }
 const privateEdit=editFixture(),privatePrice=await(await quote(privateEdit,editBody)).json();
 assert.equal(Object.hasOwn(privatePrice,'transferPolicy'),false);assert.equal(Object.hasOwn(privatePrice,'transferConsentRequired'),false);
});
test('temporary Fal transfer needs exact quote-bound consent before reservation or media export',async()=>{
 for(const patch of [{},{transferConsent:true},{transferConsent:null},{transferConsent:'public'},{transferConsent:temporaryPolicy,transferPolicy:temporaryPolicy}]){
  const f=temporaryFixture();await quote(f,temporarySelection);
  const response=await submit(f,{quoteId:'quote1',idempotencyKey:'attempt',...patch});
  assert.equal(response.status,400);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 }
 const privateEdit=editFixture();await quote(privateEdit,editBody);
 assert.equal((await submit(privateEdit,temporaryConfirmation)).status,400);assert.equal(privateEdit.calls().reserveCount,0);assert.equal(privateEdit.calls().uploadCalls,0);assert.equal(privateEdit.calls().providerCalls,0);
 const motion=fixture();await quote(motion);
 assert.equal((await submit(motion,temporaryConfirmation)).status,400);assert.equal(motion.calls().reserveCount,0);assert.equal(motion.calls().uploadCalls,0);
});
test('confirmed temporary edit uses exact O3 CDN body and one-day lifecycle while preserving guards and idempotency',async()=>{
 const f=temporaryFixture();await quote(f,temporarySelection);
 const response=await submit(f,temporaryConfirmation);assert.equal(response.status,202);assert.equal((await response.json()).state,'queued');
 assert.deepEqual(f.contexts,[{jobId:'job1',model:'fal-ai/kling-video/o3/standard/video-to-video/edit',transferPolicy:temporaryPolicy},{jobId:'job1',model:'fal-ai/kling-video/o3/standard/video-to-video/edit',transferPolicy:temporaryPolicy}]);
 const {submitted}=f.calls();assert.equal(submitted.url,'https://queue.fal.run/fal-ai/kling-video/o3/standard/video-to-video/edit');
 assert.deepEqual(submitted.body,{video_url:f.assets.video.url,elements:[{frontal_image_url:f.assets.image.url,reference_image_urls:[f.assets.image.url]}],prompt:f.qs.get('quote1').input.prompt,keep_audio:true,enable_safety_checker:true,shot_type:'customize'});
 assert.deepEqual(JSON.parse(submitted.headers['X-Fal-Object-Lifecycle-Preference']),{expiration_duration_seconds:86400});
 assert.equal(submitted.headers['X-Fal-Store-IO'],'0');assert.equal(submitted.headers['X-Fal-No-Retry'],'1');assert.equal(submitted.headers['x-app-fal-disable-fallback'],'true');assert.equal(submitted.headers['X-Fal-Request-Start-Timeout'],'300');
 // A retry recovers the original accepted job, even after price expiry or
 // without another consent field; it cannot trigger a second export/charge.
 f.qs.get('quote1').expiresAt=Date.now()-1;assert.equal((await submit(f)).status,200);
 assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().uploadCalls,2);assert.equal(f.calls().providerCalls,1);
});
function addEditAngles(f){
 f.assets.angle2={id:'angle2',kind:'image',verified:true,sha256:'a'.repeat(64),size:32,url:'https://v3b.fal.media/files/b/fixture/angle2.jpg'};
 return {...temporarySelection,faceId:'face',angleIds:['angle','angle2']};
}
test('temporary edit uses the correct source video and all four selected identity photos without scene images after quote-bound consent',async()=>{
 const f=temporaryFixture(),selection=addEditAngles(f);f.assets.video.durationSeconds=4.92;const r=await quote(f,selection),q=await r.json();
 assert.equal(r.status,201);assert.equal(q.priceCents,100);assert.equal(q.billedSeconds,5);
 assert.equal(q.durationSeconds,4.92);
 assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().providerCalls,0);
 const ids=['image','video','face','angle','angle2'];
 assert.deepEqual(f.qs.get('quote1').input.refs,ids.map(id=>({id,kind:f.assets[id].kind,sha256:f.assets[id].sha256})));
 assert.equal(f.qs.get('quote1').input.providerContract,'o3-identity-only-v1');
 assert.equal((await submit(f)).status,400);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().reserveCount,0);
 assert.equal((await submit(f,temporaryConfirmation)).status,202);
 assert.equal(f.calls().uploadCalls,5);assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().providerCalls,1);
 assert.deepEqual(f.contexts,ids.map(()=>({jobId:'job1',model:'fal-ai/kling-video/o3/standard/video-to-video/edit',transferPolicy:temporaryPolicy})));
 const payload=f.calls().submitted.body;
 assert.equal(payload.video_url,f.assets.video.url);assert.equal(Object.hasOwn(payload,'image_urls'),false);
 assert.deepEqual(payload.elements,[{frontal_image_url:f.assets.face.url,reference_image_urls:[f.assets.image.url,...selection.angleIds.map(id=>f.assets[id].url)]}]);
 assert.deepEqual([payload.elements[0].frontal_image_url,...payload.elements[0].reference_image_urls],[f.assets.face.url,f.assets.image.url,f.assets.angle.url,f.assets.angle2.url]);
 assert.match(payload.prompt,/@Video1 alone defines the scene, background, shot size, camera, body and facial motion, and timing/);assert.match(payload.prompt,/never copy their room, pose or framing/);assert.doesNotMatch(payload.prompt,/@Image1/);assert.match(payload.prompt,/@Element1/);assert.ok(payload.prompt.endsWith(selection.prompt));
 assert.equal(payload.keep_audio,true);assert.equal(payload.enable_safety_checker,true);assert.equal(payload.shot_type,'customize');
 assert.deepEqual(JSON.parse(f.calls().submitted.headers['X-Fal-Object-Lifecycle-Preference']),{expiration_duration_seconds:86400});
 assert.equal((await submit(f,temporaryConfirmation)).status,200);assert.equal(f.calls().providerCalls,1);assert.equal(f.calls().uploadCalls,5);
});
test('a third edit angle is clearly rejected before pricing or export while three motion angles remain supported',async()=>{
 const f=temporaryFixture(),selection=addEditAngles(f);
 f.services.assets.getOwned=async()=>{throw Error('An oversized edit identity must not read assets');};
 const response=await quote(f,{...selection,angleIds:['angle','angle2','angle3']}),rejection=await response.json();
 assert.equal(response.status,400);assert.match(rejection.error,/maximaal vier foto’s.*twee hoeken/);
 assert.equal(f.qs.size,0);assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
});
test('an unstarted temporary edit with an absent or old provider contract needs a fresh price before funding or export',async()=>{
 for(const contract of [undefined,'o3-image-and-element-v0','o3-identity-only-v2']){
  const f=temporaryFixture();await quote(f,addEditAngles(f));
  if(contract===undefined)delete f.qs.get('quote1').input.providerContract;else f.qs.get('quote1').input.providerContract=contract;
  let starts=0;f.services.jobs.begin=async()=>{starts++;throw Error('An old quote must not reserve');};
  const response=await submit(f,temporaryConfirmation),rejection=await response.json();
  assert.equal(response.status,409);assert.match(rejection.error,/opnieuw de prijs/);assert.equal(starts,0);
  assert.equal(f.calls().reserveCount,0);assert.equal(f.calls().uploadCalls,0);assert.equal(f.calls().providerCalls,0);
 }
});
test('an already accepted edit remains recoverable and completes after its stored quote contract changes',async()=>{
 const f=temporaryFixture();await quote(f,addEditAngles(f));assert.equal((await submit(f,temporaryConfirmation)).status,202);
 delete f.qs.get('quote1').input.providerContract;f.qs.get('quote1').expiresAt=Date.now()-1;
 // Older accepted edits could include a third angle. Status/result recovery
 // retains that read contract even though a new identity-only edit allows two.
 f.qs.get('quote1').input.data.angleIds.push('historical-third-angle');f.qs.get('quote1').input.refs.push({id:'historical-third-angle',kind:'image',sha256:'a'.repeat(64)});
 const replay=await(await submit(f,temporaryConfirmation)).json();assert.equal(replay.state,'queued');assert.equal(f.calls().providerCalls,1);assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().uploadCalls,5);
 const completed=await(await f.handler(get('/api/generations/job1'))).json();assert.equal(completed.state,'completed');assert.equal(completed.videoPath,'/api/generations/job1/video');
 const calls=f.calls().providerCalls;const completedReplay=await(await submit(f,temporaryConfirmation)).json();assert.equal(completedReplay.state,'completed');assert.equal(f.calls().providerCalls,calls);assert.equal(f.calls().reserveCount,1);assert.equal(f.calls().uploadCalls,5);
});
test('an edit close-up uses the main image as its required angle when no extra angles are selected',async()=>{
 const f=temporaryFixture();assert.equal((await quote(f,{...temporarySelection,faceId:'face'})).status,201);
 assert.equal((await submit(f,temporaryConfirmation)).status,202);
 assert.deepEqual(f.calls().submitted.body.elements,[{frontal_image_url:f.assets.face.url,reference_image_urls:[f.assets.image.url]}]);
 assert.equal(f.calls().uploadCalls,3);
});
test('foreign or modified edit identity inputs never reach the paid provider dispatch',async()=>{
 const foreign=temporaryFixture(),selection=addEditAngles(foreign),owned=foreign.services.assets.getOwned;
 foreign.services.assets.getOwned=async(user,id)=>id==='angle2'?null:owned(user,id);
 assert.equal((await quote(foreign,selection)).status,400);assert.equal(foreign.qs.size,0);assert.equal(foreign.calls().uploadCalls,0);assert.equal(foreign.calls().reserveCount,0);assert.equal(foreign.calls().providerCalls,0);
 for(const id of ['face','angle','angle2']){
  const f=temporaryFixture();await quote(f,addEditAngles(f));f.assets[id].sha256='b'.repeat(64);
  const response=await submit(f,temporaryConfirmation),failed=await response.json();
  assert.equal(failed.state,'failed');assert.equal(failed.refundConfirmed,true);assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,1);
  assert.equal((await(await submit(f,temporaryConfirmation)).json()).state,'failed');assert.equal(f.calls().releaseCount,1);
 }
});
test('temporary transfer bypasses the old owner-only inline restriction but keeps actual O3 duration checks',async()=>{
 const f=temporaryFixture();f.assets.video.durationSeconds=8.2;assert.equal((await quote(f,temporarySelection)).status,201);assert.equal((await submit(f,temporaryConfirmation)).status,202);
 const invalid=temporaryFixture();invalid.assets.video.durationSeconds=15.01;assert.equal((await quote(invalid,temporarySelection)).status,400);assert.equal(invalid.calls().reserveCount,0);
});
test('temporary CDN inputs reject signed URLs, inline bytes or changed manifests before dispatch and refund once',async()=>{
 for(const patch of [{url:'https://v3b.fal.media/files/b/fixture/image.jpg?token=private'},{url:'data:image/jpeg;base64,/9j/'},{inline:true},{id:'wrong'},{size:0},{sha256:'b'.repeat(64)}]){
  const f=temporaryFixture();await quote(f,temporarySelection);Object.assign(f.assets.image,patch);
  const response=await submit(f,temporaryConfirmation),job=await response.json();
  assert.equal(job.state,'failed');assert.equal(job.refundConfirmed,true);assert.equal(f.calls().providerCalls,0);assert.equal(f.calls().releaseCount,1);
  assert.equal((await(await submit(f,temporaryConfirmation)).json()).state,'failed');assert.equal(f.calls().releaseCount,1);
 }
});
test('result download derives temporary transfer only from the owned persisted quote and stores privately',async()=>{
 const f=temporaryFixture();await quote(f,temporarySelection);await submit(f,temporaryConfirmation);
 let observed;
 f.services.results.store=async(job,url,options)=>{observed={job,url,options};return `rig-results/${job.id}.mp4`};
 const result=await(await f.handler(get('/api/generations/job1?transferPolicy=private'))).json();
 assert.equal(result.state,'completed');assert.equal(result.videoPath,'/api/generations/job1/video');assert.equal(result.videoUrl,undefined);
 assert.equal(observed.options.transferPolicy,temporaryPolicy);assert.ok(observed.options.signal instanceof AbortSignal);
 assert.doesNotMatch(JSON.stringify(result),/v3b\.fal|temporary-links|test-key/);
 const privateMotion=fixture();await quote(privateMotion);await submit(privateMotion);let privateOptions;
 privateMotion.services.results.store=async(_job,_url,options)=>{privateOptions=options;return 'private-key'};
 assert.equal((await privateMotion.handler(get('/api/generations/job1?transferPolicy='+temporaryPolicy))).status,200);
 assert.equal(Object.hasOwn(privateOptions,'transferPolicy'),false);
});
test('missing or corrupted quote policy prevents result access before any provider read',async()=>{
 for(const modify of [q=>{q.input.data.transferPolicy='public'},q=>{q.input.data.quality='pro'},q=>{q.userId='other'}]){
  const f=temporaryFixture();await quote(f,temporarySelection);await submit(f,temporaryConfirmation);modify(f.qs.get('quote1'));
  const response=await f.handler(get('/api/generations/job1'));assert.equal(response.status,503);assert.equal(f.calls().providerCalls,1);assert.equal((await f.services.jobs.getOwned('u1','job1')).state,'queued');
 }
});
