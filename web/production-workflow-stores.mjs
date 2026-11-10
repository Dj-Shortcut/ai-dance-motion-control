// PRIVATE PROPOSAL. No route, flag, provider choice, submission or automatic retry.
// The trusted orchestrator must validate the exact provider contract and media.
import {isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {validateWorkflowClientPlan} from './workflow-client-contract.mjs';

export const WORKFLOW_VERSION='rig-workflow-v2';
const SHA=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,100}$/,STEP=/^[a-z][a-z0-9-]{0,31}$/;
const MODEL=/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+){1,8}$/;
const terminal=new Set(['completed','failed','skipped']);
const whole=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
function canonical(value,depth=0){
 if(depth>10)throw Error('Workflow settings too deep');
 if(value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=8192)return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12)return JSON.stringify(value);
 if(Array.isArray(value)&&value.length<=128)return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length<=64){
  const keys=Object.keys(value).sort();if(keys.some(k=>['__proto__','constructor','prototype'].includes(k)))throw Error('Invalid workflow settings');
  return '{'+keys.map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
 }
 throw Error('Invalid workflow settings');
}
export async function workflowHash(value){
 const text=canonical(value);if(text.length>32768)throw Error('Workflow too large');
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function workflowPlanHash(plan){const {planHash,...body}=plan??{};return workflowHash(body);}
export async function workflowInitialSourceHash(quote){return workflowHash({refs:quote?.input?.refs??[],data:quote?.input?.data??{}});}
export async function validateWorkflowPlan(plan,quote){
 const hasClient=Object.hasOwn(plan??{},'clientProcessing');
 if(!exact(plan,['version','planHash','baseStepId','baseRetailCents','cleanupRetailCents','steps',...(hasClient?['clientProcessing']:[])])||plan.version!==WORKFLOW_VERSION||!SHA.test(plan.planHash)||!STEP.test(plan.baseStepId||'')||!whole(plan.baseRetailCents,1,1200)||!whole(plan.cleanupRetailCents,0,1200)||!Array.isArray(plan.steps)||plan.steps.length<2||plan.steps.length>8)throw Error('Invalid workflow plan');
 const baseIndex=plan.steps.findIndex(step=>step?.id===plan.baseStepId&&step.kind==='base');if(baseIndex<0||plan.steps.filter(step=>step?.kind==='base').length!==1)throw Error('Workflow must bind exactly one base step');
 let usd=0,retail=0,cleanup=0,baseRetail=0;const seen=new Set();
 for(const [index,step]of plan.steps.entries()){
  if(!exact(step,['id','kind','model','queueFamily','contract','settings','dependsOn','providerEstimateUsdMicros','retailCents'])||!STEP.test(step.id)||seen.has(step.id)||step.kind!==(index<baseIndex?'preclean':index===baseIndex?'base':'postcleanup')||!MODEL.test(step.model)||!MODEL.test(step.queueFamily)||!ID.test(step.contract)||!step.settings||Array.isArray(step.settings)||canonical(step.settings).length>8192||!whole(step.providerEstimateUsdMicros,1,6000000)||!whole(step.retailCents,index===baseIndex?1:0,1200)||(index===0?step.dependsOn!==null:step.dependsOn!==plan.steps[index-1].id))throw Error('Invalid workflow step');
  seen.add(step.id);usd+=step.providerEstimateUsdMicros;retail+=step.retailCents;if(index>baseIndex)cleanup+=step.retailCents;else baseRetail+=step.retailCents;
 }
 if(hasClient){
  const client=validateWorkflowClientPlan(plan.clientProcessing,plan.steps,plan.baseStepId);
  if(quote&&[client.source,client.mask].some(ref=>!Array.isArray(quote.input?.refs)||quote.input.refs.filter(r=>r.id===ref.id&&r.sha256===ref.sha256).length!==1))throw Error('Client processing artifacts are not bound to the quote');
 }
 if(baseRetail!==plan.baseRetailCents||cleanup!==plan.cleanupRetailCents||(baseIndex<plan.steps.length-1?cleanup<1:cleanup!==0)||!whole(usd,1,6000000)||!whole(retail,1,1200)||retail!==plan.baseRetailCents+plan.cleanupRetailCents||quote&&(quote.priceCents!==retail||quote.input?.providerEstimateUsdMicros!==usd||quote.model!==plan.steps[baseIndex].model)||await workflowPlanHash(plan)!==plan.planHash)throw Error('Workflow totals or hash mismatch');
 return {plan:JSON.parse(canonical(plan)),planJson:canonical(plan),baseIndex,usd,retail};
}

export function createProductionWorkflowStores(db,{productionContext,readCurrentProductionContext,clock=Date.now}={}){
 if(!isProductionGenerationContext(productionContext,{db})||typeof clock!=='function')throw Error('Invalid production workflow capability');
 const mode="EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')";
 const active=j=>`((q.funding_kind='credits' AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||${j}.id AND l.user_id=${j}.user_id AND l.order_id IS NULL AND l.delta=-${j}.price_cents) AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id IN ('settle:'||${j}.id,'release:'||${j}.id,'partial-release:'||${j}.id))) OR(q.funding_kind='owner-provider' AND q.user_id=? AND EXISTS(SELECT 1 FROM rig_owner_provider_usage u WHERE u.job_id=${j}.id AND u.quote_id=q.id AND u.user_id=q.user_id AND u.state='authorized' AND u.estimated_usd_micros=json_extract(q.input_json,'$.providerEstimateUsdMicros')) AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id IN ('reserve:'||${j}.id,'settle:'||${j}.id,'release:'||${j}.id,'partial-release:'||${j}.id))))`;
 const owner=user=>productionFundingKind(productionContext,user)==='owner-provider'?user:'';
 const joined=`FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id AND q.price_cents=j.price_cents`;
 async function load(userId,jobId,{required=true}={}){
  if(!ID.test(userId||'')||!ID.test(jobId||''))throw Error('Invalid workflow identity');
  const row=await db.prepare(`SELECT j.*,q.model,q.input_json,q.funding_kind,q.pricing_version,q.duration_seconds,q.expires_at ${joined} WHERE j.id=? AND j.user_id=? AND ${mode}`).bind(jobId,userId).first();
  if(!row){if(required)throw Error('Workflow not found');return null;}
  const input=JSON.parse(row.input_json),quote={id:row.quote_id,userId,model:row.model,input,priceCents:row.price_cents,pricingVersion:row.pricing_version,durationSeconds:row.duration_seconds,expiresAt:row.expires_at,fundingKind:row.funding_kind};
  const checked=await validateWorkflowPlan(input.workflow,quote),header=await db.prepare('SELECT * FROM rig_generation_workflows WHERE job_id=? AND user_id=?').bind(jobId,userId).first();
  if(header&&(header.quote_id!==quote.id||header.plan_version!==WORKFLOW_VERSION||header.base_step_id!==checked.plan.baseStepId||header.plan_hash!==checked.plan.planHash||header.plan_json!==checked.planJson||header.step_count!==checked.plan.steps.length||header.provider_estimate_usd_micros!==checked.usd||header.base_retail_cents!==checked.plan.baseRetailCents||header.cleanup_retail_cents!==checked.plan.cleanupRetailCents))throw Error('Workflow binding changed');
  return {row,quote,...checked,header};
 }
 async function state(userId,jobId){
  const binding=await load(userId,jobId);if(!binding.header)throw Error('Workflow is not initialized');
  const rows=(await db.prepare('SELECT * FROM rig_generation_workflow_steps WHERE job_id=? ORDER BY step_index').bind(jobId).all()).results;
  if(rows.length!==binding.plan.steps.length||rows.some((r,i)=>r.step_index!==i||r.step_id!==binding.plan.steps[i].id||r.step_json!==canonical(binding.plan.steps[i])))throw Error('Workflow steps changed');
  const settlement=await db.prepare('SELECT * FROM rig_generation_workflow_settlements WHERE job_id=?').bind(jobId).first();
  return {...binding,steps:rows,settlement};
 }
 async function updateParent(userId,jobId){
  await db.prepare(`UPDATE rig_generation_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM rig_generation_workflow_steps s WHERE s.job_id=rig_generation_jobs.id AND s.state IN ('authorized','unknown')) THEN 'unknown' ELSE 'queued' END,poll_token=NULL,poll_lease_until=NULL WHERE id=? AND user_id=? AND state IN ('submitting','queued','unknown') AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements WHERE job_id=rig_generation_jobs.id) AND ${mode}`).bind(jobId,userId).run();
 }
 const api={
  async initialize({userId,jobId,quote}){
   const b=await load(userId,jobId);if(!quote||quote.id!==b.quote.id||quote.userId!==userId||JSON.stringify(quote.input)!==b.row.input_json)throw Error('Workflow quote changed');
   if(b.header)return state(userId,jobId);
   const now=clock(),insert=db.prepare(`INSERT OR IGNORE INTO rig_generation_workflows(job_id,quote_id,user_id,plan_version,base_step_id,plan_hash,plan_json,step_count,base_retail_cents,cleanup_retail_cents,provider_estimate_usd_micros,created_at) SELECT j.id,q.id,j.user_id,?,?,?,?,?,?,?,?,? ${joined} WHERE j.id=? AND j.user_id=? AND j.state='submitting' AND j.fal_request_id IS NULL AND q.input_json=? AND ${mode} AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id) AND ${active('j')}`).bind(WORKFLOW_VERSION,b.plan.baseStepId,b.plan.planHash,b.planJson,b.plan.steps.length,b.plan.baseRetailCents,b.plan.cleanupRetailCents,b.usd,now,jobId,userId,b.row.input_json,owner(userId));
   const inserts=b.plan.steps.map((step,index)=>db.prepare("INSERT OR IGNORE INTO rig_generation_workflow_steps(job_id,step_id,step_index,step_json,state) SELECT job_id,?,?,?,'prepared' FROM rig_generation_workflows WHERE job_id=? AND user_id=? AND plan_hash=?").bind(step.id,index,canonical(step),jobId,userId,b.plan.planHash));
   await db.batch([insert,...inserts]);return state(userId,jobId);
  },
  get:({userId,jobId})=>state(userId,jobId),
  async authorizeStep({userId,jobId,stepId,sourceHash,inputHash,requestHash}){
   const b=await state(userId,jobId),step=b.steps.find(s=>s.step_id===stepId),plan=b.plan.steps.find(s=>s.id===stepId);if(!step||![sourceHash,inputHash,requestHash].every(s=>SHA.test(s||'')))throw Error('Invalid dispatch binding');
   if(step.state!=='prepared')return {authorized:false,state:step.state};
   if(plan.dependsOn){const dep=b.steps.find(s=>s.step_id===plan.dependsOn);if(dep?.state!=='completed'||dep.output_sha256!==sourceHash)return {authorized:false,state:'dependency'};}else if(sourceHash!==await workflowInitialSourceHash(b.quote))throw Error('Invalid initial input binding');
   const client=b.plan.clientProcessing?.beforeStepId===stepId?b.plan.clientProcessing:null;
   if(client){
    const ready=await db.prepare("SELECT 1 FROM rig_generation_workflow_client_processing WHERE job_id=? AND stage_id=? AND user_id=? AND plan_hash=? AND state='advanced' AND clean_sha256=? AND output_sha256=?").bind(jobId,client.id,userId,b.plan.planHash,sourceHash,inputHash).first();
    if(!ready)return {authorized:false,state:'awaiting_client_processing'};
   }
   if(typeof readCurrentProductionContext!=='function')throw Error('Fresh production policy reader required');
   const currentContext=await readCurrentProductionContext();if(!isProductionGenerationContext(currentContext,{db})||currentContext.env.RIG_PUBLIC_ORIGIN!==productionContext.env.RIG_PUBLIC_ORIGIN)throw Error('Fresh production policy unavailable');
   const currentOwner=productionFundingKind(currentContext,userId)==='owner-provider'?userId:'';
   const now=clock(),token=crypto.randomUUID(),policy=await db.prepare('SELECT daily_provider_limit_usd_micros FROM rig_finance_policy WHERE id=1').first(),day=new Date(now).toISOString().slice(0,10);
   if(!whole(policy?.daily_provider_limit_usd_micros,1,1000000000))throw Error('Provider budget unavailable');
   const update=db.prepare(`UPDATE rig_generation_workflow_steps SET state='authorized',dispatch_token=?,source_sha256=?,input_sha256=?,request_sha256=?,authorized_at=? WHERE job_id=? AND step_id=? AND state='prepared' AND dispatch_token IS NULL AND fal_request_id IS NULL AND step_json=? AND EXISTS(SELECT 1 ${joined} JOIN rig_generation_workflows w ON w.job_id=j.id WHERE j.id=? AND j.user_id=? AND j.state IN ('submitting','queued') AND j.fal_request_id IS NULL AND (j.state='queued' OR j.poll_token='dispatch-authorized') AND q.input_json=? AND w.plan_hash=? AND ${mode} AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id) AND ${active('j')} AND EXISTS(SELECT 1 FROM rig_generation_costs c WHERE c.job_id=j.id AND c.quote_id=q.id AND c.user_id=j.user_id AND c.funding_kind=q.funding_kind AND c.provider_estimate_usd_micros=? AND c.snapshot_json=?) AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements WHERE job_id=j.id)) AND COALESCE((SELECT SUM(c.provider_estimate_usd_micros) FROM rig_generation_costs c JOIN rig_generation_jobs pending ON pending.id=c.job_id WHERE c.budget_day=? OR pending.state IN ('unknown','submitting') OR EXISTS(SELECT 1 FROM rig_generation_workflows w WHERE w.job_id=c.job_id AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_settlements f WHERE f.job_id=w.job_id))),0)<=? AND (? IS NULL OR EXISTS(SELECT 1 FROM rig_generation_workflow_steps dep WHERE dep.job_id=rig_generation_workflow_steps.job_id AND dep.step_id=? AND dep.state='completed' AND dep.output_sha256=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM rig_generation_workflow_client_processing cp WHERE cp.job_id=rig_generation_workflow_steps.job_id AND cp.stage_id=? AND cp.user_id=? AND cp.plan_hash=? AND cp.state='advanced' AND cp.clean_sha256=? AND cp.output_sha256=?))`).bind(token,sourceHash,inputHash,requestHash,now,jobId,stepId,canonical(plan),jobId,userId,b.row.input_json,b.plan.planHash,currentOwner,b.usd,JSON.stringify(b.quote.input.profitSnapshot),day,policy.daily_provider_limit_usd_micros,plan.dependsOn,plan.dependsOn,sourceHash,client?.id??null,client?.id??null,userId,b.plan.planHash,sourceHash,inputHash);
   const parent=db.prepare(`UPDATE rig_generation_jobs SET state='queued',poll_token=NULL,poll_lease_until=NULL WHERE id=? AND user_id=? AND state IN ('submitting','queued') AND EXISTS(SELECT 1 FROM rig_generation_workflow_steps WHERE job_id=? AND step_id=? AND dispatch_token=? AND state='authorized') AND ${mode}`).bind(jobId,userId,jobId,stepId,token);
   const results=await db.batch([update,parent]);if(results[0]?.meta?.changes!==1)return {authorized:false,state:'blocked'};if(results[1]?.meta?.changes!==1)throw Error('Dispatch authorization requires reconciliation');
   // A fresh authorization is usable once by its original caller. A lost
   // response cannot be reclaimed; recoverAuthorized converts it to unknown.
   return {authorized:true,dispatchToken:token};
  },
  async recoverAuthorized({userId,jobId}){
   await state(userId,jobId);await db.prepare("UPDATE rig_generation_workflow_steps SET state='unknown',failure_code='dispatch_unknown' WHERE job_id=? AND state='authorized' AND fal_request_id IS NULL").bind(jobId).run();await updateParent(userId,jobId);return state(userId,jobId);
  },
  async markSubmitted({userId,jobId,stepId,dispatchToken,requestId}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||!ID.test(requestId||'')||s.dispatch_token!==dispatchToken)throw Error('Invalid provider identity');
   if(s.state==='queued'&&s.fal_request_id===requestId)return;
   const r=await db.prepare("UPDATE rig_generation_workflow_steps SET state='queued',fal_request_id=?,submitted_at=?,failure_code=NULL WHERE job_id=? AND step_id=? AND dispatch_token=? AND state IN ('authorized','unknown') AND fal_request_id IS NULL").bind(requestId,clock(),jobId,stepId,dispatchToken).run();if(r.meta?.changes!==1)throw Error('Submission requires reconciliation');await updateParent(userId,jobId);
  },
  async markUnknown({userId,jobId,stepId,dispatchToken}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||s.dispatch_token!==dispatchToken)throw Error('Invalid dispatch identity');
   await db.prepare("UPDATE rig_generation_workflow_steps SET state='unknown',failure_code='dispatch_unknown' WHERE job_id=? AND step_id=? AND dispatch_token=? AND state='authorized' AND fal_request_id IS NULL").bind(jobId,stepId,dispatchToken).run();await updateParent(userId,jobId);
  },
  async claimPoll({userId,jobId,stepId}){
   await state(userId,jobId);const now=clock(),token=crypto.randomUUID(),r=await db.prepare("UPDATE rig_generation_workflow_steps SET poll_token=?,poll_lease_until=? WHERE job_id=? AND step_id=? AND state='queued' AND fal_request_id IS NOT NULL AND (poll_lease_until IS NULL OR poll_lease_until<=?)").bind(token,now+90000,jobId,stepId,now).run();return r.meta?.changes===1?{kind:'acquired',token}:{kind:'busy'};
  },
  async releasePoll({userId,jobId,stepId,token}){await state(userId,jobId);await db.prepare("UPDATE rig_generation_workflow_steps SET poll_token=NULL,poll_lease_until=NULL WHERE job_id=? AND step_id=? AND poll_token=? AND state='queued'").bind(jobId,stepId,token).run();},
  async markNeedsReview({userId,jobId,stepId,requestId,token}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||s.fal_request_id!==requestId)throw Error('Invalid review identity');
   const r=await db.prepare("UPDATE rig_generation_workflow_steps SET failure_code='provider_status_unrecognized' WHERE job_id=? AND step_id=? AND state='queued' AND fal_request_id=? AND poll_token=? AND poll_lease_until>?").bind(jobId,stepId,requestId,token,clock()).run();if(r.meta?.changes!==1)throw Error('Review status requires reconciliation');
  },
  async markCompleted({userId,jobId,stepId,requestId,token,resultKey,outputHash,outputMetadata}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||s.fal_request_id!==requestId||!SHA.test(outputHash||'')||resultKey!==`rig-workflow-results/${jobId}/${stepId}.mp4`||!outputMetadata||canonical(outputMetadata).length>8192)throw Error('Invalid completed artifact');
   if(s.state==='completed'&&s.result_key===resultKey&&s.output_sha256===outputHash&&s.output_metadata_json===canonical(outputMetadata))return;
   const now=clock(),r=await db.prepare("UPDATE rig_generation_workflow_steps SET state='completed',result_key=?,output_sha256=?,output_metadata_json=?,failure_code=NULL,finalized_at=?,poll_token=NULL,poll_lease_until=NULL WHERE job_id=? AND step_id=? AND state='queued' AND fal_request_id=? AND poll_token=? AND poll_lease_until>?").bind(resultKey,outputHash,canonical(outputMetadata),now,jobId,stepId,requestId,token,now).run();if(r.meta?.changes!==1)throw Error('Completion requires reconciliation');
  },
  async markFailed({userId,jobId,stepId,requestId,token,reason='provider_failed'}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||s.fal_request_id!==requestId||!['provider_failed','provider_input_unavailable','output_invalid'].includes(reason))throw Error('Invalid terminal failure');if(s.state==='failed'&&s.failure_code===reason)return;
   const now=clock(),r=await db.prepare("UPDATE rig_generation_workflow_steps SET state='failed',failure_code=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL WHERE job_id=? AND step_id=? AND state='queued' AND fal_request_id=? AND poll_token=? AND poll_lease_until>?").bind(reason,now,jobId,stepId,requestId,token,now).run();if(r.meta?.changes!==1)throw Error('Failure requires reconciliation');
  },
  async skipStep({userId,jobId,stepId,reason='not_dispatched'}){
   const b=await state(userId,jobId),s=b.steps.find(s=>s.step_id===stepId);if(!s||!['not_dispatched','dependency_failed'].includes(reason))throw Error('Invalid skipped step');
   const spec=b.plan.steps[s.step_index];if(reason==='dependency_failed'&&!b.steps.some(d=>d.step_id===spec.dependsOn&&['failed','skipped'].includes(d.state)))throw Error('Dependency has not failed');
   const r=await db.prepare("UPDATE rig_generation_workflow_steps SET state='skipped',failure_code=?,finalized_at=? WHERE job_id=? AND step_id=? AND state='prepared' AND dispatch_token IS NULL AND fal_request_id IS NULL").bind(reason,clock(),jobId,stepId).run();if(r.meta?.changes!==1&&s.state!=='skipped')throw Error('A dispatched step cannot be skipped');
  },
  async finalize({userId,jobId}){
   const b=await state(userId,jobId);if(b.steps.some(s=>!terminal.has(s.state)))throw Error('Workflow outcome is unresolved');
   const base=b.steps[b.baseIndex],all=b.steps.every(s=>s.state==='completed'),outcome=base.state==='completed'?(all?'completed':'partial'):'failed';
   if(base.state==='completed'&&b.steps.slice(0,b.baseIndex).some(s=>s.state!=='completed')||outcome==='failed'&&b.steps.slice(b.baseIndex+1).some(s=>s.state!=='skipped'))throw Error('Invalid dependent completion');
   const authorizedCount=b.steps.filter(s=>s.dispatch_token!==null).length,dispatchedCount=b.steps.filter(s=>s.fal_request_id!==null).length;
   const charged=outcome==='completed'?b.retail:outcome==='partial'?b.plan.baseRetailCents:0,refund=b.retail-charged,resultKey=outcome==='failed'?null:(all?b.steps.at(-1):base).result_key,now=clock(),parentState=outcome==='failed'?'failed':'completed';
   if(!b.settlement){
    // Finalize historical accepted funding even if the current owner pin has
    // changed. This cannot authorize a new step or create a provider request.
    const insert=db.prepare(`INSERT OR IGNORE INTO rig_generation_workflow_settlements(job_id,outcome,funding_kind,base_step_id,provider_authorized_steps,provider_dispatched_steps,reserved_cents,charged_cents,refunded_cents,result_key,plan_hash,finalized_at) SELECT j.id,?,q.funding_kind,?,?,?,j.price_cents,?,?,?,?,? ${joined} WHERE j.id=? AND j.user_id=? AND j.state IN ('submitting','queued','unknown') AND j.finalized_at IS NULL AND q.input_json=? AND ${mode} AND ${active('j')} AND NOT EXISTS(SELECT 1 FROM rig_generation_workflow_steps s WHERE s.job_id=j.id AND s.state NOT IN ('completed','failed','skipped'))`).bind(outcome,b.plan.baseStepId,authorizedCount,dispatchedCount,charged,refund,resultKey,b.plan.planHash,now,jobId,userId,b.row.input_json,userId);
    const failureCode=outcome==='completed'?null:outcome==='partial'?'workflow_postcleanup_failed':base.state==='failed'?'workflow_base_failed':'workflow_before_base_failed';
    const update=db.prepare("UPDATE rig_generation_jobs SET state=?,result_key=?,failure_code=?,finalized_at=?,poll_token=NULL,poll_lease_until=NULL WHERE id=? AND user_id=? AND state IN ('submitting','queued','unknown') AND finalized_at IS NULL AND EXISTS(SELECT 1 FROM rig_generation_workflow_settlements s WHERE s.job_id=rig_generation_jobs.id AND s.outcome=? AND s.plan_hash=?)").bind(parentState,resultKey,failureCode,now,jobId,userId,outcome,b.plan.planHash);
    const releaseEvent=outcome==='partial'?`partial-release:${jobId}`:`release:${jobId}`;
    const release=db.prepare("INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,j.user_id,NULL,s.refunded_cents FROM rig_generation_workflow_settlements s JOIN rig_generation_jobs j ON j.id=s.job_id WHERE j.id=? AND j.user_id=? AND s.funding_kind='credits' AND s.refunded_cents>0 AND j.state=? AND s.outcome=? AND s.plan_hash=?").bind(releaseEvent,jobId,userId,parentState,outcome,b.plan.planHash);
    const settle=db.prepare("INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta) SELECT ?,j.user_id,NULL,0 FROM rig_generation_workflow_settlements s JOIN rig_generation_jobs j ON j.id=s.job_id WHERE j.id=? AND j.user_id=? AND s.funding_kind='credits' AND s.charged_cents>0 AND j.state='completed' AND s.outcome=? AND s.plan_hash=?").bind(`settle:${jobId}`,jobId,userId,outcome,b.plan.planHash);
    const ownerFinal=db.prepare("UPDATE rig_owner_provider_usage SET state=?,finalized_at=? WHERE job_id=? AND user_id=? AND state='authorized' AND estimated_usd_micros=? AND EXISTS(SELECT 1 FROM rig_generation_workflow_settlements s JOIN rig_generation_jobs j ON j.id=s.job_id WHERE s.job_id=rig_owner_provider_usage.job_id AND s.funding_kind='owner-provider' AND s.outcome=? AND s.plan_hash=? AND j.state=?)").bind(parentState,now,jobId,userId,b.usd,outcome,b.plan.planHash,parentState);
    await db.batch([insert,update,release,settle,ownerFinal]);
   }
   const done=await state(userId,jobId),s=done.settlement;if(!s||s.outcome!==outcome||s.funding_kind!==b.quote.fundingKind||s.base_step_id!==b.plan.baseStepId||s.provider_authorized_steps!==authorizedCount||s.provider_dispatched_steps!==dispatchedCount||s.charged_cents!==charged||s.refunded_cents!==refund||s.reserved_cents!==b.retail||s.plan_hash!==b.plan.planHash||s.result_key!==resultKey||done.row.state!==parentState||done.row.result_key!==resultKey)throw Error('Workflow settlement requires reconciliation');
   const ledger=(await db.prepare("SELECT event_id,delta FROM rig_ledger WHERE user_id=? AND event_id IN (?,?,?,?)").bind(userId,`reserve:${jobId}`,`settle:${jobId}`,`release:${jobId}`,`partial-release:${jobId}`).all()).results;
   const expected=b.quote.fundingKind==='owner-provider'?[]:[{event_id:`reserve:${jobId}`,delta:-b.retail},...(charged?[{event_id:`settle:${jobId}`,delta:0}]:[]),...(refund?[{event_id:outcome==='partial'?`partial-release:${jobId}`:`release:${jobId}`,delta:refund}]:[])];
   if(canonical(ledger.sort((a,b)=>a.event_id.localeCompare(b.event_id)))!==canonical(expected.sort((a,b)=>a.event_id.localeCompare(b.event_id))))throw Error('Workflow wallet requires reconciliation');
   if(b.quote.fundingKind==='owner-provider'){const proof=await db.prepare('SELECT state,estimated_usd_micros FROM rig_owner_provider_usage WHERE job_id=? AND user_id=?').bind(jobId,userId).first();if(proof?.state!==parentState||proof.estimated_usd_micros!==b.usd)throw Error('Owner workflow requires reconciliation');}
   return s;
  }
 };
 return api;
}
