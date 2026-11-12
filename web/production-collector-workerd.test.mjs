import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {collectProduction} from './production-collector.mjs';
import {isProductionGenerationContext} from './production-generation-context.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const USERS=['u-12345678-1234-4123-8123-123456789abc','u-22345678-1234-4123-8123-123456789abc','u-32345678-1234-4123-8123-123456789abc'];
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_TESTPROFILE',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_COLLECTION_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]'};
 async function job(user,created){const quote=crypto.randomUUID(),id=crypto.randomUUID();await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(quote,user,'fal-ai/kling-video/v3/pro/motion-control','{}',100,'paid-v1',4,9999999999999,created).run();await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,created_at) VALUES(?,?,?,?,?,'queued',?,?)").bind(id,user,quote,crypto.randomUUID(),100,'provider-'+id,created).run();return id}
 const payments=new Map();
 async function order(user,created){const id=crypto.randomUUID(),request=crypto.randomUUID(),payment='tr_'+String(created).padStart(8,'0');await db.prepare("INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,'five',500,500,?,'open',?)").bind(id,user,request,payment,String(created).padStart(8,'0')).run();payments.set(payment,{id:payment,mode:'live',profileId:'pfl_TESTPROFILE',status:'paid',amount:{currency:'EUR',value:'5.00'},metadata:{order_id:id}});return id}
 const external=[];
 const network=async(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)),method=init.method||'GET';external.push({path:url.pathname,method});
  assert.equal(url.origin,'https://api.mollie.com');assert.equal(method,'GET','collector must never create or cancel a provider request');
  if(url.pathname==='/v2/profiles/me')return Response.json({id:'pfl_TESTPROFILE'});
  const m=url.pathname.match(/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/);assert.ok(m,'only verified existing payments may be read');assert.ok(payments.has(m[1]));
  if(m[2])return Response.json({_embedded:{[m[2]]:[]}});
  return Response.json(payments.get(m[1]));
 };
 const calls=[];
 const videoFactory=async(raw,options)=>{
  assert.equal(raw,env);assert.ok(isProductionGenerationContext(options.productionContext,{db}));assert.equal(options.providerFetch,network);assert.equal(options.gatewayFetch,network);
  return async req=>{assert.equal(req.method,'GET');assert.equal(req.body,null);assert.equal(new URL(req.url).origin,SITE);const id=new URL(req.url).pathname.match(/^\/api\/generations\/([0-9a-f-]{36})$/)?.[1];assert.ok(id);const row=await db.prepare('SELECT user_id,state FROM rig_generation_jobs WHERE id=?').bind(id).first();assert.equal(options.trustedUserId,row.user_id,'each completion must be polled as its own database owner');calls.push({id,user:row.user_id});return Response.json({id,state:'queued',priceCents:100,currency:'EUR'})};
 };
 return {mf,db,legacy,env,job,order,calls,network,external,videoFactory};
}

test('bounded production collection rotates across users, reconciles exact existing purchases and never dispatches',async()=>{
 const f=await fixture();try{
  const ids=[];for(let i=0;i<6;i++)ids.push(await f.job(USERS[i%3],i+1));
  for(let i=0;i<3;i++)await f.order(USERS[i],i+1);
  await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(USERS[1],'post-dispatch review').run();
  const run=now=>collectProduction(f.env,{limit:2,clock:()=>now,network:f.network,videoFactory:f.videoFactory});
  let stats=await run(1000000);assert.deepEqual(stats,{videosChecked:2,paymentsChecked:2,needsReview:0,unavailable:0});assert.deepEqual(f.calls.map(x=>x.id),ids.slice(0,2));
  stats=await run(1060000);assert.equal(stats.videosChecked,2);assert.equal(stats.paymentsChecked,1);assert.deepEqual(f.calls.slice(2).map(x=>x.id),ids.slice(2,4));
  stats=await run(1120000);assert.equal(stats.videosChecked,2);assert.equal(stats.paymentsChecked,0);assert.deepEqual(f.calls.slice(4).map(x=>x.id),ids.slice(4,6));
  stats=await run(1180000);assert.equal(stats.videosChecked,2);assert.equal(stats.paymentsChecked,0);assert.deepEqual(f.calls.slice(6).map(x=>x.id),ids.slice(0,2));
  assert.deepEqual((await f.db.prepare('SELECT user_id,SUM(delta) AS balance FROM rig_ledger GROUP BY user_id ORDER BY user_id').all()).results,[{user_id:USERS[0],balance:500},{user_id:USERS[2],balance:500}]);
  assert.equal((await f.db.prepare("SELECT state FROM rig_orders WHERE user_id=?").bind(USERS[1]).first()).state,'credit_pending_review');
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_payment_reconciliation_attempts').first()).n,3);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_collector_attempts').first()).n,6);
  assert.ok(f.external.length>0);assert.ok(f.external.every(x=>x.method==='GET'));assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='rig_ledger'").first()).n,0);
 }finally{await f.mf.dispose()}
});

