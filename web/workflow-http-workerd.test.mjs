import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProductionVideoService} from './production-video-service.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {workflowClientMedia} from './workflow-client-contract.mjs';
import {overlayCleanupPayload,OVERLAY_CLEANUP_BILLING} from './overlay-cleanup-contract.mjs';
import {RECAST_BILLING} from './price-preflight.mjs';
import {RECAST_SETTINGS} from './recast-contract.mjs';
import {createProductionWorkflowStores,workflowInitialSourceHash,workflowHash} from './production-workflow-stores.mjs';
const OWNER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc',SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',POLICY='fal-temporary-links-v1';
const run=promisify(execFile);let directory,clips;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rig-http-workflow-'));const source=join(directory,'source.mp4'),clean=join(directory,'clean.mp4'),output=join(directory,'output.mp4'),mask=join(directory,'mask.mp4'),final=join(directory,'final.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:20000});
 await run('ffmpeg',['-v','error','-i',source,'-map','0:v','-c','copy','-an',clean],{timeout:10000});
 await run('ffmpeg',['-v','error','-i',source,'-c','copy','-movflags','+faststart',output],{timeout:10000});
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:size=360x640:rate=24','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-an',mask],{timeout:10000});
 await run('ffmpeg',['-v','error','-i',source,'-vf','scale=1080:1920','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','copy',final],{timeout:20000});
 clips={};for(const [role,path]of Object.entries({source,clean,output,mask,final})){const bytes=new Uint8Array(await readFile(path));clips[role]={bytes,inspection:await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':['clean','final'].includes(role)?'result':'input'})};}
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true})});
async function fixture({flags=true,owner=true}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'},r2Buckets:['BUCKET']});
 try{
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(q).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('workflow-http-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await installTestOwnerCredential(db,OWNER);
 const imageId=crypto.randomUUID(),image=new Uint8Array(await readFile(new URL('./test/fixtures/input.jpg',import.meta.url))),imageSha=Buffer.from(await crypto.subtle.digest('SHA-256',image)).toString('hex');
 let imageExpired=false;
 const media={async fetch(req){assert.equal(req.headers.get('authorization'),'Bearer '+'x'.repeat(40));if(imageExpired||new URL(req.url).pathname!=='/v1/assets/'+imageId||req.headers.get('x-rig-user')!==OWNER)return new Response(null,{status:404});return new Response(image.slice(),{headers:{'content-type':'image/jpeg','content-length':String(image.length),'x-rig-asset-kind':'image','x-rig-sha256':imageSha,'x-rig-width':'360','x-rig-height':'360'}})}};
 const env={DB:legacy,PRODUCTION_DB:db,BUCKET:bucket,RIG_MEDIA:media,RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fake-provider-key',RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_RECAST:'30',RIG_EDIT_ENABLED:'no',RIG_PRICE_VERSION:'workflow-v1',RIG_CLOSED_VIDEO_MAX_CENTS:'1200',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_OWNER_RECAST_VALIDATION_ENABLED:flags?'yes':'no',RIG_OWNER_CLEANUP_VALIDATION_ENABLED:flags?'yes':'no',RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'workflow-http-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:OWNER}:{})};
 const submissions=[],preparations=[],polls=[];let cleanupOutcome='completed',baseOutcome='completed',priceRate=.45,loseSubmission=false;
 const adapterFactory=({inputs,assets})=>({
  async prepareStep({userId,jobId,step,quote,inputBinding}){preparations.push(step.id);if(step.id==='source-cleanup'){const cp=quote.input.workflow.clientProcessing,pair=await inputs.getPair({userId,sourceId:cp.source.id,maskId:cp.mask.id});assert.equal(pair.source.inspection.sha256,clips.source.inspection.sha256);assert.equal(pair.mask.inspection.sha256,clips.mask.inspection.sha256);return {inputHash:inputBinding.inputHash,payload:overlayCleanupPayload(quote.input.cleanup,{source:{verified:true,kind:'video',sha256:cp.source.sha256,url:'https://v3b.fal.media/files/b/fixture/source.mp4'},mask:{verified:true,kind:'video',sha256:cp.mask.sha256,url:'https://v3b.fal.media/files/b/fixture/mask.mp4'}})}}assert.equal(inputBinding.kind,'client-composed');assert.equal(inputBinding.inputHash,clips.output.inspection.sha256);const portrait=await assets.uploadOwned(userId,imageId,imageSha,{jobId,model:'minimax/h3-max/recast',transferPolicy:POLICY});assert.equal(portrait.sha256,imageSha);return {inputHash:inputBinding.inputHash,payload:{video_url:'https://v3b.fal.media/files/b/fixture/composed.mp4',reference_image_urls:[portrait.url],prompt:quote.input.prompt,...RECAST_SETTINGS}};},
  async submitStep(r){submissions.push(r);if(loseSubmission)throw Error('Lost queue response');return {requestId:'provider-'+r.stepId};},
  async pollStep(r){polls.push(r);const state=r.stepId==='source-cleanup'?cleanupOutcome:baseOutcome;return {state,requestId:r.requestId,...(state==='completed'?{result:{fixture:true}}:{})};},
  async persistStepResult(r){const clip=clips[r.step.id==='source-cleanup'?'clean':'final'],m=clip.inspection,metadata={version:'rig-workflow-result-v1',jobId:r.jobId,userId:r.userId,stepId:r.step.id,providerRequestId:r.requestId,planHash:r.plan.planHash,contract:r.step.contract,sha256:m.sha256,inspection:'workflow-mp4-sps-v1',outcome:'accepted',media:JSON.stringify({mime:m.mime,codec:m.codec,inspectionLevel:m.inspectionLevel,geometryVerified:m.geometryVerified,sha256:m.sha256,size:m.size,durationSeconds:m.durationSeconds,...workflowClientMedia(m)})};await bucket.put(r.resultKey,clip.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'video/mp4',cacheControl:'private, no-store'},customMetadata:metadata});return {kind:'stored',resultKey:r.resultKey,outputHash:m.sha256,outputMetadata:JSON.parse(metadata.media)};}
 });
 const uploadedImages=new Map();
 const provider=async(input,init)=>{const u=new URL(input),headers=new Headers(init.headers);assert.equal(init.redirect,'manual');if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate'){assert.equal(headers.get('authorization'),'Key fake-provider-key');assert.equal(headers.get('x-fal-object-lifecycle-preference'),'{"expiration_duration_seconds":86400}');const id=crypto.randomUUID();return Response.json({upload_url:'https://v3b.fal.media/upload/'+id,file_url:'https://v3b.fal.media/files/b/fixture/'+id+'.jpg'})}if(u.origin==='https://v3b.fal.media'&&u.pathname.startsWith('/upload/')&&init.method==='PUT'){assert.equal(headers.has('authorization'),false);const bytes=new Uint8Array(await init.body.arrayBuffer());assert.equal(Buffer.from(bytes).equals(Buffer.from(image)),true);uploadedImages.set(u.pathname.split('/').at(-1),bytes);return new Response('OK')}if(u.origin==='https://v3b.fal.media'&&init.method==='GET'){assert.equal(headers.has('authorization'),false);const id=u.pathname.split('/').at(-1).replace(/\.jpg$/,''),bytes=uploadedImages.get(id);if(bytes)return new Response(bytes.slice(),{headers:{'content-type':'image/jpeg','content-length':String(bytes.length)}})}throw Error('Unexpected external network');};
 const priceFetch=async()=>({provider:'fal',currency:'USD',unit:'second',prices:{'human-recast':priceRate},billingContracts:{'human-recast':{...RECAST_BILLING}}});
 const service=(userId=OWNER,extra={})=>createProductionVideoService(env,{trustedUserId:userId,priceFetch,cleanupPriceFetch:async()=>({...OVERLAY_CLEANUP_BILLING}),providerFetch:provider,workflowAdapterFactory:adapterFactory,...extra});
 const call=(h,path,data,extra={})=>h(new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json',...extra},...(data===undefined?{}:{body:JSON.stringify(data)})}));
 const upload=(h,path,bytes,extra={})=>h(new Request(SITE+path,{method:'POST',headers:{origin:SITE,'content-type':'video/mp4','content-length':String(bytes.length),...extra},body:bytes.slice()}));
 async function selected(h){let r=await upload(h,'/api/workflow-inputs/source',clips.source.bytes);assert.equal(r.status,201,await r.clone().text());const source=(await r.json()).manifest;r=await upload(h,'/api/workflow-inputs/'+source.id+'/mask',clips.mask.bytes);assert.equal(r.status,201,await r.clone().text());const mask=await r.json();return {imageId,videoId:source.id,cleanupMaskId:mask.id,quality:'human-recast',keepSound:true,faceId:null,angleIds:[],steadyCamera:false,prompt:'Replace the person using my portrait. Preserve the source scene and performance.',transferPolicy:POLICY};}
 async function priced(h){const selection=await selected(h),r=await call(h,'/api/generation-quotes',selection);assert.equal(r.status,201,await r.clone().text());return {selection,quote:await r.json()};}
 async function approved(quote){const payload={quoteId:quote.id,idempotencyKey:crypto.randomUUID(),transferConsent:POLICY};return {...payload,verification:await verificationFor(db,OWNER,'owner-generation',payload,Date.now(),{env})};}
 return {mf,db,bucket,env,service,call,upload,selected,priced,approved,submissions,preparations,polls,imageId,uploadedImages,expireImage:()=>{imageExpired=true},setCleanup:x=>cleanupOutcome=x,setBase:x=>baseOutcome=x,setPrice:x=>priceRate=x,setLostSubmission:x=>loseSubmission=x};
 }catch(e){await mf.dispose();throw e}
}

