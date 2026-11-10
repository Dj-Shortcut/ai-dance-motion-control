import test,{before,after} from 'node:test';
import {createWorkflowRunner,validateOwnerCleanupWorkflow,WORKFLOW_TRANSFER_POLICY} from './workflow-runner.mjs';
import {createOverlayCleanupPlan,overlayCleanupPayload,OVERLAY_CLEANUP_MODEL,OVERLAY_CLEANUP_QUEUE_FAMILY,OVERLAY_CLEANUP_CONTRACT,OVERLAY_CLEANUP_SETTINGS,OVERLAY_CLEANUP_BILLING} from './overlay-cleanup-contract.mjs';
import {RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_QUALITY,RECAST_SETTINGS} from './recast-contract.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {WORKFLOW_CLIENT_CONTRACT,workflowClientMedia} from './workflow-client-contract.mjs';
import {createProductionWorkflowClientStores} from './production-workflow-client-stores.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createProductionWorkflowStores,workflowPlanHash,workflowHash} from './production-workflow-stores.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',HASH='a'.repeat(64);
async function fixture({owner=true,flag='yes',recastFlag='yes'}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 try{
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 for(const file of ['./production-schema.sql']){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('workflow-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,2000)').bind('paid:'+USER,USER).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_OWNER_CLEANUP_VALIDATION_ENABLED:flag,RIG_OWNER_RECAST_VALIDATION_ENABLED:recastFlag,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'workflow-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:USER}:{})};
 const context=await createProductionGenerationContext(env),parents=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:context});
 if(owner)await installTestOwnerCredential(db,USER);
 const workflow=createProductionWorkflowStores(db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env)});
 const cleanup=createOverlayCleanupPlan({source:clips.source.meta,mask:clips.mask.meta,maskSourceSha256:clips.source.meta.sha256,billing:{...OVERLAY_CLEANUP_BILLING},baseProviderEstimateUsdMicros:2700000});
 const pre={id:'source-cleanup',kind:'preclean',model:OVERLAY_CLEANUP_MODEL,queueFamily:OVERLAY_CLEANUP_QUEUE_FAMILY,contract:OVERLAY_CLEANUP_CONTRACT,settings:{...OVERLAY_CLEANUP_SETTINGS},dependsOn:null,providerEstimateUsdMicros:cleanup.providerEstimateUsdMicros,retailCents:75};
 const base={id:'base',kind:'base',model:RECAST_MODEL,queueFamily:RECAST_QUEUE_FAMILY,contract:RECAST_PROVIDER_CONTRACT,settings:{...RECAST_SETTINGS},dependsOn:pre.id,providerEstimateUsdMicros:2700000,retailCents:owner?300:725};
 const plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:pre.retailCents+base.retailCents,cleanupRetailCents:0,steps:[pre,base],clientProcessing:{id:'compose',contract:WORKFLOW_CLIENT_CONTRACT,beforeStepId:'base',cleanFromStepId:pre.id,source:{id:'source',sha256:clips.source.meta.sha256},mask:{id:'mask',sha256:clips.mask.meta.sha256},media:workflowClientMedia(clips.source.meta)}};plan.planHash=await workflowPlanHash(plan);
 const usd=cleanup.combinedProviderEstimateUsdMicros,totalRetail=plan.baseRetailCents,prompt='Replace the person using this identity; preserve the source camera and movement.';
 const made=await parents.quotes.create({userId:USER,model:RECAST_MODEL,input:{data:{imageId:'image',videoId:'source',faceId:null,angleIds:[],quality:RECAST_QUALITY,prompt,keepSound:true,steadyCamera:false,transferPolicy:WORKFLOW_TRANSFER_POLICY},prompt,providerContract:RECAST_PROVIDER_CONTRACT,providerSettings:{...RECAST_SETTINGS},refs:[{id:'image',kind:'image',sha256:HASH},{id:'source',kind:'video',sha256:clips.source.meta.sha256},{id:'mask',kind:'video',sha256:clips.mask.meta.sha256}],cleanup,workflow:plan,providerEstimateUsdMicros:usd},priceCents:totalRetail,pricingVersion:'fixture-v1',durationSeconds:6});
 const quote=await parents.quotes.getOwned(USER,made.id),key=crypto.randomUUID(),payload={quoteId:quote.id,idempotencyKey:key,transferConsent:WORKFLOW_TRANSFER_POLICY},verification=owner?await verificationFor(db,USER,'owner-generation',payload,Date.now(),{env}):undefined;
 const begun=await parents.jobs.begin({userId:USER,quoteId:quote.id,idempotencyKey:key,quote,verification,verificationPayload:payload});assert.equal(begun.kind,'created');
 const job=begun.job,identity={userId:USER,jobId:job.id},args=(stepId,more={})=>({...identity,stepId,...more});
 const balance=async()=>(await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n;
 const objects=new Map(),reads=[],writes=[];
 const clients=createProductionWorkflowClientStores(db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env),workflows:workflow,readOwnedArtifact:async request=>{reads.push(request);assert.equal(request.userId,USER);assert.equal(request.jobId,job.id);if(['output','clean'].includes(request.role))return objects.get(request.reference.key);return clips[request.role].bytes;},putOwnedOutput:async request=>{writes.push(request);if(!objects.has(request.key))objects.set(request.key,request.bytes.slice());}});
 const prepared=[],submitted=[],polled=[],stored=[],answers=new Map();
 const adapters={
  async prepareStep(request){prepared.push(request);const {step,inputBinding}=request;const videoUrl='https://v3b.fal.media/files/b/fixture/'+(step.kind==='preclean'?'source':'composed')+'.mp4';
   if(step.kind==='preclean')return {inputHash:inputBinding.inputHash,payload:overlayCleanupPayload(quote.input.cleanup,{source:{verified:true,kind:'video',sha256:plan.clientProcessing.source.sha256,url:videoUrl},mask:{verified:true,kind:'video',sha256:plan.clientProcessing.mask.sha256,url:'https://v3b.fal.media/files/b/fixture/mask.mp4'}})};
   assert.equal(inputBinding.kind,'client-composed');assert.equal(inputBinding.inspection.sha256,clips.output.meta.sha256);assert.equal(inputBinding.bytes.length,clips.output.bytes.length);
   return {inputHash:inputBinding.inputHash,payload:{video_url:videoUrl,reference_image_urls:['https://v3b.fal.media/files/b/fixture/image.jpg'],prompt:quote.input.prompt,...RECAST_SETTINGS}};
  },
  async submitStep(request){submitted.push(request);return {requestId:'provider-'+request.stepId};},
  async pollStep(request){polled.push(request);return answers.get(request.requestId)??{state:'pending',requestId:request.requestId};},
  async persistStepResult(request){stored.push(request);const clip=clips[request.step.kind==='preclean'?'clean':'output'];objects.set(request.resultKey,clip.bytes);return {kind:'stored',resultKey:request.resultKey,outputHash:clip.meta.sha256,outputMetadata:{inspectionLevel:'container-only',size:clip.bytes.length,...workflowClientMedia(clip.meta)}};}
 };
 const runner=createWorkflowRunner({db,productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env),parents,workflows:workflow,clients,adapters});
 const start=()=>runner.startAccepted({method:'POST',...identity,quote,transferConsent:WORKFLOW_TRANSFER_POLICY});
 const poll=()=>runner.poll({method:'GET',...identity});
 const stage=async()=>{await start();answers.set('provider-source-cleanup',{state:'completed',requestId:'provider-source-cleanup',result:{fixture:true}});return poll();};
 const upload=()=>clients.uploadOutput({...identity,stageId:'compose',body:clips.output.bytes,sha256:clips.output.meta.sha256});
 const advance=()=>runner.advance({method:'POST',...identity,stageId:'compose',idempotencyKey:'explicit-owner-advance',outputHash:clips.output.meta.sha256});
 return {runner,adapters,prepared,submitted,polled,stored,answers,start,poll,stage,advance,clients,upload,objects,reads,writes,mf,db,env,context,parents,workflow,plan,quote,job,identity,balance,usd,totalRetail};
 }catch(error){await mf.dispose();throw error;}
}

