import test,{before,after} from 'node:test';
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
import {createProductionWorkflowStores,workflowPlanHash,workflowInitialSourceHash,validateWorkflowPlan} from './production-workflow-stores.mjs';
import {workflowNetRetailCents} from './workflow-finance.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',HASH='a'.repeat(64);
async function fixture({owner=false,preclean=true,postcleanup=false,client=true,reader=true,writer=true}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 for(const file of ['./production-schema.sql']){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('workflow-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,2000)').bind('paid:'+USER,USER).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'workflow-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:USER}:{})};
 const context=await createProductionGenerationContext(env),parents=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:context});
 if(owner)await installTestOwnerCredential(db,USER);
 const workflow=createProductionWorkflowStores(db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env)});
 const pre={id:'preclean',kind:'preclean',model:'fixture/preclean',queueFamily:'fixture/preclean',contract:'preclean-v1',settings:{resolution:'1080P'},dependsOn:null,providerEstimateUsdMicros:300000,retailCents:75};
 const base={id:'base',kind:'base',model:'fixture/base',queueFamily:'fixture/base',contract:'base-v1',settings:{resolution:'1080P'},dependsOn:preclean?'preclean':null,providerEstimateUsdMicros:600000,retailCents:300};
 const post={id:'cleanup',kind:'postcleanup',model:'fixture/cleanup',queueFamily:'fixture/cleanup',contract:'cleanup-v1',settings:{resolution:'1080P'},dependsOn:'base',providerEstimateUsdMicros:200000,retailCents:100};
 const plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:300+(preclean?75:0),cleanupRetailCents:postcleanup?100:0,steps:[...(preclean?[pre]:[]),base,...(postcleanup?[post]:[])]};if(client)plan.clientProcessing={id:'compose',contract:WORKFLOW_CLIENT_CONTRACT,beforeStepId:'base',cleanFromStepId:'preclean',source:{id:'source',sha256:clips.source.meta.sha256},mask:{id:'mask',sha256:clips.mask.meta.sha256},media:workflowClientMedia(clips.source.meta)};plan.planHash=await workflowPlanHash(plan);
 const usd=plan.steps.reduce((n,s)=>n+s.providerEstimateUsdMicros,0),totalRetail=plan.baseRetailCents+plan.cleanupRetailCents;
 const made=await parents.quotes.create({userId:USER,model:'fixture/base',input:{data:{quality:'pro',prompt:'fixture'},refs:[{id:'source',sha256:clips.source.meta.sha256},{id:'mask',sha256:clips.mask.meta.sha256}],workflow:plan,providerEstimateUsdMicros:usd},priceCents:totalRetail,pricingVersion:'fixture-v1',durationSeconds:6});
 const quote=await parents.quotes.getOwned(USER,made.id),key=crypto.randomUUID(),payload={quoteId:quote.id,idempotencyKey:key},verification=owner?await verificationFor(db,USER,'owner-generation',payload,Date.now(),{env}):undefined;
 const begun=await parents.jobs.begin({userId:USER,quoteId:quote.id,idempotencyKey:key,quote,verification,verificationPayload:payload});assert.equal(begun.kind,'created');
 const job=begun.job,identity={userId:USER,jobId:job.id},args=(stepId,more={})=>({...identity,stepId,...more});
 const init=()=>workflow.initialize({...identity,quote});
 const authorize=async(stepId='base',{inputHash=clips.output.meta.sha256}={})=>{const dep=plan.steps.find(s=>s.id===stepId).dependsOn;const sourceHash=dep?(await workflow.get(identity)).steps.find(s=>s.step_id===dep).output_sha256:await workflowInitialSourceHash(quote);return workflow.authorizeStep(args(stepId,{sourceHash,inputHash,requestHash:'b'.repeat(64)}));};
 const balance=async()=>(await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n;
 async function complete(stepId='base',{failed=false}={}){const auth=await authorize(stepId);assert.equal(auth.authorized,true);const requestId='request-'+stepId;await workflow.markSubmitted(args(stepId,{dispatchToken:auth.dispatchToken,requestId}));const poll=await workflow.claimPoll(args(stepId));assert.equal(poll.kind,'acquired');if(failed)await workflow.markFailed(args(stepId,{requestId,token:poll.token}));else await workflow.markCompleted(args(stepId,{requestId,token:poll.token,resultKey:`rig-workflow-results/${job.id}/${stepId}.mp4`,outputHash:stepId==='preclean'?clips.clean.meta.sha256:clips.output.meta.sha256,outputMetadata:stepId==='preclean'?clips.clean.meta:clips.output.meta}));}
 const objects=new Map(),reads=[],writes=[];
 const clients=createProductionWorkflowClientStores(db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(env),workflows:workflow,...(reader?{readOwnedArtifact:async request=>{reads.push(request);assert.equal(request.userId,USER);assert.equal(request.jobId,job.id);if(request.role==='output')return objects.get(request.reference.key);return clips[request.role].bytes;}}:{}),...(writer?{putOwnedOutput:async request=>{writes.push(request);if(!objects.has(request.key))objects.set(request.key,request.bytes.slice());}}:{})});
 const prep=async()=>{await init();assert.equal(await parents.jobs.authorizeDispatch(USER,job.id),true);await complete('preclean');return clients.prepareAwaiting(identity);};
 const upload=()=>clients.uploadOutput({...identity,stageId:'compose',body:clips.output.bytes,sha256:clips.output.meta.sha256});
 return {clients,prep,upload,objects,reads,writes,mf,db,env,context,parents,workflow,plan,quote,job,identity,args,init,authorize,balance,complete,usd,totalRetail};
}