test('disabled collector performs no database, clock, provider or factory operation',async()=>{
 let touched=0;const forbidden=()=>{touched++;throw Error('must not run')};
 const env={RIG_PRODUCTION_COLLECTION_ENABLED:'no',get PRODUCTION_DB(){return forbidden()}};
 assert.deepEqual(await collectProduction(env,{network:forbidden,videoFactory:forbidden,clock:forbidden}),{videosChecked:0,paymentsChecked:0,needsReview:0,unavailable:0});assert.equal(touched,0);
});

test('paid purchases reconcile exactly once while video generation is paused, without touching video tables or providers',async()=>{
 const f=await fixture();try{
  const orderId=await f.order(USERS[0],1);f.env.RIG_PRODUCTION_VIDEO_ENABLED='no';
  const db=f.db;f.env.PRODUCTION_DB={prepare(sql){assert.doesNotMatch(sql,/rig_generation|rig_workflow/,'payment recovery must not depend on video storage');return db.prepare(sql)},batch:statements=>db.batch(statements)};
  const forbidden=async()=>{throw Error('Video service must remain paused')};
  const run=now=>collectProduction(f.env,{limit:1,clock:()=>now,network:f.network,videoFactory:forbidden});
  assert.deepEqual(await run(1000000),{videosChecked:0,paymentsChecked:1,needsReview:0,unavailable:0});
  assert.equal((await db.prepare('SELECT state FROM rig_orders WHERE id=?').bind(orderId).first()).state,'paid');
  assert.equal((await db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(USERS[0]).first()).amount,500);
  assert.deepEqual(await run(1400000),{videosChecked:0,paymentsChecked:1,needsReview:0,unavailable:0});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_ledger WHERE order_id=?').bind(orderId).first()).n,1);
  assert.ok(f.external.length>0);assert.ok(f.external.every(call=>call.method==='GET'));
 }finally{await f.mf.dispose()}
});

test('malformed owners never reach a video handler; failed old jobs cannot starve unvisited owners',async()=>{
 const f=await fixture();try{
  await f.job('not-a-production-user',1);const first=await f.job(USERS[0],2),next=await f.job(USERS[2],3);
  let attempted=[];const videoFactory=async(raw,options)=>{assert.ok(USERS.includes(options.trustedUserId));return async req=>{const id=new URL(req.url).pathname.split('/').at(-1);attempted.push(id);return id===first?new Response(null,{status:503}):Response.json({id,state:'queued',priceCents:100,currency:'EUR'})}};
  let stats=await collectProduction(f.env,{limit:2,clock:()=>1000000,network:f.network,videoFactory});assert.equal(stats.needsReview,1);assert.equal(stats.unavailable,1);assert.deepEqual(attempted,[first]);
  stats=await collectProduction(f.env,{limit:2,clock:()=>1060000,network:f.network,videoFactory});assert.equal(stats.needsReview,1);assert.equal(stats.videosChecked,1);assert.deepEqual(attempted,[first,next]);assert.equal(f.external.length,0);
  await assert.rejects(collectProduction(f.env,{limit:5,network:f.network,videoFactory}));
 }finally{await f.mf.dispose()}
});

