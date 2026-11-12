// Signed production ingress calls this wrapper before the legacy single-model
// router. Every workflow marker is handled or rejected here, never downgraded.
import {hasWorkflow,workflowError,workflowHeldBytes,workflowSha} from './workflow-runtime.mjs';
import {validateOwnerCleanupWorkflow,WORKFLOW_TRANSFER_POLICY} from './workflow-runner.mjs';
import {WORKFLOW_VERSION} from './production-workflow-stores.mjs';
const ID=/^[A-Za-z0-9_-]{1,100}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,SHA=/^[a-f0-9]{64}$/;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(body,status=200)=>Response.json(body,{status,headers});
const error=(code,status=409)=>{throw workflowError(code,status)};
const exact=(x,required,optional=[])=>x&&typeof x==='object'&&!Array.isArray(x)&&required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
async function readJSON(req){if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))error('workflow_invalid_request',400);const b=await workflowHeldBytes(req.clone().body,16384);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b))}catch{error('workflow_invalid_request',400)}}
function mediaHeaders(req,max){if(req.headers.get('content-type')!=='video/mp4'||req.headers.has('content-encoding')||req.headers.has('range'))error('workflow_invalid_media',400);const length=req.headers.get('content-length');if(length!==null&&(!/^[1-9][0-9]{0,7}$/.test(length)||Number(length)>max))error('workflow_body_too_large',413);return length;}
async function binary(req,max){const length=mediaHeaders(req,max),bytes=await workflowHeldBytes(req.body,max);if(bytes.length<32||length!==null&&bytes.length!==Number(length))error('workflow_invalid_media',400);return bytes;}
function publicError(e){const status=[400,403,404,405,408,409,413,429].includes(e?.status)?e.status:503,code=typeof e?.code==='string'?e.code:'workflow_unavailable';const messages={provider_limit_exceeded:'Dit fragment met tekstverwijdering valt buiten de ingestelde Fal-limiet. Kies een korter fragment.',workflow_owner_validation_unavailable:'Tekst verwijderen is voor dit account nog niet beschikbaar.',workflow_invalid_selection:'Controleer je foto, videofragment en tekstmasker.',workflow_invalid_duration:'Kies een echt fragment van minstens 5 en maximaal 15 seconden.',workflow_quote_expired:'Vraag de prijs opnieuw op en bevestig die opnieuw.',workflow_transfer_consent_required:'Bevestig de prijs en de tijdelijke Fal-bestandslinks opnieuw.',workflow_rate_limited:'Te veel aanvragen. Probeer later opnieuw.',workflow_media_busy:'Een mediabewerking is nog bezig. Probeer straks opnieuw.',workflow_not_found:'Opdracht of bestand niet gevonden.'};return json({error:messages[code]||(status===400||status===413?'Controleer je aanvraag of bestand.':status===404?'Opdracht of bestand niet gevonden.':'Deze verwerking kon niet veilig worden afgerond. Controleer de status voordat je opnieuw start.'),code},status);}

