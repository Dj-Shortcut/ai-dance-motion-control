import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {seedVerifiedPaidCredit} from './funding-test-support.mjs';

const USER='u-12345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
async function fixture({loseAdmissionReceipt=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const raw=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');let loseReceipt=loseAdmissionReceipt;
 const db=loseAdmissionReceipt?{prepare(sql){
  const statement=raw.prepare(sql);if(!sql.startsWith('INSERT INTO rig_generation_costs'))return statement;
  return {bind(...args){const bound=statement.bind(...args);return {async run(){const result=await bound.run();if(loseReceipt){loseReceipt=false;throw Error('Lost admission receipt after commit')}return result;}};}};
 },batch:statements=>raw.batch(statements)}:raw;
 const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(v=>v.trim()).filter(Boolean))await db.prepare(statement).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('admission-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await seedVerifiedPaidCredit(db,USER,500);
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'admission-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]'};
 const productionContext=await createProductionGenerationContext(env),stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext});
 async function begin(){
  const made=await stores.quotes.create({userId:USER,model:'fal-ai/kling-video/v3/pro/motion-control',input:{data:{quality:'pro'},providerEstimateUsdMicros:400000},priceCents:125,pricingVersion:'admission-fixture',durationSeconds:4});
  const quote=await stores.quotes.getOwned(USER,made.id),result=await stores.jobs.begin({userId:USER,quoteId:quote.id,idempotencyKey:crypto.randomUUID(),quote});assert.equal(result.kind,'created');return result.job;
 }
 const costs=()=>db.prepare('SELECT * FROM rig_generation_costs').all().then(r=>r.results);
 const balance=()=>db.prepare('SELECT SUM(delta) balance FROM rig_ledger WHERE user_id=?').bind(USER).first().then(r=>r.balance);
 return {mf,db,stores,begin,costs,balance};
}

test('parallel admission reserves one immutable cost and parallel dispatch wins exactly once',async()=>{
 const f=await fixture();try{
  const job=await f.begin();assert.deepEqual(await Promise.all([f.stores.jobs.admitProviderWork(USER,job.id),f.stores.jobs.admitProviderWork(USER,job.id)]),[true,true]);
  assert.equal((await f.costs()).length,1);assert.deepEqual((await Promise.all([f.stores.jobs.authorizeDispatch(USER,job.id),f.stores.jobs.authorizeDispatch(USER,job.id)])).sort(),[false,true]);
  await f.stores.jobs.markUnknown(USER,job.id);assert.equal(await f.stores.jobs.admitProviderWork(USER,job.id),false);assert.equal((await f.costs()).length,1);assert.equal(await f.balance(),375);
 }finally{await f.mf.dispose()}
});

test('a lost admission receipt leaves its permanent cost and permits only a correct pre-export wallet refund',async()=>{
 const f=await fixture({loseAdmissionReceipt:true});try{
  const job=await f.begin();
  await assert.rejects(f.stores.jobs.admitProviderWork(USER,job.id),/Lost admission receipt/);
  await f.stores.jobs.markPreparationFailed(USER,job.id);assert.equal(await f.balance(),500);assert.equal((await f.costs()).length,1);assert.equal(await f.stores.jobs.authorizeDispatch(USER,job.id),false);
  assert.equal(await f.stores.jobs.confirmFailureRefund(USER,job.id),true);
 }finally{await f.mf.dispose()}
});

test('an admission crossing UTC midnight cannot export or dispatch on its old-day reservation',async()=>{
 const f=await fixture();try{
  const job=await f.begin();assert.equal(await f.stores.jobs.admitProviderWork(USER,job.id),true);
  await f.db.prepare("UPDATE rig_generation_costs SET budget_day='2000-01-01' WHERE job_id=?").bind(job.id).run();
  assert.equal(await f.stores.jobs.admitProviderWork(USER,job.id),false);assert.equal(await f.stores.jobs.authorizeDispatch(USER,job.id),false);
  await f.stores.jobs.markPreparationFailed(USER,job.id);assert.equal(await f.balance(),500);assert.equal((await f.costs()).length,1);
 }finally{await f.mf.dispose()}
});

test('policy changes or corrupt immutable cost evidence cannot reuse an early admission',async()=>{
 const f=await fixture();try{
  const job=await f.begin();assert.equal(await f.stores.jobs.admitProviderWork(USER,job.id),true);
  await f.db.prepare("UPDATE rig_finance_policy SET version='changed-after-admission' WHERE id=1").run();
  assert.equal(await f.stores.jobs.admitProviderWork(USER,job.id),false);assert.equal(await f.stores.jobs.authorizeDispatch(USER,job.id),false);
  await f.stores.jobs.markPreparationFailed(USER,job.id);assert.equal(await f.balance(),500);
  const second=await f.begin();assert.equal(await f.stores.jobs.admitProviderWork(USER,second.id),true);
  await f.db.prepare("UPDATE rig_generation_costs SET snapshot_json='{}' WHERE job_id=?").bind(second.id).run();
  assert.equal(await f.stores.jobs.authorizeDispatch(USER,second.id),false);await f.stores.jobs.markPreparationFailed(USER,second.id);assert.equal(await f.balance(),500);
 }finally{await f.mf.dispose()}
});