test('actual owner HTTP flow: trusted uploads, combined quote, device confirmation, explicit local compose, one base dispatch and private final result',async()=>{
 const f=await fixture();try{
  let h=await f.service(),r=await f.call(h,'/api/video-config');assert.equal((await r.json()).cleanup.enabled,true);
  const {selection,quote}=await f.priced(h);assert.equal(quote.outputResolution,'1080P');assert.equal(quote.workflowVersion,'rig-workflow-v2');assert.equal(quote.providerCurrency,'USD');assert.ok(quote.providerEstimateUsdMicros>2700000);assert.equal(f.submissions.length,0);
  r=await f.call(h,'/api/generations',{quoteId:quote.id,idempotencyKey:'needs-device',transferConsent:POLICY});assert.equal(r.status,428,await r.clone().text());assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
  const approved=await f.approved(quote);r=await f.call(h,'/api/generations',{...approved,transferConsent:undefined});assert.equal(r.status,400);assert.equal(f.submissions.length,0);
  r=await f.call(h,'/api/generations',approved);assert.equal(r.status,202,await r.clone().text());const job=await r.json();assert.equal(job.state,'queued');assert.equal(f.submissions.length,1);assert.equal(f.submissions[0].stepId,'source-cleanup');assert.equal(job.providerEstimateUsdMicros,quote.providerEstimateUsdMicros);
  assert.equal((await f.call(h,'/api/generations',approved)).status,200);assert.equal(f.submissions.length,1);
  assert.equal((await f.call(await f.service(OTHER),'/api/generations/'+job.id)).status,404);
  r=await f.call(h,'/api/generations/'+job.id);assert.equal(r.status,200,await r.clone().text());let status=await r.json();assert.equal(status.state,'awaiting_client_processing');assert.equal(f.submissions.length,1);
  r=await f.call(h,'/api/generations/'+job.id+'/client');assert.equal(r.status,200,await r.clone().text());let manifest=(await r.json()).manifest;assert.equal(manifest.jobId,job.id);assert.equal(manifest.state,'awaiting_client_processing');
  for(const role of ['source','mask','clean']){r=await f.call(h,'/api/generations/'+job.id+'/client/'+role);assert.equal(r.status,200,role+': '+await r.clone().text().then(t=>t.slice(0,100)));assert.equal(r.headers.get('cache-control'),'private, no-store');assert.ok((await r.arrayBuffer()).byteLength>32);}
  r=await f.upload(h,'/api/generations/'+job.id+'/client/output',clips.output.bytes);assert.equal(r.status,200,await r.clone().text());manifest=(await r.json()).manifest;assert.equal(manifest.state,'ready_to_advance');assert.equal(manifest.output.sha256,clips.output.inspection.sha256);assert.equal(f.submissions.length,1);
  // Status never dispatches the next paid step, including after refresh.
  f.expireImage();h=await f.service();await f.call(h,'/api/generations/'+job.id);assert.equal(f.submissions.length,1);
  r=await f.call(h,'/api/generations/'+job.id+'/client/advance',{stageId:manifest.stageId,idempotencyKey:'explicit-compose-advance',outputHash:manifest.output.sha256});assert.equal(r.status,200,await r.clone().text());assert.equal(f.submissions.length,2);assert.equal(f.submissions[1].stepId,'base');assert.equal(f.submissions[1].payload.resolution,'1080P');assert.equal(f.uploadedImages.size,1);
  await f.call(h,'/api/generations/'+job.id+'/client/advance',{stageId:manifest.stageId,idempotencyKey:'explicit-compose-advance',outputHash:manifest.output.sha256});assert.equal(f.submissions.length,2);
  r=await f.call(h,'/api/generations/'+job.id);assert.equal(r.status,200,await r.clone().text());status=await r.json();assert.equal(status.state,'completed');assert.equal(status.funding,'owner-provider');
  r=await f.call(h,'/api/generations/'+job.id+'/video');assert.equal(r.status,200,await r.clone().text());assert.equal(Buffer.from(await r.arrayBuffer()).length,clips.final.bytes.length);assert.equal(r.headers.get('content-type'),'video/mp4');
  r=await f.call(h,'/api/generations/recent');assert.equal((await r.json()).job.id,job.id);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_workflow_settlements').first()).n,1);
  assert.equal((await f.call(h,'/api/generation-intents/'+approved.idempotencyKey+'/reconcile',{quoteId:quote.id})).status,200);
  const sourceResponse=await f.call(h,'/api/workflow-inputs/'+selection.videoId);assert.equal(sourceResponse.status,200);await sourceResponse.body.cancel();
 }finally{await f.mf.dispose()}
});

