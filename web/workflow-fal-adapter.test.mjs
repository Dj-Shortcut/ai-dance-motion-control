import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkflowFalAdapter,WORKFLOW_RESULT_LIMIT} from './workflow-fal-adapter.mjs';
import {createOverlayCleanupPlan,OVERLAY_CLEANUP_MODEL,OVERLAY_CLEANUP_QUEUE_FAMILY,OVERLAY_CLEANUP_CONTRACT,OVERLAY_CLEANUP_SETTINGS,OVERLAY_CLEANUP_BILLING} from './overlay-cleanup-contract.mjs';
import {RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_QUALITY,RECAST_SETTINGS} from './recast-contract.mjs';
import {WORKFLOW_CLIENT_CONTRACT,workflowClientMedia} from './workflow-client-contract.mjs';
import {WORKFLOW_TRANSFER_POLICY} from './workflow-runner.mjs';
import {workflowPlanHash,workflowHash} from './production-workflow-stores.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',JOB='12345678-1234-4123-8123-123456789abc',SOURCE='12345678-1234-4123-8123-123456789ab1',MASK='12345678-1234-4123-8123-123456789ab2',IMAGE='12345678-1234-4123-8123-123456789ab3',SHA='a'.repeat(64),REQUEST='official-request-id';
const run=promisify(execFile);let directory,clips;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rig-workflow-fal-adapter-'));const source=join(directory,'source.mp4'),clean=join(directory,'clean.mp4'),mask=join(directory,'mask.mp4'),base=join(directory,'base.mp4'),short=join(directory,'short.mp4'),silent=join(directory,'silent.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:20000});
 await run('ffmpeg',['-v','error','-i',source,'-map','0:v','-c','copy','-an',clean],{timeout:10000});
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=black:size=360x640:rate=24','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-an',mask],{timeout:10000});
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=1080x1920:rate=30','-i',source,'-t','6','-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-threads','2','-pix_fmt','yuv420p','-c:a','copy',base],{timeout:20000});
 await run('ffmpeg',['-v','error','-i',base,'-t','5','-c','copy',short],{timeout:10000});
 await run('ffmpeg',['-v','error','-i',base,'-map','0:v','-an','-c','copy',silent],{timeout:10000});
 clips={};for(const [role,path]of Object.entries({source,clean,mask,base,short,silent})){const bytes=new Uint8Array(await readFile(path));clips[role]={bytes,meta:await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':role==='source'?'input':'result'})};}
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
function bucket(){const items=new Map();return {items,async head(key){return items.get(key)??null},async get(key){const item=items.get(key);return item?{...item,body:new Response(item.bytes).body}:null},async put(key,bytes,options){assert.equal(options.onlyIf.etagDoesNotMatch,'*');if(items.has(key))return null;const item={bytes:bytes.slice(),size:bytes.length,httpMetadata:structuredClone(options.httpMetadata),customMetadata:structuredClone(options.customMetadata)};items.set(key,item);return item;}};}
async function fixture(){
 const cleanup=createOverlayCleanupPlan({source:clips.source.meta,mask:clips.mask.meta,maskSourceSha256:clips.source.meta.sha256,billing:{...OVERLAY_CLEANUP_BILLING},baseProviderEstimateUsdMicros:2700000});
 const pre={id:'source-cleanup',kind:'preclean',model:OVERLAY_CLEANUP_MODEL,queueFamily:OVERLAY_CLEANUP_QUEUE_FAMILY,contract:OVERLAY_CLEANUP_CONTRACT,settings:{...OVERLAY_CLEANUP_SETTINGS},dependsOn:null,providerEstimateUsdMicros:cleanup.providerEstimateUsdMicros,retailCents:75};
 const base={id:'base',kind:'base',model:RECAST_MODEL,queueFamily:RECAST_QUEUE_FAMILY,contract:RECAST_PROVIDER_CONTRACT,settings:{...RECAST_SETTINGS},dependsOn:pre.id,providerEstimateUsdMicros:2700000,retailCents:300};
 const plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:375,cleanupRetailCents:0,steps:[pre,base],clientProcessing:{id:'compose',contract:WORKFLOW_CLIENT_CONTRACT,beforeStepId:'base',cleanFromStepId:pre.id,source:{id:SOURCE,sha256:clips.source.meta.sha256},mask:{id:MASK,sha256:clips.mask.meta.sha256},media:workflowClientMedia(clips.source.meta)}};plan.planHash=await workflowPlanHash(plan);
 const prompt='Replace the person with the reference photo and preserve camera movement.',image={id:IMAGE,kind:'image',sha256:SHA};
 const quote={id:'quote',userId:USER,model:RECAST_MODEL,fundingKind:'owner-provider',priceCents:375,durationSeconds:6,input:{data:{imageId:IMAGE,videoId:SOURCE,faceId:null,angleIds:[],quality:RECAST_QUALITY,prompt,keepSound:true,steadyCamera:false,transferPolicy:WORKFLOW_TRANSFER_POLICY},prompt,providerContract:RECAST_PROVIDER_CONTRACT,providerSettings:{...RECAST_SETTINGS},refs:[image,{id:SOURCE,kind:'video',sha256:clips.source.meta.sha256},{id:MASK,kind:'video',sha256:clips.mask.meta.sha256}],cleanup,workflow:plan,providerEstimateUsdMicros:cleanup.combinedProviderEstimateUsdMicros}};
 const pair={source:{record:{id:SOURCE,userId:USER,kind:'source'},bytes:clips.source.bytes,inspection:clips.source.meta},mask:{record:{id:MASK,userId:USER,kind:'mask',source:{id:SOURCE,sha256:clips.source.meta.sha256}},bytes:clips.mask.bytes,inspection:clips.mask.meta}};
 const network=[],uploaded=new Map(),imageCalls=[],inputCalls=[],privateBucket=bucket();let index=0;
 const options={falKey:'fixture-key-not-real',privateBucket,inputs:{async getPair(args){inputCalls.push(args);return pair}},assets:{async uploadOwned(...args){imageCalls.push(args);return {verified:true,kind:'image',id:IMAGE,sha256:SHA,size:5,url:'https://v3b.fal.media/files/b/fixture/photo.jpg'}}}};
 const response=(bytes,type='video/mp4')=>new Response(bytes,{headers:{'content-type':type,'content-length':String(bytes.length)}});
 const fetchImpl=async(url,init={})=>{
  network.push({url,init});assert.equal(init.redirect,'manual');
  if(url.startsWith('https://api.fal.ai/v1/models/pricing?')){const endpoint=new URL(url).searchParams.get('endpoint_id');return Response.json({prices:[{endpoint_id:endpoint,currency:'USD',unit:endpoint===RECAST_MODEL?'units':'megapixels',unit_price:endpoint===RECAST_MODEL?0.05:OVERLAY_CLEANUP_BILLING.unitPrice}]});}
  if(url.startsWith('https://rest.fal.ai/storage/upload/initiate?')){const name=++index;return Response.json({upload_url:`https://upload.fal.media/${name}`,file_url:`https://v3b.fal.media/files/b/fixture/input-${name}.mp4`});}
  if(url.startsWith('https://upload.fal.media/')){assert.equal(new Headers(init.headers).has('authorization'),false);uploaded.set(url.split('/').at(-1),new Uint8Array(await init.body.arrayBuffer()));return new Response(null,{status:200});}
  const input=url.match(/^https:\/\/v3b\.fal\.media\/files\/b\/fixture\/input-(\d+)\.mp4$/);if(input){assert.equal(new Headers(init.headers).has('authorization'),false);return response(uploaded.get(input[1]));}
  if(url==='https://v3b.fal.media/files/b/fixture/result.mp4')return response(clips.clean.bytes);
  if(url.startsWith('https://queue.fal.run/')){if(init.method==='POST')return Response.json({request_id:REQUEST,response_url:'https://attacker.invalid/result',status_url:'https://attacker.invalid/status'});if(url.endsWith('/status'))return Response.json({status:'IN_PROGRESS',request_id:REQUEST});return Response.json({video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}});}
  throw Error('Unexpected fixture request');
 };
 const transport=(...args)=>f.transport(...args);options.fetchImpl=transport;
 const f={options,network,uploaded,imageCalls,inputCalls,privateBucket,pair,quote,plan,pre,base,image,transport:fetchImpl,response};
 f.adapter=createWorkflowFalAdapter(options);
 f.prepare=async(step=pre)=>{let inputBinding;if(step===pre){const value={kind:'source-and-mask',source:plan.clientProcessing.source,mask:plan.clientProcessing.mask};inputBinding={...value,inputHash:await workflowHash(value)}}else inputBinding={kind:'client-composed',inputHash:clips.source.meta.sha256,artifact:{id:'composed',sha256:clips.source.meta.sha256,size:clips.source.bytes.length},bytes:clips.source.bytes,inspection:clips.source.meta,image};return f.adapter.prepareStep({userId:USER,jobId:JOB,quote,plan,step,inputBinding});};
 f.submitArgs=async(step=pre)=>{const p=await f.prepare(step);return {userId:USER,jobId:JOB,stepId:step.id,model:step.model,queueFamily:step.queueFamily,contract:step.contract,payload:p.payload,inputHash:p.inputHash,requestHash:await workflowHash({model:step.model,queueFamily:step.queueFamily,contract:step.contract,settings:step.settings,inputHash:p.inputHash,payload:p.payload}),dispatchToken:crypto.randomUUID()};};
 f.pollArgs=(step=pre)=>({userId:USER,jobId:JOB,stepId:step.id,model:step.model,queueFamily:step.queueFamily,contract:step.contract,requestId:REQUEST});
 f.persist=async(step=pre)=>{const previous=f.transport,path=`https://queue.fal.run/${step.queueFamily}/requests/${REQUEST}`;f.transport=(url,init)=>url===path+'/status'?Promise.resolve(Response.json({request_id:REQUEST,status:'COMPLETED'})):url===path?Promise.resolve(Response.json({video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}})):previous(url,init);try{const polled=await f.adapter.pollStep(f.pollArgs(step));return await f.adapter.persistStepResult({userId:USER,jobId:JOB,quote,plan,step,requestId:REQUEST,providerResult:polled.result,resultKey:`rig-workflow-results/${JOB}/${step.id}.mp4`});}finally{f.transport=previous}};
 return f;
}