// Retain the shared memory/CPU admission while a private MP4 is still held by
// the outgoing body. Copy small chunks so a final subarray cannot retain the
// entire backing file after EOF. A client cannot keep the admission forever.
export function workflowLeaseResponse(response,release,{idleMs=10000,totalMs=60000}={}){
 if(!(response instanceof Response)||!response.body||typeof release!=='function'||!Number.isSafeInteger(idleMs)||idleMs<1||idleMs>10000||!Number.isSafeInteger(totalMs)||totalMs<idleMs||totalMs>60000)throw Error('Bounded binary response required');
 const reader=response.body.getReader();let buffered=null,offset=0,finished=false,idle,total,controller,finishing;
 async function finish(){if(finishing)return finishing;finished=true;buffered=null;offset=0;clearTimeout(idle);clearTimeout(total);finishing=(async()=>{try{await reader.cancel()}finally{try{reader.releaseLock()}catch{}await release();}})();return finishing;}
 const expire=()=>{if(finished)return;controller.error(Error('Private download timed out'));void finish().catch(()=>{});};
 const touch=()=>{clearTimeout(idle);idle=setTimeout(expire,idleMs)};
 const body=new ReadableStream({
  start(c){controller=c;touch();total=setTimeout(expire,totalMs);},
  async pull(c){if(finished)return;try{touch();if(!buffered){const item=await reader.read();if(finished)return;if(item.done){await finish();c.close();return;}if(!(item.value instanceof Uint8Array)||!item.value.length)throw Error('Invalid private response body');buffered=item.value;offset=0;}const end=Math.min(offset+65536,buffered.length),part=buffered.slice(offset,end);offset=end;if(offset===buffered.length){buffered=null;offset=0;}c.enqueue(part);}catch(e){try{c.error(e)}catch{}try{await finish()}catch{}}},
  cancel(){return finish();}
 },{highWaterMark:0});
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}