test('cleanup capability is fail-closed for customer, missing/stale flags, malformed selection and absent combined consent',async()=>{
 for(const options of [{flags:false},{owner:false}]){const f=await fixture(options);try{const h=await f.service(),r=await f.call(h,'/api/video-config');assert.equal((await r.json()).cleanup,undefined);assert.equal((await f.upload(h,'/api/workflow-inputs/source',clips.source.bytes)).status,403);assert.equal(f.submissions.length,0);}finally{await f.mf.dispose()}}
 const f=await fixture();try{const h=await f.service(),selection=await f.selected(h);for(const bad of [{...selection,cleanupMaskId:null},{...selection,faceId:f.imageId},{...selection,angleIds:[f.imageId]},{...selection,keepSound:false},{...selection,model:'client/model'},{...selection,providerEstimateUsdMicros:1}]){const r=await f.call(h,'/api/generation-quotes',bad);assert.equal(r.status,400,await r.clone().text());}assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_quotes').first()).n,0);f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';assert.equal((await f.call(h,'/api/generation-quotes',selection)).status,403);assert.equal(f.submissions.length,0);}finally{await f.mf.dispose()}
});

test('accepted workflow retains exact private inputs beyond the unaccepted upload expiry and recovers while flags are off',async()=>{
 const f=await fixture();try{
  let h=await f.service();const {selection,quote}=await f.priced(h),approved=await f.approved(quote),r=await f.call(h,'/api/generations',approved);assert.equal(r.status,202,await r.clone().text());const job=await r.json();
  // Expire only the original working uploads, keeping their exact bytes private.
  for(const id of [selection.videoId,selection.cleanupMaskId]){const key=`rig-workflow-inputs/${OWNER}/${id}.mp4`,obj=await f.bucket.get(key),m=JSON.parse(obj.customMetadata.manifest);m.createdAt-=86400001;m.expiresAt-=86400001;await f.bucket.put(key,await obj.arrayBuffer(),{httpMetadata:obj.httpMetadata,customMetadata:{manifest:JSON.stringify(m)}});}
  assert.equal((await f.call(h,'/api/workflow-inputs/'+selection.videoId)).status,503);
  f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';f.env.RIG_OWNER_RECAST_VALIDATION_ENABLED='no';h=await f.service();
  const polled=await f.call(h,'/api/generations/'+job.id);assert.equal(polled.status,200,await polled.clone().text());assert.equal((await polled.json()).state,'awaiting_client_processing');
  const artifact=await f.call(h,'/api/generations/'+job.id+'/client/source');assert.equal(artifact.status,200,await artifact.clone().text());assert.equal(Buffer.from(await artifact.arrayBuffer()).equals(Buffer.from(clips.source.bytes)),true);
  assert.equal((await f.upload(h,'/api/generations/'+job.id+'/client/output',clips.output.bytes)).status,403);assert.equal(f.submissions.length,1);
 }finally{await f.mf.dispose()}
});