test('Fal adapter requires explicit secrets, owned stores and transport without fallback defaults',async()=>{
 const f=await fixture();for(const key of ['falKey','fetchImpl','inputs','assets','privateBucket'])assert.throws(()=>createWorkflowFalAdapter({...f.options,[key]:undefined}));assert.throws(()=>createWorkflowFalAdapter({...f.options,falKey:'key\r\nInjected: yes'}));
 await assert.rejects(f.adapter.pollStep({...f.pollArgs(),model:'other/model'}));assert.equal(f.network.length,0);
});
test('cleanup preparation rechecks exact owned bytes and live billing, then verifies two24h uploads without queuing',async()=>{
 const f=await fixture(),p=await f.prepare();assert.deepEqual(f.inputCalls,[{userId:USER,sourceId:SOURCE,maskId:MASK}]);assert.equal(p.payload.num_inference_steps,30);assert.equal(p.payload.video_quality,'maximum');assert.equal(p.payload.generate_audio,false);assert.equal(f.uploaded.size,2);assert.deepEqual(f.uploaded.get('1'),clips.source.bytes);assert.deepEqual(f.uploaded.get('2'),clips.mask.bytes);
 for(const request of f.network.filter(x=>x.url.startsWith('https://rest.fal.ai/storage/upload/initiate')))assert.deepEqual(JSON.parse(new Headers(request.init.headers).get('X-Fal-Object-Lifecycle-Preference')),{expiration_duration_seconds:86400});assert.ok(!f.network.some(x=>x.url.startsWith('https://queue.fal.run')));
});
test('changed owned bytes or provider billing abort before any media transfer',async()=>{
 const f=await fixture();f.pair.source.bytes=clips.mask.bytes;await assert.rejects(f.prepare());assert.equal(f.uploaded.size,0);
 const g=await fixture(),original=g.transport;g.transport=async(url,init)=>url.startsWith('https://api.fal.ai/')?Response.json({prices:[{endpoint_id:OVERLAY_CLEANUP_MODEL,currency:'USD',unit:'seconds',unit_price:0.01}]}):original(url,init);await assert.rejects(g.prepare());assert.equal(g.uploaded.size,0);
});
test('base preparation uploads only the held composed bytes and the exact quoted photo at1080P',async()=>{
 const f=await fixture(),p=await f.prepare(f.base);assert.equal(p.inputHash,clips.source.meta.sha256);assert.equal(p.payload.resolution,'1080P');assert.equal(p.payload.enhance_realism,true);assert.equal(p.payload.enable_safety_checker,true);assert.equal(p.payload.prompt,f.quote.input.prompt);assert.deepEqual(f.uploaded.get('1'),clips.source.bytes);assert.deepEqual(f.imageCalls,[[USER,IMAGE,SHA,{jobId:JOB,model:RECAST_MODEL,transferPolicy:WORKFLOW_TRANSFER_POLICY}]]);assert.equal(f.inputCalls.length,0);
});
test('a changed photo, unconfirmed composed input or shifted billing is never silently substituted',async()=>{
 const f=await fixture();f.options.assets.uploadOwned=async()=>({verified:true,kind:'image',id:IMAGE,sha256:'b'.repeat(64),size:1,url:'https://v3b.fal.media/files/b/fixture/photo.jpg'});await assert.rejects(f.prepare(f.base));assert.equal(f.uploaded.size,0);
 const g=await fixture();g.plan.clientProcessing.media.audio.packetSha256=SHA;await assert.rejects(g.prepare(g.base));assert.equal(g.network.length,0);
});
test('queue submission has fixed contracts, zero retries, disabled fallback and24h IO retention settings',async()=>{
 const f=await fixture(),args=await f.submitArgs();assert.deepEqual(await f.adapter.submitStep(args),{requestId:REQUEST});const calls=f.network.filter(x=>x.url.startsWith('https://queue.fal.run'));assert.equal(calls.length,1);assert.equal(calls[0].url,'https://queue.fal.run/'+OVERLAY_CLEANUP_MODEL);const h=new Headers(calls[0].init.headers);assert.equal(h.get('X-Fal-No-Retry'),'1');assert.equal(h.get('X-Fal-Store-IO'),'0');assert.equal(h.get('x-app-fal-disable-fallback'),'true');assert.deepEqual(JSON.parse(h.get('X-Fal-Object-Lifecycle-Preference')),{expiration_duration_seconds:86400});await assert.rejects(f.adapter.submitStep({...args,dispatchToken:crypto.randomUUID()}));assert.equal(f.network.filter(x=>x.url.startsWith('https://queue.fal.run')).length,1);
});
test('a changed prepared payload or an ambiguous submit cannot be resent even after a lost response',async()=>{
 const f=await fixture(),args=await f.submitArgs();await assert.rejects(f.adapter.submitStep({...args,payload:{...args.payload,num_inference_steps:20}}));assert.equal(f.network.filter(x=>x.url.startsWith('https://queue.fal.run')).length,0);
 const original=f.transport;let attempts=0;f.transport=(url,init)=>{if(url.startsWith('https://queue.fal.run')){attempts++;return Promise.reject(Error('lost response'))}return original(url,init)};await assert.rejects(f.adapter.submitStep(args));await assert.rejects(f.adapter.submitStep(args));assert.equal(attempts,1);
});
test('poll URLs are reconstructed from the fixed queue family and never follow provider supplied URLs',async()=>{
 const f=await fixture();assert.deepEqual(await f.adapter.pollStep(f.pollArgs(f.base)),{state:'pending',requestId:REQUEST});assert.equal(f.network[0].url,`https://queue.fal.run/${RECAST_QUEUE_FAMILY}/requests/${REQUEST}/status`);await assert.rejects(f.adapter.pollStep({...f.pollArgs(),requestId:'../leak'}));assert.equal(f.network.length,1);
});
test('only explicit terminal errors or exact known422 validation failures become failed',async()=>{
 for(const kind of ['explicit','known','unknown']){const f=await fixture();f.transport=async url=>url.endsWith('/status')?Response.json({request_id:REQUEST,status:'COMPLETED',...(kind==='explicit'?{error:'confirmed model failure'}:{})}):Response.json(kind==='known'?{request_id:REQUEST,detail:[{type:'input_value_error',loc:['body'],msg:'Failed to access the input file. Please ensure the URL is publicly accessible and in a supported format.'}]}:{request_id:REQUEST,detail:'unrecognized'},{status:422});const result=await f.adapter.pollStep(f.pollArgs());assert.equal(result.state,kind==='unknown'?'pending':'failed');if(kind==='unknown')assert.equal(result.needsReview,true);}
});
test('mismatched status identity, redirects and untrusted result hosts never fetch media',async()=>{
 const f=await fixture();f.transport=async()=>Response.json({request_id:'other',status:'COMPLETED'});await assert.rejects(f.adapter.pollStep(f.pollArgs()));assert.equal(f.privateBucket.items.size,0);
 const g=await fixture();let calls=0;g.transport=async url=>{calls++;return url.endsWith('/status')?Response.json({request_id:REQUEST,status:'COMPLETED'}):Response.json({video:{url:'https://attacker.invalid/video.mp4'}})};assert.equal((await g.adapter.pollStep(g.pollArgs())).needsReview,true);assert.equal(calls,2);
 const h=await fixture();h.transport=async()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid'}});await assert.rejects(h.adapter.pollStep(h.pollArgs()));
});
test('LTX output persists privately only with exact source clock/geometry and no generated audio',async()=>{
 const f=await fixture(),result=await f.persist();assert.equal(result.kind,'stored');assert.equal(result.outputHash,clips.clean.meta.sha256);const object=f.privateBucket.items.get(result.resultKey);assert.equal(object.httpMetadata.cacheControl,'private, no-store');assert.equal(object.customMetadata.outcome,'accepted');assert.ok(object.customMetadata.media.length<8192);assert.equal(new Headers(f.network[0].init.headers).has('authorization'),false);
 const bad=await fixture(),original=bad.transport;bad.transport=(url,init)=>url.endsWith('/result.mp4')?Promise.resolve(bad.response(clips.source.bytes)):original(url,init);assert.equal((await bad.persist()).kind,'rejected');assert.equal(bad.privateBucket.items.size,1);
});
test('Recast output may change FPS but must preserve bounded duration,1080P aspect and an expected audio track',async()=>{
 const f=await fixture(),original=f.transport;f.transport=(url,init)=>url.endsWith('/result.mp4')?Promise.resolve(f.response(clips.base.bytes)):original(url,init);const result=await f.persist(f.base);assert.equal(result.kind,'stored');assert.equal(result.outputMetadata.fpsNumerator,30);assert.equal(result.outputMetadata.width,1080);assert.equal(result.outputMetadata.height,1920);
 for(const role of ['source','short','silent']){const g=await fixture(),base=g.transport;g.transport=(url,init)=>url.endsWith('/result.mp4')?Promise.resolve(g.response(clips[role].bytes)):base(url,init);assert.equal((await g.persist(g.base)).kind,'rejected');const saved=g.privateBucket.items.get(`rig-workflow-results/${JOB}/base.mp4`);assert.equal(saved.customMetadata.outcome,'rejected');assert.deepEqual(saved.bytes,clips[role].bytes);}
});
test('stored output recovers a lost D1 completion without another Fal request or overwrite',async()=>{
 const f=await fixture();const first=await f.persist();f.network.length=0;const polled=await f.adapter.pollStep(f.pollArgs());assert.equal(polled.state,'completed');assert.deepEqual(polled.result,{stored:true});assert.equal(f.network.length,0);assert.deepEqual(await f.adapter.persistStepResult({userId:USER,jobId:JOB,quote:f.quote,plan:f.plan,step:f.pre,requestId:REQUEST,providerResult:polled.result,resultKey:first.resultKey}),first);assert.equal(f.network.length,0);
 await assert.rejects(f.adapter.pollStep({...f.pollArgs(),userId:'other-owner'}));assert.equal(f.network.length,0);
});
test('a loose allowlisted Fal URL is not a server-owned result capability',async()=>{
 const f=await fixture();await assert.rejects(f.adapter.persistStepResult({userId:USER,jobId:JOB,quote:f.quote,plan:f.plan,step:f.pre,requestId:REQUEST,providerResult:{video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}},resultKey:`rig-workflow-results/${JOB}/source-cleanup.mp4`}),/Verified provider result/);assert.equal(f.network.length,0);assert.equal(f.privateBucket.items.size,0);
});
test('result size, truncation and MIME bounds stop before storing unchecked bytes',async()=>{
 for(const kind of ['large','truncated','html','unknown-large']){const f=await fixture();let cancelled=false;f.transport=async()=>{if(kind==='large')return new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'video/mp4','content-length':String(WORKFLOW_RESULT_LIMIT+1)}});if(kind==='truncated')return new Response(clips.clean.bytes,{headers:{'content-type':'video/mp4','content-length':String(clips.clean.bytes.length+1)}});if(kind==='html')return new Response('error',{headers:{'content-type':'text/html'}});let count=0;return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));if(++count===17)c.close()},cancel(){cancelled=true}}),{headers:{'content-type':'video/mp4'}})};await assert.rejects(f.persist());assert.equal(f.privateBucket.items.size,0);if(kind==='large')assert.equal(cancelled,true);}
});
