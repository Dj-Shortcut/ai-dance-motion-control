// Real local D1; synthetic billing/credentials only. Never contacts Fal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
import {prepareFundingAdmission,prepareOwnerFundingAdmission,readFundingCoverage} from './funding-coverage.mjs';
import {createProductionWorkflowStores,workflowPlanHash,workflowInitialSourceHash} from './production-workflow-stores.mjs';
const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
async function fixture({migration=true,enabled=true,balance=9,customerCents=500,response,oldSchema=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'}}),raw=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 let hold=null,lose=false;const db={prepare:sql=>raw.prepare(sql),async batch(statements){if(hold){const pending=hold;hold=null;pending.enter();await pending.gate;}const result=await raw.batch(statements);if(lose){lose=false;throw Error('Lost committed database receipt')}return result;}};
 const source=await readFile(new URL('./production-schema.sql',import.meta.url),'utf8'),schema=(oldSchema?source.split('-- Generation workflow foundation v2 (inactive until separately integrated).')[0]:source).replace(/^\s*--.*$/gm,'');for(const s of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
 if(migration){const text=(await readFile(new URL('./production-migrations/0015_funding_coverage.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,''),[tables,...triggers]=text.split('CREATE TRIGGER');for(const s of tables.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();for(const trigger of triggers)await db.prepare('CREATE TRIGGER'+trigger).run();}
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('owner-funding-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 if(customerCents)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-paid-credit',CUSTOMER,customerCents).run();
 if(migration&&enabled)await db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'owner-funding-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER,FAL_KEY:'same-runtime-owner-fixture-key',...(enabled?{RIG_FUNDING_COVERAGE_ENABLED:'yes'}:{})};
 let calls=0,deny=false;const network=async(url,init)=>{calls++;assert.equal(url,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),'Key '+env.FAL_KEY);if(deny)throw Error('Forbidden after earlier authorization');return response?response():Response.json({username:'fixture-team',credits:{current_balance:balance,currency:'USD'}})};
 const context=await createProductionGenerationContext(env);await installTestOwnerCredential(db,OWNER);const stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:context,fundingNetwork:network});
 async function quote(usd=700000,input={}){const made=await stores.quotes.create({userId:OWNER,model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:100,pricingVersion:'fixture-v1',durationSeconds:5,input:{data:{quality:'pro'},providerEstimateUsdMicros:usd,...input}});return stores.quotes.getOwned(OWNER,made.id);}
 const proof=(q,key)=>verificationFor(db,OWNER,'owner-generation',{quoteId:q.id,idempotencyKey:key},Date.now(),{env});
 async function begin(q,key=crypto.randomUUID(),verification){const payload={quoteId:q.id,idempotencyKey:key};return stores.jobs.begin({userId:OWNER,quoteId:q.id,idempotencyKey:key,quote:q,verification:verification??await proof(q,key),verificationPayload:payload});}
 const count=table=>db.prepare('SELECT COUNT(*) n FROM '+table).first().then(x=>x.n);
 return {mf,db,raw,env,context,network,stores,quote,proof,begin,count,calls:()=>calls,deny(){deny=true},loseNext(){lose=true},pauseNext(){let enter,release;const ready=new Promise(r=>enter=r),gate=new Promise(r=>release=r);hold={enter,gate};return {ready,release}}};
}
test('an owner cannot consume provider stock backing paid customer credit; refusal creates no job, usage or customer credit',async()=>{
 const f=await fixture({customerCents:2500,balance:20});try{
  await assert.rejects(f.begin(await f.quote(3000000)),error=>error.code==='funding_capacity');assert.equal(await f.count('rig_generation_jobs'),0);assert.equal(await f.count('rig_owner_provider_usage'),0);assert.equal(await f.count('rig_ledger'),1);assert.equal(f.calls(),1);
  const accepted=await f.begin(await f.quote(2000000));assert.equal(accepted.kind,'created');assert.equal((await f.db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(CUSTOMER).first()).amount,2500);
 }finally{await f.mf.dispose()}
});
test('owner submissions share one finite reserve and completed recent provider cost does not become free stock again',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),key=crypto.randomUUID(),started=await f.begin(q,key);assert.equal(started.kind,'created');assert.equal((await f.begin(q,key)).kind,'existing');assert.equal(await f.count('rig_owner_provider_usage'),1);assert.equal(f.calls(),1);
  const id=started.job.id;assert.equal(await f.stores.jobs.authorizeDispatch(OWNER,id),true);await f.stores.jobs.markSubmitted(OWNER,id,'existing-provider');const claim=await f.stores.jobs.claimPoll(OWNER,id);await f.stores.jobs.markCompleted(OWNER,id,'existing-provider',`rig-results/${id}.mp4`,claim.token);
  const status=await readFundingCoverage(f.env,{network:f.network});assert.equal(status.providerReservedUsdMicros,700000);
  await assert.rejects(f.begin(await f.quote()),error=>error.code==='funding_capacity');assert.equal(await f.count('rig_generation_jobs'),1);assert.equal(await f.count('rig_owner_provider_usage'),1);assert.equal(await f.count('rig_ledger'),1);
 }finally{await f.mf.dispose()}
});
test('actual owner begin and workflow stages retain the full confirmed plan through client preparation and late financial completion',async()=>{
 const f=await fixture({balance:100});try{
  const hash=n=>n.repeat(64),model='fal-ai/kling-video/v3/pro/motion-control',plan={version:'rig-workflow-v2',planHash:'',baseStepId:'base',baseRetailCents:100,cleanupRetailCents:0,
   steps:[{id:'clean',kind:'preclean',model:'fixture/cleanup',queueFamily:'fixture/cleanup',contract:'fixture-cleanup',settings:{},dependsOn:null,providerEstimateUsdMicros:200000,retailCents:0},{id:'base',kind:'base',model,queueFamily:'fal-ai/kling-video',contract:'fixture-base',settings:{},dependsOn:'clean',providerEstimateUsdMicros:500000,retailCents:100}],
   clientProcessing:{id:'compose',contract:'rig-client-mask-compose-v1',beforeStepId:'base',cleanFromStepId:'clean',source:{id:'source',sha256:hash('a')},mask:{id:'mask',sha256:hash('b')},media:{width:360,height:640,frameCount:120,fpsNumerator:24,fpsDenominator:1,timelineSha256:hash('c'),hasAudio:false,audio:null}}};
  plan.planHash=await workflowPlanHash(plan);
  const q=await f.quote(700000,{workflow:plan,refs:[{id:'source',sha256:hash('a')},{id:'mask',sha256:hash('b')}]}),job=(await f.begin(q)).job,identity={userId:OWNER,jobId:job.id};
  const workflow=createProductionWorkflowStores(f.db,{productionContext:f.context,readCurrentProductionContext:()=>createProductionGenerationContext(f.env)});
  const held=async label=>assert.equal((await readFundingCoverage(f.env,{network:f.network})).providerReservedUsdMicros,700000,label);
  await held('begin reserves every future step before any cost journal exists');
  await workflow.initialize({...identity,quote:q});assert.equal(await f.stores.jobs.authorizeDispatch(OWNER,job.id),true);
  await f.db.prepare('UPDATE rig_generation_costs SET authorized_at=? WHERE job_id=?').bind(Date.now()-120*60000,job.id).run();
  await held('both prepared steps retain the entire aged parent authorization');
  const clean=await workflow.authorizeStep({...identity,stepId:'clean',sourceHash:await workflowInitialSourceHash(q),inputHash:hash('d'),requestHash:hash('e')});assert.equal(clean.authorized,true);await held('preclean authorized');
  await workflow.markSubmitted({...identity,stepId:'clean',dispatchToken:clean.dispatchToken,requestId:'fixture-clean'});await held('preclean queued');
  const lease=await workflow.claimPoll({...identity,stepId:'clean'});await workflow.markCompleted({...identity,stepId:'clean',requestId:'fixture-clean',token:lease.token,resultKey:`rig-workflow-results/${job.id}/clean.mp4`,outputHash:hash('d'),outputMetadata:{durationSeconds:5}});await held('preclean completed while the primary provider step is still prepared');
  // These are local, schema-valid stage fixtures. Actual media validation is
  // covered by workflow-client tests; no upload or provider dispatch occurs.
  await f.db.prepare("INSERT INTO rig_generation_workflow_client_processing(job_id,stage_id,user_id,plan_hash,contract,before_step_id,clean_step_id,clean_sha256,inputs_json,state,created_at) VALUES(?,'compose',?,?,'rig-client-mask-compose-v1','base','clean',?,'{}','awaiting_client_processing',?)").bind(job.id,OWNER,plan.planHash,hash('d'),Date.now()).run();
  await held('awaiting client processing does not release future provider spend');
  assert.equal((await workflow.authorizeStep({...identity,stepId:'base',sourceHash:hash('d'),inputHash:hash('e'),requestHash:hash('f')})).state,'awaiting_client_processing');
  await f.db.prepare("UPDATE rig_generation_workflow_client_processing SET state='ready_to_advance',output_key='fixture-output',output_sha256=?,output_size=100,output_metadata_json='{}',uploaded_at=? WHERE job_id=?").bind(hash('e'),Date.now(),job.id).run();await held('client output ready still reserves the whole plan');
  await f.db.prepare("UPDATE rig_generation_workflow_client_processing SET state='advanced',advance_key='fixture-explicit-advance',advanced_at=? WHERE job_id=?").bind(Date.now(),job.id).run();
  const base=await workflow.authorizeStep({...identity,stepId:'base',sourceHash:hash('d'),inputHash:hash('e'),requestHash:hash('f')});assert.equal(base.authorized,true);await held('base authorized');
  await workflow.markSubmitted({...identity,stepId:'base',dispatchToken:base.dispatchToken,requestId:'fixture-base'});await held('base queued');
  const baseLease=await workflow.claimPoll({...identity,stepId:'base'});await workflow.markCompleted({...identity,stepId:'base',requestId:'fixture-base',token:baseLease.token,resultKey:`rig-workflow-results/${job.id}/base.mp4`,outputHash:hash('f'),outputMetadata:{durationSeconds:5}});await held('all steps completed before financial settlement');
  await workflow.finalize(identity);await held('a late parent and owner financial completion starts a new conservative window');
  await f.db.prepare('UPDATE rig_generation_jobs SET finalized_at=? WHERE id=?').bind(Date.now()-120*60000,job.id).run();await held('a recent owner financial finalization is independently retained');
  await f.db.prepare('UPDATE rig_owner_provider_usage SET finalized_at=? WHERE job_id=?').bind(Date.now()-120*60000,job.id).run();assert.equal((await readFundingCoverage(f.env,{network:f.network})).providerReservedUsdMicros,0);
  assert.equal(await f.count('rig_generation_costs'),1);assert.equal(await f.count('rig_ledger'),1,'customer credits are never spent by this owner workflow');
 }finally{await f.mf.dispose()}
});
test('owner-versus-checkout race is serialized against the same stock and cannot admit both',async()=>{
 const f=await fixture({customerCents:0,balance:8.5});let pause;try{
  const q=await f.quote(),key=crypto.randomUUID(),verification=await f.proof(q,key);pause=f.pauseNext();const owner=f.begin(q,key,verification);await pause.ready;
  const a={userId:CUSTOMER,orderId:crypto.randomUUID(),requestId:crypto.randomUUID(),pkg:{id:'five',amountCents:500,credits:500},network:f.network};const admission=await prepareFundingAdmission(f.context.env,a);
  const purchase=await f.db.batch([...admission.before,f.db.prepare(`INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits) SELECT ?,?,?,?,?,? WHERE ${admission.gate.sql}`).bind(a.orderId,a.userId,a.requestId,a.pkg.id,a.pkg.amountCents,a.pkg.credits,...admission.gate.params)]);assert.equal(purchase.at(-1).meta.changes,1);pause.release();const outcome=await owner;assert.equal(outcome.kind,'insufficient');assert.equal(await f.count('rig_owner_provider_usage'),0);assert.equal(await f.count('rig_generation_jobs'),0);assert.equal(await f.count('rig_orders'),1);
 }finally{pause?.release();await f.mf.dispose()}
});
test('enabled owner protection requires billing permission and the account pin, while absent/disabled coverage preserves only legacy owner use',async()=>{
 for(const response of [()=>Response.json({error:'no permission'},{status:403}),()=>Response.json({username:'wrong-account',credits:{current_balance:100,currency:'USD'}})]){
  const f=await fixture({response});try{await assert.rejects(f.begin(await f.quote()),error=>error.code==='funding_unavailable');assert.equal(await f.count('rig_generation_jobs'),0);assert.equal(await f.count('rig_owner_provider_usage'),0);}finally{await f.mf.dispose()}
 }
 for(const options of [{migration:false,enabled:false},{enabled:false},{enabled:false,oldSchema:true}]){const f=await fixture(options);try{assert.equal((await f.begin(await f.quote())).kind,'created');assert.equal(f.calls(),0);assert.equal(await f.count('rig_ledger'),1);}finally{await f.mf.dispose()}}
});
test('owner trigger rejects a legacy unbound usage insertion and a substituted quote/user/USD or changed finance policy',async()=>{
 const f=await fixture({balance:100});try{
  const q=await f.quote(),jobId=crypto.randomUUID(),a={userId:OWNER,jobId,quoteId:q.id,providerEstimateUsdMicros:700000,network:f.network};
  const usage=(data,gate={sql:'1',params:[]})=>f.db.prepare(`INSERT INTO rig_owner_provider_usage(job_id,quote_id,user_id,estimated_usd_micros,state,created_at) SELECT ?,?,?,?,'authorized',? WHERE ${gate.sql}`).bind(data.jobId,data.quoteId,data.userId,data.providerEstimateUsdMicros,Date.now(),...gate.params);
  await assert.rejects(usage(a).run(),/RIG_OWNER_FUNDING_REQUIRED/);
  for(const substitute of [{userId:CUSTOMER},{jobId:crypto.randomUUID()},{quoteId:crypto.randomUUID()},{providerEstimateUsdMicros:1}]){const admission=await prepareOwnerFundingAdmission(f.context.env,a);await assert.rejects(f.db.batch([...admission.before,usage({...a,...substitute},admission.gate)]),/RIG_OWNER_FUNDING_REQUIRED/);}
  const admission=await prepareOwnerFundingAdmission(f.context.env,a);await f.db.prepare('UPDATE rig_finance_policy SET eur_per_usd_micros=1100000 WHERE id=1').run();assert.equal((await f.db.batch([...admission.before,usage(a,admission.gate)])).at(-1).meta.changes,0);assert.equal(await f.count('rig_owner_provider_usage'),0);
 }finally{await f.mf.dispose()}
});
test('a lost committed owner-begin response replays its exact existing job without another balance read or second reserve',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),key=crypto.randomUUID(),verification=await f.proof(q,key);f.loseNext();await assert.rejects(f.begin(q,key,verification),/Lost committed database receipt/);f.deny();const result=await f.begin(q,key,verification);assert.equal(result.kind,'existing');assert.equal(result.job.state,'submitting');assert.equal(await f.count('rig_owner_provider_usage'),1);assert.equal(await f.count('rig_generation_jobs'),1);assert.equal(f.calls(),1);assert.equal(await f.count('rig_ledger'),1);
 }finally{await f.mf.dispose()}
});