test('malformed stored workflow is never interpreted by the legacy handler or refunded as a legacy job',async()=>{
 const f=await fixture();try{const h=await f.service(),{quote}=await f.priced(h),payload=await f.approved(quote),context=await createProductionGenerationContext(f.env),stores=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:context}),q=await stores.quotes.getOwned(OWNER,quote.id);q.input.workflow.version='invalid';await f.db.prepare('UPDATE rig_generation_quotes SET input_json=? WHERE id=?').bind(JSON.stringify(q.input),quote.id).run();const r=await f.call(h,'/api/generations',payload);assert.equal(r.status,503,await r.clone().text());assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);assert.equal(f.submissions.length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);}finally{await f.mf.dispose()}
});

test('quota is admitted before lease/buffering, a busy lease blocks preparation, and invalid raw bytes still count',async()=>{
 const f=await fixture();try{let acquisitions=0;const h=await f.service(OWNER,{lease:{async acquire(){acquisitions++;assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_preparation_reservations').first()).n,1);return {state:'busy'}},async complete(){throw Error('Not acquired')}}});assert.equal((await f.upload(h,'/api/workflow-inputs/source',clips.source.bytes)).status,429);assert.equal(acquisitions,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_preparation_reservations').first()).n,1);const ordinary=await f.service();assert.equal((await f.upload(ordinary,'/api/workflow-inputs/source',new Uint8Array(100))).status,503);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_preparation_reservations').first()).n,2);assert.equal(f.submissions.length,0);}finally{await f.mf.dispose()}
});

test('the combined cost is capped before a quote or funding, even when the base video alone fits',async()=>{
 const f=await fixture();try{f.env.RIG_CLOSED_VIDEO_MAX_USD_MICROS='2700000';const h=await f.service(),selection=await f.selected(h),r=await f.call(h,'/api/generation-quotes',selection);assert.equal(r.status,400,await r.clone().text());assert.equal((await r.json()).code,'provider_limit_exceeded');for(const table of ['rig_generation_quotes','rig_generation_jobs','rig_generation_costs','rig_ledger'])assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0);assert.equal(f.submissions.length,0);}finally{await f.mf.dispose()}
});

test('uncertain queue delivery is retained and repeated confirmation/status never dispatch another model or manufacture a refund',async()=>{
 const f=await fixture();try{let h=await f.service();const {quote}=await f.priced(h),approved=await f.approved(quote);f.setLostSubmission(true);let r=await f.call(h,'/api/generations',approved);assert.equal(r.status,202,await r.clone().text());const job=await r.json();assert.equal(job.state,'unknown');assert.equal(f.submissions.length,1);h=await f.service();for(let i=0;i<2;i++){r=await f.call(h,'/api/generations',approved);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'unknown');r=await f.call(h,'/api/generations/'+job.id);assert.equal(r.status,200);assert.equal((await r.json()).state,'unknown');}assert.equal(f.submissions.length,1);assert.equal(f.polls.length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_workflow_settlements').first()).n,0);}finally{await f.mf.dispose()}
});

test('a definitive first-step failure settles only the workflow and cannot reach Recast or serve its rejected clean clip',async()=>{
 const f=await fixture();try{const h=await f.service(),{quote}=await f.priced(h),approved=await f.approved(quote),r=await f.call(h,'/api/generations',approved);assert.equal(r.status,202);const job=await r.json();f.setCleanup('failed');const status=await f.call(h,'/api/generations/'+job.id);assert.equal(status.status,200,await status.clone().text());const done=await status.json();assert.equal(done.state,'failed');assert.equal(done.finalizationConfirmed,true);assert.equal(f.submissions.length,1);assert.equal((await f.call(h,'/api/generations/'+job.id+'/video')).status,404);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal((await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first()).state,'failed');}finally{await f.mf.dispose()}
});

test('the existing production service remains usable without the optional workflow migration or any new binding',async()=>{
 const f=await fixture();try{for(const table of ['rig_generation_workflow_client_processing','rig_generation_workflow_settlements','rig_generation_workflow_steps','rig_generation_workflows'])await f.db.prepare('DROP TABLE '+table).run();const h=await f.service(),config=await f.call(h,'/api/video-config');assert.equal(config.status,200,await config.clone().text());const capabilities=await config.json();assert.equal(capabilities.cleanup,undefined);assert.ok(capabilities.qualities.includes('pro'));const recent=await f.call(h,'/api/generations/recent');assert.equal(recent.status,200,await recent.clone().text());assert.deepEqual(await recent.json(),{job:null});assert.equal(f.submissions.length,0);}finally{await f.mf.dispose()}
});
test('an unread private MP4 keeps the real durable lease until body cancel or EOF',async()=>{
 const f=await fixture();try{const h=await f.service(),selection=await f.selected(h);let response=await f.call(h,'/api/workflow-inputs/'+selection.videoId);assert.equal(response.status,200);assert.equal((await f.call(h,'/api/workflow-inputs/'+selection.videoId)).status,429);assert.equal((await f.upload(h,'/api/workflow-inputs/source',clips.source.bytes)).status,429);await response.body.cancel();response=await f.call(h,'/api/workflow-inputs/'+selection.videoId);assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,clips.source.bytes.length);const after=await f.call(h,'/api/workflow-inputs/'+selection.videoId);assert.equal(after.status,200);await after.body.cancel();assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,0);}finally{await f.mf.dispose()}
});

