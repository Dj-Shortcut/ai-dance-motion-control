// Server-only candidate. No routes, fetch defaults, credentials or scheduler.
// Controllers authenticate the user, enforce CSRF/quota and obtain jobs.begin's
// accepted funding/device proof before invoking this runner.
import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {validateWorkflowPlan,workflowHash,workflowInitialSourceHash} from './production-workflow-stores.mjs';
import {OVERLAY_CLEANUP_MODEL,OVERLAY_CLEANUP_QUEUE_FAMILY,OVERLAY_CLEANUP_CONTRACT,OVERLAY_CLEANUP_BILLING,validOverlayCleanupSettings,overlayCleanupPayload} from './overlay-cleanup-contract.mjs';
import {RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_QUALITY,RECAST_SETTINGS,validRecastSettings} from './recast-contract.mjs';
import {RECAST_BILLING} from './price-preflight.mjs';
export const WORKFLOW_OWNER_CLEANUP_FLAG='RIG_OWNER_CLEANUP_VALIDATION_ENABLED';
export const WORKFLOW_TRANSFER_POLICY='fal-temporary-links-v1';
const ID=/^[A-Za-z0-9_-]{1,100}$/,SHA=/^[a-f0-9]{64}$/;
const plain=x=>x!==null&&Object.getPrototypeOf(x)===Object.prototype;
const same=(a,b)=>plain(a)&&plain(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>Object.hasOwn(a,k)&&Object.is(a[k],b[k]));
const clone=x=>structuredClone(x);
function reject(code,status=409){const error=Error(code);error.code=code;error.status=status;throw error;}
const post=method=>{if(method!=='POST')reject('workflow_explicit_post_required',405)};
function temporaryUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='v3b.fal.media'&&!u.port&&!u.username&&!u.password&&!u.hash&&!u.search&&/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname)}catch{return false}}

// This exported check can also run before jobs.begin, so an invalid candidate
// is never reserved as a legacy single-provider job.
export async function validateOwnerCleanupWorkflow(quote){
 const checked=await validateWorkflowPlan(quote?.input?.workflow,quote),plan=checked.plan,[pre,base]=plan.steps,cleanup=quote.input.cleanup,data=quote.input.data;
 if(plan.steps.length!==2||pre.id!=='source-cleanup'||pre.kind!=='preclean'||pre.model!==OVERLAY_CLEANUP_MODEL||pre.queueFamily!==OVERLAY_CLEANUP_QUEUE_FAMILY||pre.contract!==OVERLAY_CLEANUP_CONTRACT||!validOverlayCleanupSettings(pre.settings)||base.id!=='base'||base.kind!=='base'||base.dependsOn!==pre.id||base.model!==RECAST_MODEL||base.queueFamily!==RECAST_QUEUE_FAMILY||base.contract!==RECAST_PROVIDER_CONTRACT||!validRecastSettings(base.settings)||plan.baseStepId!==base.id||plan.cleanupRetailCents!==0||!plan.clientProcessing||plan.clientProcessing.beforeStepId!==base.id||plan.clientProcessing.cleanFromStepId!==pre.id||quote.fundingKind!=='owner-provider')reject('workflow_contract_requires_new_quote');
 const media=plan.clientProcessing.media,duration=media.frameCount/media.fpsNumerator;
 if(duration<5||duration>15||!Number.isFinite(quote.durationSeconds)||Math.abs(duration-quote.durationSeconds)>1e-6||data?.quality!==RECAST_QUALITY||data.transferPolicy!==WORKFLOW_TRANSFER_POLICY||data.keepSound!==true||data.steadyCamera!==false||data.faceId!==null||!Array.isArray(data.angleIds)||data.angleIds.length||!ID.test(data.imageId||'')||typeof data.prompt!=='string'||!data.prompt.trim()||data.prompt.length>1900||quote.input.prompt!==data.prompt||quote.input.providerContract!==RECAST_PROVIDER_CONTRACT||!validRecastSettings(quote.input.providerSettings))reject('workflow_contract_requires_new_quote');
 const image=quote.input.refs.filter(ref=>ref.id===data.imageId&&ref.kind==='image'&&SHA.test(ref.sha256||''));
 if(image.length!==1||data.videoId!==plan.clientProcessing.source.id||!plain(cleanup)||cleanup.contract!==pre.contract||cleanup.model!==pre.model||cleanup.queueFamily!==pre.queueFamily||!validOverlayCleanupSettings(cleanup.settings)||cleanup.sourceSha256!==plan.clientProcessing.source.sha256||cleanup.maskSha256!==plan.clientProcessing.mask.sha256||cleanup.timelineSha256!==media.timelineSha256||['width','height','frameCount','fpsNumerator','fpsDenominator'].some(k=>cleanup[k]!==media[k])||!same(cleanup.billing,OVERLAY_CLEANUP_BILLING)||cleanup.providerEstimateUsdMicros!==pre.providerEstimateUsdMicros||cleanup.combinedProviderEstimateUsdMicros!==checked.usd)reject('workflow_contract_requires_new_quote');
 const audio=media.hasAudio?{packetSha256:media.audio.packetSha256,timelineSha256:media.audio.timelineSha256,decoderConfigSha256:media.audio.codecConfigSha256}:null;
 if(audio?!same(cleanup.audio,audio):cleanup.audio!==null)reject('workflow_contract_requires_new_quote');
 const pixelFrames=BigInt(media.width)*BigInt(media.height)*BigInt(media.frameCount),mp=(pixelFrames+999999n)/1000000n,estimate=Number((mp*BigInt(OVERLAY_CLEANUP_BILLING.nanosPerMegapixel)+999n)/1000n);
 if(pre.providerEstimateUsdMicros!==estimate||base.providerEstimateUsdMicros!==Math.ceil(duration)*RECAST_BILLING.usdMicrosPerSecond||cleanup.billedMegapixels!==Number(mp)||cleanup.pixelFrames!==pixelFrames.toString())reject('workflow_contract_requires_new_quote');
 // Reuse the exact provider contract to check the stored cleanup prompt too.
 overlayCleanupPayload(cleanup,{source:{verified:true,kind:'video',sha256:cleanup.sourceSha256,url:'https://v3b.fal.media/files/b/contract/source.mp4'},mask:{verified:true,kind:'video',sha256:cleanup.maskSha256,url:'https://v3b.fal.media/files/b/contract/mask.mp4'}});
 return {...checked,image:clone(image[0])};
}

