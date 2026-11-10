// Inactive infrastructure. No HTTP route, provider call, paid retry or scheduler.
// R2 callbacks resolve server-owned references only; they never accept URLs.
import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {inspectWorkflowMp4} from './workflow-mp4-inspect.mjs';
import {WORKFLOW_CLIENT_CONTRACT,WORKFLOW_CLIENT_LIMITS,validateWorkflowClientInspection} from './workflow-client-contract.mjs';
const ID=/^[A-Za-z0-9_-]{1,100}$/,SHA=/^[a-f0-9]{64}$/;
const clone=value=>JSON.parse(JSON.stringify(value));
const descriptor=(id,media)=>({id,sha256:media.sha256,size:media.size});
const outputKey=(jobId,stageId,hash)=>`rig-workflow-composed/${jobId}/${stageId}/${hash}.mp4`;

export async function readBoundedWorkflowClientOutput(body,{timeoutMs=15000}={}){
 const limit=WORKFLOW_CLIENT_LIMITS.output;
 if(body instanceof Uint8Array){if(typeof SharedArrayBuffer!=='undefined'&&body.buffer instanceof SharedArrayBuffer||body.byteLength<32||body.byteLength>limit)throw Error('Invalid composed output size');return body.slice();}
 if(!body||typeof body.getReader!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('Composed output stream required');
 const reader=body.getReader(),chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Composed output upload timed out')),timeoutMs)});
 try{for(;;){const item=await Promise.race([reader.read(),deadline]);if(item.done)break;if(!(item.value instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&item.value.buffer instanceof SharedArrayBuffer||!item.value.byteLength||size+item.value.byteLength>limit||chunks.length>=1024)throw Error('Invalid composed output size or chunk count');chunks.push(item.value.slice());size+=item.value.byteLength;}if(size<32)throw Error('Invalid composed output size');const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}return bytes;}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function createProductionWorkflowClientStores(db,{productionContext,readCurrentProductionContext,workflows,readOwnedArtifact,putOwnedOutput,clock=Date.now}={}){
 if(!isProductionGenerationContext(productionContext,{db})||!workflows||typeof workflows.get!=='function'||typeof clock!=='function')throw Error('Invalid workflow client capability');
 async function binding(userId,jobId,stageId){
  if(!ID.test(userId||'')||!ID.test(jobId||'')||stageId!==undefined&&!ID.test(stageId||''))throw Error('Invalid client processing identity');
  const b=await workflows.get({userId,jobId}),spec=b.plan.clientProcessing;
  if(!spec||stageId!==undefined&&spec.id!==stageId)throw Error('Client processing not found');
  const clean=b.steps.find(s=>s.step_id===spec.cleanFromStepId),base=b.steps.find(s=>s.step_id===spec.beforeStepId);
  if(clean?.state!=='completed'||!SHA.test(clean.output_sha256||'')||clean.result_key!==`rig-workflow-results/${jobId}/${spec.cleanFromStepId}.mp4`)throw Error('Owned clean artifact is not ready');
  return {...b,spec,clean,base};
 }
 async function rowFor(userId,jobId,stageId){
  const b=await binding(userId,jobId,stageId),row=await db.prepare('SELECT * FROM rig_generation_workflow_client_processing WHERE job_id=? AND stage_id=? AND user_id=?').bind(jobId,b.spec.id,userId).first();
  if(!row||row.plan_hash!==b.plan.planHash||row.contract!==WORKFLOW_CLIENT_CONTRACT||row.before_step_id!==b.spec.beforeStepId||row.clean_step_id!==b.spec.cleanFromStepId||row.clean_sha256!==b.clean.output_sha256)throw Error('Client processing binding changed');
  const inputs=JSON.parse(row.inputs_json);
  if(inputs.source.id!==b.spec.source.id||inputs.source.sha256!==b.spec.source.sha256||inputs.mask.id!==b.spec.mask.id||inputs.mask.sha256!==b.spec.mask.sha256||inputs.clean.sha256!==b.clean.output_sha256)throw Error('Client artifact binding changed');
  if(row.output_sha256&&(!SHA.test(row.output_sha256)||row.output_key!==outputKey(jobId,b.spec.id,row.output_sha256)))throw Error('Composed artifact binding changed');
  return {...b,row,inputs};
 }
 async function held(b,role){
  if(typeof readOwnedArtifact!=='function')throw Error('Private artifact reader unavailable');
  const reference=role==='source'||role==='mask'?{kind:'input',...b.spec[role]}:role==='clean'?{kind:'workflow-result',stepId:b.spec.cleanFromStepId,key:b.clean.result_key,sha256:b.clean.output_sha256}:{kind:'workflow-composed',key:b.row.output_key,sha256:b.row.output_sha256};
  const bytes=await readOwnedArtifact({userId:b.quote.userId,jobId:b.row?.job_id??b.jobId,stageId:b.spec.id,role,reference:clone(reference)});
  // The callback must stream/bound its R2 read too; no network URL is accepted.
  if(!(bytes instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&bytes.buffer instanceof SharedArrayBuffer||bytes.byteLength>WORKFLOW_CLIENT_LIMITS[role])throw Error('Private artifact is unavailable or too large');
  // The private server callback returns a fresh exclusively-held byte array.
  // Do not make a second64MiB clean-video copy inside a128MiB Worker.
  const inspection=await inspectWorkflowMp4(bytes,{role:role==='mask'?'mask':role==='clean'?'result':'input'});
  validateWorkflowClientInspection(inspection,b.spec.media,{role,sha256:reference.sha256});
  return {bytes,inspection};
 }
 function manifest(b){
  return {version:WORKFLOW_CLIENT_CONTRACT,jobId:b.row.job_id,stageId:b.spec.id,planHash:b.plan.planHash,state:b.row.state,media:clone(b.spec.media),artifacts:clone(b.inputs),...(b.row.output_sha256?{output:{id:'composed-'+b.spec.id,sha256:b.row.output_sha256,size:b.row.output_size}}:{})};
 }
 const api={
  async prepareAwaiting({userId,jobId}){
   const b=await binding(userId,jobId);b.jobId=jobId;
   const existing=await db.prepare('SELECT 1 FROM rig_generation_workflow_client_processing WHERE job_id=? AND stage_id=?').bind(jobId,b.spec.id).first();
   if(existing)return manifest(await rowFor(userId,jobId,b.spec.id));
   if(b.base?.state!=='prepared'||b.settlement)throw Error('Client processing cannot be prepared');
   // Only retain compact metadata between reads, not three media buffers.
   const source=(await held(b,'source')).inspection,clean=(await held(b,'clean')).inspection,mask=(await held(b,'mask')).inspection;
   const inputs={source:descriptor(b.spec.source.id,source),clean:descriptor('clean-'+b.spec.cleanFromStepId,clean),mask:descriptor(b.spec.mask.id,mask)};
   await db.prepare(`INSERT OR IGNORE INTO rig_generation_workflow_client_processing(job_id,stage_id,user_id,plan_hash,contract,before_step_id,clean_step_id,clean_sha256,inputs_json,state,created_at) SELECT w.job_id,?,?,?,?,?,?,?,?,'awaiting_client_processing',? FROM rig_generation_workflows w JOIN rig_generation_jobs j ON j.id=w.job_id JOIN rig_generation_workflow_steps c ON c.job_id=w.job_id AND c.step_id=? JOIN rig_generation_workflow_steps b ON b.job_id=w.job_id AND b.step_id=? WHERE w.job_id=? AND w.user_id=? AND w.plan_hash=? AND c.state='completed' AND c.output_sha256=? AND b.state='prepared' AND j.state='queued' AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements WHERE job_id=w.job_id)`).bind(b.spec.id,userId,b.plan.planHash,WORKFLOW_CLIENT_CONTRACT,b.spec.beforeStepId,b.spec.cleanFromStepId,b.clean.output_sha256,JSON.stringify(inputs),clock(),b.spec.cleanFromStepId,b.spec.beforeStepId,jobId,userId,b.plan.planHash,b.clean.output_sha256).run();
   return manifest(await rowFor(userId,jobId,b.spec.id));
  },
  async get({userId,jobId,stageId}){return manifest(await rowFor(userId,jobId,stageId));},
  async getArtifact({userId,jobId,stageId,role}){
   if(!['source','clean','mask','output'].includes(role))throw Error('Invalid client artifact role');
   const b=await rowFor(userId,jobId,stageId);if(role==='output'&&!b.row.output_sha256)throw Error('Composed artifact is not ready');
   const result=await held(b,role);return {...result,artifact:descriptor(role==='output'?'composed-'+b.spec.id:b.inputs[role].id,result.inspection)};
  },
  async uploadOutput({userId,jobId,stageId,body,sha256}){
   if(!SHA.test(sha256||''))throw Error('Invalid composed output digest');
   const b=await rowFor(userId,jobId,stageId);if(b.settlement||b.base.state!=='prepared')throw Error('Client processing is closed');
   if(b.row.state!=='awaiting_client_processing'){if(b.row.output_sha256!==sha256)throw Error('Composed output is immutable');return manifest(b);}
   if(typeof putOwnedOutput!=='function')throw Error('Private output writer unavailable');
   const bytes=await readBoundedWorkflowClientOutput(body),inspection=await inspectWorkflowMp4(bytes);
   validateWorkflowClientInspection(inspection,b.spec.media,{role:'output',sha256});
   const key=outputKey(jobId,b.spec.id,sha256);
   // Content-addressed private key. Callback must use write-once semantics and
   // never publish the object; an interrupted write may be resumed, not paid.
   await putOwnedOutput({userId,jobId,stageId:b.spec.id,key,bytes,sha256});
   await db.prepare("UPDATE rig_generation_workflow_client_processing SET state='ready_to_advance',output_key=?,output_sha256=?,output_size=?,output_metadata_json=?,uploaded_at=? WHERE job_id=? AND stage_id=? AND user_id=? AND plan_hash=? AND state='awaiting_client_processing' AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements WHERE job_id=?) AND EXISTS(SELECT 1 FROM rig_generation_workflow_steps WHERE job_id=? AND step_id=? AND state='prepared')").bind(key,sha256,inspection.size,JSON.stringify(inspection),clock(),jobId,b.spec.id,userId,b.plan.planHash,jobId,jobId,b.spec.beforeStepId).run();
   const after=await rowFor(userId,jobId,b.spec.id);if(after.row.output_sha256!==sha256)throw Error('Composed output requires reconciliation');return manifest(after);
  },
  async advance({userId,jobId,stageId,idempotencyKey,outputHash}){
   if(!ID.test(idempotencyKey||'')||!SHA.test(outputHash||''))throw Error('Invalid client advance binding');
   const b=await rowFor(userId,jobId,stageId);
   if(b.row.state==='advanced'){if(b.row.advance_key!==idempotencyKey||b.row.output_sha256!==outputHash)throw Error('Conflicting client advance');return {advanced:false,manifest:manifest(b)};}
   if(b.row.state!=='ready_to_advance'||b.row.output_sha256!==outputHash||b.base.state!=='prepared'||b.settlement)throw Error('Verified composed output required');
   if(typeof readCurrentProductionContext!=='function')throw Error('Fresh production policy reader required');
   const current=await readCurrentProductionContext();if(!isProductionGenerationContext(current,{db})||current.env.RIG_PUBLIC_ORIGIN!==productionContext.env.RIG_PUBLIC_ORIGIN)throw Error('Fresh production policy unavailable');
   const currentOwner=productionFundingKind(current,userId)==='owner-provider'?userId:'';
   const update=await db.prepare(`UPDATE rig_generation_workflow_client_processing SET state='advanced',advance_key=?,advanced_at=? WHERE job_id=? AND stage_id=? AND user_id=? AND plan_hash=? AND state='ready_to_advance' AND output_sha256=? AND EXISTS(SELECT 1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id JOIN rig_generation_workflow_steps s ON s.job_id=j.id AND s.step_id=? WHERE j.id=? AND j.user_id=? AND j.state='queued' AND s.state='prepared' AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id) AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements WHERE job_id=j.id) AND ((q.funding_kind='credits' AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents) AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id IN ('release:'||j.id,'settle:'||j.id,'partial-release:'||j.id))) OR (q.funding_kind='owner-provider' AND q.user_id=? AND EXISTS(SELECT 1 FROM rig_owner_provider_usage u WHERE u.job_id=j.id AND u.user_id=q.user_id AND u.quote_id=q.id AND u.state='authorized'))))`).bind(idempotencyKey,clock(),jobId,b.spec.id,userId,b.plan.planHash,outputHash,b.spec.beforeStepId,jobId,userId,currentOwner).run();
   const after=await rowFor(userId,jobId,b.spec.id);
   if(update.meta?.changes!==1){if(after.row.state==='advanced'&&after.row.advance_key===idempotencyKey&&after.row.output_sha256===outputHash)return {advanced:false,manifest:manifest(after)};throw Error('Client advance is blocked');}
   // No dispatch here. A POST controller may now invoke the normal one-time
   // authorizeStep (which rechecks owner/freeze/budget) and then submit once.
   return {advanced:true,manifest:manifest(after)};
  }
 };
 return Object.freeze(api);
}
