// Ephemeral D1 and injected provider responses only. No credentials or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createGenerationHandler} from './generation.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {providerBillingRejection} from './provider-response.mjs';
import {loadProfitPolicy,validProfitSnapshot,profitable} from './profit-policy.mjs';
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const DETAIL='User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing';
const refusal=()=>Response.json({detail:DETAIL},{status:403});
async function fixture({owner=false,response=refusal}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 const sql=(await readFile(new URL('./production-schema.sql',import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('billing-refusal-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_FIXTURE',BRIDGE+'/api/payments/webhook').run();
 await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,500)').bind('fixture-only-funding',USER).run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'billing-refusal-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',...(owner?{RIG_PRODUCTION_OWNER_USER_ID:USER}:{})};
 const productionContext=await createProductionGenerationContext(env),stores=createD1GenerationStores(db,{mode:'live',dispatchMode:'paid',productionContext});if(owner)await installTestOwnerCredential(db,USER);
 const assets={image:{id:'image',kind:'image',verified:true,sha256:'a'.repeat(64),url:'https://v3b.fal.media/files/b/fixture/image.jpg'},video:{id:'video',kind:'video',verified:true,sha256:'b'.repeat(64),durationVerified:true,durationSeconds:5,url:'https://v3b.fal.media/files/b/fixture/video.mp4'}};
 const calls=[];const services={...stores,productionContext,mode:'live',trustedOrigin:SITE,falKey:'fixture-only-key',pricing:{standard:50,pro:50,version:'billing-fixture-v1'},authenticate:async()=>({id:USER}),assets:{getOwned:async(user,id)=>user===USER?assets[id]:null,uploadOwned:async(user,id,sha)=>{assert.equal(user,USER);assert.equal(assets[id].sha256,sha);return assets[id]}},results:{store:async()=>{throw Error('No result expected')},read:async()=>{throw Error('No result expected')}},trialGuard:{quoteCurrent:async q=>validProfitSnapshot(q.input.profitSnapshot,{policy:await loadProfitPolicy(db),fundingKind:q.fundingKind,retailPriceCents:q.priceCents,providerEstimateUsdMicros:q.input.providerEstimateUsdMicros})&&profitable(q.input.profitSnapshot),estimate:async()=>700000,retailPrice:async()=>250,permits:async()=>true,claimOnce:async()=>true}};
 const handler=createGenerationHandler(services,async(url,init)=>{assert.equal(url,'https://queue.fal.run/fal-ai/kling-video/v3/pro/motion-control');assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');calls.push(url);return response()});
 const post=(path,data)=>handler(new Request(SITE+path,{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify(data)}));
 async function quote(){const r=await post('/api/generation-quotes',{imageId:'image',videoId:'video',quality:'pro',prompt:'Move naturally',keepSound:true});assert.equal(r.status,201,await r.clone().text());return r.json()}
 async function submit(q,key=crypto.randomUUID()){const payload={quoteId:q.id,idempotencyKey:key},verification=owner?await verificationFor(db,USER,'owner-generation',payload,Date.now(),{env}):undefined;return post('/api/generations',{...payload,...(verification?{verification}:{})})}
 const balance=async()=>(await db.prepare('SELECT SUM(delta) amount FROM rig_ledger WHERE user_id=?').bind(USER).first()).amount;
 const entries=async id=>(await db.prepare('SELECT event_id,delta FROM rig_ledger WHERE event_id IN (?,?,?) ORDER BY event_id').bind('reserve:'+id,'release:'+id,'settle:'+id).all()).results;
 const proof=jobId=>providerBillingRejection(refusal(),{userId:USER,jobId});
 return {mf,db,env,stores,services,handler,quote,submit,balance,entries,calls,proof};
}
test('a definitive queue billing refusal returns customer credit once and permits a fresh confirmed attempt',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),key=crypto.randomUUID(),r=await f.submit(q,key),job=await r.json();
  assert.equal(r.status,200,JSON.stringify(job));assert.equal(job.state,'failed');assert.equal(job.failureCode,'provider_billing_locked');assert.equal(job.refundConfirmed,true);assert.equal(await f.balance(),500);
  assert.deepEqual((await f.entries(job.id)).map(x=>x.delta).sort((a,b)=>a-b),[-250,250]);
  const replay=await f.submit(q,key);assert.equal((await replay.json()).state,'failed');assert.equal(f.calls.length,1);
  const later=await f.handler(new Request(SITE+'/api/generations/'+job.id));assert.equal((await later.json()).refundConfirmed,true);
  const next=await f.submit(await f.quote());assert.equal((await next.json()).refundConfirmed,true);assert.equal(f.calls.length,2);assert.equal(await f.balance(),500);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,2,'retain the conservative estimate journal; do not invent a Fal refund');
 }finally{await f.mf.dispose()}
});
test('generic 402, incomplete 403, accepted IDs and network failure remain unknown with credit held and no second submission',async()=>{
 for(const response of [()=>Response.json({detail:DETAIL},{status:402}),()=>Response.json({detail:'Forbidden'},{status:403}),()=>Response.json({detail:DETAIL,request_id:'accepted-id'},{status:403}),()=>new Response('{"detail":',{status:403,headers:{'content-type':'application/json'}}),()=>{throw Error('Network reply lost')}]){
  const f=await fixture({response});try{
   const q=await f.quote(),key=crypto.randomUUID(),job=await(await f.submit(q,key)).json();assert.equal(job.state,'unknown');assert.equal(job.refundConfirmed,undefined);assert.equal(await f.balance(),250);
   assert.equal((await(await f.submit(q,key)).json()).state,'unknown');assert.equal(f.calls.length,1);assert.deepEqual((await f.entries(job.id)).map(x=>x.delta),[-250]);
  }finally{await f.mf.dispose()}
 }
});
test('D1 rejection proof cannot be forged or applied to another owner or dispatch, and concurrent finalization releases once',async()=>{
 const f=await fixture();try{
  const q=await f.quote(),stored=await f.stores.quotes.getOwned(USER,q.id),job=(await f.stores.jobs.begin({userId:USER,quoteId:q.id,idempotencyKey:crypto.randomUUID(),quote:stored})).job;
  assert.equal(await f.stores.jobs.authorizeDispatch(USER,job.id),true);const proof=await f.proof(job.id);
  await assert.rejects(f.stores.jobs.markSubmissionRejected(USER,job.id,{...proof}));await assert.rejects(f.stores.jobs.markSubmissionRejected(OTHER,job.id,proof));await assert.rejects(f.stores.jobs.markSubmissionRejected(USER,crypto.randomUUID(),proof));
  assert.equal(await f.balance(),250);const outcomes=await Promise.all(Array.from({length:16},()=>f.stores.jobs.markSubmissionRejected(USER,job.id,proof)));assert.ok(outcomes.every(x=>x.state==='failed'));assert.equal(await f.balance(),500);
  assert.deepEqual((await f.entries(job.id)).map(x=>x.delta).sort((a,b)=>a-b),[-250,250]);
 }finally{await f.mf.dispose()}
});
test('even a genuine refusal proof cannot release an accepted, unknown or not-yet-authorized dispatch',async()=>{
 for(const state of ['queued','unknown','unsubmitted']){const f=await fixture();try{
  const q=await f.quote(),stored=await f.stores.quotes.getOwned(USER,q.id),job=(await f.stores.jobs.begin({userId:USER,quoteId:q.id,idempotencyKey:crypto.randomUUID(),quote:stored})).job;
  if(state!=='unsubmitted')assert.equal(await f.stores.jobs.authorizeDispatch(USER,job.id),true);
  if(state==='queued')await f.stores.jobs.markSubmitted(USER,job.id,'known-provider-id');else if(state==='unknown')await f.stores.jobs.markUnknown(USER,job.id);
  await assert.rejects(f.stores.jobs.markSubmissionRejected(USER,job.id,await f.proof(job.id)));assert.equal(await f.balance(),250);assert.deepEqual((await f.entries(job.id)).map(x=>x.delta),[-250]);
 }finally{await f.mf.dispose()}}
});
test('lost finalization response stays cautious while the same owned status proves the completed credit return',async()=>{
 const f=await fixture();try{
  const finalize=f.services.jobs.markSubmissionRejected;f.services.jobs.markSubmissionRejected=async(...args)=>{await finalize(...args);throw Error('Receipt lost after commit')};
  const job=await(await f.submit(await f.quote())).json();assert.equal(job.state,'unknown');assert.equal(job.refundConfirmed,undefined);
  const status=await(await f.handler(new Request(SITE+'/api/generations/'+job.id))).json();assert.equal(status.state,'failed');assert.equal(status.refundConfirmed,true);assert.equal(await f.balance(),500);assert.equal(f.calls.length,1);assert.equal((await f.entries(job.id)).length,2);
 }finally{await f.mf.dispose()}
});
test('owner-funded billing rejection finalizes its own usage without creating customer credit or claiming a Fal refund',async()=>{
 const f=await fixture({owner:true});try{
  const job=await(await f.submit(await f.quote())).json();assert.equal(job.state,'failed');assert.equal(job.failureCode,'provider_billing_locked');assert.equal(job.finalizationConfirmed,true);assert.equal(job.refundConfirmed,undefined);assert.equal(await f.balance(),500);assert.deepEqual(await f.entries(job.id),[]);
  assert.equal((await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first()).state,'failed');
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,1);
 }finally{await f.mf.dispose()}
});
