import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleOwnerFinance} from './owner-finance.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
import {createProfitSnapshot,loadProfitPolicy} from './profit-policy.mjs';
import {signSitesBridgeRequest,sitesDigest} from './sites-bridge-protocol.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc',OTHER='u-32345678-1234-4123-8123-123456789abc',KEY='de'.repeat(32);
const NOW=Date.parse('2026-11-09T12:00:00Z');
const timestamp=n=>new Date(n).toISOString().slice(0,19).replace('T',' ');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('finance-fixture','live',PROJECT,SITE,BRIDGE,'pfl_FINANCE',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'no',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FINANCE',RIG_PRODUCTION_ENVIRONMENT_ID:'finance-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY,RIG_PRODUCTION_OWNER_USER_ID:OWNER,RIG_PRICE_STANDARD:'30',RIG_PRICE_PRO:'40',RIG_PRICE_EDIT:'35'};
 const request=(path='/api/owner/finance',data,headers={})=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{origin:SITE,'content-type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const call=(path,data,{userId=OWNER,extraEnv={},headers={}}={})=>handleOwnerFinance(request(path,data,headers),{...env,...extraEnv},{userId,now:NOW});
 const report=async(path='/api/owner/finance')=>{const response=await call(path);assert.equal(response.status,200,await response.clone().text());return response.json();};
 const ledger=async(event,user,delta,{orderId=null,at=NOW}={})=>db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta,created_at) VALUES(?,?,?,?,?)').bind(event,user,orderId,delta,timestamp(at)).run();
 async function paid(user=CUSTOMER,amount=1000,at=NOW,state='paid'){
  const id=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,crypto.randomUUID(),'fixture',amount,amount,'tr_'+id.replaceAll('-',''),state,timestamp(at)).run();
  if(state==='paid'||state==='reversal_review')await ledger('credit:'+id,user,amount,{orderId:id,at});return id;
 }
 async function job({user=CUSTOMER,funding='credits',state='completed',at=NOW,price=150,usd=630000,dispatched=true,snapshot=true}={}){
  const policy=await loadProfitPolicy(db),cost=createProfitSnapshot({policy,fundingKind:funding,retailPriceCents:price,providerEstimateUsdMicros:usd}),id=crypto.randomUUID(),quote=crypto.randomUUID(),input={providerEstimateUsdMicros:usd,...(snapshot?{profitSnapshot:cost}:{}),prompt:'Never expose this private prompt',refs:[{secret:'private-input-url'}]};
  await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,funding_kind,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(quote,user,'fal-ai/kling-video/v3/standard/motion-control',JSON.stringify(input),funding,price,'finance-fixture',5,at+600000,at).run();
  const requestId=dispatched&&state!=='unknown'?'provider-'+id:null;
  await db.prepare('INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,finalized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,quote,crypto.randomUUID(),price,state,requestId,['completed','failed'].includes(state)?at+1000:null,at).run();
  if(funding==='credits'){
   await ledger('reserve:'+id,user,-price,{at});
   if(state==='completed')await ledger('settle:'+id,user,0,{at:at+1000});
   if(state==='failed')await ledger('release:'+id,user,price,{at:at+1000});
  }
  if(dispatched)await db.prepare('INSERT INTO rig_generation_costs(job_id,quote_id,user_id,funding_kind,provider_estimate_usd_micros,budget_day,authorized_at,snapshot_json) VALUES(?,?,?,?,?,?,?,?)').bind(id,quote,user,funding,usd,new Date(at).toISOString().slice(0,10),at,JSON.stringify(cost)).run();
  return {id,cost};
 }
 return {mf,db,env,call,report,ledger,paid,job,request};
}
const expense=(options={})=>({idempotencyKey:crypto.randomUUID(),category:'hosting',date:'2026-11-09',amountCents:500,note:'Invoice including non-deductible purchase tax',...options});

