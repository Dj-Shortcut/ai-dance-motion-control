import test from 'node:test';
import {createProductionWorkflowStores,workflowPlanHash,workflowInitialSourceHash} from './production-workflow-stores.mjs';
import {handleOwnerFinance} from './owner-finance.mjs';
import {workflowProviderBudgetPredicate} from './workflow-finance.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
const USERS=['u-12345678-1234-4123-8123-123456789abc','u-22345678-1234-4123-8123-123456789abc','u-32345678-1234-4123-8123-123456789abc'];
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
async function fixture({flag='yes',oldSchema=false,daily=1400000}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 const full=await readFile(new URL('./production-schema.sql',import.meta.url),'utf8'),sql=(oldSchema?full.split('-- Generation workflow foundation v2 (inactive until separately integrated).')[0]:full).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(v=>v.trim()).filter(Boolean))await db.prepare(statement).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('guard-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await db.prepare('UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=? WHERE id=1').bind(daily).run();
 for(const user of USERS)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,2000)').bind('paid:'+user,user).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_OWNER_CLEANUP_VALIDATION_ENABLED:flag,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'guard-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:USERS[0]};
 const productionContext=await createProductionGenerationContext(env),stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext});
 await installTestOwnerCredential(db,USERS[0]);
 async function quote(user=USERS[0],{price=175,usd=700000}={}){
  const made=await stores.quotes.create({userId:user,model:'fal-ai/kling-video/o3/standard/video-to-video/edit',input:{data:{quality:'edit-standard'},providerEstimateUsdMicros:usd},priceCents:price,pricingVersion:'approved-prices-v1',durationSeconds:5});
  return stores.quotes.getOwned(user,made.id);
 }
 async function begin(q){const idempotencyKey=crypto.randomUUID(),payload={quoteId:q.id,idempotencyKey},verification=q.fundingKind==='owner-provider'?await verificationFor(db,q.userId,'owner-generation',payload,Date.now(),{env}):undefined;return stores.jobs.begin({userId:q.userId,quoteId:q.id,idempotencyKey,quote:q,verification,verificationPayload:payload});}
 const balance=async(user=USERS[0])=>(await db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(user).first()).amount;
 const costs=async()=>(await db.prepare('SELECT * FROM rig_generation_costs').all()).results;
 async function report(){const response=await handleOwnerFinance(new Request(SITE+'/api/owner/finance'),env,{userId:USERS[0]});assert.equal(response.status,200,await response.clone().text());return response.json();}
 async function newStores(){return createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:await createProductionGenerationContext(env)});}
 async function awaitingWorkflow(user=USERS[0]){
  const model='fal-ai/kling-video/o3/standard/video-to-video/edit',plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:150,cleanupRetailCents:25,steps:[{id:'base',kind:'base',model,queueFamily:'fal-ai/kling-video',contract:'fixture-base-v1',settings:{},dependsOn:null,providerEstimateUsdMicros:500000,retailCents:150},{id:'cleanup',kind:'postcleanup',model:'fixture/cleanup',queueFamily:'fixture/cleanup',contract:'fixture-cleanup-v1',settings:{},dependsOn:'base',providerEstimateUsdMicros:200000,retailCents:25}]};plan.planHash=await workflowPlanHash(plan);
  const made=await stores.quotes.create({userId:user,model,input:{data:{quality:'edit-standard'},refs:[],workflow:plan,providerEstimateUsdMicros:700000},priceCents:175,pricingVersion:'workflow-fixture',durationSeconds:5}),q=await stores.quotes.getOwned(user,made.id),begun=await begin(q);assert.equal(begun.kind,'created');const id=begun.job.id,identity={userId:user,jobId:id},workflow=createProductionWorkflowStores(db,{productionContext,readCurrentProductionContext:()=>createProductionGenerationContext(env)});await workflow.initialize({...identity,quote:q});assert.equal(await stores.jobs.authorizeDispatch(user,id),true);
  const authorization=await workflow.authorizeStep({...identity,stepId:'base',sourceHash:await workflowInitialSourceHash(q),inputHash:'a'.repeat(64),requestHash:'b'.repeat(64)});assert.equal(authorization.authorized,true);await workflow.markSubmitted({...identity,stepId:'base',dispatchToken:authorization.dispatchToken,requestId:'original-base'});const lease=await workflow.claimPoll({...identity,stepId:'base'});await workflow.markCompleted({...identity,stepId:'base',requestId:'original-base',token:lease.token,resultKey:`rig-workflow-results/${id}/base.mp4`,outputHash:'a'.repeat(64),outputMetadata:{durationSeconds:5}});
  await db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(id).run();return {id,identity,workflow,q};
 }
 return {mf,db,env,stores,quote,begin,balance,costs,report,newStores,awaitingWorkflow};
}

