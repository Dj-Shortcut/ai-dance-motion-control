// Private owner workflow composition. No public identity, URL, rate or funding
// is accepted here. The authenticated production HTTP wrapper owns the lease.
import {isProductionGenerationContext,productionFundingKind,createProductionGenerationContext} from './production-generation-context.mjs';
import {createWorkflowInputStore} from './workflow-inputs.mjs';
import {createProductionWorkflowStores,workflowPlanHash,WORKFLOW_VERSION} from './production-workflow-stores.mjs';
import {createProductionWorkflowClientStores} from './production-workflow-client-stores.mjs';
import {workflowClientMedia,WORKFLOW_CLIENT_CONTRACT} from './workflow-client-contract.mjs';
import {createWorkflowRunner,validateOwnerCleanupWorkflow,WORKFLOW_TRANSFER_POLICY} from './workflow-runner.mjs';
import {createWorkflowFalAdapter,WORKFLOW_RESULT_LIMIT} from './workflow-fal-adapter.mjs';
import {createAssets} from './assets.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {closedVideoTesting} from './closed-video-service.mjs';
import {d1Limit} from './router.mjs';
import {createPreparationBudget,consumePreparationReservation,preparationRequestBytes} from './preparation-budget.mjs';
import {getOverlayCleanupPricePreflight,createOverlayCleanupPlan,OVERLAY_CLEANUP_MODEL,OVERLAY_CLEANUP_QUEUE_FAMILY,OVERLAY_CLEANUP_CONTRACT,OVERLAY_CLEANUP_SETTINGS} from './overlay-cleanup-contract.mjs';
import {getFalPricePreflight,recastPricePerSecond} from './price-preflight.mjs';
import {RECAST_QUALITY,RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_SETTINGS,RECAST_RESOLUTION} from './recast-contract.mjs';
import {loadProfitPolicy,retailPriceCents} from './profit-policy.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {uploadVerifiedAsset} from './upload.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,SHA=/^[a-f0-9]{64}$/;
const INPUT_MAX=16*1024*1024,MASK_MAX=2*1024*1024;
export function workflowError(code,status=409){const e=Error(code);e.code=code;e.status=status;return e;}
const fail=(code,status)=>{throw workflowError(code,status)};
const compact=m=>({sha256:m.sha256,size:m.size,geometryVerified:m.geometryVerified,...workflowClientMedia(m)});
const identical=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hasWorkflow=q=>q?.input&&Object.hasOwn(q.input,'workflow');
export {hasWorkflow};
export async function workflowHeldBytes(body,max,expectedSize){
 if(!body?.getReader||!Number.isSafeInteger(max)||max<1||max>WORKFLOW_RESULT_LIMIT)fail('workflow_body_required',400);
 if(expectedSize!==undefined&&(!Number.isSafeInteger(expectedSize)||expectedSize<32||expectedSize>max))fail('workflow_body_too_large',413);
 // Private R2 has a bounded known size: allocate once, avoiding a second whole
 // 32MiB result allocation while retaining its stream chunks.
 const held=expectedSize===undefined?null:new Uint8Array(expectedSize),reader=body.getReader(),parts=[];let total=0,count=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(workflowError('workflow_read_timeout',408)),15000)});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&value.buffer instanceof SharedArrayBuffer||!value.length||++count>1024||total+value.length>(held?expectedSize:max))fail('workflow_body_too_large',413);if(held)held.set(value,total);else parts.push(value.slice());total+=value.length}if(held){if(total!==expectedSize)fail('workflow_body_size_changed',409);return held;}const bytes=new Uint8Array(total);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}return bytes;}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
export async function workflowSha(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}

