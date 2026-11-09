import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {closedVideoTesting} from './closed-video-service.mjs';

const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('provider-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'provider-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER,RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000'};
 const context=await createProductionGenerationContext(env);assert.ok(context);
 const stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext:context});
 const args={model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:100,pricingVersion:'owner-v1',durationSeconds:5,input:{data:{quality:'pro'},providerEstimateUsdMicros:700000}};
 async function quote(user=OWNER,overrides={}){const created=await stores.quotes.create({...args,userId:user,...overrides});return stores.quotes.getOwned(user,created.id);}
 const begin=(q,key=crypto.randomUUID(),adapter=stores)=>adapter.jobs.begin({userId:q.userId,quoteId:q.id,idempotencyKey:key,quote:q});
 const ledger=()=>db.prepare('SELECT * FROM rig_ledger ORDER BY event_id').all().then(r=>r.results);
 const usage=id=>db.prepare('SELECT * FROM rig_owner_provider_usage WHERE job_id=?').bind(id).first();
 const guard=closedVideoTesting.guard(context.env,async()=>({currency:'USD',unit:'second',prices:{pro:.14}}),{trustedUserId:OWNER,accessMode:'paid',productionContext:context});
 return {mf,db,env,context,stores,quote,begin,ledger,usage,guard};
}

test('owner provider funding: zero cash wallet, one durable authorization, ambiguity never resubmits',async()=>{
 const f=await fixture();try{
  const q=await f.quote();assert.equal(q.fundingKind,'owner-provider');assert.equal(q.providerEstimateUsdMicros,700000);assert.deepEqual(await f.ledger(),[]);
  assert.equal(await f.guard.permits({durationSeconds:5,priceCents:100}),true);
  const attempts=await Promise.all([f.begin(q,'owner-same-key'),f.begin(q,'owner-same-key')]);assert.deepEqual(attempts.map(x=>x.kind).sort(),['created','existing']);assert.equal(attempts[0].job.id,attempts[1].job.id);
  const job=attempts.find(x=>x.kind==='created').job;assert.equal(job.fundingKind,'owner-provider');assert.equal(job.providerEstimateUsdMicros,700000);assert.equal((await f.usage(job.id)).state,'authorized');
  assert.equal(await f.guard.claimOnce({userId:OWNER,jobId:job.id,quote:q}),true);
  assert.equal(await f.stores.jobs.authorizeDispatch(OWNER,job.id),true);assert.equal(await f.stores.jobs.authorizeDispatch(OWNER,job.id),false);
  await f.stores.jobs.markUnknown(OWNER,job.id);assert.equal((await f.begin(q,'owner-same-key')).job.state,'unknown');
  assert.equal((await f.begin(await f.quote())).kind,'pending');assert.equal(await f.guard.claimOnce({userId:OWNER,jobId:job.id,quote:q}),false);
  await assert.rejects(f.stores.jobs.markPreparationFailed(OWNER,job.id));assert.equal(await f.stores.jobs.confirmFailureFinalized(OWNER,job.id),false);
  assert.equal((await f.usage(job.id)).state,'authorized');assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});

test('owner completion and failure finalize only the provider journal, with poll-token fencing',async()=>{
 const f=await fixture();try{
  let q=await f.quote(),started=await f.begin(q),id=started.job.id;
  const failed=await f.stores.jobs.markPreparationFailed(OWNER,id);assert.equal(failed.fundingKind,'owner-provider');await f.stores.jobs.markPreparationFailed(OWNER,id);
  assert.equal(await f.stores.jobs.confirmFailureFinalized(OWNER,id),true);assert.equal(await f.stores.jobs.confirmFailureRefund(OWNER,id),false);assert.equal((await f.usage(id)).state,'failed');
  q=await f.quote();started=await f.begin(q);id=started.job.id;await f.stores.jobs.authorizeDispatch(OWNER,id);await f.stores.jobs.markSubmitted(OWNER,id,'provider-failure');let poll=await f.stores.jobs.claimPoll(OWNER,id);
  await assert.rejects(f.stores.jobs.markProviderFailed(OWNER,id,'provider-failure','stale-token'));assert.equal((await f.usage(id)).state,'authorized');
  await f.stores.jobs.markProviderFailed(OWNER,id,'provider-failure',poll.token,'provider_input_unavailable');
  assert.equal(await f.stores.jobs.confirmFailureFinalized(OWNER,id,'provider-failure'),true);assert.equal(await f.stores.jobs.confirmInputFailureRefund(OWNER,id,'provider-failure'),false);assert.equal(await f.stores.jobs.confirmFailureFinalized(CUSTOMER,id,'provider-failure'),false);
  q=await f.quote();started=await f.begin(q);id=started.job.id;await f.stores.jobs.authorizeDispatch(OWNER,id);await f.stores.jobs.markSubmitted(OWNER,id,'provider-completion');poll=await f.stores.jobs.claimPoll(OWNER,id);
  await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(OWNER,'freeze after paid dispatch').run();
  const key=`rig-results/${id}.mp4`;await f.stores.jobs.markCompleted(OWNER,id,'provider-completion',key,poll.token);await f.stores.jobs.markCompleted(OWNER,id,'provider-completion',key,poll.token);
  assert.equal((await f.usage(id)).state,'completed');assert.equal((await f.stores.jobs.getOwned(OWNER,id)).state,'completed');assert.equal(await f.stores.jobs.getOwned(CUSTOMER,id),null);assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});

test('owner cannot bypass freeze, expiry, canceled intent, exact estimate or another active job',async()=>{
 const f=await fixture();try{
  let q=await f.quote();assert.equal((await f.begin({...q,providerEstimateUsdMicros:1})).kind,'insufficient');
  await f.db.prepare('UPDATE rig_generation_quotes SET expires_at=? WHERE id=?').bind(Date.now()-1,q.id).run();assert.equal((await f.begin(q)).kind,'insufficient');
  q=await f.quote();await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(OWNER,'freeze').run();assert.equal((await f.begin(q)).kind,'insufficient');assert.equal(await f.guard.permits({durationSeconds:5,priceCents:100,quote:q}),false);await f.db.prepare('DELETE FROM rig_frozen_accounts').run();
  assert.equal((await f.stores.jobs.reconcileIntent(OWNER,'canceled-key',q.id)).kind,'canceled');assert.equal((await f.begin(q,'canceled-key')).kind,'conflict');
  const qa=await f.quote(),qb=await f.quote(),outcomes=await Promise.all([f.begin(qa),f.begin(qb)]);assert.deepEqual(outcomes.map(x=>x.kind).sort(),['created','pending']);
  const job=outcomes.find(x=>x.kind==='created').job;await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(OWNER,'freeze before queue').run();assert.equal(await f.stores.jobs.authorizeDispatch(OWNER,job.id),false);await f.stores.jobs.markPreparationFailed(OWNER,job.id);
  assert.deepEqual(await f.ledger(),[]);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,1);
 }finally{await f.mf.dispose();}
});

test('customers cannot claim provider funding; historical purchased owner jobs retain exact EUR treatment',async()=>{
 const f=await fixture();try{
  const customer=await f.quote(CUSTOMER,{fundingKind:'owner-provider'});assert.equal(customer.fundingKind,'credits');assert.equal((await f.begin(customer)).kind,'insufficient');
  const noOwnerContext=await createProductionGenerationContext({...f.env,RIG_PRODUCTION_OWNER_USER_ID:undefined}),old=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:noOwnerContext});
  const created=await old.quotes.create({userId:OWNER,model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:125,pricingVersion:'historical-v1',durationSeconds:5,input:{data:{quality:'pro'},providerEstimateUsdMicros:700000}}),q=await f.stores.quotes.getOwned(OWNER,created.id);assert.equal(q.fundingKind,'credits');
  assert.equal(await f.guard.permits({durationSeconds:5,priceCents:125,quote:q}),false);
  await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('verified-purchase',?,500)").bind(OWNER).run();
  assert.equal(await f.guard.permits({durationSeconds:5,priceCents:125,quote:q}),true);const started=await f.begin(q),id=started.job.id;
  assert.equal(await f.guard.claimOnce({userId:OWNER,jobId:id,quote:q}),true);assert.equal(await f.usage(id),null);
  await f.stores.jobs.markPreparationFailed(OWNER,id);assert.equal(await f.stores.jobs.confirmFailureRefund(OWNER,id),true);assert.equal(await f.stores.jobs.confirmFailureFinalized(OWNER,id),false);
  const rows=await f.ledger();assert.deepEqual(rows.map(x=>x.delta).sort((a,b)=>a-b),[-125,125,500]);assert.equal(rows.reduce((sum,x)=>sum+x.delta,0),500);
  assert.equal(productionFundingKind({...f.context},OWNER),'credits');assert.throws(()=>createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:{...f.context}}));
 }finally{await f.mf.dispose();}
});

