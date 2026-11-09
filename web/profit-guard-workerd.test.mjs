import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
const USERS=['u-12345678-1234-4123-8123-123456789abc','u-22345678-1234-4123-8123-123456789abc','u-32345678-1234-4123-8123-123456789abc'];
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
async function fixture({owner=false,daily=1000000}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(v=>v.trim()).filter(Boolean))await db.prepare(statement).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('guard-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await db.prepare('UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=? WHERE id=1').bind(daily).run();
 for(const user of USERS)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,2000)').bind('paid:'+user,user).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'guard-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:USERS[0]}:{})};
 const productionContext=await createProductionGenerationContext(env),stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext});
 if(owner)await installTestOwnerCredential(db,USERS[0]);
 async function quote(user=USERS[0],{price=175,usd=700000}={}){
  const made=await stores.quotes.create({userId:user,model:'fal-ai/kling-video/o3/standard/video-to-video/edit',input:{data:{quality:'edit-standard'},providerEstimateUsdMicros:usd},priceCents:price,pricingVersion:'approved-prices-v1',durationSeconds:5});
  return stores.quotes.getOwned(user,made.id);
 }
 async function begin(q){const idempotencyKey=crypto.randomUUID(),payload={quoteId:q.id,idempotencyKey},verification=q.fundingKind==='owner-provider'?await verificationFor(db,q.userId,'owner-generation',payload,Date.now(),{env}):undefined;return stores.jobs.begin({userId:q.userId,quoteId:q.id,idempotencyKey,quote:q,verification,verificationPayload:payload});}
 const balance=async(user=USERS[0])=>(await db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(user).first()).amount;
 const costs=async()=>(await db.prepare('SELECT * FROM rig_generation_costs').all()).results;
 return {mf,db,env,stores,quote,begin,balance,costs};
}
test('D1 daily authorization is atomic across customers and rejected work refunds once before dispatch',async()=>{
 const f=await fixture();try{
  const quotes=await Promise.all(USERS.slice(0,2).map(user=>f.quote(user))),jobs=await Promise.all(quotes.map(q=>f.begin(q)));assert.ok(jobs.every(v=>v.kind==='created'));
  const allowed=await Promise.all(jobs.map((v,i)=>f.stores.jobs.authorizeDispatch(quotes[i].userId,v.job.id)));assert.deepEqual([...allowed].sort(),[false,true]);
  assert.equal((await f.costs()).length,1);assert.equal((await f.costs())[0].provider_estimate_usd_micros,700000);
  const rejected=allowed.indexOf(false),user=quotes[rejected].userId,id=jobs[rejected].job.id;
  await f.stores.jobs.markPreparationFailed(user,id);await f.stores.jobs.markPreparationFailed(user,id);assert.equal(await f.balance(user),2000);
  assert.equal(await f.stores.jobs.authorizeDispatch(quotes[1-rejected].userId,jobs[1-rejected].job.id),false);
  assert.equal((await f.costs()).length,1);
 }finally{await f.mf.dispose();}
});
test('unknown older-day provider liability continues to consume the shared budget and is never auto-released',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),job=(await f.begin(q)).job;assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,job.id),true);await f.stores.jobs.markUnknown(q.userId,job.id);
  await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(job.id).run();
  const next=await f.quote(USERS[1]),nextJob=(await f.begin(next)).job;assert.equal(await f.stores.jobs.authorizeDispatch(next.userId,nextJob.id),false);
  await f.stores.jobs.markPreparationFailed(next.userId,nextJob.id);assert.equal(await f.balance(next.userId),2000);
  await assert.rejects(f.stores.jobs.markPreparationFailed(q.userId,job.id));assert.equal(await f.balance(q.userId),1825);assert.equal((await f.costs()).length,1);
 }finally{await f.mf.dispose();}
});
test('a terminal provider failure refunds customer retail without inventing a provider refund or reopening the same-day budget',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),job=(await f.begin(q)).job;assert.equal(await f.stores.jobs.authorizeDispatch(q.userId,job.id),true);
  await f.stores.jobs.markSubmitted(q.userId,job.id,'known-provider');const poll=await f.stores.jobs.claimPoll(q.userId,job.id);
  await f.stores.jobs.markProviderFailed(q.userId,job.id,'known-provider',poll.token);assert.equal(await f.balance(q.userId),2000);
  const next=await f.quote(USERS[1]),nextJob=(await f.begin(next)).job;assert.equal(await f.stores.jobs.authorizeDispatch(next.userId,nextJob.id),false);assert.equal((await f.costs()).length,1);
  await f.stores.jobs.markPreparationFailed(next.userId,nextJob.id);
  // A known final job consumes its authorization day, not every future day.
  await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(job.id).run();
  const after=await f.quote(USERS[2]),afterJob=(await f.begin(after)).job;assert.equal(await f.stores.jobs.authorizeDispatch(after.userId,afterJob.id),true);
 }finally{await f.mf.dispose();}
});
test('margin, immutable assumptions and missing historical snapshots fail closed before credit reserve',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.quote(USERS[0],{price:100}));assert.equal(await f.balance(),2000);
  const q=await f.quote();assert.equal((await f.begin({...q,input:{...q.input,profitSnapshot:{...q.input.profitSnapshot,paymentFeeReserveCents:0}}})).kind,'pricing');
  await f.db.prepare("UPDATE rig_generation_quotes SET input_json=json_remove(input_json,'$.profitSnapshot') WHERE id=?").bind(q.id).run();
  const legacy=await f.stores.quotes.getOwned(q.userId,q.id);assert.equal((await f.begin(legacy)).kind,'pricing');assert.equal(await f.balance(),2000);
  const second=await f.quote();await f.db.prepare("UPDATE rig_finance_policy SET version='revised-fx',eur_per_usd_micros=1100000 WHERE id=1").run();assert.equal((await f.begin(second)).kind,'pricing');assert.equal(await f.balance(),2000);
  const current=await f.quote(USERS[0],{price:200}),job=(await f.begin(current)).job;await f.db.prepare("UPDATE rig_finance_policy SET version='revised-again' WHERE id=1").run();assert.equal(await f.stores.jobs.authorizeDispatch(current.userId,job.id),false);await f.stores.jobs.markPreparationFailed(current.userId,job.id);assert.equal(await f.balance(),2000);assert.deepEqual(await f.costs(),[]);
 }finally{await f.mf.dispose();}
});
test('private owner use has zero sales revenue and shares the same provider budget',async()=>{
 const f=await fixture({owner:true});try{
  const owner=await f.quote(USERS[0],{price:100}),job=(await f.begin(owner)).job;assert.equal(owner.fundingKind,'owner-provider');assert.equal(owner.input.profitSnapshot.revenueCents,0);assert.equal(owner.input.profitSnapshot.marginCents,-99);
  assert.equal(await f.stores.jobs.authorizeDispatch(owner.userId,job.id),true);assert.equal(await f.balance(),2000);
  const customer=await f.quote(USERS[1]),next=(await f.begin(customer)).job;assert.equal(await f.stores.jobs.authorizeDispatch(customer.userId,next.id),false);await f.stores.jobs.markPreparationFailed(customer.userId,next.id);
  const rows=await f.costs();assert.equal(rows.length,1);assert.equal(rows[0].funding_kind,'owner-provider');assert.equal(JSON.parse(rows[0].snapshot_json).revenueCents,0);
 }finally{await f.mf.dispose();}
});