const run=promisify(execFile);let directory,clips;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rig-client-workflow-'));const source=join(directory,'source.mp4'),clean=join(directory,'clean.mp4'),mask=join(directory,'mask.mp4'),output=join(directory,'output.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:20000});
 await run('ffmpeg',['-v','error','-i',source,'-map','0:v','-c','copy','-an',clean],{timeout:10000});
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=black:size=360x640:rate=24','-frames:v','144','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-an',mask],{timeout:10000});
 await run('ffmpeg',['-v','error','-i',source,'-c','copy','-movflags','+faststart',output],{timeout:10000});
 clips={};for(const [role,path]of Object.entries({source,clean,mask,output})){const bytes=await readFile(path);clips[role]={bytes,meta:await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':role==='clean'?'result':'input'})};}
 assert.notEqual(clips.source.meta.sha256,clips.output.meta.sha256);assert.equal(clips.source.meta.timelineSha256,clips.clean.meta.timelineSha256);assert.equal(clips.source.meta.audio.packetSha256,clips.output.meta.audio.packetSha256);
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

test('runner requires genuine production capability and explicit provider/storage adapters',async()=>{
 assert.throws(()=>createWorkflowRunner({productionContext:{mode:'live'}}));
 const f=await fixture();try{
  const options={db:f.db,productionContext:f.context,readCurrentProductionContext:()=>createProductionGenerationContext(f.env),parents:f.parents,workflows:f.workflow,clients:f.clients,adapters:f.adapters};
  for(const key of ['prepareStep','submitStep','pollStep','persistStepResult'])assert.throws(()=>createWorkflowRunner({...options,adapters:{...f.adapters,[key]:undefined}}));
 }finally{await f.mf.dispose();}
});
test('owner cleanup is default-off and rejects stale activation or forged customer identities',async()=>{
 for(const options of [{flag:'no'},{recastFlag:'no'},{owner:false}]){const f=await fixture(options);try{
  if(options.flag==='no')f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='yes';
  if(options.recastFlag==='no')f.env.RIG_OWNER_RECAST_VALIDATION_ENABLED='yes';
  await assert.rejects(f.start(),{code:'workflow_owner_validation_unavailable'});assert.equal(f.submitted.length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_workflows').first()).n,0);
 }finally{await f.mf.dispose();}}
 const f=await fixture();try{f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';await assert.rejects(f.start(),{code:'workflow_owner_validation_unavailable'});await assert.rejects(f.runner.startAccepted({method:'POST',userId:OTHER,jobId:f.job.id,quote:f.quote,transferConsent:WORKFLOW_TRANSFER_POLICY}),{code:'workflow_owner_validation_unavailable'});assert.equal(f.submitted.length,0);}finally{await f.mf.dispose();}
});
test('only fixed LTX source cleanup and 1080P Recast with exact billing/contracts can be accepted',async()=>{
 const f=await fixture();try{
  assert.equal((await validateOwnerCleanupWorkflow(f.quote)).plan.steps.length,2);
  for(const mutate of [q=>q.input.workflow.steps[0].model='other/model',q=>q.input.workflow.steps[1].settings.resolution='768P',q=>q.input.cleanup.settings.num_inference_steps=20,q=>q.input.cleanup.audio.packetSha256=HASH,q=>q.input.cleanup.billing.unit='second',q=>q.input.cleanup.providerEstimateUsdMicros++,q=>q.input.data.prompt='changed',q=>q.fundingKind='credits']){const q=structuredClone(f.quote);mutate(q);await assert.rejects(validateOwnerCleanupWorkflow(q));}
  await assert.rejects(f.runner.startAccepted({method:'GET',...f.identity,quote:f.quote,transferConsent:WORKFLOW_TRANSFER_POLICY}),{code:'workflow_explicit_post_required'});
  await assert.rejects(f.runner.startAccepted({method:'POST',...f.identity,quote:f.quote}),{code:'workflow_transfer_consent_required'});assert.equal(f.submitted.length,0);
 }finally{await f.mf.dispose();}
});
test('one accepted quote authorizes the whole budget once and starts only the preclean model',async()=>{
 const f=await fixture();try{
  const result=await f.start();assert.equal(result.state,'queued');assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].model,OVERLAY_CLEANUP_MODEL);assert.equal(f.submitted[0].payload.num_inference_steps,30);assert.equal(f.submitted[0].payload.video_quality,'maximum');assert.equal(f.submitted[0].payload.generate_audio,false);
  const b=await f.workflow.get(f.identity),step=b.steps[0],sent=f.submitted[0];assert.equal(b.steps[1].state,'prepared');assert.equal(step.fal_request_id,'provider-source-cleanup');assert.equal(step.input_sha256,sent.inputHash);assert.equal(step.request_sha256,sent.requestHash);
  assert.equal(sent.requestHash,await workflowHash({model:sent.model,queueFamily:sent.queueFamily,contract:sent.contract,settings:f.plan.steps[0].settings,inputHash:sent.inputHash,payload:sent.payload}));
  const costs=(await f.db.prepare('SELECT * FROM rig_generation_costs').all()).results;assert.equal(costs.length,1);assert.equal(costs[0].provider_estimate_usd_micros,f.usd);assert.equal(await f.balance(),2000);
  await f.start();assert.equal(f.submitted.length,1);
 }finally{await f.mf.dispose();}
});
test('concurrent accepted POST replay cannot submit the same preclean twice',async()=>{
 const f=await fixture();try{
  const results=await Promise.allSettled([f.start(),f.start()]);assert.ok(results.every(r=>r.status==='fulfilled'));assert.equal(f.submitted.length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
  assert.equal((await f.workflow.get(f.identity)).steps[0].state,'queued');
 }finally{await f.mf.dispose();}
});
test('GET polling may persist preclean output and prepare private client artifacts but never starts the base',async()=>{
 const f=await fixture();try{
  await f.start();await f.poll();await f.poll();assert.equal(f.submitted.length,1);assert.equal(f.stored.length,0);
  f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';f.answers.set('provider-source-cleanup',{state:'completed',requestId:'provider-source-cleanup',result:{fixture:true}});
  const stage=await f.poll();assert.equal(stage.state,'awaiting_client_processing');assert.equal(stage.clientProcessing.artifacts.clean.sha256,clips.clean.meta.sha256);assert.equal(f.stored.length,1);
  await f.poll();await f.runner.get(f.identity);assert.equal(f.submitted.length,1);assert.equal((await f.workflow.get(f.identity)).steps[1].state,'prepared');
  assert.ok(!JSON.stringify(stage).includes('rig-workflow-results/'));const exposedUrls=JSON.stringify(stage).match(/https?:\/\/[^"\\\s]+/g)??[];assert.ok(!exposedUrls.some(value=>new URL(value).origin==='https://v3b.fal.media'));assert.equal(exposedUrls.length,0,'The client manifest exposes no provider or private-storage URL');
 }finally{await f.mf.dispose();}
});
test('upload and GET remain unpaid; only explicit exact-stage POST uses the composed bytes for Recast',async()=>{
 const f=await fixture();try{
  await f.stage();await f.upload();await f.poll();assert.equal(f.submitted.length,1);
  const args={...f.identity,stageId:'compose',idempotencyKey:'explicit-owner-advance',outputHash:clips.output.meta.sha256};
  await assert.rejects(f.runner.advance({method:'GET',...args}),{code:'workflow_explicit_post_required'});await assert.rejects(f.runner.advance({method:'POST',...args,stageId:'other'}),{code:'workflow_client_stage_changed'});
  const concurrent=await Promise.all([f.advance(),f.advance()]);assert.ok(concurrent.every(result=>['unknown','queued'].includes(result.state)));assert.equal(f.submitted.length,2);const sent=f.submitted[1];assert.equal(sent.model,RECAST_MODEL);assert.equal(sent.payload.resolution,'1080P');assert.equal(sent.payload.prompt,f.quote.input.prompt);assert.equal(sent.inputHash,clips.output.meta.sha256);assert.equal(sent.payload.video_url,'https://v3b.fal.media/files/b/fixture/composed.mp4');
  const state=await f.workflow.get(f.identity);assert.equal(state.steps[1].source_sha256,clips.clean.meta.sha256);assert.equal(state.steps[1].input_sha256,clips.output.meta.sha256);await f.advance();assert.equal(f.submitted.length,2);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('an ambiguous paid POST is held unknown without provider resubmission or automatic refund',async()=>{
 const f=await fixture();try{
  f.adapters.submitStep=async request=>{f.submitted.push(request);throw Error('response lost')};const result=await f.start();assert.equal(result.state,'unknown');await f.start();await f.poll();assert.equal(f.submitted.length,1);assert.equal(f.polled.length,0);
  const state=await f.workflow.get(f.identity);assert.equal(state.steps[0].state,'unknown');assert.equal(state.steps[0].fal_request_id,null);assert.equal(state.settlement,null);assert.equal(await f.balance(),2000);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('a malformed provider submit response also stays unknown and is never treated as a free preparation error',async()=>{
 const f=await fixture();try{
  f.adapters.submitStep=async request=>{f.submitted.push(request);return {requestId:'provider-source-cleanup',unexpected:true}};assert.equal((await f.start()).state,'unknown');await f.poll();assert.equal(f.submitted.length,1);assert.equal((await f.workflow.get(f.identity)).settlement,null);
 }finally{await f.mf.dispose();}
});
test('a flag or owner reduction during preparation prevents any new paid claim',async()=>{
 for(const field of ['RIG_OWNER_CLEANUP_VALIDATION_ENABLED','RIG_OWNER_RECAST_VALIDATION_ENABLED','RIG_PRODUCTION_OWNER_USER_ID']){const f=await fixture();try{
  const prepare=f.adapters.prepareStep;f.adapters.prepareStep=async request=>{const answer=await prepare(request);f.env[field]=field==='RIG_PRODUCTION_OWNER_USER_ID'?OTHER:'no';return answer};await assert.rejects(f.start(),{code:'workflow_owner_validation_unavailable'});assert.equal(f.submitted.length,0);assert.equal((await f.workflow.get(f.identity)).steps[0].state,'prepared');
 }finally{await f.mf.dispose();}}
});
test('fixed payload or input-hash changes fail before the provider authorization',async()=>{
 for(const mutation of [r=>r.inputHash=HASH,r=>r.payload.num_inference_steps=20,r=>r.payload.video_url='https://attacker.invalid/video.mp4']){const f=await fixture();try{
  const prepare=f.adapters.prepareStep;f.adapters.prepareStep=async request=>{const answer=await prepare(request);mutation(answer);return answer};await assert.rejects(f.start());assert.equal(f.submitted.length,0);assert.equal((await f.workflow.get(f.identity)).steps[0].dispatch_token,null);
 }finally{await f.mf.dispose();}}
});
test('a mismatched poll request identity retains the known job and releases its lease for read-only recovery',async()=>{
 const f=await fixture();try{
  await f.start();f.answers.set('provider-source-cleanup',{state:'failed',requestId:'another-request'});await assert.rejects(f.poll());const b=await f.workflow.get(f.identity);assert.equal(b.steps[0].state,'queued');assert.equal(b.steps[0].poll_token,null);assert.equal(b.settlement,null);assert.equal(f.stored.length,0);assert.equal(f.submitted.length,1);
 }finally{await f.mf.dispose();}
});
test('definitive preclean failure skips unstarted Recast and settles without inventing owner RIG credits',async()=>{
 const f=await fixture();try{
  await f.start();f.answers.set('provider-source-cleanup',{state:'failed',requestId:'provider-source-cleanup'});const failed=await f.poll();assert.equal(failed.state,'failed');assert.equal(failed.settlement.refundedCents,375);assert.equal(failed.settlement.fundingKind,'owner-provider');const b=await f.workflow.get(f.identity);assert.equal(b.steps[1].state,'skipped');assert.equal(b.settlement.provider_dispatched_steps,1);assert.equal(await f.balance(),2000);assert.equal(f.submitted.length,1);await f.poll();assert.equal(f.submitted.length,1);
 }finally{await f.mf.dispose();}
});
test('temporary result storage failure retries only the known result read, while explicit output rejection is terminal',async()=>{
 const f=await fixture();try{
  await f.start();f.answers.set('provider-source-cleanup',{state:'completed',requestId:'provider-source-cleanup',result:{fixture:true}});const store=f.adapters.persistStepResult;f.adapters.persistStepResult=async()=>{throw Error('temporary private storage error')};await assert.rejects(f.poll());assert.equal((await f.workflow.get(f.identity)).steps[0].state,'queued');assert.equal(f.submitted.length,1);
  f.adapters.persistStepResult=store;assert.equal((await f.poll()).state,'awaiting_client_processing');assert.equal(f.submitted.length,1);
 }finally{await f.mf.dispose();}
 const f2=await fixture();try{await f2.start();f2.answers.set('provider-source-cleanup',{state:'completed',requestId:'provider-source-cleanup',result:{fixture:true}});f2.adapters.persistStepResult=async()=>({kind:'rejected',reason:'output_invalid'});assert.equal((await f2.poll()).state,'failed');assert.equal(f2.submitted.length,1);}finally{await f2.mf.dispose();}
});
test('accepted base result polling and settlement recover after owner validation is disabled',async()=>{
 const f=await fixture();try{
  await f.stage();await f.upload();await f.advance();f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';f.env.RIG_PRODUCTION_OWNER_USER_ID=OTHER;f.answers.set('provider-base',{state:'completed',requestId:'provider-base',result:{fixture:true}});
  const result=await f.poll();assert.equal(result.state,'completed');assert.equal(result.result.sha256,clips.output.meta.sha256);assert.equal(result.settlement.outcome,'completed');assert.equal(result.settlement.chargedCents,375);assert.equal(result.settlement.refundedCents,0);assert.equal(f.submitted.length,2);assert.equal(await f.balance(),2000);await f.poll();assert.equal(f.submitted.length,2);
 }finally{await f.mf.dispose();}
});
test('both current validation stops still block the paid base after a successfully paid preclean',async()=>{
 for(const flag of ['RIG_OWNER_CLEANUP_VALIDATION_ENABLED','RIG_OWNER_RECAST_VALIDATION_ENABLED']){const f=await fixture();try{
  await f.stage();await f.upload();f.env[flag]='no';await assert.rejects(f.advance(),{code:'workflow_owner_validation_unavailable'});assert.equal(f.submitted.length,1);assert.equal((await f.workflow.get(f.identity)).steps[1].dispatch_token,null);assert.equal((await f.poll()).state,'ready_to_advance');
 }finally{await f.mf.dispose();}}
});
test('a reduced daily provider ceiling blocks the next paid step without another reserve or silent no-op',async()=>{
 const f=await fixture();try{
  await f.stage();await f.upload();await f.db.prepare('UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=? WHERE id=1').bind(f.usd-1).run();
  await assert.rejects(f.advance(),{code:'workflow_dispatch_blocked'});assert.equal(f.submitted.length,1);assert.equal((await f.workflow.get(f.identity)).steps[1].dispatch_token,null);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);assert.equal(await f.balance(),2000);
 }finally{await f.mf.dispose();}
});
test('failed base after completed paid source cleanup retains both requests and settles full owner outcome',async()=>{
 const f=await fixture();try{
  await f.stage();await f.upload();await f.advance();f.answers.set('provider-base',{state:'failed',requestId:'provider-base'});const result=await f.poll();assert.equal(result.state,'failed');assert.equal(result.settlement.refundedCents,375);assert.equal(result.settlement.chargedCents,0);const b=await f.workflow.get(f.identity);assert.equal(b.steps[0].state,'completed');assert.equal(b.settlement.provider_dispatched_steps,2);assert.equal(f.submitted.length,2);assert.equal(await f.balance(),2000);
 }finally{await f.mf.dispose();}
});
test('unrecognized422 review persists with the known request and only terminal success clears it',async()=>{
 const f=await fixture();try{
  await f.start();await assert.rejects(f.workflow.markNeedsReview({...f.identity,stepId:'source-cleanup',requestId:'provider-source-cleanup',token:'wrong-poll-lease'}));
  f.answers.set('provider-source-cleanup',{state:'pending',requestId:'provider-source-cleanup',needsReview:true});assert.equal((await f.poll()).state,'needs_review');
  let b=await f.workflow.get(f.identity);assert.equal(b.steps[0].failure_code,'provider_status_unrecognized');assert.equal(b.steps[0].fal_request_id,'provider-source-cleanup');assert.equal(b.settlement,null);
  f.answers.set('provider-source-cleanup',{state:'pending',requestId:'provider-source-cleanup'});assert.equal((await f.poll()).state,'needs_review');assert.equal((await f.runner.get(f.identity)).state,'needs_review');await f.start();assert.equal(f.submitted.length,1);
  f.answers.set('provider-source-cleanup',{state:'completed',requestId:'provider-source-cleanup',result:{fixture:true}});assert.equal((await f.poll()).state,'awaiting_client_processing');b=await f.workflow.get(f.identity);assert.equal(b.steps[0].failure_code,null);assert.equal(f.submitted.length,1);
 }finally{await f.mf.dispose();}
});