export function createWorkflowRuntime(env,{productionContext,trustedUserId,providerFetch=fetch,priceFetch,cleanupPriceFetch,preparationReservation,adapterFactory=createWorkflowFalAdapter,clock=Date.now}={}){
 if(!isProductionGenerationContext(productionContext,{db:env.PRODUCTION_DB}))throw Error('Workflow production capability required');
 const context=productionContext,mapped=context.env,db=mapped.DB,bucket=mapped.BUCKET;
 if(['get','put','head'].some(k=>typeof bucket?.[k]!=='function'))throw Error('Private workflow bucket required');
 const current=()=>createProductionGenerationContext(env),transport=closedVideoTesting.providerTransport(providerFetch),parents=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:context});
 const workflows=createProductionWorkflowStores(db,{productionContext:context,readCurrentProductionContext:current,clock});
 let initialReservation=preparationReservation,activeReservation=null;
 async function admitPreparation(req){
  const bytes=preparationRequestBytes(req);if(bytes===null)fail('workflow_invalid_media',400);
  if(initialReservation){const value=initialReservation;initialReservation=null;return value;}
  const admitted=await createPreparationBudget(db,{productionContext:context,clock}).reserve({userId:trustedUserId,bytes});
  if(admitted.state!=='reserved')fail(admitted.state==='frozen'?'workflow_account_unavailable':'workflow_rate_limited',admitted.state==='frozen'?403:429);
  return admitted.reservation;
 }
 async function withPreparation(reservation,fn){if(activeReservation)fail('workflow_media_busy',429);activeReservation=reservation;try{return await fn()}finally{activeReservation=null;}}
 async function reservePreparation({userId,bytes}){
  if(userId!==trustedUserId)return false;
  if(activeReservation){const value=activeReservation;activeReservation=null;return consumePreparationReservation(value,{db,userId,bytes});}
  const reserved=await createPreparationBudget(db,{productionContext:context,clock}).reserve({userId,bytes});
  return reserved.state==='reserved'&&consumePreparationReservation(reserved.reservation,{db,userId,bytes});
 }
 // Polling and confirmation are separate fixed windows. Sharing a GET/POST
 // counter would make ordinary status polls exhaust the 12-write allowance.
 // These server-derived suffixes never become a subject or ownership key.
 const limit=async(category,method)=>await d1Limit({env:mapped,category,userId:category==='generation'?`${trustedUserId}:workflow:${method}`:trustedUserId,method})===true;
 const inputs=createWorkflowInputStore({productionContext:context,readCurrentProductionContext:current,bucket,reservePreparation,allowRead:async({userId})=>userId===trustedUserId&&await limit('asset','GET'),clock});
 const assets=createAssets({mode:'live',productionContext:context,origin:mapped.RIG_PUBLIC_ORIGIN,media:mapped.RIG_MEDIA,mediaSecret:mapped.RIG_MEDIA_SECRET,falKey:mapped.FAL_KEY,providerFetch:transport,gatewayOrigin:env.RIG_PRODUCTION_BRIDGE_ORIGIN,r2Inputs:null,authenticate:async()=>({id:trustedUserId}),limit:async(user,scope)=>user===trustedUserId&&await limit('asset',scope==='asset-read'?'GET':'POST')});
 async function gate(){
  if(productionFundingKind(context,trustedUserId)!=='owner-provider'||trustedUserId!==env.RIG_PRODUCTION_OWNER_USER_ID||['RIG_OWNER_CLEANUP_VALIDATION_ENABLED','RIG_OWNER_RECAST_VALIDATION_ENABLED'].some(k=>mapped[k]!=='yes'))fail('workflow_owner_validation_unavailable',403);
  const fresh=await current();
  if(!isProductionGenerationContext(fresh,{db,origin:mapped.RIG_PUBLIC_ORIGIN})||productionFundingKind(context,trustedUserId)!=='owner-provider'||productionFundingKind(fresh,trustedUserId)!=='owner-provider'||trustedUserId!==env.RIG_PRODUCTION_OWNER_USER_ID||['RIG_OWNER_CLEANUP_VALIDATION_ENABLED','RIG_OWNER_RECAST_VALIDATION_ENABLED'].some(k=>mapped[k]!=='yes'||fresh.env[k]!=='yes'))fail('workflow_owner_validation_unavailable',403);
  const frozen=await db.prepare('SELECT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) frozen').bind(trustedUserId).first();if(frozen?.frozen!==0)fail('workflow_account_unavailable',403);
  return fresh;
 }
 async function available(){try{await gate();const row=await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('rig_generation_workflows','rig_generation_workflow_steps','rig_generation_workflow_settlements','rig_generation_workflow_client_processing')").first();return row?.n===4;}catch{return false}}
 async function ownedQuote(id){return parents.quotes.getOwned(trustedUserId,id);}
 async function ownedJob(id){return parents.jobs.getOwned(trustedUserId,id);}
 async function jobQuote(job){return job?ownedQuote(job.quoteId):null;}
 async function validatePaidLimits(q){
  const fresh=await gate();await validateOwnerCleanupWorkflow(q);
  const usd=q.input.providerEstimateUsdMicros;
  for(const settings of [mapped,fresh.env])if(!Number.isSafeInteger(Number(settings.RIG_CLOSED_VIDEO_MAX_USD_MICROS))||Number(settings.RIG_CLOSED_VIDEO_MAX_USD_MICROS)<usd||Number(settings.RIG_CLOSED_VIDEO_MAX_USD_MICROS)>6000000||!Number.isSafeInteger(Number(settings.RIG_CLOSED_VIDEO_MAX_CENTS))||Number(settings.RIG_CLOSED_VIDEO_MAX_CENTS)<q.priceCents)fail('provider_limit_exceeded',400);
 }
 async function validateCurrentQuote(q){
  await validatePaidLimits(q);
  if(q.userId!==trustedUserId||q.expiresAt<=clock())fail('workflow_quote_expired',409);
  const price=await (priceFetch??((key,quality)=>getFalPricePreflight(key,transport,{includeRecast:true,quality})))(mapped.FAL_KEY,RECAST_QUALITY),billing=await (cleanupPriceFetch??getOverlayCleanupPricePreflight)(mapped.FAL_KEY,transport);
  if(Math.ceil(recastPricePerSecond(price)*1e6)*Math.ceil(q.durationSeconds)>q.input.workflow.steps[1].providerEstimateUsdMicros||!identical(billing,q.input.cleanup.billing))fail('workflow_quote_expired',409);
 }
 async function quote(raw){
  const fresh=await gate();if(!await limit('generation','POST'))fail('workflow_rate_limited',429);
  const allowed=['imageId','videoId','cleanupMaskId','faceId','angleIds','quality','prompt','keepSound','steadyCamera','transferPolicy'];
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k))||![raw.imageId,raw.videoId,raw.cleanupMaskId].every(x=>UUID.test(x||''))||new Set([raw.imageId,raw.videoId,raw.cleanupMaskId]).size!==3||raw.quality!==RECAST_QUALITY||raw.faceId!==undefined&&raw.faceId!==null||raw.angleIds!==undefined&&(!Array.isArray(raw.angleIds)||raw.angleIds.length)||raw.keepSound!==true||raw.steadyCamera!==undefined&&raw.steadyCamera!==false||raw.transferPolicy!==WORKFLOW_TRANSFER_POLICY||typeof raw.prompt!=='string'||!raw.prompt.trim()||raw.prompt.length>1900)fail('workflow_invalid_selection',400);
  const pair=await inputs.getPair({userId:trustedUserId,sourceId:raw.videoId,maskId:raw.cleanupMaskId}),source=pair.source.inspection,mask=pair.mask.inspection,image=await assets.getOwned(trustedUserId,raw.imageId);
  if(!image||image.verified!==true||image.kind!=='image'||image.id!==raw.imageId||!SHA.test(image.sha256||''))fail('workflow_invalid_selection',400);
  const duration=source.frameCount/source.fpsNumerator;
  if(duration<5||duration>15||source.width>1280||source.height>1280)fail('workflow_invalid_duration',400);
  const pricing=await (priceFetch??((key,quality)=>getFalPricePreflight(key,transport,{includeRecast:true,quality})))(mapped.FAL_KEY,RECAST_QUALITY);
  const baseUsd=Math.ceil(recastPricePerSecond(pricing)*1e6)*Math.ceil(duration),max=Math.min(Number(mapped.RIG_CLOSED_VIDEO_MAX_USD_MICROS),Number(fresh.env.RIG_CLOSED_VIDEO_MAX_USD_MICROS));
  if(!Number.isSafeInteger(max)||max<=0||max>6000000)fail('workflow_budget_unavailable',503);
  const billing=await (cleanupPriceFetch??getOverlayCleanupPricePreflight)(mapped.FAL_KEY,transport);
  let cleanup;try{cleanup=createOverlayCleanupPlan({source,mask,maskSourceSha256:pair.mask.record.source.sha256,billing,baseProviderEstimateUsdMicros:baseUsd,maxProviderUsdMicros:max});}catch{fail('provider_limit_exceeded',400)}
  const usd=cleanup.combinedProviderEstimateUsdMicros,rate=Number(mapped.RIG_PRICE_RECAST);
  if(!Number.isSafeInteger(rate)||rate<1||rate>250)fail('workflow_budget_unavailable',503);
  const cents=retailPriceCents(await loadProfitPolicy(db),{quality:RECAST_QUALITY,billedSeconds:Math.ceil(duration),rateCents:rate,providerEstimateUsdMicros:usd,fundingKind:'owner-provider',maxPriceCents:Number(mapped.RIG_CLOSED_VIDEO_MAX_CENTS)});
  if(!Number.isSafeInteger(cents)||cents<=0)fail('workflow_budget_unavailable',503);
  const plan={version:WORKFLOW_VERSION,planHash:'',baseStepId:'base',baseRetailCents:cents,cleanupRetailCents:0,steps:[{id:'source-cleanup',kind:'preclean',model:OVERLAY_CLEANUP_MODEL,queueFamily:OVERLAY_CLEANUP_QUEUE_FAMILY,contract:OVERLAY_CLEANUP_CONTRACT,settings:{...OVERLAY_CLEANUP_SETTINGS},dependsOn:null,providerEstimateUsdMicros:cleanup.providerEstimateUsdMicros,retailCents:0},{id:'base',kind:'base',model:RECAST_MODEL,queueFamily:RECAST_QUEUE_FAMILY,contract:RECAST_PROVIDER_CONTRACT,settings:{...RECAST_SETTINGS},dependsOn:'source-cleanup',providerEstimateUsdMicros:baseUsd,retailCents:cents}],clientProcessing:{id:'compose',contract:WORKFLOW_CLIENT_CONTRACT,beforeStepId:'base',cleanFromStepId:'source-cleanup',source:{id:raw.videoId,sha256:source.sha256},mask:{id:raw.cleanupMaskId,sha256:mask.sha256},media:workflowClientMedia(source)}};
  plan.planHash=await workflowPlanHash(plan);
  const data={imageId:raw.imageId,videoId:raw.videoId,faceId:null,angleIds:[],quality:RECAST_QUALITY,prompt:raw.prompt,keepSound:true,steadyCamera:false,transferPolicy:WORKFLOW_TRANSFER_POLICY};
  const input={data,refs:[{id:raw.imageId,kind:'image',sha256:image.sha256},{id:raw.videoId,kind:'video',sha256:source.sha256},{id:raw.cleanupMaskId,kind:'video',sha256:mask.sha256}],prompt:raw.prompt,providerContract:RECAST_PROVIDER_CONTRACT,providerSettings:{...RECAST_SETTINGS},cleanup,workflow:plan,providerEstimateUsdMicros:usd};
  const candidate={userId:trustedUserId,model:RECAST_MODEL,input,priceCents:cents,pricingVersion:mapped.RIG_PRICE_VERSION,durationSeconds:duration,fundingKind:'owner-provider'};await validateOwnerCleanupWorkflow(candidate);
  const made=await parents.quotes.create(candidate);return {id:made.id,quality:RECAST_QUALITY,durationSeconds:duration,billedSeconds:Math.ceil(duration),outputResolution:RECAST_RESOLUTION,funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:usd,expiresAt:made.expiresAt,transferPolicy:WORKFLOW_TRANSFER_POLICY,transferConsentRequired:true,workflowVersion:WORKFLOW_VERSION};
 }
 const acceptedKey=(jobId,role)=>`rig-workflow-accepted/${jobId}/${role}.mp4`;
 async function acceptedBinding(jobId){const job=await ownedJob(jobId),q=await jobQuote(job);if(!job||!hasWorkflow(q))fail('workflow_not_found',404);await validateOwnerCleanupWorkflow(q);return {job,quote:q,plan:q.input.workflow};}
 async function writeOnce(key,bytes,metadata,contentType='video/mp4'){
  let saved=await bucket.head(key);if(!saved){await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType,cacheControl:'private, no-store'},customMetadata:metadata});saved=await bucket.head(key)}
  if(!saved||saved.size!==bytes.length||!saved.customMetadata||Object.keys(saved.customMetadata).length!==Object.keys(metadata).length||Object.keys(metadata).some(k=>saved.customMetadata[k]!==metadata[k])||saved.httpMetadata?.contentType!==contentType||saved.httpMetadata?.cacheControl!=='private, no-store')fail('workflow_private_storage_uncertain',503);
 }
 async function acceptInputs(jobId){
  const b=await acceptedBinding(jobId);if(!['submitting','queued','unknown'].includes(b.job.state))return;
  const cp=b.plan.clientProcessing;
  for(const role of ['source','mask']){const ref=cp[role],held=await inputs.get({userId:trustedUserId,id:ref.id,expectedSha256:ref.sha256});if(held.record.kind!==role||role==='mask'&&(held.record.source?.id!==cp.source.id||held.record.source.sha256!==cp.source.sha256))fail('workflow_input_changed',409);await writeOnce(acceptedKey(jobId,role),held.bytes,{version:'rig-workflow-accepted-v1',userId:trustedUserId,jobId,planHash:b.plan.planHash,role,id:ref.id,sha256:ref.sha256,media:JSON.stringify(compact(held.inspection))});}
  // Portraits have the same temporary-source expiry as video uploads. Copy the
  // exact already-quoted private JPEG now; a later paid base step never relies
  // on an expired asset or on a replacement selected after confirmation.
  const ref=(await validateOwnerCleanupWorkflow(b.quote)).image;
  if(!await limit('asset','GET'))fail('workflow_rate_limited',429);
  const response=await mapped.RIG_MEDIA.fetch(new Request(`https://rig-media.internal/v1/assets/${ref.id}`,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${mapped.RIG_MEDIA_SECRET}`,'X-Rig-User':trustedUserId}})),h=response.headers,size=Number(h.get('content-length')),width=Number(h.get('x-rig-width')),height=Number(h.get('x-rig-height'));
  if(!response.ok||response.redirected||h.get('content-type')!=='image/jpeg'||h.get('x-rig-asset-kind')!=='image'||h.get('x-rig-sha256')!==ref.sha256||!Number.isSafeInteger(size)||size<32||size>INPUT_MAX||![width,height].every(n=>Number.isSafeInteger(n)&&n>=340&&n<=3850)||width/height<.4||width/height>2.5)fail('workflow_input_changed',409);
  const bytes=await workflowHeldBytes(response.body,INPUT_MAX,size);if(await workflowSha(bytes)!==ref.sha256)fail('workflow_input_changed',409);
  await writeOnce(`rig-workflow-accepted/${jobId}/image.jpg`,bytes,{version:'rig-workflow-accepted-image-v1',userId:trustedUserId,jobId,planHash:b.plan.planHash,id:ref.id,sha256:ref.sha256,width:String(width),height:String(height)},'image/jpeg');
 }
 async function readAccepted(jobId,role){
  const b=await acceptedBinding(jobId),ref=b.plan.clientProcessing[role];if(!['source','mask'].includes(role)||!ref)fail('workflow_not_found',404);
  const object=await bucket.get(acceptedKey(jobId,role)),m=object?.customMetadata;
  if(!m||m.version!=='rig-workflow-accepted-v1'||m.userId!==trustedUserId||m.jobId!==jobId||m.planHash!==b.plan.planHash||m.role!==role||m.id!==ref.id||m.sha256!==ref.sha256||typeof m.media!=='string'||m.media.length>8192||object.httpMetadata?.contentType!=='video/mp4'||object.httpMetadata?.cacheControl!=='private, no-store')fail('workflow_private_input_unavailable',503);
  const bytes=await workflowHeldBytes(object.body,role==='mask'?MASK_MAX:INPUT_MAX,object.size),inspection=await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':'input'});
  if(bytes.length!==object.size||inspection.sha256!==ref.sha256||!identical(compact(inspection),JSON.parse(m.media)))fail('workflow_input_changed',409);
  return {record:{userId:trustedUserId,id:ref.id,kind:role,source:role==='mask'?b.plan.clientProcessing.source:null},bytes,inspection};
 }
 async function readResult({jobId,stepId,key,sha256}){
  const b=await workflows.get({userId:trustedUserId,jobId}),step=b.steps.find(s=>s.step_id===stepId),spec=b.plan.steps.find(s=>s.id===stepId);
  if(!step||step.state!=='completed'||step.result_key!==key||step.output_sha256!==sha256||key!==`rig-workflow-results/${jobId}/${stepId}.mp4`)fail('workflow_result_unavailable',404);
  const object=await bucket.get(key),m=object?.customMetadata;
  if(!m||m.version!=='rig-workflow-result-v1'||m.userId!==trustedUserId||m.jobId!==jobId||m.stepId!==stepId||m.planHash!==b.plan.planHash||m.providerRequestId!==step.fal_request_id||m.contract!==spec.contract||m.sha256!==sha256||m.inspection!=='workflow-mp4-sps-v1'||m.outcome!=='accepted'||typeof m.media!=='string'||m.media.length>8192||object.httpMetadata?.contentType!=='video/mp4'||object.httpMetadata?.cacheControl!=='private, no-store')fail('workflow_result_unavailable',404);
  const bytes=await workflowHeldBytes(object.body,WORKFLOW_RESULT_LIMIT,object.size),inspection=await inspectWorkflowMp4(bytes,{role:'result'}),media=JSON.parse(m.media);
  if(object.size!==bytes.length||inspection.sha256!==sha256||media.sha256!==sha256||media.size!==bytes.length||!identical(workflowClientMedia(inspection),workflowClientMedia(media)))fail('workflow_result_unavailable',409);
  return {bytes,inspection};
 }
 async function uploadAcceptedImage(jobId,userId,id,sha256,transfer){
  const b=await acceptedBinding(jobId),ref=(await validateOwnerCleanupWorkflow(b.quote)).image;
  if(userId!==trustedUserId||id!==ref.id||sha256!==ref.sha256||transfer?.jobId!==jobId||transfer?.model!==RECAST_MODEL||transfer?.transferPolicy!==WORKFLOW_TRANSFER_POLICY)fail('workflow_input_changed',409);
  const object=await bucket.get(`rig-workflow-accepted/${jobId}/image.jpg`),m=object?.customMetadata,width=Number(m?.width),height=Number(m?.height);
  if(!m||m.version!=='rig-workflow-accepted-image-v1'||m.userId!==userId||m.jobId!==jobId||m.planHash!==b.plan.planHash||m.id!==id||m.sha256!==sha256||![width,height].every(n=>Number.isSafeInteger(n)&&n>=340&&n<=3850)||width/height<.4||width/height>2.5||object.httpMetadata?.contentType!=='image/jpeg'||object.httpMetadata?.cacheControl!=='private, no-store')fail('workflow_input_changed',409);
  const bytes=await workflowHeldBytes(object.body,INPUT_MAX,object.size);if(await workflowSha(bytes)!==sha256)fail('workflow_input_changed',409);
  const url=await uploadVerifiedAsset({asset:{verified:true,mime:'image/jpeg',size:bytes.length,body:new Blob([bytes],{type:'image/jpeg'})},key:mapped.FAL_KEY,fetchImpl:transport,transferPolicy:WORKFLOW_TRANSFER_POLICY});
  return {verified:true,kind:'image',id,sha256,size:bytes.length,width,height,url};
 }
 const clients=createProductionWorkflowClientStores(db,{productionContext:context,readCurrentProductionContext:current,workflows,clock,
  async readOwnedArtifact({userId,jobId,stageId,role,reference}){
   if(userId!==trustedUserId)fail('workflow_not_found',404);
   const b=await acceptedBinding(jobId);if(stageId!==b.plan.clientProcessing.id)fail('workflow_not_found',404);
   if(role==='source'||role==='mask'){const ref=b.plan.clientProcessing[role];if(reference.kind!=='input'||reference.id!==ref.id||reference.sha256!==ref.sha256)fail('workflow_input_changed',409);return (await readAccepted(jobId,role)).bytes;}
   if(role==='clean'){if(reference.kind!=='workflow-result'||reference.stepId!=='source-cleanup')fail('workflow_not_found',404);return (await readResult({jobId,stepId:reference.stepId,key:reference.key,sha256:reference.sha256})).bytes;}
   if(role!=='output'||reference.kind!=='workflow-composed'||reference.key!==`rig-workflow-composed/${jobId}/${stageId}/${reference.sha256}.mp4`||!SHA.test(reference.sha256||''))fail('workflow_not_found',404);
   const object=await bucket.get(reference.key),m=object?.customMetadata;if(!m||m.version!=='rig-workflow-composed-v1'||m.userId!==trustedUserId||m.jobId!==jobId||m.stageId!==stageId||m.planHash!==b.plan.planHash||m.sha256!==reference.sha256||object.httpMetadata?.contentType!=='video/mp4'||object.httpMetadata?.cacheControl!=='private, no-store')fail('workflow_output_unavailable',404);
   const bytes=await workflowHeldBytes(object.body,INPUT_MAX,object.size);if(bytes.length!==object.size||await workflowSha(bytes)!==reference.sha256)fail('workflow_output_changed',409);return bytes;
  },
  async putOwnedOutput({userId,jobId,stageId,key,bytes,sha256}){const b=await acceptedBinding(jobId);if(userId!==trustedUserId||stageId!==b.plan.clientProcessing.id||!SHA.test(sha256)||key!==`rig-workflow-composed/${jobId}/${stageId}/${sha256}.mp4`)fail('workflow_not_found',404);await writeOnce(key,bytes,{version:'rig-workflow-composed-v1',userId,jobId,stageId,planHash:b.plan.planHash,sha256});}
 });
 const runners=new Map();function runner(jobId){
  if(!UUID.test(jobId||''))fail('workflow_not_found',404);
  if(!runners.has(jobId)){const boundInputs={async getPair({userId,sourceId,maskId}){const b=await acceptedBinding(jobId);if(userId!==trustedUserId||sourceId!==b.plan.clientProcessing.source.id||maskId!==b.plan.clientProcessing.mask.id)fail('workflow_not_found',404);return {source:await readAccepted(jobId,'source'),mask:await readAccepted(jobId,'mask')};}};
   const boundAssets={uploadOwned:(user,id,sha,transfer)=>uploadAcceptedImage(jobId,user,id,sha,transfer)};
   const adapters=adapterFactory({falKey:mapped.FAL_KEY,fetchImpl:transport,inputs:boundInputs,assets:boundAssets,privateBucket:bucket});runners.set(jobId,createWorkflowRunner({db,productionContext:context,readCurrentProductionContext:current,parents,workflows,clients,adapters}));}
  return runners.get(jobId);
 }
 async function result(jobId){const b=await workflows.get({userId:trustedUserId,jobId});if(b.row.state!=='completed'||b.settlement?.outcome!=='completed'||b.settlement.result_key!==b.row.result_key)fail('workflow_result_unavailable',404);const base=b.steps.find(s=>s.step_id===b.plan.baseStepId);return readResult({jobId,stepId:base.step_id,key:b.settlement.result_key,sha256:base.output_sha256});}
 return Object.freeze({db,context,origin:mapped.RIG_PUBLIC_ORIGIN,trustedUserId,inputs,assets,parents,workflows,clients,gate,available,limit,admitPreparation,withPreparation,reservePreparation,quote,validateCurrentQuote,validatePaidLimits,ownedQuote,ownedJob,jobQuote,acceptInputs,runner,result});
}