const run=promisify(execFile);let directory,clips;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'rig-client-workflow-'));const source=join(directory,'source.mp4'),clean=join(directory,'clean.mp4'),mask=join(directory,'mask.mp4'),output=join(directory,'output.mp4');
 await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=360x640:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.5','-frames:v','12','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',source],{timeout:20000});
 await run('ffmpeg',['-v','error','-i',source,'-map','0:v','-c','copy','-an',clean],{timeout:10000});
 await run('ffmpeg',['-v','error','-f','lavfi','-i','color=black:size=360x640:rate=24','-frames:v','12','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-an',mask],{timeout:10000});
 await run('ffmpeg',['-v','error','-i',source,'-c','copy','-movflags','+faststart',output],{timeout:10000});
 clips={};for(const [role,path]of Object.entries({source,clean,mask,output})){const bytes=await readFile(path);clips[role]={bytes,meta:await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':role==='clean'?'result':'input'})};}
 assert.notEqual(clips.source.meta.sha256,clips.output.meta.sha256);assert.equal(clips.source.meta.timelineSha256,clips.clean.meta.timelineSha256);assert.equal(clips.source.meta.audio.packetSha256,clips.output.meta.audio.packetSha256);
});
after(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

test('client stage requires a completed owned preclean and cannot bypass the base authorization edge',async()=>{
 const f=await fixture();try{
  await f.init();await assert.rejects(f.clients.prepareAwaiting(f.identity),/not ready/);
  assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('preclean');
  assert.equal((await f.authorize('base')).state,'awaiting_client_processing');
  const manifest=await f.clients.prepareAwaiting(f.identity);assert.equal(manifest.state,'awaiting_client_processing');assert.equal(manifest.version,WORKFLOW_CLIENT_CONTRACT);assert.equal(manifest.media.hasAudio,true);assert.equal(manifest.artifacts.clean.sha256,clips.clean.meta.sha256);assert.equal(f.reads.length,3);
  assert.deepEqual(await f.clients.prepareAwaiting(f.identity),manifest);assert.equal(f.reads.length,3);
  assert.equal((await f.authorize('base')).state,'awaiting_client_processing');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('private manifest and role reads enforce owner, exact stage, and actual held artifact hash',async()=>{
 const f=await fixture();try{
  const manifest=await f.prep();const serialized=JSON.stringify(manifest);assert.ok(!serialized.includes('rig-workflow-results'));assert.ok(!serialized.includes('fal_request'));assert.ok(!serialized.includes('https://'));
  await assert.rejects(f.clients.get({...f.identity,userId:OTHER,stageId:'compose'}));await assert.rejects(f.clients.get({...f.identity,stageId:'other'}));
  for(const role of ['source','clean','mask']){const held=await f.clients.getArtifact({...f.identity,stageId:'compose',role});assert.equal(held.inspection.sha256,clips[role].meta.sha256);assert.equal(held.bytes.length,clips[role].bytes.length);}
  await assert.rejects(f.clients.getArtifact({...f.identity,stageId:'compose',role:'../private'}));await assert.rejects(f.clients.getArtifact({...f.identity,stageId:'compose',role:'output'}));
  const changed=Buffer.from(clips.source.bytes),original=clips.source.bytes;changed[changed.length-1]^=1;clips.source.bytes=changed;
  try{await assert.rejects(f.clients.getArtifact({...f.identity,stageId:'compose',role:'source'}));}finally{clips.source.bytes=original;}
  assert.equal((await f.workflow.get(f.identity)).steps[1].state,'prepared');
 }finally{await f.mf.dispose();}
});
test('verified output upload remains unpaid and only explicit advance unlocks one primary dispatch',async()=>{
 const f=await fixture();try{
  await f.prep();const uploaded=await f.upload();assert.equal(uploaded.state,'ready_to_advance');assert.equal(f.writes.length,1);assert.equal((await f.authorize('base')).state,'awaiting_client_processing');
  assert.deepEqual(await f.upload(),uploaded);assert.equal(f.writes.length,1);
  const read=await f.clients.getArtifact({...f.identity,stageId:'compose',role:'output'});assert.equal(read.inspection.audio.packetSha256,clips.source.meta.audio.packetSha256);
  const advance={...f.identity,stageId:'compose',idempotencyKey:'explicit-post-advance',outputHash:clips.output.meta.sha256};
  const done=await f.clients.advance(advance);assert.equal(done.advanced,true);assert.equal((await f.workflow.get(f.identity)).steps[1].state,'prepared');assert.equal((await f.clients.advance(advance)).advanced,false);
  const wrong=await f.authorize('base',{inputHash:clips.source.meta.sha256});assert.equal(wrong.state,'awaiting_client_processing');
  const results=await Promise.all([f.authorize('base'),f.authorize('base')]);assert.equal(results.filter(r=>r.authorized).length,1);assert.equal(await f.balance(),1625);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('a tab can reconstruct client work from private artifacts without a second provider authorization',async()=>{
 const f=await fixture();try{
  const first=await f.prep(),reopened=createProductionWorkflowClientStores(f.db,{productionContext:f.context,workflows:f.workflow,readOwnedArtifact:request=>clips[request.role].bytes});
  assert.deepEqual(await reopened.get({...f.identity,stageId:'compose'}),first);
  for(const role of ['source','clean','mask'])assert.ok((await reopened.getArtifact({...f.identity,stageId:'compose',role})).bytes.length>0);
  const state=await f.workflow.get(f.identity);assert.equal(state.steps[0].state,'completed');assert.equal(state.steps[1].state,'prepared');assert.equal(state.settlement,null);assert.equal(await f.balance(),1625);
 }finally{await f.mf.dispose();}
});
test('a wrong digest, changed audio, malformed output or missing private callback cannot unlock the base',async()=>{
 const f=await fixture();try{
  await f.prep();for(const value of [{body:clips.output.bytes,sha256:HASH},{body:clips.clean.bytes,sha256:clips.clean.meta.sha256},{body:new Uint8Array(64),sha256:HASH},{body:new Uint8Array(16777217),sha256:HASH}])await assert.rejects(f.clients.uploadOutput({...f.identity,stageId:'compose',...value}));
  const noWriter=createProductionWorkflowClientStores(f.db,{productionContext:f.context,workflows:f.workflow});await assert.rejects(noWriter.uploadOutput({...f.identity,stageId:'compose',body:clips.output.bytes,sha256:clips.output.meta.sha256}),/writer/);
  assert.equal(f.writes.length,0);assert.equal((await f.clients.get({...f.identity,stageId:'compose'})).state,'awaiting_client_processing');assert.equal((await f.authorize('base')).authorized,false);
 }finally{await f.mf.dispose();}
});
test('output and advance idempotency are immutable; a stale or forged transition cannot dispatch',async()=>{
 const f=await fixture();try{
  await f.prep();await assert.rejects(f.clients.advance({...f.identity,stageId:'compose',idempotencyKey:'too-early',outputHash:clips.output.meta.sha256}),/Verified/);await f.upload();
  await assert.rejects(f.clients.uploadOutput({...f.identity,stageId:'compose',body:clips.source.bytes,sha256:clips.source.meta.sha256}),/immutable/);
  const args={...f.identity,stageId:'compose',idempotencyKey:'same-advance',outputHash:clips.output.meta.sha256};const race=await Promise.all([f.clients.advance(args),f.clients.advance(args)]);assert.equal(race.filter(r=>r.advanced).length,1);
  await assert.rejects(f.clients.advance({...args,idempotencyKey:'different'}),/Conflicting/);assert.equal((await f.workflow.get(f.identity)).steps[1].state,'prepared');
 }finally{await f.mf.dispose();}
});
test('freeze and current owner-pin reductions block explicit continuation but preserve private recovery',async()=>{
 const f=await fixture({owner:true});try{
  await f.prep();await f.upload();const args={...f.identity,stageId:'compose',idempotencyKey:'owner-advance',outputHash:clips.output.meta.sha256};
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(USER).run();await assert.rejects(f.clients.advance(args),/blocked/);assert.equal((await f.clients.get({...f.identity,stageId:'compose'})).state,'ready_to_advance');await f.db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').bind(USER).run();
  f.env.RIG_PRODUCTION_OWNER_USER_ID=OTHER;await assert.rejects(f.clients.advance(args),/blocked/);assert.equal((await f.authorize('base')).authorized,false);
  f.env.RIG_PRODUCTION_OWNER_USER_ID=USER;assert.equal((await f.clients.advance(args)).advanced,true);f.env.RIG_PRODUCTION_OWNER_USER_ID=OTHER;assert.equal((await f.authorize('base')).authorized,false);assert.equal(await f.balance(),2000);
 }finally{await f.mf.dispose();}
});
test('an unstarted primary can still be cancelled after paid preclean without erasing provider costs',async()=>{
 const f=await fixture();try{
  await f.prep();await f.workflow.skipStep(f.args('base'));const settlement=await f.workflow.finalize(f.identity);assert.equal(settlement.outcome,'failed');assert.equal(settlement.refunded_cents,375);assert.equal(await f.balance(),2000);assert.equal(settlement.provider_dispatched_steps,1);
  await assert.rejects(f.upload());assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);assert.equal((await f.clients.get({...f.identity,stageId:'compose'})).state,'awaiting_client_processing');
 }finally{await f.mf.dispose();}
});
