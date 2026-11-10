// Inactive, server-only Fal transport for the fixed owner cleanup workflow.
// Secrets, owned stores and transport are injected; no environment lookup,
// arbitrary URL input, route registration, SDK retry or provider fallback.
import {validateOwnerCleanupWorkflow,WORKFLOW_TRANSFER_POLICY} from './workflow-runner.mjs';
import {workflowHash} from './production-workflow-stores.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {workflowClientMedia,validateWorkflowClientInspection} from './workflow-client-contract.mjs';
import {getOverlayCleanupPricePreflight,createOverlayCleanupPlan,overlayCleanupPayload,OVERLAY_CLEANUP_MODEL,OVERLAY_CLEANUP_QUEUE_FAMILY,OVERLAY_CLEANUP_CONTRACT} from './overlay-cleanup-contract.mjs';
import {RECAST_MODEL,RECAST_QUEUE_FAMILY,RECAST_PROVIDER_CONTRACT,RECAST_SETTINGS,RECAST_QUALITY} from './recast-contract.mjs';
import {getFalPricePreflight,recastPricePerSecond} from './price-preflight.mjs';
import {uploadVerifiedAsset,privateResultFetch,TEMPORARY_LINK_POLICY,TEMPORARY_LINK_LIFECYCLE} from './upload.mjs';
import {providerJSON,providerInputValidation} from './provider-response.mjs';
export const WORKFLOW_RESULT_LIMIT=32*1024*1024;
const UNKNOWN_RESULT_LIMIT=16*1024*1024,QUEUE='https://queue.fal.run',VERSION='rig-workflow-result-v1';
const ID=/^[A-Za-z0-9_-]{1,100}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,SHA=/^[a-f0-9]{64}$/;
const MODELS=Object.freeze({'source-cleanup':{model:OVERLAY_CLEANUP_MODEL,queueFamily:OVERLAY_CLEANUP_QUEUE_FAMILY,contract:OVERLAY_CLEANUP_CONTRACT},base:{model:RECAST_MODEL,queueFamily:RECAST_QUEUE_FAMILY,contract:RECAST_PROVIDER_CONTRACT}});
const plain=x=>x!==null&&Object.getPrototypeOf(x)===Object.prototype;
function identity({userId,jobId,stepId,model,queueFamily,contract}){
 const fixed=MODELS[stepId];if(!ID.test(userId||'')||!UUID.test(jobId||'')||!fixed||fixed.model!==model||fixed.queueFamily!==queueFamily||fixed.contract!==contract)throw Error('Unsupported workflow provider identity');return fixed;
}
const keyFor=({jobId,stepId})=>`rig-workflow-results/${jobId}/${stepId}.mp4`;
const hashBytes=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
function falUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='v3b.fal.media'&&!u.port&&!u.username&&!u.password&&!u.hash&&!u.search&&/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(u.pathname)}catch{return false}}
async function bounded(promise,signal){
 if(signal.aborted)throw Error('Workflow provider deadline');
 let listener;const deadline=new Promise((_,reject)=>{listener=()=>reject(Error('Workflow provider deadline'));signal.addEventListener('abort',listener,{once:true})});
 try{return await Promise.race([promise,deadline])}finally{signal.removeEventListener('abort',listener)}
}
async function readResult(response,signal){
 const mime=(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase(),raw=response.headers.get('content-length');
 if(!response.ok||response.redirected||!response.body||!['video/mp4','application/octet-stream','binary/octet-stream'].includes(mime)||raw!==null&&(!/^\d+$/.test(raw)||Number(raw)<32||Number(raw)>WORKFLOW_RESULT_LIMIT)){void response.body?.cancel().catch(()=>{});throw Error('Workflow result size or type requires review');}
 const length=raw===null?null:Number(raw),max=length??UNKNOWN_RESULT_LIMIT,reader=response.body.getReader();let bytes=length===null?null:new Uint8Array(length),parts=[],total=0;
 try{
  for(;;){const {done,value}=await bounded(reader.read(),signal);if(done)break;if(!(value instanceof Uint8Array)||total+value.length>max||parts.length>=1024)throw Error('Workflow result exceeds bounded read');if(bytes)bytes.set(value,total);else parts.push(value);total+=value.length;}
  if(total<32||length!==null&&total!==length)throw Error('Incomplete workflow result');
  if(!bytes){bytes=new Uint8Array(total);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}parts=[];}return bytes;
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function compact(media){return {mime:media.mime,codec:media.codec,inspectionLevel:media.inspectionLevel,geometryVerified:media.geometryVerified,sha256:media.sha256,size:media.size,durationSeconds:media.durationSeconds,...workflowClientMedia(media)};}

export function createWorkflowFalAdapter({falKey,fetchImpl,inputs,assets,privateBucket}={}){
 if(typeof falKey!=='string'||!falKey||falKey.length>1024||/[\r\n]/.test(falKey)||typeof fetchImpl!=='function'||typeof inputs?.getPair!=='function'||typeof assets?.uploadOwned!=='function'||['get','head','put'].some(k=>typeof privateBucket?.[k]!=='function'))throw Error('Workflow Fal dependencies unavailable');
 const prepared=new Map(),used=new Set(),providerResults=new WeakMap();
 const net=async(url,init)=>{if(init?.redirect!=='manual')throw Error('Redirect policy required');const r=await fetchImpl(url,init);if(r.redirected)throw Error('Provider redirect forbidden');return r;};
 const readProvider=privateResultFetch(falKey,net);
 const authorization={Authorization:`Key ${falKey}`,Accept:'application/json'};
 async function upload(bytes){return uploadVerifiedAsset({asset:{verified:true,mime:'video/mp4',size:bytes.length,body:new Blob([bytes],{type:'video/mp4'})},key:falKey,fetchImpl:net,transferPolicy:TEMPORARY_LINK_POLICY});}
 function stored(object,args,planHash){
  if(!object)return null;const m=object.customMetadata;
  if(!m||m.version!==VERSION||m.jobId!==args.jobId||m.userId!==args.userId||m.stepId!==args.stepId||m.providerRequestId!==args.requestId||m.contract!==args.contract||!SHA.test(m.sha256||'')||!SHA.test(m.planHash||'')||planHash&&m.planHash!==planHash||!['accepted','rejected'].includes(m.outcome)||!Number.isSafeInteger(object.size)||object.size<32||object.size>WORKFLOW_RESULT_LIMIT||object.httpMetadata?.cacheControl!=='private, no-store'||typeof m.media!=='string'||m.media.length>8192)throw Error('Private workflow result conflict');
  const media=JSON.parse(m.media);
  if(media.sha256!==m.sha256||media.size!==object.size||m.outcome==='accepted'&&(m.inspection!=='workflow-mp4-sps-v1'||media.inspectionLevel!=='container-only'||media.geometryVerified!=='avc-sps'||object.httpMetadata?.contentType!=='video/mp4'))throw Error('Unverified private workflow result');
  return m.outcome==='rejected'?{kind:'rejected',reason:'output_invalid'}:{kind:'stored',resultKey:keyFor(args),outputHash:m.sha256,outputMetadata:media};
 }
 return Object.freeze({
  async prepareStep({userId,jobId,quote,plan,step,inputBinding}){
   identity({userId,jobId,stepId:step?.id,...step});
   const validated=await validateOwnerCleanupWorkflow(quote);
   if(quote.userId!==userId||plan?.planHash!==validated.plan.planHash||await workflowHash(step)!==await workflowHash(validated.plan.steps.find(s=>s.id===step.id)))throw Error('Workflow quote binding changed');
   let payload,inputHash;
   if(step.id==='source-cleanup'){
    const cp=validated.plan.clientProcessing,binding={kind:'source-and-mask',source:cp.source,mask:cp.mask};inputHash=await workflowHash(binding);
    if(inputBinding?.kind!==binding.kind||inputBinding.inputHash!==inputHash||await workflowHash(inputBinding.source)!==await workflowHash(cp.source)||await workflowHash(inputBinding.mask)!==await workflowHash(cp.mask))throw Error('Owned cleanup input changed');
    const pair=await inputs.getPair({userId,sourceId:cp.source.id,maskId:cp.mask.id});
    for(const [role,ref]of [['source',cp.source],['mask',cp.mask]])if(pair?.[role]?.record?.userId!==userId||pair[role].record.id!==ref.id||pair[role].record.kind!==role||!(pair[role].bytes instanceof Uint8Array))throw Error('Owned cleanup pair unavailable');
    const source=await inspectWorkflowMp4(pair.source.bytes),mask=await inspectWorkflowMp4(pair.mask.bytes,{role:'mask'});
    if(source.sha256!==cp.source.sha256||mask.sha256!==cp.mask.sha256||pair.mask.record.source?.id!==cp.source.id||pair.mask.record.source?.sha256!==source.sha256)throw Error('Owned cleanup bytes changed');
    const billing=await getOverlayCleanupPricePreflight(falKey,net),fresh=createOverlayCleanupPlan({source,mask,maskSourceSha256:source.sha256,billing,baseProviderEstimateUsdMicros:validated.plan.steps[1].providerEstimateUsdMicros,maxProviderUsdMicros:validated.usd});
    if(fresh.providerEstimateUsdMicros>step.providerEstimateUsdMicros||await workflowHash(fresh)!==await workflowHash(quote.input.cleanup))throw Error('Cleanup price or contract changed');
    const sourceUrl=await upload(pair.source.bytes),maskUrl=await upload(pair.mask.bytes);
    payload=overlayCleanupPayload(quote.input.cleanup,{source:{verified:true,kind:'video',sha256:source.sha256,url:sourceUrl},mask:{verified:true,kind:'video',sha256:mask.sha256,url:maskUrl}});
   }else{
    if(inputBinding?.kind!=='client-composed'||!(inputBinding.bytes instanceof Uint8Array)||!SHA.test(inputBinding.inputHash||''))throw Error('Held composed input required');
    const actual=await inspectWorkflowMp4(inputBinding.bytes);inputHash=actual.sha256;
    validateWorkflowClientInspection(actual,validated.plan.clientProcessing.media,{role:'output',sha256:inputBinding.inputHash});
    if(inputBinding.inspection?.sha256!==actual.sha256||inputBinding.artifact?.sha256!==actual.sha256||await workflowHash(inputBinding.image)!==await workflowHash(validated.image))throw Error('Composed input or photo changed');
    const price=await getFalPricePreflight(falKey,net,{includeRecast:true,quality:RECAST_QUALITY}),micros=Math.ceil(recastPricePerSecond(price)*1000000)*Math.ceil(quote.durationSeconds);
    if(micros>step.providerEstimateUsdMicros)throw Error('Recast price exceeds confirmation');
    const image=await assets.uploadOwned(userId,validated.image.id,validated.image.sha256,{jobId,model:RECAST_MODEL,transferPolicy:WORKFLOW_TRANSFER_POLICY});
    if(image?.verified!==true||image.kind!=='image'||image.id!==validated.image.id||image.sha256!==validated.image.sha256||!Number.isSafeInteger(image.size)||image.size<1||!falUrl(image.url))throw Error('Verified quoted photo unavailable');
    const videoUrl=await upload(inputBinding.bytes);payload={video_url:videoUrl,reference_image_urls:[image.url],prompt:quote.input.prompt,...RECAST_SETTINGS};
   }
   const fingerprint=await workflowHash({model:step.model,queueFamily:step.queueFamily,contract:step.contract,settings:step.settings,inputHash,payload});
   prepared.set(fingerprint,{userId,jobId,stepId:step.id,settings:structuredClone(step.settings)});return {inputHash,payload};
  },
  async submitStep(args){
   const fixed=identity(args),{userId,jobId,stepId,payload,inputHash,requestHash,dispatchToken}=args,binding=prepared.get(requestHash),once=jobId+':'+stepId;
   if(!binding||binding.userId!==userId||binding.jobId!==jobId||binding.stepId!==stepId||!UUID.test(dispatchToken||'')||used.has(once)||!SHA.test(inputHash||''))throw Error('Unprepared or repeated workflow submission');
   const heldPayload=structuredClone(payload);
   if(await workflowHash({model:fixed.model,queueFamily:fixed.queueFamily,contract:fixed.contract,settings:binding.settings,inputHash,payload:heldPayload})!==requestHash)throw Error('Workflow submission changed');
   used.add(once);prepared.delete(requestHash);
   const signal=AbortSignal.timeout(30000),response=await net(`${QUEUE}/${fixed.model}`,{method:'POST',redirect:'manual',signal,headers:{...authorization,'Content-Type':'application/json','X-Fal-No-Retry':'1','X-Fal-Request-Start-Timeout':'300','x-app-fal-disable-fallback':'true','X-Fal-Store-IO':'0','X-Fal-Object-Lifecycle-Preference':TEMPORARY_LINK_LIFECYCLE},body:JSON.stringify(heldPayload)});
   if(!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error('Workflow submission unknown');
   const body=await providerJSON(response,{signal,limit:65536});if(!ID.test(body?.request_id||''))throw Error('Workflow submission unknown');return {requestId:body.request_id};
  },
  async pollStep(args){
   const fixed=identity(args);if(!ID.test(args.requestId||''))throw Error('Known workflow request required');
   const signal=AbortSignal.timeout(60000),saved=await bounded(privateBucket.head(keyFor(args)),signal);
   if(saved){stored(saved,args);return {state:'completed',requestId:args.requestId,result:{stored:true}};}
   const url=`${QUEUE}/${fixed.queueFamily}/requests/${encodeURIComponent(args.requestId)}`;
   const status=await net(url+'/status',{method:'GET',redirect:'manual',signal,headers:authorization});
   if(!/^application\/json(?:\s*;|$)/i.test(status.headers.get('content-type')||''))throw Error('Workflow status unavailable');
   const s=await providerJSON(status,{signal,limit:65536});if(s?.request_id!==args.requestId||!['IN_QUEUE','IN_PROGRESS','COMPLETED'].includes(s.status))throw Error('Workflow status identity changed');
   if(s.status!=='COMPLETED')return {state:'pending',requestId:args.requestId};
   if(s.error||s.error_type)return typeof s.error==='string'&&s.error.trim()?{state:'failed',requestId:args.requestId}:{state:'pending',requestId:args.requestId,needsReview:true};
   const response=await net(url,{method:'GET',redirect:'manual',signal,headers:authorization});
   if(!response.ok){const reason=await providerInputValidation(response,{signal,requestId:args.requestId});return reason?{state:'failed',requestId:args.requestId}:{state:'pending',requestId:args.requestId,needsReview:true};}
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error('Workflow result metadata unavailable');
   const body=await providerJSON(response,{signal,limit:65536});if(body?.request_id!==undefined&&body.request_id!==args.requestId||!falUrl(body?.video?.url))return {state:'pending',requestId:args.requestId,needsReview:true};
   const result={video:{url:body.video.url}};providerResults.set(result,{userId:args.userId,jobId:args.jobId,stepId:args.stepId,requestId:args.requestId,url:body.video.url});
   return {state:'completed',requestId:args.requestId,result};
  },
  async persistStepResult({userId,jobId,quote,plan,step,requestId,providerResult,resultKey}){
   const args={userId,jobId,stepId:step?.id,...step,requestId};identity(args);if(!ID.test(requestId||'')||resultKey!==keyFor(args))throw Error('Invalid workflow result identity');
   const validated=await validateOwnerCleanupWorkflow(quote);if(quote.userId!==userId||plan?.planHash!==validated.plan.planHash||await workflowHash(step)!==await workflowHash(validated.plan.steps.find(s=>s.id===step.id)))throw Error('Workflow result quote changed');
   const signal=AbortSignal.timeout(60000),prior=await bounded(privateBucket.head(resultKey),signal);if(prior)return stored(prior,args,validated.plan.planHash);
   const provenance=plain(providerResult)?providerResults.get(providerResult):null;
   if(!provenance||provenance.userId!==userId||provenance.jobId!==jobId||provenance.stepId!==step.id||provenance.requestId!==requestId||provenance.url!==providerResult?.video?.url||!falUrl(provenance.url))throw Error('Verified provider result unavailable');
   const response=await readProvider(providerResult.video.url,{signal,transferPolicy:TEMPORARY_LINK_POLICY}),bytes=await readResult(response,signal);let media,outcome='accepted';
   try{
    const actual=await inspectWorkflowMp4(bytes,{role:'result'});media=compact(actual);
    if(step.id==='source-cleanup')validateWorkflowClientInspection(actual,validated.plan.clientProcessing.media,{role:'clean'});
    else{const source=validated.plan.clientProcessing.media,ratio=source.width/source.height,actualRatio=actual.width/actual.height;if(Math.min(actual.width,actual.height)!==1080||actual.durationSeconds<5||actual.durationSeconds>15||Math.abs(actual.durationSeconds-quote.durationSeconds)>0.125||Math.ceil(actual.durationSeconds)>Math.ceil(quote.durationSeconds)||Math.abs(actualRatio-ratio)/ratio>0.01||actual.hasAudio!==source.hasAudio)throw Error('Recast output does not match confirmed framing/timing');}
   }catch{outcome='rejected';media??={inspectionLevel:'unverified',sha256:await hashBytes(bytes),size:bytes.length};}
   const encoded=JSON.stringify(media);if(encoded.length>8192)throw Error('Workflow output metadata too large');
   const metadata={version:VERSION,jobId,userId,stepId:step.id,providerRequestId:requestId,planHash:validated.plan.planHash,contract:step.contract,sha256:media.sha256,inspection:media.geometryVerified==='avc-sps'?'workflow-mp4-sps-v1':'workflow-mp4-unverified-v1',outcome,media:encoded};
   await bounded(privateBucket.put(resultKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:media.geometryVerified==='avc-sps'?'video/mp4':'application/octet-stream',cacheControl:'private, no-store'},customMetadata:metadata}),signal);
   const saved=await bounded(privateBucket.head(resultKey),signal);if(saved?.customMetadata?.sha256!==media.sha256||saved.customMetadata.outcome!==outcome)throw Error('Private workflow write uncertain');return stored(saved,args,validated.plan.planHash)??Promise.reject(Error('Private workflow write uncertain'));
  }
 });
}
