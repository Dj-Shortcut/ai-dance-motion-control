import test from 'node:test';
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
async function fixture({owner=false,preclean=false,postcleanup=true,schemaUpgrade=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 const schema=await readFile(new URL('./production-schema.sql',import.meta.url),'utf8'),migration=await readFile(new URL('./production-migrations/0014_generation_workflows.sql',import.meta.url),'utf8');
 const marker='-- Generation workflow foundation v2 (inactive until separately integrated).';
 assert.equal(schema.split(marker)[1].trim(),migration.trim());
 async function apply(sql){for(const statement of sql.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
 if(schemaUpgrade){await apply(schema.split(marker)[0]);await db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('preexisting-income',?,123)").bind(OTHER).run();await apply(migration);}else await apply(schema);
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
 const plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:300+(preclean?75:0),cleanupRetailCents:postcleanup?100:0,steps:[...(preclean?[pre]:[]),base,...(postcleanup?[post]:[])]};plan.planHash=await workflowPlanHash(plan);
 const usd=plan.steps.reduce((n,s)=>n+s.providerEstimateUsdMicros,0),totalRetail=plan.baseRetailCents+plan.cleanupRetailCents;
 const made=await parents.quotes.create({userId:USER,model:'fixture/base',input:{data:{quality:'pro',prompt:'fixture'},refs:[{id:'image',sha256:HASH}],workflow:plan,providerEstimateUsdMicros:usd},priceCents:totalRetail,pricingVersion:'fixture-v1',durationSeconds:6});
 const quote=await parents.quotes.getOwned(USER,made.id),key=crypto.randomUUID(),payload={quoteId:quote.id,idempotencyKey:key},verification=owner?await verificationFor(db,USER,'owner-generation',payload,Date.now(),{env}):undefined;
 const begun=await parents.jobs.begin({userId:USER,quoteId:quote.id,idempotencyKey:key,quote,verification,verificationPayload:payload});assert.equal(begun.kind,'created');
 const job=begun.job,identity={userId:USER,jobId:job.id},args=(stepId,more={})=>({...identity,stepId,...more});
 const init=()=>workflow.initialize({...identity,quote});
 const authorize=async(stepId='base')=>workflow.authorizeStep(args(stepId,{sourceHash:plan.steps.find(s=>s.id===stepId).dependsOn===null?await workflowInitialSourceHash(quote):HASH,inputHash:HASH,requestHash:'b'.repeat(64)}));
 const balance=async()=>(await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n;
 async function complete(stepId='base',{failed=false}={}){const auth=await authorize(stepId);assert.equal(auth.authorized,true);const requestId='request-'+stepId;await workflow.markSubmitted(args(stepId,{dispatchToken:auth.dispatchToken,requestId}));const poll=await workflow.claimPoll(args(stepId));assert.equal(poll.kind,'acquired');if(failed)await workflow.markFailed(args(stepId,{requestId,token:poll.token}));else await workflow.markCompleted(args(stepId,{requestId,token:poll.token,resultKey:`rig-workflow-results/${job.id}/${stepId}.mp4`,outputHash:HASH,outputMetadata:{durationSeconds:6,resolution:'1080P',hasAudio:true}}));}
 return {mf,db,env,context,parents,workflow,plan,quote,job,identity,args,init,authorize,balance,complete,usd,totalRetail};
}
test('workflow requires a genuine production capability and an exact immutable bounded plan',async()=>{
 assert.throws(()=>createProductionWorkflowStores({},{productionContext:{mode:'live'}}));
 const f=await fixture();try{
  assert.equal(await f.balance(),1600);assert.equal((await f.init()).steps.length,2);assert.equal((await f.init()).steps.length,2);
  for(const change of [p=>p.steps.push(...Array(7).fill(p.steps[1])),p=>p.cleanupRetailCents=101,p=>p.steps[1].settings.resolution='750P',p=>p.steps[1].dependsOn='missing',p=>p.steps[1].retailCents=-1]){const p=structuredClone(f.plan);change(p);await assert.rejects(validateWorkflowPlan(p,f.quote));}
  await assert.rejects(f.workflow.get({userId:OTHER,jobId:f.job.id}));
  await f.db.prepare("UPDATE rig_generation_workflow_steps SET step_json='{}' WHERE job_id=? AND step_id='cleanup'").bind(f.job.id).run();await assert.rejects(f.authorize());
 }finally{await f.mf.dispose();}
});
test('additive migration0014 matches fresh schema and preserves pre-existing financial rows',async()=>{
 const f=await fixture({schemaUpgrade:true});try{
  assert.equal((await f.db.prepare("SELECT delta FROM rig_ledger WHERE event_id='preexisting-income'").first()).delta,123);
  for(const name of ['rig_generation_workflows','rig_generation_workflow_steps','rig_generation_workflow_settlements','rig_generation_workflow_client_processing'])assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM '+name).first()).n,0);
  await f.init();assert.equal(await f.balance(),1600);assert.equal((await f.workflow.get(f.identity)).steps.length,2);
 }finally{await f.mf.dispose();}
});
test('generic workflow planning accepts eight linear steps but rejects a branch or an unbound price',async()=>{
 const f=await fixture();try{
  const p=structuredClone(f.plan);for(let i=2;i<8;i++)p.steps.push({...structuredClone(p.steps[1]),id:'cleanup-'+i,dependsOn:p.steps.at(-1).id,providerEstimateUsdMicros:10000,retailCents:0});p.planHash=await workflowPlanHash(p);assert.equal((await validateWorkflowPlan(p)).plan.steps.length,8);
  const branch=structuredClone(p);branch.steps[2].dependsOn='base';branch.planHash=await workflowPlanHash(branch);await assert.rejects(validateWorkflowPlan(branch));
  await assert.rejects(validateWorkflowPlan(p,f.quote));
 }finally{await f.mf.dispose();}
});
test('one parent budget authorizes each step once and no lost dispatch can be blindly retried',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal((await f.authorize()).authorized,false);assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);
  const results=await Promise.all([f.authorize(),f.authorize()]);assert.equal(results.filter(r=>r.authorized).length,1);const auth=results.find(r=>r.authorized);
  const recovered=await f.workflow.recoverAuthorized(f.identity);assert.equal(recovered.steps[0].state,'unknown');assert.equal(recovered.row.state,'unknown');assert.equal((await f.authorize()).authorized,false);await assert.rejects(f.workflow.finalize(f.identity));
  assert.equal(await f.balance(),1600);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
  // A late authenticated response from the original attempt may be adopted,
  // with the same one-time token; no replacement request is created.
  await f.workflow.markSubmitted(f.args('base',{dispatchToken:auth.dispatchToken,requestId:'late-original-request'}));assert.equal((await f.workflow.get(f.identity)).row.state,'queued');
  assert.equal((await f.authorize()).authorized,false);await assert.rejects(f.workflow.markSubmitted(f.args('base',{dispatchToken:auth.dispatchToken,requestId:'different-request'})));
 }finally{await f.mf.dispose();}
});
test('completed workflow settles its original total once and cleanup binds the owned base output',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);assert.equal((await f.authorize('cleanup')).state,'dependency');await f.complete();
  await assert.rejects(f.workflow.authorizeStep(f.args('cleanup',{sourceHash:'c'.repeat(64),inputHash:HASH,requestHash:HASH})).then(r=>{if(!r.authorized)throw Error('Rejected');}));
  await f.complete('cleanup');const done=await f.workflow.finalize(f.identity);assert.equal(done.outcome,'completed');assert.equal(done.charged_cents,400);assert.equal(done.refunded_cents,0);assert.equal(await f.balance(),1600);assert.deepEqual(await f.workflow.finalize(f.identity),done);
  assert.equal(workflowNetRetailCents({priceCents:400,state:'completed',fundingKind:'credits',settlement:done}),400);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('only the winning poll lease can complete a provider step and contradictory artifacts fail closed',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);const auth=await f.authorize();await f.workflow.markSubmitted(f.args('base',{dispatchToken:auth.dispatchToken,requestId:'poll-request'}));
  const polls=await Promise.all([f.workflow.claimPoll(f.args('base')),f.workflow.claimPoll(f.args('base'))]);assert.equal(polls.filter(p=>p.kind==='acquired').length,1);const token=polls.find(p=>p.kind==='acquired').token;
  const output=f.args('base',{requestId:'poll-request',token,resultKey:`rig-workflow-results/${f.job.id}/base.mp4`,outputHash:HASH,outputMetadata:{resolution:'1080P'}});
  await assert.rejects(f.workflow.markCompleted({...output,token:'wrong-lease'}));await assert.rejects(f.workflow.markCompleted({...output,resultKey:`rig-workflow-results/${crypto.randomUUID()}/base.mp4`}));await f.workflow.markCompleted(output);await f.workflow.markCompleted(output);await assert.rejects(f.workflow.markCompleted({...output,outputHash:'c'.repeat(64)}));assert.equal(await f.balance(),1600);
 }finally{await f.mf.dispose();}
});
test('cleanup failure preserves the base and returns only the quoted addon exactly once',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete();await f.complete('cleanup',{failed:true});
  const results=await Promise.all([f.workflow.finalize(f.identity),f.workflow.finalize(f.identity)]);assert.ok(results.every(r=>r.outcome==='partial'));assert.equal(await f.balance(),1700);
  const state=await f.workflow.get(f.identity);assert.equal(state.row.state,'completed');assert.equal(state.settlement.charged_cents,300);assert.equal(state.settlement.refunded_cents,100);assert.equal(state.row.result_key,`rig-workflow-results/${f.job.id}/base.mp4`);
  assert.equal(workflowNetRetailCents({priceCents:400,state:'completed',fundingKind:'credits',settlement:state.settlement}),300);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?").bind('partial-release:'+f.job.id).first()).n,1);
  await assert.rejects(f.parents.jobs.markPreparationFailed(USER,f.job.id));assert.equal(await f.balance(),1700);
 }finally{await f.mf.dispose();}
});
test('an uncertain cleanup retains the base and the full hold without a retry or a premature partial refund',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete();const auth=await f.authorize('cleanup');assert.equal(auth.authorized,true);await f.workflow.markUnknown(f.args('cleanup',{dispatchToken:auth.dispatchToken}));
  const state=await f.workflow.get(f.identity);assert.equal(state.row.state,'unknown');assert.equal(state.steps[0].state,'completed');assert.equal(state.steps[0].result_key,`rig-workflow-results/${f.job.id}/base.mp4`);assert.equal((await f.authorize('cleanup')).authorized,false);await assert.rejects(f.workflow.finalize(f.identity));await assert.rejects(f.workflow.skipStep(f.args('cleanup')));assert.equal(await f.balance(),1600);assert.equal(state.settlement,null);
 }finally{await f.mf.dispose();}
});
test('base failure cancels unstarted cleanup and fully refunds without reopening the provider budget',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('base',{failed:true});await f.workflow.skipStep(f.args('cleanup',{reason:'dependency_failed'}));
  const done=await f.workflow.finalize(f.identity);assert.equal(done.outcome,'failed');assert.equal(done.charged_cents,0);assert.equal(done.refunded_cents,400);assert.equal(await f.balance(),2000);assert.equal(done.result_key,null);await f.workflow.finalize(f.identity);assert.equal(await f.balance(),2000);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('a definitively unstarted workflow returns the full customer hold without inventing provider cost',async()=>{
 const f=await fixture();try{await f.init();await f.workflow.skipStep(f.args('base'));await f.workflow.skipStep(f.args('cleanup',{reason:'dependency_failed'}));const s=await f.workflow.finalize(f.identity);assert.equal(s.outcome,'failed');assert.equal(await f.balance(),2000);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,0);assert.equal(workflowNetRetailCents({priceCents:400,state:'failed',fundingKind:'credits',settlement:s}),0);assert.throws(()=>workflowNetRetailCents({priceCents:400,state:'failed',fundingKind:'credits',settlement:{...s,refunded_cents:399}}));}finally{await f.mf.dispose();}
});
test('a freeze or exhausted next-day budget blocks new cleanup without losing the completed base',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete();
  await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(USER).run();assert.equal((await f.authorize('cleanup')).authorized,false);await f.db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').bind(USER).run();
  await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(f.job.id).run();await f.db.prepare('UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=700000 WHERE id=1').run();assert.equal((await f.authorize('cleanup')).authorized,false);
  await f.workflow.skipStep(f.args('cleanup'));const partial=await f.workflow.finalize(f.identity);assert.equal(partial.outcome,'partial');assert.equal(await f.balance(),1700);
 }finally{await f.mf.dispose();}
});
test('owner partial completion never invents RIG credits or a Fal refund',async()=>{
 const f=await fixture({owner:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete();await f.complete('cleanup',{failed:true});const done=await f.workflow.finalize(f.identity);assert.equal(done.outcome,'partial');assert.equal(done.funding_kind,'owner-provider');assert.equal(await f.balance(),2000);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE ?').bind('%'+f.job.id).first()).n,0);const usage=await f.db.prepare('SELECT * FROM rig_owner_provider_usage WHERE job_id=?').bind(f.job.id).first();assert.equal(usage.state,'completed');assert.equal(usage.estimated_usd_micros,800000);assert.equal(workflowNetRetailCents({priceCents:400,state:'completed',fundingKind:'owner-provider',settlement:done}),0);
 }finally{await f.mf.dispose();}
});
test('a changed owner pin denies new owner spending but does not strand finalization of accepted work',async()=>{
 const f=await fixture({owner:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete();
  const newEnv={...f.env,RIG_PRODUCTION_OWNER_USER_ID:OTHER},context=await createProductionGenerationContext(newEnv),recovery=createProductionWorkflowStores(f.db,{productionContext:context,readCurrentProductionContext:()=>createProductionGenerationContext(newEnv)});
  assert.equal((await recovery.authorizeStep(f.args('cleanup',{sourceHash:HASH,inputHash:HASH,requestHash:HASH}))).authorized,false);
  await recovery.skipStep(f.args('cleanup'));const done=await recovery.finalize(f.identity);assert.equal(done.outcome,'partial');assert.equal(done.funding_kind,'owner-provider');assert.equal(await f.balance(),2000);
 }finally{await f.mf.dispose();}
});
test('v2 binds exactly one primary base and permits source cleanup before it with no postcleanup',async()=>{
 const f=await fixture({preclean:true,postcleanup:false});try{
  const checked=await validateWorkflowPlan(f.plan,f.quote);assert.equal(checked.baseIndex,1);assert.equal(checked.plan.baseStepId,'base');assert.equal(checked.plan.cleanupRetailCents,0);
  for(const change of [p=>p.baseStepId='missing',p=>p.baseStepId='preclean',p=>p.steps[0].kind='base',p=>p.steps[0].kind='postcleanup',p=>p.steps[1].kind='preclean',p=>p.version='rig-workflow-v1']){const p=structuredClone(f.plan);change(p);p.planHash=await workflowPlanHash(p);await assert.rejects(validateWorkflowPlan(p));}
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);assert.equal((await f.authorize('base')).state,'dependency');await f.complete('preclean');await f.complete('base');const done=await f.workflow.finalize(f.identity);
  assert.equal(done.outcome,'completed');assert.equal(done.base_step_id,'base');assert.equal(done.charged_cents,375);assert.equal(done.refunded_cents,0);assert.equal(done.provider_authorized_steps,2);assert.equal(done.provider_dispatched_steps,2);assert.equal(done.result_key,`rig-workflow-results/${f.job.id}/base.mp4`);assert.equal(await f.balance(),1625);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose();}
});
test('a definitive paid preclean failure refunds all retail while its authorization remains a provider cost',async()=>{
 const f=await fixture({preclean:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('preclean',{failed:true});await f.workflow.skipStep(f.args('base',{reason:'dependency_failed'}));await f.workflow.skipStep(f.args('cleanup',{reason:'dependency_failed'}));const done=await f.workflow.finalize(f.identity);await f.workflow.finalize(f.identity);
  assert.equal(done.outcome,'failed');assert.equal(done.charged_cents,0);assert.equal(done.refunded_cents,475);assert.equal(done.provider_dispatched_steps,1);assert.equal(await f.balance(),2000);assert.equal((await f.workflow.get(f.identity)).row.failure_code,'workflow_before_base_failed');
  const cost=await f.db.prepare('SELECT * FROM rig_generation_costs WHERE job_id=?').bind(f.job.id).first();assert.equal(cost.provider_estimate_usd_micros,1100000);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id=?").bind('partial-release:'+f.job.id).first()).n,0);
 }finally{await f.mf.dispose();}
});
test('base failure after successful paid source cleanup still refunds all retail and preserves both attempt identities',async()=>{
 const f=await fixture({preclean:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('preclean');await f.complete('base',{failed:true});await f.workflow.skipStep(f.args('cleanup',{reason:'dependency_failed'}));const done=await f.workflow.finalize(f.identity),state=await f.workflow.get(f.identity);
  assert.equal(done.outcome,'failed');assert.equal(done.refunded_cents,475);assert.equal(done.charged_cents,0);assert.equal(done.provider_authorized_steps,2);assert.equal(done.provider_dispatched_steps,2);assert.equal(state.row.failure_code,'workflow_base_failed');assert.equal(state.steps[0].fal_request_id,'request-preclean');assert.equal(state.steps[1].fal_request_id,'request-base');assert.equal(await f.balance(),2000);assert.equal((await f.db.prepare('SELECT provider_estimate_usd_micros n FROM rig_generation_costs WHERE job_id=?').bind(f.job.id).first()).n,1100000);
 }finally{await f.mf.dispose();}
});
test('only a failure after the bound base can return the postcleanup addon rather than required preclean retail',async()=>{
 const f=await fixture({preclean:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('preclean');await f.complete('base');await f.complete('cleanup',{failed:true});const done=await f.workflow.finalize(f.identity);
  assert.equal(done.outcome,'partial');assert.equal(done.charged_cents,375);assert.equal(done.refunded_cents,100);assert.equal(done.provider_dispatched_steps,3);assert.equal(done.result_key,`rig-workflow-results/${f.job.id}/base.mp4`);assert.equal(await f.balance(),1625);assert.equal((await f.workflow.get(f.identity)).row.failure_code,'workflow_postcleanup_failed');assert.equal(workflowNetRetailCents({priceCents:475,state:'completed',fundingKind:'credits',settlement:done}),375);
 }finally{await f.mf.dispose();}
});
test('uncertain paid source cleanup cannot start the base, be skipped or cause an automatic full refund',async()=>{
 const f=await fixture({preclean:true});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);const auth=await f.authorize('preclean');assert.equal(auth.authorized,true);await f.workflow.markUnknown(f.args('preclean',{dispatchToken:auth.dispatchToken}));assert.equal((await f.authorize('base')).state,'dependency');assert.equal((await f.authorize('preclean')).authorized,false);await assert.rejects(f.workflow.skipStep(f.args('preclean')));await assert.rejects(f.workflow.finalize(f.identity));assert.equal(await f.balance(),1525);assert.equal((await f.workflow.get(f.identity)).settlement,null);
 }finally{await f.mf.dispose();}
});
test('each new paid step re-reads the current owner pin even when the workflow factory survives across steps',async()=>{
 const f=await fixture({owner:true,preclean:true,postcleanup:false});try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);await f.complete('preclean');f.env.RIG_PRODUCTION_OWNER_USER_ID=OTHER;assert.equal((await f.authorize('base')).authorized,false);await f.workflow.skipStep(f.args('base'));const done=await f.workflow.finalize(f.identity);assert.equal(done.outcome,'failed');assert.equal(done.provider_dispatched_steps,1);assert.equal(done.refunded_cents,375);assert.equal(await f.balance(),2000);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE ?').bind('%'+f.job.id).first()).n,0);
 }finally{await f.mf.dispose();}
});
test('missing or forged fresh production policy cannot authorize a new paid step',async()=>{
 const f=await fixture();try{
  await f.init();assert.equal(await f.parents.jobs.authorizeDispatch(USER,f.job.id),true);const args=f.args('base',{sourceHash:await workflowInitialSourceHash(f.quote),inputHash:HASH,requestHash:HASH});
  for(const options of [{},{readCurrentProductionContext:async()=>({mode:'live',env:f.context.env})}]){const stores=createProductionWorkflowStores(f.db,{productionContext:f.context,...options});await assert.rejects(stores.authorizeStep(args));}
  assert.equal((await f.workflow.get(f.identity)).steps[0].state,'prepared');assert.equal(await f.balance(),1600);
 }finally{await f.mf.dispose();}
});