test('new workflow tables are never referenced by flag-off legacy dispatch or finance on an old schema',async()=>{
 const f=await fixture({flag:'no',oldSchema:true});try{
  assert.equal(await f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rig_generation_workflows'").first(),null);
  assert.doesNotMatch(workflowProviderBudgetPredicate(),/rig_generation_workflows|rig_generation_workflow_settlements/);
  const q=await f.quote(USERS[1]),begun=await f.begin(q);assert.equal(begun.kind,'created');assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,begun.job.id),true);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
 }finally{await f.mf.dispose();}
});
test('previous-day queued owner workflow competes atomically with concurrent legacy customer dispatches',async()=>{
 const f=await fixture();try{
  const prior=await f.awaitingWorkflow(USERS[0]);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
  const quotes=await Promise.all(USERS.slice(1).map(user=>f.quote(user))),jobs=await Promise.all(quotes.map(q=>f.begin(q)));assert.ok(jobs.every(j=>j.kind==='created'));
  const allowed=await Promise.all(jobs.map((j,i)=>f.stores.jobs.authorizeDispatch(quotes[i].userId,j.job.id)));assert.deepEqual([...allowed].sort(),[false,true]);assert.equal((await f.costs()).length,2);assert.equal((await f.report()).dailyBudget.usedUsdMicros,1400000);
  await prior.workflow.skipStep({...prior.identity,stepId:'cleanup'});await prior.workflow.finalize(prior.identity);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
  const retry=allowed.indexOf(false);assert.equal(await f.stores.jobs.authorizeDispatch(quotes[retry].userId,jobs[retry].job.id),true);assert.equal((await f.report()).dailyBudget.usedUsdMicros,1400000);
 }finally{await f.mf.dispose();}
});
test('previous-day queued customer workflow competes with both owner and customer legacy funding',async()=>{
 const f=await fixture();try{
  await f.awaitingWorkflow(USERS[1]);const quotes=await Promise.all([f.quote(USERS[0]),f.quote(USERS[2])]),jobs=await Promise.all(quotes.map(q=>f.begin(q)));assert.ok(jobs.every(j=>j.kind==='created'));assert.deepEqual(quotes.map(q=>q.fundingKind),['owner-provider','credits']);
  const allowed=await Promise.all(jobs.map((j,i)=>f.stores.jobs.authorizeDispatch(quotes[i].userId,j.job.id)));assert.deepEqual([...allowed].sort(),[false,true]);assert.equal((await f.report()).dailyBudget.usedUsdMicros,1400000);assert.equal((await f.costs()).reduce((sum,c)=>sum+c.provider_estimate_usd_micros,0),1400000);
 }finally{await f.mf.dispose();}
});
test('stopping the feature after midnight cannot free an accepted workflow budget through a table-free legacy context',async()=>{
 const f=await fixture({daily:1000000});try{
  await f.awaitingWorkflow();f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';const stopped=await f.newStores(),q=await f.quote(USERS[1]),job=(await f.begin(q)).job;assert.equal(await stopped.jobs.authorizeDispatch(q.userId,job.id),false);assert.equal((await f.costs()).length,1);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
 }finally{await f.mf.dispose();}
});
test('a queued parent without an official ID is conservatively held even on an unmigrated flag-off database',async()=>{
 const f=await fixture({flag:'no',oldSchema:true,daily:1000000});try{
  const q=await f.quote(),job=(await f.begin(q)).job;assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,job.id),true);await f.db.prepare("UPDATE rig_generation_jobs SET state='queued',poll_token=NULL,poll_lease_until=NULL WHERE id=?").bind(job.id).run();await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(job.id).run();
  const next=await f.quote(USERS[1]),pending=(await f.begin(next)).job;assert.equal(await f.stores.jobs.authorizeDispatch(next.userId,pending.id),false);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
 }finally{await f.mf.dispose();}
});
test('ordinary previous-day queued legacy jobs with official IDs retain their existing authorization-day treatment',async()=>{
 const f=await fixture({flag:'no',oldSchema:true,daily:1000000});try{
  const q=await f.quote(),job=(await f.begin(q)).job;assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,job.id),true);await f.stores.jobs.markSubmitted(q.userId,job.id,'official-old-job');await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(job.id).run();assert.equal((await f.report()).dailyBudget.usedUsdMicros,0);
  const next=await f.quote(USERS[1]),pending=(await f.begin(next)).job;assert.equal(await f.stores.jobs.authorizeDispatch(next.userId,pending.id),true);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
 }finally{await f.mf.dispose();}
});
test('explicit unfinished-workflow proof remains held if a parent drifts terminal before its settlement',async()=>{
 const f=await fixture({daily:1000000});try{
  const prior=await f.awaitingWorkflow();await f.db.prepare("UPDATE rig_generation_jobs SET state='completed' WHERE id=?").bind(prior.id).run();const q=await f.quote(USERS[1]),job=(await f.begin(q)).job;assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,job.id),false);assert.equal((await f.report()).dailyBudget.usedUsdMicros,700000);
 }finally{await f.mf.dispose();}
});