test('REPRO: a daily-limit change after accepted owner funding must finalize wholly undispatched workflow steps',async()=>{
 const f=await fixture();try{
  const media=f.env.RIG_MEDIA;let changed=false;
  f.env.RIG_MEDIA={async fetch(req){const parent=await f.db.prepare("SELECT id FROM rig_generation_jobs WHERE user_id=? AND state='submitting'").bind(OWNER).first();if(parent&&!changed){changed=true;await f.db.prepare('UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=100000 WHERE id=1').run();}return media.fetch(req)}};
  const h=await f.service(),{quote}=await f.priced(h),approved=await f.approved(quote),response=await f.call(h,'/api/generations',approved);
  assert.equal(changed,true);assert.equal(f.submissions.length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,0);
  const rows=(await f.db.prepare('SELECT state,dispatch_token,fal_request_id FROM rig_generation_workflow_steps ORDER BY step_index').all()).results;
  assert.ok(rows.every(row=>row.dispatch_token===null&&row.fal_request_id===null),JSON.stringify(rows));
  const parent=await f.db.prepare('SELECT id,state FROM rig_generation_jobs').first();
  assert.ok(await f.bucket.head(`rig-workflow-accepted/${parent.id}/image.jpg`),'The portrait snapshot must finish; this reproduces the later dispatch-budget failure.');
  assert.equal(parent.state,'failed',JSON.stringify({httpStatus:response.status,parent,steps:rows,providerCalls:f.submissions.length}));
  assert.equal(response.status,200);assert.equal((await response.json()).finalizationConfirmed,true);
  assert.ok(rows.every(row=>row.state==='skipped'));assert.equal((await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(parent.id).first()).state,'failed');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.mf.dispose()}
});