export function createWorkflowRunner({db,productionContext,readCurrentProductionContext,parents,workflows,clients,adapters}={}){
 if(!isProductionGenerationContext(productionContext,{db})||typeof readCurrentProductionContext!=='function'||typeof parents?.jobs?.authorizeDispatch!=='function'||['initialize','get','authorizeStep','markSubmitted','markUnknown','claimPoll','releasePoll','markNeedsReview','markCompleted','markFailed','skipStep','finalize'].some(k=>typeof workflows?.[k]!=='function')||['prepareAwaiting','get','getArtifact','advance'].some(k=>typeof clients?.[k]!=='function')||['prepareStep','submitStep','pollStep','persistStepResult'].some(k=>typeof adapters?.[k]!=='function'))throw Error('Workflow runner adapters required');
 async function gate(userId){
  const current=await readCurrentProductionContext();
  if(!isProductionGenerationContext(current,{db})||current.env.RIG_PUBLIC_ORIGIN!==productionContext.env.RIG_PUBLIC_ORIGIN||[WORKFLOW_OWNER_CLEANUP_FLAG,'RIG_OWNER_RECAST_VALIDATION_ENABLED'].some(flag=>productionContext.env[flag]!=='yes'||current.env[flag]!=='yes')||productionFundingKind(productionContext,userId)!=='owner-provider'||productionFundingKind(current,userId)!=='owner-provider')reject('workflow_owner_validation_unavailable',403);
 }
 async function owned(userId,jobId){
  if(!ID.test(userId||'')||!ID.test(jobId||''))reject('workflow_not_found',404);
  const state=await workflows.get({userId,jobId});await validateOwnerCleanupWorkflow(state.quote);return state;
 }
 async function summary(userId,jobId){
  const b=await owned(userId,jobId),first=b.steps[0],base=b.steps[1];let state=b.row.state,clientProcessing;
  if(!b.settlement&&(['authorized','unknown'].includes(first.state)||['authorized','unknown'].includes(base.state)))state='unknown';
  else if(!b.settlement&&b.steps.some(s=>s.state==='queued'&&s.failure_code==='provider_status_unrecognized'))state='needs_review';
  else if(!b.settlement&&first.state==='completed'&&base.state==='prepared'){
   try{clientProcessing=await clients.get({userId,jobId,stageId:b.plan.clientProcessing.id});state=clientProcessing.state==='advanced'?'ready_to_advance':clientProcessing.state;}
   catch{state='awaiting_client_processing';}
  }
  return {jobId,quoteId:b.quote.id,state,...(clientProcessing?{clientProcessing}:{}),...(b.settlement?{settlement:{outcome:b.settlement.outcome,fundingKind:b.settlement.funding_kind,chargedCents:b.settlement.charged_cents,refundedCents:b.settlement.refunded_cents},...(b.settlement.result_key?{result:{stepId:base.step_id,sha256:base.output_sha256}}:{})}:{})};
 }
 async function prepare(userId,jobId,b,index){
  const step=b.plan.steps[index];let inputBinding,sourceHash;
  if(index===0){sourceHash=await workflowInitialSourceHash(b.quote);inputBinding={kind:'source-and-mask',source:clone(b.plan.clientProcessing.source),mask:clone(b.plan.clientProcessing.mask)};inputBinding.inputHash=await workflowHash(inputBinding);}
  else{
   const manifest=await clients.get({userId,jobId,stageId:b.plan.clientProcessing.id});
   if(manifest.state!=='advanced'||!SHA.test(manifest.output?.sha256||''))reject('workflow_explicit_advance_required');
   const held=await clients.getArtifact({userId,jobId,stageId:b.plan.clientProcessing.id,role:'output'});
   if(held.artifact.sha256!==manifest.output.sha256)reject('workflow_composed_input_changed');
   sourceHash=b.steps[0].output_sha256;inputBinding={kind:'client-composed',inputHash:manifest.output.sha256,artifact:clone(held.artifact),bytes:held.bytes,inspection:held.inspection,image:clone((await validateOwnerCleanupWorkflow(b.quote)).image)};
  }
  const prepared=await adapters.prepareStep({userId,jobId,quote:clone(b.quote),plan:clone(b.plan),step:clone(step),inputBinding});
  if(!plain(prepared)||Object.keys(prepared).length!==2||!Object.hasOwn(prepared,'inputHash')||!Object.hasOwn(prepared,'payload')||prepared.inputHash!==inputBinding.inputHash||!plain(prepared.payload))reject('workflow_prepared_input_changed');
  let expected;
  if(index===0)expected=overlayCleanupPayload(b.quote.input.cleanup,{source:{verified:true,kind:'video',sha256:b.plan.clientProcessing.source.sha256,url:prepared.payload.video_url},mask:{verified:true,kind:'video',sha256:b.plan.clientProcessing.mask.sha256,url:prepared.payload.mask_video_url}});
  else{
   if(!temporaryUrl(prepared.payload.video_url)||!Array.isArray(prepared.payload.reference_image_urls)||prepared.payload.reference_image_urls.length!==1||!temporaryUrl(prepared.payload.reference_image_urls[0]))reject('workflow_invalid_transfer');
   expected={video_url:prepared.payload.video_url,reference_image_urls:[prepared.payload.reference_image_urls[0]],prompt:b.quote.input.prompt,...RECAST_SETTINGS};
  }
  if(await workflowHash(prepared.payload)!==await workflowHash(expected))reject('workflow_payload_contract_changed');
  const payload=clone(prepared.payload),inputHash=prepared.inputHash,requestHash=await workflowHash({model:step.model,queueFamily:step.queueFamily,contract:step.contract,settings:step.settings,inputHash,payload});
  return {step,payload,sourceHash,inputHash,requestHash};
 }
 async function dispatch(userId,jobId,index){
  let b=await owned(userId,jobId);if(b.settlement||b.steps[index].state!=='prepared')return summary(userId,jobId);
  await gate(userId);const prepared=await prepare(userId,jobId,b,index);await gate(userId);
  const authorization=await workflows.authorizeStep({userId,jobId,stepId:prepared.step.id,sourceHash:prepared.sourceHash,inputHash:prepared.inputHash,requestHash:prepared.requestHash});
  if(!authorization.authorized){if((await owned(userId,jobId)).steps[index].state==='prepared')reject('workflow_dispatch_blocked');return summary(userId,jobId);}
  // From this durable claim onwards, every ambiguous result retains the hold.
  // Never call submit twice, even if the HTTP response or ID persistence fails.
  try{
   await gate(userId);
   const submitted=await adapters.submitStep({userId,jobId,model:prepared.step.model,queueFamily:prepared.step.queueFamily,contract:prepared.step.contract,stepId:prepared.step.id,payload:prepared.payload,requestHash:prepared.requestHash,inputHash:prepared.inputHash,dispatchToken:authorization.dispatchToken});
   if(!plain(submitted)||Object.keys(submitted).length!==1||!ID.test(submitted.requestId||''))throw Error('Ambiguous provider response');
   await workflows.markSubmitted({userId,jobId,stepId:prepared.step.id,dispatchToken:authorization.dispatchToken,requestId:submitted.requestId});
  }catch{
   await workflows.markUnknown({userId,jobId,stepId:prepared.step.id,dispatchToken:authorization.dispatchToken});
  }
  return summary(userId,jobId);
 }
 async function terminalProgress(userId,jobId){
  const b=await owned(userId,jobId);
  if(b.steps[0].state==='failed'&&b.steps[1].state==='prepared')await workflows.skipStep({userId,jobId,stepId:b.steps[1].step_id,reason:'dependency_failed'});
  const after=await owned(userId,jobId);
  if(after.steps.every(s=>['completed','failed','skipped'].includes(s.state)))await workflows.finalize({userId,jobId});
  else if(after.steps[0].state==='completed'&&after.steps[1].state==='prepared')await clients.prepareAwaiting({userId,jobId});
 }
 return Object.freeze({
  get:({userId,jobId})=>summary(userId,jobId),
  async startAccepted({method,userId,jobId,quote,transferConsent}){
   post(method);if(transferConsent!==WORKFLOW_TRANSFER_POLICY)reject('workflow_transfer_consent_required',400);
   await gate(userId);await validateOwnerCleanupWorkflow(quote);await workflows.initialize({userId,jobId,quote});
   const b=await owned(userId,jobId);if(b.settlement||b.steps[0].state!=='prepared')return summary(userId,jobId);
   if(b.row.poll_token!=='dispatch-authorized'){
    const authorized=await parents.jobs.authorizeDispatch(userId,jobId);
    if(!authorized){const after=await owned(userId,jobId);if(after.settlement||after.steps[0].state!=='prepared')return summary(userId,jobId);if(after.row.poll_token!=='dispatch-authorized')reject('workflow_budget_unavailable');}
   }
   return dispatch(userId,jobId,0);
  },
  async advance({method,userId,jobId,stageId,idempotencyKey,outputHash}){
   post(method);const b=await owned(userId,jobId);if(stageId!==b.plan.clientProcessing.id)reject('workflow_client_stage_changed');
   await gate(userId);await clients.advance({userId,jobId,stageId,idempotencyKey,outputHash});return dispatch(userId,jobId,1);
  },
  async poll({method,userId,jobId}){
   if(method!=='GET')reject('workflow_get_required',405);
   const b=await owned(userId,jobId);if(b.settlement)return summary(userId,jobId);
   const queued=b.steps.find(s=>s.state==='queued'&&s.fal_request_id);
   if(!queued){await terminalProgress(userId,jobId);return summary(userId,jobId);}
   const lease=await workflows.claimPoll({userId,jobId,stepId:queued.step_id});if(lease.kind!=='acquired')return summary(userId,jobId);
   const step=b.plan.steps[queued.step_index],identity={userId,jobId,stepId:queued.step_id,requestId:queued.fal_request_id,token:lease.token};
   try{
    const answer=await adapters.pollStep({userId,jobId,stepId:step.id,model:step.model,queueFamily:step.queueFamily,contract:step.contract,requestId:queued.fal_request_id});
    if(!plain(answer)||answer.requestId!==queued.fal_request_id||!['pending','completed','failed'].includes(answer.state))throw Error('Provider status requires reconciliation');
    if(answer.state==='pending'&&answer.needsReview===true)await workflows.markNeedsReview(identity);
    if(answer.state==='failed')await workflows.markFailed({...identity,reason:'provider_failed'});
    else if(answer.state==='completed'){
     const stored=await adapters.persistStepResult({userId,jobId,quote:clone(b.quote),plan:clone(b.plan),step:clone(step),requestId:queued.fal_request_id,providerResult:answer.result,resultKey:`rig-workflow-results/${jobId}/${step.id}.mp4`});
     if(stored?.kind==='rejected'&&stored.reason==='output_invalid')await workflows.markFailed({...identity,reason:'output_invalid'});
     else if(stored?.kind==='stored'&&stored.resultKey===`rig-workflow-results/${jobId}/${step.id}.mp4`&&SHA.test(stored.outputHash||'')&&plain(stored.outputMetadata))await workflows.markCompleted({...identity,resultKey:stored.resultKey,outputHash:stored.outputHash,outputMetadata:stored.outputMetadata});
     else throw Error('Provider artifact requires reconciliation');
    }
   }finally{await workflows.releasePoll({userId,jobId,stepId:queued.step_id,token:lease.token});}
   await terminalProgress(userId,jobId);return summary(userId,jobId);
  }
 });
}