export function createWorkflowHttp({runtime,lease}={}){
 if(!runtime?.parents||typeof runtime.runner!=='function'||typeof lease?.acquire!=='function'||typeof lease.complete!=='function')throw Error('Workflow HTTP dependencies required');
 const userId=runtime.trustedUserId;
 async function limited(method){if(!await runtime.limit('generation',method))error('workflow_rate_limited',429);}
 async function locked(fn){const claim=await lease.acquire(userId);if(claim?.state!=='acquired'||!UUID.test(claim.token||''))error('workflow_media_busy',429);let outcome='settled',bodyOwnsLease=false;try{const response=await fn();if(response instanceof Response&&response.headers.get('content-type')==='video/mp4'&&response.body){const held=workflowLeaseResponse(response,()=>lease.complete(claim.token,'settled'));bodyOwnsLease=true;return held;}return response;}catch(e){if(e?.code==='workflow_private_storage_uncertain')outcome='uncertain';throw e}finally{if(!bodyOwnsLease)await lease.complete(claim.token,outcome)}}
 async function prepared(req,max,fn){await runtime.gate();mediaHeaders(req,max);const reservation=await runtime.admitPreparation(req);return locked(()=>runtime.withPreparation(reservation,()=>fn()));}
 async function describe(jobId,{poll=false}={}){const runner=runtime.runner(jobId),summary=await runner[poll?'poll':'get']({method:'GET',userId,jobId}),job=await runtime.ownedJob(jobId);return {id:jobId,quoteId:summary.quoteId,state:summary.state,workflowVersion:WORKFLOW_VERSION,funding:'owner-provider',providerEstimateUsdMicros:job.providerEstimateUsdMicros,...(summary.clientProcessing?{clientProcessing:summary.clientProcessing}:{}),...(summary.settlement?{settlement:summary.settlement,...(summary.state==='failed'&&summary.settlement.outcome==='failed'?{finalizationConfirmed:true}:{})}:{}),...(summary.state==='completed'?{videoPath:`/api/generations/${jobId}/video`}:{})};}
 async function binding(jobId){const job=await runtime.ownedJob(jobId),q=await runtime.jobQuote(job);return {job,quote:q,workflow:hasWorkflow(q)};}
 async function dispatch(req){
  const u=new URL(req.url),p=u.pathname;
  if(u.origin!==runtime.origin||req.method==='POST'&&req.headers.get('origin')!==runtime.origin)return json({error:'Aanvraag geweigerd.'},403);
  const input=p.match(/^\/api\/workflow-inputs(?:\/([^/]+)(?:\/(mask))?)?$/);
  if(input){
   if(u.search)error('workflow_invalid_request',400);
   if(p==='/api/workflow-inputs/source'&&req.method==='POST')return prepared(req,16*1024*1024,async()=>{const bytes=await binary(req,16*1024*1024),made=await runtime.inputs.putSource({userId,bytes});return json({manifest:made.manifest},201)});
   if(input[1]&&UUID.test(input[1])&&!input[2]&&req.method==='GET')return locked(async()=>{const held=await runtime.inputs.get({userId,id:input[1]});return new Response(held.bytes,{headers:{...headers,'content-type':'video/mp4','content-length':String(held.bytes.length)}})});
   if(input[1]&&UUID.test(input[1])&&input[2]==='mask'&&req.method==='POST')return prepared(req,2*1024*1024,async()=>{const bytes=await binary(req,2*1024*1024),source=await runtime.inputs.get({userId,id:input[1]});if(source.record.kind!=='source')error('workflow_invalid_selection',400);const made=await runtime.inputs.putMask({userId,sourceId:input[1],sourceSha256:source.inspection.sha256,bytes});return json({id:made.id,sha256:made.sha256},201)});
   error('workflow_not_found',404);
  }
  if(req.method==='POST'&&p==='/api/generation-quotes'){
   const raw=await readJSON(req);if(!raw||!Object.hasOwn(raw,'cleanupMaskId'))return null;
   if(u.search)error('workflow_invalid_request',400);return locked(async()=>json(await runtime.quote(raw),201));
  }
  if(req.method==='POST'&&p==='/api/generations'){
   const raw=await readJSON(req);if(!raw||!ID.test(raw.quoteId||'')||!ID.test(raw.idempotencyKey||''))return null;
   const prior=await runtime.parents.jobs.getByIdempotency(userId,raw.idempotencyKey),priorQuote=await runtime.jobQuote(prior),q=await runtime.ownedQuote(raw.quoteId);
   if(!hasWorkflow(q)&&!hasWorkflow(priorQuote))return null;
   if(u.search||!exact(raw,['quoteId','idempotencyKey','transferConsent'],['verification'])||raw.transferConsent!==WORKFLOW_TRANSFER_POLICY)error('workflow_transfer_consent_required',400);
   await limited('POST');
   if(prior){if(prior.quoteId!==raw.quoteId)error('workflow_intent_conflict',409);return json(await describe(prior.id));}
   if(!q||!hasWorkflow(q))error('workflow_quote_expired',409);
   await validateOwnerCleanupWorkflow(q);await runtime.validateCurrentQuote(q);
   return locked(async()=>{
    // Recheck after acquiring the shared resource lease. A fresh passkey proof
    // is consumed only by the ordinary production owner-generation store.
    await runtime.validateCurrentQuote(q);
    const payload={quoteId:raw.quoteId,idempotencyKey:raw.idempotencyKey,transferConsent:raw.transferConsent};
    const begun=await runtime.parents.jobs.begin({userId,quoteId:raw.quoteId,idempotencyKey:raw.idempotencyKey,quote:q,verification:raw.verification,verificationPayload:payload});
    if(begun?.kind==='verification'&&begun.response instanceof Response)return begun.response;
    if(!['created','existing'].includes(begun?.kind))error(begun?.kind==='pricing'?'workflow_quote_expired':'workflow_intent_conflict',409);
    if(begun.kind==='existing')return json(await describe(begun.job.id));
    const jobId=begun.job.id;
    try{await runtime.acceptInputs(jobId);}catch(e){
     // No runner/provider call has happened. Settle only the workflow's own
     // undispatched steps, never route it through a legacy release handler.
     await runtime.workflows.initialize({userId,jobId,quote:q});
     if(await runtime.workflows.finalizeWhollyUndispatched({userId,jobId}))return json(await describe(jobId));throw e;
    }
    try{await runtime.runner(jobId).startAccepted({method:'POST',userId,jobId,quote:q,transferConsent:raw.transferConsent});}
    catch(e){if(await runtime.workflows.finalizeWhollyUndispatched({userId,jobId}))return json(await describe(jobId));throw e;}
    return json(await describe(jobId),202);
   });
  }
  const intent=p.match(/^\/api\/generation-intents\/([A-Za-z0-9_-]{1,100})\/reconcile$/);
  if(req.method==='POST'&&intent){const raw=await readJSON(req);if(!raw||!ID.test(raw.quoteId||''))return null;const prior=await runtime.parents.jobs.getByIdempotency(userId,intent[1]),q=await runtime.ownedQuote(raw.quoteId),priorQuote=await runtime.jobQuote(prior);if(!hasWorkflow(q)&&!hasWorkflow(priorQuote))return null;if(!exact(raw,['quoteId'])||u.search)error('workflow_invalid_request',400);await limited('POST');const result=await runtime.parents.jobs.reconcileIntent(userId,intent[1],raw.quoteId);if(result.kind==='existing'){if(result.job.quoteId!==raw.quoteId)error('workflow_intent_conflict',409);return json(await describe(result.job.id));}if(result.kind==='canceled')return json({state:'canceled'});error('workflow_intent_conflict',409);}
  if(req.method==='GET'&&p==='/api/generations/recent'){const job=await runtime.parents.jobs.getRecent(userId),q=await runtime.jobQuote(job);if(!hasWorkflow(q))return null;if(u.search)error('workflow_invalid_request',400);await limited('GET');return json({job:await describe(job.id)});}
  const route=p.match(/^\/api\/generations\/([A-Za-z0-9_-]{1,100})(?:\/(video|client)(?:\/(source|mask|clean|output|advance))?)?$/);
  if(!route)return null;
  const [,jobId,kind,role]=route,b=await binding(jobId);if(!b.workflow){if(kind==='client')error('workflow_not_found',404);return null;}
  if(u.search)error('workflow_invalid_request',400);await validateOwnerCleanupWorkflow(b.quote);await limited(req.method);
  if(req.method==='GET'&&!kind)return locked(async()=>json(await describe(jobId,{poll:true})));
  if(kind==='video'&&!role&&req.method==='GET')return locked(async()=>{const held=await runtime.result(jobId);return new Response(held.bytes,{headers:{...headers,'content-type':'video/mp4','content-length':String(held.bytes.length),'content-disposition':'attachment; filename="RIG-video.mp4"'}})});
  if(kind!=='client')error('workflow_not_found',404);
  const stageId=b.quote.input.workflow.clientProcessing.id;
  if(!role&&req.method==='GET')return locked(async()=>json({manifest:await runtime.clients.get({userId,jobId,stageId})}));
  if(['source','mask','clean','output'].includes(role)&&req.method==='GET')return locked(async()=>{const held=await runtime.clients.getArtifact({userId,jobId,stageId,role});return new Response(held.bytes,{headers:{...headers,'content-type':'video/mp4','content-length':String(held.bytes.length)}})});
  if(role==='output'&&req.method==='POST')return prepared(req,16*1024*1024,async()=>{const bytes=await binary(req,16*1024*1024);if(!await runtime.reservePreparation({userId,bytes:bytes.length}))error('workflow_rate_limited',429);const sha256=await workflowSha(bytes);await runtime.clients.uploadOutput({userId,jobId,stageId,body:bytes,sha256});return json({manifest:await runtime.clients.get({userId,jobId,stageId})});});
  if(role==='advance'&&req.method==='POST'){const raw=await readJSON(req);if(!exact(raw,['stageId','idempotencyKey','outputHash'])||raw.stageId!==stageId||!ID.test(raw.idempotencyKey||'')||!SHA.test(raw.outputHash||''))error('workflow_invalid_request',400);return locked(async()=>{await runtime.validatePaidLimits(b.quote);await runtime.runner(jobId).advance({method:'POST',userId,jobId,...raw});return json(await describe(jobId));});}
  error('workflow_not_found',404);
 }
 return async req=>{try{return await dispatch(req)}catch(e){return publicError(e)}};
}