async function fundedPreparedFixture(f){
 const h=await f.service(),{quote}=await f.priced(h),payload=await f.approved(quote),context=await createProductionGenerationContext(f.env),parents=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:context}),q=await parents.quotes.getOwned(OWNER,quote.id),verificationPayload={quoteId:q.id,idempotencyKey:payload.idempotencyKey,transferConsent:POLICY};
 const begun=await parents.jobs.begin({userId:OWNER,quoteId:q.id,idempotencyKey:payload.idempotencyKey,quote:q,verification:payload.verification,verificationPayload});assert.equal(begun.kind,'created');const identity={userId:OWNER,jobId:begun.job.id},workflows=createProductionWorkflowStores(f.db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(f.env)});await workflows.initialize({...identity,quote:q});assert.equal(await parents.jobs.authorizeDispatch(OWNER,begun.job.id),true);
 const cp=q.input.workflow.clientProcessing,authorization={...identity,stepId:'source-cleanup',sourceHash:await workflowInitialSourceHash(q),inputHash:await workflowHash({kind:'source-and-mask',source:cp.source,mask:cp.mask}),requestHash:'a'.repeat(64)};
 return {parents,workflows,identity,authorization};
}
test('atomic undispatched cancellation races a genuine step authorization without releasing a winning dispatch',async()=>{
 for(const cancelFirst of [true,false]){const f=await fixture();try{
  const b=await fundedPreparedFixture(f),cancel=()=>b.workflows.finalizeWhollyUndispatched(b.identity),authorize=()=>b.workflows.authorizeStep(b.authorization),results=await Promise.all(cancelFirst?[cancel(),authorize()]:[authorize(),cancel()]),canceled=results[cancelFirst?0:1],authorization=results[cancelFirst?1:0];
  const actual=await b.workflows.get(b.identity);assert.equal(authorization.authorized,canceled===false);
  if(canceled){assert.equal(actual.row.state,'failed');assert.ok(actual.steps.every(s=>s.state==='skipped'&&s.dispatch_token===null&&s.fal_request_id===null));assert.equal(actual.settlement.provider_authorized_steps,0);assert.equal(actual.settlement.provider_dispatched_steps,0);}
  else{assert.equal(actual.settlement,null);assert.equal(actual.steps[0].state,'authorized');assert.ok(actual.steps[0].dispatch_token);assert.equal((await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(b.identity.jobId).first()).state,'authorized');}
  assert.equal(f.submissions.length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.mf.dispose()}}
});
test('authorized, unknown and queued steps are never canceled or released by the wholly-undispatched recovery',async()=>{
 for(const state of ['authorized','unknown','queued']){const f=await fixture();try{
  const b=await fundedPreparedFixture(f),claim=await b.workflows.authorizeStep(b.authorization);assert.equal(claim.authorized,true);
  if(state==='unknown')await b.workflows.markUnknown({...b.identity,stepId:'source-cleanup',dispatchToken:claim.dispatchToken});
  if(state==='queued')await b.workflows.markSubmitted({...b.identity,stepId:'source-cleanup',dispatchToken:claim.dispatchToken,requestId:'known-provider-id'});
  assert.equal(await b.workflows.finalizeWhollyUndispatched(b.identity),false);const actual=await b.workflows.get(b.identity);assert.equal(actual.steps[0].state,state);assert.equal(actual.steps[1].state,'prepared');assert.equal(actual.settlement,null);assert.equal((await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(b.identity.jobId).first()).state,'authorized');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal(f.submissions.length,0);
 }finally{await f.mf.dispose()}}
});