test('owner finance: signed identity gate is independent from generation; customer and forged owner headers reveal no data',async()=>{
 const f=await fixture();try{
  const producer={RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_SITES_BRIDGE_ORIGIN:BRIDGE,RIG_SITES_BRIDGE_KEY:KEY};
  for(const [subject,user] of [['owner-subject',OWNER],['customer-subject',CUSTOMER]]){
   const hash=await sitesDigest(new TextEncoder().encode(PROJECT+'\0'+subject));await f.db.prepare('INSERT INTO rig_sites_identities(site_id,subject_hash,user_id,created_at) VALUES(?,?,?,?)').bind(PROJECT,hash,user,NOW).run();
  }
  const worker=createProductionCommerceWorker({network:async()=>{throw Error('No provider permitted')}});
  let signed=await signSitesBridgeRequest({env:producer,subject:'owner-subject',path:'/api/owner/finance'}),response=await worker.fetch(signed,f.env);
  assert.equal(response.status,200,await response.clone().text());const value=await response.json();assert.equal(value.income.cashReceivedCents,0);assert.equal(value.costs.actualProfitCents,null);assert.equal(value.policy.minProPriceCents,125);assert.equal(response.headers.get('cache-control'),'no-store');
  signed=await signSitesBridgeRequest({env:producer,subject:'customer-subject',path:'/api/owner/finance'});signed.headers.set('x-rig-owner',OWNER);signed.headers.set('oai-authenticated-user-id',OWNER);
  response=await worker.fetch(signed,f.env);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Geen toegang.'});
  response=await worker.fetch(new Request(BRIDGE+'/api/owner/finance',{headers:{'oai-authenticated-user-id':OWNER}}),f.env);assert.equal(response.status,401);
  for(const extraEnv of [{PRODUCTION_DB:f.env.DB},{RIG_PRODUCTION_SITE_ORIGIN:'https://attacker.invalid'},{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'}])assert.equal((await f.call('/api/owner/finance',undefined,{extraEnv})).status,503);
  assert.equal((await f.call('/api/owner/finance',undefined,{userId:CUSTOMER})).status,403);
  assert.equal((await f.call('/api/owner/finance?month=2026-11&month=2026-10')).status,400);
  assert.equal((await f.call('/api/owner/finance?month=2026-13')).status,400);
 }finally{await f.mf.dispose();}
});

test('paid receipts, promo-first earned revenue, pending liability, owner use and missing actual costs stay distinct',async()=>{
 const f=await fixture();try{
  await f.paid(CUSTOMER,1000,Date.parse('2026-11-01T10:00:00Z'));await f.paid(CUSTOMER,2500,NOW,'expired');
  await f.job({at:Date.parse('2026-11-01T11:00:00Z')});
  await f.ledger('promo:gift',CUSTOMER,200,{at:Date.parse('2026-11-02T10:00:00Z')});
  const free=await f.job({at:Date.parse('2026-11-03T10:00:00Z')}),mixed=await f.job({at:Date.parse('2026-11-04T10:00:00Z')});
  const pending=await f.job({state:'unknown',at:Date.parse('2026-11-08T10:00:00Z')});
  await f.job({user:OWNER,funding:'owner-provider',at:Date.parse('2026-11-05T10:00:00Z')});
  await f.ledger('reversal-negative',OTHER,-700);
  const value=await f.report();assert.equal(value.income.cashReceivedCents,1000);assert.equal(value.income.creditIssuedCents,1000);assert.equal(value.income.earnedVideoCents,250);assert.equal(value.income.promotionalVideoUseCents,200);
  assert.equal(value.credits.outstandingCents,600);assert.equal(value.credits.heldCents,150);assert.equal(value.credits.liabilityCents,750);assert.equal(value.credits.negativeBalanceCents,700);assert.equal(value.costs.missingActualJobs,5);assert.equal(value.costs.actualProfitCents,null);
  assert.equal(value.jobs.find(j=>j.id===free.id).estimatedMarginCents,-free.cost.estimatedCostCents);
  assert.equal(value.jobs.find(j=>j.id===mixed.id).estimatedMarginCents,100-mixed.cost.estimatedCostCents);
  assert.equal(value.jobs.find(j=>j.id===pending.id).estimatedMarginCents,-pending.cost.estimatedCostCents);
  assert.equal(value.dailyBudget.usedUsdMicros,630000);assert.equal(value.dailyBudget.timeZone,'UTC');
  assert.doesNotMatch(JSON.stringify(value),/Never expose|private-input-url|live_fixture|owner-subject|customer-subject/);
 }finally{await f.mf.dispose();}
});

test('report month uses Brussels boundaries, keeps current liability, and never treats refunded or legacy jobs as profitable sales',async()=>{
 const f=await fixture();try{
  const oct=Date.parse('2026-10-31T22:30:00Z'),nov=Date.parse('2026-10-31T23:30:00Z');await f.paid(CUSTOMER,1000,oct);await f.paid(CUSTOMER,500,nov);
  await f.job({at:oct});const failed=await f.job({state:'failed',at:nov}),legacy=await f.job({snapshot:false,at:NOW,dispatched:true});
  const value=await f.report('/api/owner/finance?month=2026-11');assert.equal(value.period.from,'2026-10-31T23:00:00.000Z');assert.equal(value.period.to,'2026-11-30T23:00:00.000Z');assert.equal(value.income.cashReceivedCents,500);assert.equal(value.income.earnedVideoCents,150);
  assert.equal(value.costs.missingEstimateJobs,1);assert.equal(value.costs.estimatedTotalCents,null);assert.equal(value.margin.estimatedContributionCents,null);assert.equal(value.jobs.find(j=>j.id===failed.id).estimatedMarginCents,-failed.cost.estimatedCostCents);assert.equal(value.jobs.find(j=>j.id===legacy.id).estimatedCostCents,null);
  assert.equal(value.credits.outstandingCents,1200);const summer=await f.report('/api/owner/finance?month=2026-07');assert.equal(summer.period.from,'2026-06-30T22:00:00.000Z');assert.equal(summer.credits.outstandingCents,1200);
 }finally{await f.mf.dispose();}
});

test('actual expenses are bounded, idempotent and corrected append-only; Fal topups are not counted twice as consumption',async()=>{
 const f=await fixture();try{
  await f.paid();const j=await f.job(),input=expense({category:'fal-charge',jobId:j.id,amountCents:80});
  let response=await f.call('/api/owner/finance/expenses',input);assert.equal(response.status,201,await response.clone().text());const first=await response.json();
  const race=await Promise.all([f.call('/api/owner/finance/expenses',input),f.call('/api/owner/finance/expenses',input)]);assert.ok(race.every(r=>r.status===200));
  assert.equal((await f.call('/api/owner/finance/expenses',{...input,amountCents:90})).status,409);
  assert.equal((await f.call('/api/owner/finance/expenses',{...input,idempotencyKey:crypto.randomUUID()})).status,409);
  const correction=expense({category:'fal-charge',jobId:j.id,amountCents:0,replacesExpenseId:first.id});response=await f.call('/api/owner/finance/expenses',correction);assert.equal(response.status,201,await response.clone().text());
  assert.equal((await f.call('/api/owner/finance/expenses',{...correction,idempotencyKey:crypto.randomUUID(),amountCents:50})).status,409);
  await f.call('/api/owner/finance/expenses',expense({category:'fal-topup',amountCents:2500}));await f.call('/api/owner/finance/expenses',expense({category:'mollie',amountCents:32}));await f.call('/api/owner/finance/expenses',expense({category:'hosting',amountCents:500}));
  const value=await f.report();assert.equal(value.costs.falTopupsCents,2500);assert.equal(value.costs.actualFalRecordedCents,0);assert.equal(value.costs.actualRecordedCents,532);assert.equal(value.costs.recordedResultCents,150-532);assert.equal(value.costs.actualProfitCents,null);assert.equal(value.costs.missingActualJobs,0);assert.equal(value.jobs[0].actualCostCents,0);assert.equal(value.jobs[0].canRecordFalCost,false);assert.equal(value.expenses.length,4);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,5);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,3);
 }finally{await f.mf.dispose();}
});

test('valid Fal job ID cannot bypass invalid dates, negative amounts, extra keys or hostile notes; unknown and undispatched jobs cannot receive costs',async()=>{
 const f=await fixture();try{
  const known=await f.job(),undispatched=await f.job({dispatched:false,state:'failed'}),base=expense({category:'fal-charge',jobId:known.id});
  for(const patch of [{date:'2026-02-31'},{date:'2099-01-01'},{amountCents:-1},{amountCents:100000001},{amountCents:1.5},{note:'x'.repeat(241)},{note:'bad\nline'},{note:' '},{unexpected:true},{idempotencyKey:'bad'}]){
   const response=await f.call('/api/owner/finance/expenses',{...base,...patch});assert.equal(response.status,400,JSON.stringify(patch)+' '+await response.text());
  }
  await f.db.prepare('DELETE FROM rig_rate_limits').run();
  assert.equal((await f.call('/api/owner/finance/expenses',expense({category:'fal-charge',jobId:crypto.randomUUID()}))).status,409);
  assert.equal((await f.call('/api/owner/finance/expenses',expense({category:'fal-charge',jobId:undispatched.id}))).status,409);
  assert.equal((await f.call('/api/owner/finance/expenses',expense({jobId:known.id}))).status,400);
  assert.equal((await f.call('/api/owner/finance/expenses',base,{userId:CUSTOMER})).status,403);
  assert.equal((await f.call('/api/owner/finance/expenses',base,{headers:{origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('owner report reads cannot exhaust the independent finance write allowance',async()=>{
 const f=await fixture();try{
  for(let i=0;i<60;i++)assert.equal((await f.call('/api/owner/finance')).status,200);
  assert.equal((await f.call('/api/owner/finance')).status,429);
  assert.equal((await f.call('/api/owner/finance/expenses',expense())).status,201);
 }finally{await f.mf.dispose();}
});

test('policy changes use optimistic versioning, preserve history and reject untrusted or out-of-range values',async()=>{
 const f=await fixture();try{
  const before=await f.report(),{version,updatedAt,...values}=before.policy,input={expectedVersion:version,...values,eurPerUsdMicros:1100000};
  let response=await f.call('/api/owner/finance/policy',input);assert.equal(response.status,200,await response.clone().text());const saved=await response.json();assert.notEqual(saved.policy.version,version);assert.equal(saved.policy.eurPerUsdMicros,1100000);
  assert.equal((await f.call('/api/owner/finance/policy',input)).status,409);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_policy_history').first()).n,1);
  for(const patch of [{eurPerUsdMicros:0},{providerVatBps:-1},{minMarginBps:10000},{minProPriceCents:1201},{dailyProviderLimitUsdMicros:1000000001},{evil:true}])assert.equal((await f.call('/api/owner/finance/policy',{...input,expectedVersion:saved.policy.version,...patch})).status,400);
  assert.equal((await f.call('/api/owner/finance/policy',{...input,expectedVersion:saved.policy.version},{userId:CUSTOMER})).status,403);
  const after=await f.report();assert.equal(after.policy.version,saved.policy.version);assert.equal(after.policy.minProPriceCents,125);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('policy updates do not rewrite historical cost estimates or falsely complete actual-cost coverage',async()=>{
 const f=await fixture();try{
  await f.paid();const j=await f.job(),before=await f.report(),{version,updatedAt,...values}=before.policy;
  assert.equal((await f.call('/api/owner/finance/policy',{expectedVersion:version,...values,eurPerUsdMicros:1500000,providerVatBps:3000})).status,200);
  const after=await f.report();assert.equal(after.costs.estimatedTotalCents,before.costs.estimatedTotalCents);assert.equal(after.jobs[0].estimatedCostCents,j.cost.estimatedCostCents);assert.equal(after.margin.estimatedContributionCents,before.margin.estimatedContributionCents);assert.equal(after.costs.actualProfitCents,null);assert.equal(after.costs.missingActualJobs,1);
 }finally{await f.mf.dispose();}
});

test('additive finance migration preserves existing paid orders, balances and mode',async()=>{
 const f=await fixture();try{
  await f.paid();const beforeOrders=(await f.db.prepare('SELECT * FROM rig_orders').all()).results,beforeLedger=(await f.db.prepare('SELECT * FROM rig_ledger').all()).results;
  for(const table of ['rig_finance_expenses','rig_generation_costs','rig_finance_policy_history','rig_finance_policy'])await f.db.prepare('DROP TABLE '+table).run();
  await migrate(f.db,'./production-migrations/0003_profit_monitoring.sql');
  assert.deepEqual((await f.db.prepare('SELECT * FROM rig_orders').all()).results,beforeOrders);assert.deepEqual((await f.db.prepare('SELECT * FROM rig_ledger').all()).results,beforeLedger);assert.equal((await f.db.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first()).mode,'live');assert.equal((await loadProfitPolicy(f.db)).minProPriceCents,125);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('a video crossing the Brussels month boundary brings both earned revenue and its estimated costs into completion month',async()=>{
 const f=await fixture();try{
  const at=Date.parse('2026-10-31T22:59:59.500Z');await f.paid(CUSTOMER,1000,at-10000);const j=await f.job({at});
  const october=await f.report('/api/owner/finance?month=2026-10'),november=await f.report('/api/owner/finance?month=2026-11');
  assert.equal(october.income.earnedVideoCents,0);assert.equal(october.costs.estimatedTotalCents,0);assert.equal(october.jobs.length,0);
  assert.equal(november.income.earnedVideoCents,150);assert.equal(november.costs.estimatedTotalCents,j.cost.estimatedCostCents);assert.equal(november.margin.estimatedContributionCents,150-j.cost.estimatedCostCents);assert.equal(november.jobs.length,1);assert.equal(november.jobs[0].id,j.id);assert.equal(november.jobs[0].recognizedAt,'2026-10-31T23:00:00.500Z');assert.equal(november.jobs[0].createdAt,'2026-10-31T22:59:59.500Z');
 }finally{await f.mf.dispose();}
});

test('a zero correction voids an invoice without deleting history; generic cash refunds do not double-count liability repayment as a cost',async()=>{
 const f=await fixture();try{
  let response=await f.call('/api/owner/finance/expenses',expense({category:'hosting',amountCents:500}));assert.equal(response.status,201);const first=await response.json();
  response=await f.call('/api/owner/finance/expenses',expense({category:'hosting',amountCents:0,replacesExpenseId:first.id,note:'Void duplicate hosting invoice'}));assert.equal(response.status,201,await response.clone().text());
  assert.equal((await f.call('/api/owner/finance/expenses',expense({category:'other',amountCents:0}))).status,400);
  assert.equal((await f.call('/api/owner/finance/expenses',expense({category:'refund',amountCents:250,note:'Repay unused prepaid customer credit'}))).status,201);
  const value=await f.report();assert.equal(value.income.refundedCents,250);assert.equal(value.costs.fixedRecordedCents,0);assert.equal(value.costs.actualRecordedCents,0);assert.equal(value.costs.recordedResultCents,0);assert.equal(value.costs.actualProfitCents,null);assert.equal(value.credits.liabilityCents,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,3);assert.equal(value.expenses.length,2);
 }finally{await f.mf.dispose();}
});