test('owner changes block new dispatch while previously queued provider jobs remain recoverable',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),first=await f.begin(q);await f.stores.jobs.authorizeDispatch(OWNER,first.job.id);await f.stores.jobs.markSubmitted(OWNER,first.job.id,'queued-before-change');
  const changed=await createProductionGenerationContext({...f.env,RIG_PRODUCTION_OWNER_USER_ID:CUSTOMER}),stores=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:changed});
  const poll=await stores.jobs.claimPoll(OWNER,first.job.id);await stores.jobs.markCompleted(OWNER,first.job.id,'queued-before-change',`rig-results/${first.job.id}.mp4`,poll.token);
  const next=await f.quote(),started=await f.begin(next);assert.equal(await stores.jobs.authorizeDispatch(OWNER,started.job.id),false);await stores.jobs.markPreparationFailed(OWNER,started.job.id);
  assert.equal((await stores.jobs.getOwned(OWNER,first.job.id)).fundingKind,'owner-provider');assert.deepEqual(await f.ledger(),[]);
 }finally{await f.mf.dispose();}
});

test('migration preserves historical funding and creates no purchased-credit entries',async()=>{
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null)}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});try{
  const db=await mf.getD1Database('DB');await migrate(db,'./generation-schema.sql');await db.prepare("INSERT INTO rig_generation_quotes VALUES('old-quote','owner','model','{}',100,'v1',5,9999999999999,1)").run();
  await migrate(db,'./production-migrations/0002_owner_provider_funding.sql');assert.equal((await db.prepare("SELECT funding_kind FROM rig_generation_quotes WHERE id='old-quote'").first()).funding_kind,'credits');assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
  await assert.rejects(db.prepare("UPDATE rig_generation_quotes SET funding_kind='free' WHERE id='old-quote'").run());
 }finally{await mf.dispose();}
});