test('collector rejects a successful response for another job and reports reviewed states',async()=>{
 const f=await fixture();try{
  await f.job(USERS[0],1);
  let stats=await collectProduction(f.env,{limit:1,clock:()=>1000000,network:f.network,videoFactory:async()=>async()=>Response.json({id:crypto.randomUUID(),state:'completed'})});
  assert.equal(stats.videosChecked,0);assert.equal(stats.unavailable,1);
  stats=await collectProduction(f.env,{limit:1,clock:()=>1060000,network:f.network,videoFactory:async()=>async req=>Response.json({id:new URL(req.url).pathname.split('/').at(-1),state:'needs_review'})});
  assert.equal(stats.videosChecked,1);assert.equal(stats.needsReview,1);
 }finally{await f.mf.dispose()}
});

test('collector polls exact known workflow steps with dispatch disabled and never advances local processing',async()=>{
 const f=await fixture();try{
  const id=await f.job(USERS[0],1),row=await f.db.prepare('SELECT quote_id FROM rig_generation_jobs WHERE id=?').bind(id).first();
  await f.db.prepare('UPDATE rig_generation_jobs SET fal_request_id=NULL WHERE id=?').bind(id).run();
  await f.db.prepare("INSERT INTO rig_generation_workflows(job_id,quote_id,user_id,plan_version,base_step_id,plan_hash,plan_json,step_count,base_retail_cents,cleanup_retail_cents,provider_estimate_usd_micros,created_at) VALUES(?,?,?,'rig-workflow-v2','base',?,'{}',2,100,0,2200000,1)").bind(id,row.quote_id,USERS[0],'a'.repeat(64)).run();
  await f.db.prepare("INSERT INTO rig_generation_workflow_steps(job_id,step_id,step_index,step_json,state,dispatch_token,fal_request_id) VALUES(?,'source-cleanup',0,'{}','queued',?,?)").bind(id,crypto.randomUUID(),'provider-cleanup').run();
  f.env.RIG_OWNER_CLEANUP_VALIDATION_ENABLED='no';f.env.RIG_OWNER_RECAST_VALIDATION_ENABLED='no';
  let reads=0;
  const videoFactory=async(raw,{trustedUserId})=>async req=>{
   reads++;assert.equal(trustedUserId,USERS[0]);assert.equal(req.method,'GET');assert.equal(req.body,null);assert.equal(new URL(req.url).pathname,'/api/generations/'+id);
   await f.db.prepare("UPDATE rig_generation_workflow_steps SET state='completed',result_key='owned-result',output_sha256=?,output_metadata_json='{}' WHERE job_id=?").bind('b'.repeat(64),id).run();
   return Response.json({id,state:'awaiting_client_processing',workflowVersion:'rig-workflow-v2'});
  };
  let result=await collectProduction(f.env,{network:f.network,videoFactory,clock:()=>1000000});
  assert.deepEqual(result,{videosChecked:1,paymentsChecked:0,needsReview:0,unavailable:0});assert.equal(reads,1);assert.equal(f.external.length,0);
  result=await collectProduction(f.env,{network:f.network,videoFactory,clock:()=>1060000});
  assert.equal(result.videosChecked,0);assert.equal(reads,1,'a step waiting for the browser must never be advanced by scheduled reads');
 }finally{await f.mf.dispose()}
});

test('legacy collector remains valid without optional workflow tables',async()=>{
 const f=await fixture();try{
  for(const table of ['rig_generation_workflow_client_processing','rig_generation_workflow_settlements','rig_generation_workflow_steps','rig_generation_workflows'])await f.db.prepare('DROP TABLE '+table).run();
  await f.job(USERS[0],1);
  const result=await collectProduction(f.env,{network:f.network,videoFactory:f.videoFactory,clock:()=>1000000});
  assert.equal(result.videosChecked,1);assert.equal(result.unavailable,0);
 }finally{await f.mf.dispose()}
});
