import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createProductionGenerationContext,isProductionGenerationContext} from './production-generation-context.mjs';
import {createProductionVideoService} from './production-video-service.mjs';
import {createProductionPayment} from './production-payment.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import {createChatgptApprovals} from './rig-chatgpt-approvals.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc';
const quoteArgs={model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:100,pricingVersion:'paid-v1',durationSeconds:4,input:{data:{quality:'pro'}}};
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
async function fixture({owner=false}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'},r2Buckets:['BUCKET']});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 await migrate(db,'./production-schema.sql');await migrate(legacy,'./cloudflare-migrations/0001_test_baseline.sql');await migrate(legacy,'./closed-payment-migrations/0004_test_media_work_lock.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_TESTPROFILE',BRIDGE+'/api/payments/webhook').run();
 await legacy.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,1000)').bind('legacy-only',ALICE).run();
 const image=new Uint8Array(await readFile(new URL('./test/fixtures/input.jpg',import.meta.url))),video=new Uint8Array(await readFile(new URL('./test/fixtures/silent.mp4',import.meta.url)));
 const assets=new Map(),cdn=new Map();let mediaCalls=0,dispatches=0,providerOutcome='complete',priceRate=.1;
 async function source(kind,owner=ALICE){const bytes=kind==='image'?image:video,id=crypto.randomUUID(),sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');assets.set(id,{id,kind,bytes,owner,sha256});return id}
 const imageId=await source('image'),videoId=await source('video');
 const media={async fetch(req){mediaCalls++;const u=new URL(req.url);if(req.headers.get('authorization')!=='Bearer '+'x'.repeat(40))return new Response(null,{status:401});
  if(req.method==='POST'&&u.pathname==='/v1/normalize/image'){const user=req.headers.get('x-rig-user'),id=await source('image',user),a=assets.get(id);return Response.json({id,ownerId:user,kind:'image',mime:'image/jpeg',sha256:a.sha256,size:a.bytes.length,width:360,height:360},{status:201})}
  const id=u.pathname.split('/').at(-1),a=assets.get(id);if(!a||req.headers.get('x-rig-user')!==a.owner)return new Response(null,{status:404});return new Response(a.bytes.slice(),{headers:{'content-type':a.kind==='image'?'image/jpeg':'video/mp4','content-length':String(a.bytes.length),'x-rig-asset-kind':a.kind,'x-rig-sha256':a.sha256,'x-rig-width':'360','x-rig-height':'360',...(a.kind==='video'?{'x-rig-duration-seconds':'4','x-rig-fps':'30'}:{})}})}};
 const env={DB:legacy,PRODUCTION_DB:db,BUCKET:{get:(...args)=>bucket.get(...args),head:(...args)=>bucket.head(...args),put:(key,bytes,options)=>{assert.equal(options.onlyIf.get('If-None-Match'),'*');return bucket.put(key,bytes,{...options,onlyIf:{etagDoesNotMatch:'*'}})}},RIG_MEDIA:media,RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fake-provider-key',RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_EDIT:'20',RIG_EDIT_ENABLED:'yes',RIG_PRICE_VERSION:'paid-v1',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]'};
 if(owner)env.RIG_PRODUCTION_OWNER_USER_ID=ALICE;
 const provider=async(input,init={})=>{const u=new URL(String(input)),h=new Headers(init.headers);
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate'){const id=crypto.randomUUID(),url='https://v3b.fal.media/files/b/fixture/'+id;cdn.set(url,null);return Response.json({upload_url:'https://v3b.fal.media/upload/'+id,file_url:url})}
  if(u.origin==='https://v3b.fal.media'&&u.pathname.startsWith('/upload/')&&init.method==='PUT'){const value='https://v3b.fal.media/files/b/fixture/'+u.pathname.split('/').at(-1);cdn.set(value,{bytes:new Uint8Array(await init.body.arrayBuffer()),mime:h.get('content-type')});return new Response('OK')}
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/files/acl')return Response.json({default:'forbid',rules:[]});
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/auth/token')return Response.json({token:'fixture-token'});
  if(u.origin==='https://v3b.fal.media'&&u.pathname.endsWith('/sign'))return new Response(u.origin+u.pathname.slice(0,-5)+'?identity=fixture');
  if(u.origin==='https://v3b.fal.media'&&u.search==='?identity=fixture'){const c=cdn.get(u.origin+u.pathname);if(!c)throw Error('missing CDN input');return new Response(c.bytes.slice(),{headers:{'content-type':c.mime,'content-length':String(c.bytes.length)}})}
  if(u.origin==='https://v3b.fal.media'&&u.pathname==='/files/b/fixture/result.mp4'&&h.get('authorization')==='Bearer fixture-token')return new Response(video.slice(),{headers:{'content-type':'video/mp4','content-length':String(video.length)}});
  if(u.origin==='https://v3b.fal.media')return new Response(null,{status:403});
  if(u.origin==='https://queue.fal.run'&&init.method==='POST'){dispatches++;if(providerOutcome==='unknown')throw Error('Lost response after submission');return Response.json({request_id:'provider-request-'+dispatches})}
  if(u.origin==='https://queue.fal.run'&&u.pathname.endsWith('/status'))return Response.json({status:'COMPLETED',request_id:'provider-request-'+dispatches,...(providerOutcome==='failure'?{error:'Fixture terminal failure'}:{})});
  if(u.origin==='https://queue.fal.run')return Response.json({video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}});
  throw Error('Unexpected provider destination');
 };
 const priceFetch=async()=>({currency:'USD',unit:'second',prices:{standard:priceRate,pro:priceRate,'edit-standard':.14}});
 const service=async(user=ALICE,extra={})=>createProductionVideoService({...env,...extra},{trustedUserId:user,providerFetch:provider,priceFetch});
 const call=async(handler,path,data)=>handler(new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})}));
 const balance=async()=> (await db.prepare('SELECT COALESCE(SUM(delta),0) AS cents FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).cents;
 async function fund(user=ALICE){let payment;
  const transport=async(input,init={})=>{const u=new URL(input);if(u.pathname==='/v2/profiles/me')return Response.json({id:'pfl_TESTPROFILE'});if(u.pathname==='/v2/payments'&&init.method==='POST'){const data=JSON.parse(init.body);payment={id:'tr_Fixture001',mode:'live',profileId:'pfl_TESTPROFILE',amount:data.amount,metadata:data.metadata,status:'open',_links:{checkout:{href:'https://www.mollie.com/checkout/fixture'}}};return Response.json(payment)}if(u.pathname.endsWith('/refunds'))return Response.json({_embedded:{refunds:[]}});if(u.pathname.endsWith('/chargebacks'))return Response.json({_embedded:{chargebacks:[]}});return Response.json(payment)};
  const payments=createProductionPayment({transport});const result=await payments.user(new Request(SITE+'/api/payments/create',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify({packageId:'five',requestId:crypto.randomUUID()})}),env,user);assert.equal(result.status,200,await result.clone().text());payment.status='paid';
  for(let i=0;i<2;i++)assert.equal((await payments.webhook(new Request(env.RIG_PRODUCTION_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+payment.id}),env)).status,200);
 }
 return {mf,db,legacy,env,imageId,videoId,image,source,service,call,balance,fund,setOutcome:value=>{providerOutcome=value},setPrice:value=>{priceRate=value},stats:()=>({mediaCalls,dispatches})};
}

test('fresh paid wallet: verified purchase, owned quote, one reserve, private result and isolated test balance',async()=>{
 const f=await fixture();try{
  const h=await f.service(),select={imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false};
  let r=await f.call(h,'/api/video-config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{enabled:true,funding:'credits',mode:'live',currency:'EUR',qualities:['standard','pro','edit-standard']});
  r=await f.call(h,'/api/estimate/fal?quality=pro&duration=4');assert.equal(r.status,200);const estimate=await r.json();assert.equal(estimate.customerProposal.priceCents,100);assert.equal(estimate.customerProposal.testOnly,false);assert.equal(estimate.providerEstimate.currency,'USD');
  const before=f.stats();r=await h(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:new Uint8Array(64)}));assert.equal(r.status,402);assert.equal(f.stats().mediaCalls,before.mediaCalls);
  assert.equal((await f.call(h,'/api/generation-quotes',select)).status,400);assert.equal(await f.balance(),0);
  await f.fund();assert.equal(await f.balance(),500);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
  const bob=await f.service(BOB);assert.equal((await f.call(bob,'/api/generation-quotes',select)).status,400);
  r=await f.call(h,'/api/generation-quotes',select);assert.equal(r.status,201,await r.clone().text());const quote=await r.json();assert.equal(quote.priceCents,100);
  const submission={quoteId:quote.id,idempotencyKey:'paid-generation-001'};
  const results=await Promise.all([f.call(h,'/api/generations',submission),f.call(h,'/api/generations',submission)]);assert.ok(results.every(x=>[200,202,503].includes(x.status)));const accepted=results.find(x=>x.status===202);assert.ok(accepted,await Promise.all(results.map(x=>x.clone().text())));const job=await accepted.json();
  assert.equal(f.stats().dispatches,1);assert.equal(await f.balance(),400);assert.equal((await f.call(h,'/api/generations',submission)).status,200);assert.equal(f.stats().dispatches,1);
  await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'test freeze after dispatch').run();
  r=await f.call(h,'/api/generations/'+job.id);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'completed');
  r=await f.call(h,'/api/generations/'+job.id+'/video');assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>1000);
  assert.equal((await f.call(bob,'/api/generations/'+job.id)).status,404);assert.equal((await f.call(bob,'/api/generations/'+job.id+'/video')).status,404);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'reserve:%'").first()).n,1);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'settle:%'").first()).n,1);
  assert.equal((await f.legacy.prepare('SELECT SUM(delta) cents FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).cents,1000);
 }finally{await f.mf.dispose()}
});

test('production capability cannot be forged or moved to test storage; live release requires exact durable reservation',async()=>{
 const f=await fixture();try{
  const context=await createProductionGenerationContext(f.env);assert.ok(context);assert.ok(isProductionGenerationContext(context,{db:f.db}));assert.equal(isProductionGenerationContext({...context}),false);
  assert.throws(()=>createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid'}));assert.throws(()=>createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:{...context}}));assert.throws(()=>createD1GenerationStores(f.legacy,{mode:'live',dispatchMode:'paid',productionContext:context}));assert.throws(()=>createDurableMediaLease(f.db,{mode:'live'}));
  const lease=createDurableMediaLease(f.db,{mode:'live',productionContext:context}),claim=await lease.acquire(ALICE);assert.equal(claim.state,'acquired');assert.equal((await lease.acquire(BOB)).state,'busy');await lease.complete(claim.token,'settled');
  assert.equal((await f.legacy.prepare('SELECT COUNT(*) n FROM rig_media_work_lock').first()).n,0);
  await f.fund();const stores=createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:context}),q=await stores.quotes.create({...quoteArgs,userId:ALICE}),quote=await stores.quotes.getOwned(ALICE,q.id);
  const first=await stores.jobs.begin({userId:ALICE,quoteId:q.id,idempotencyKey:'prepare-refund',quote});assert.equal(first.kind,'created');assert.equal(await f.balance(),400);
  await stores.jobs.markPreparationFailed(ALICE,first.job.id);await stores.jobs.markPreparationFailed(ALICE,first.job.id);assert.equal(await f.balance(),500);assert.equal(await stores.jobs.confirmFailureRefund(ALICE,first.job.id),true);assert.equal(await stores.jobs.confirmFailureRefund(BOB,first.job.id),false);
  const q2=await stores.quotes.create({...quoteArgs,userId:ALICE}),quote2=await stores.quotes.getOwned(ALICE,q2.id),second=await stores.jobs.begin({userId:ALICE,quoteId:q2.id,idempotencyKey:'provider-refund',quote:quote2});assert.equal(second.kind,'created');assert.equal(await stores.jobs.authorizeDispatch(ALICE,second.job.id),true);assert.equal(await stores.jobs.authorizeDispatch(ALICE,second.job.id),false);await stores.jobs.markSubmitted(ALICE,second.job.id,'known-request');
  const poll=await stores.jobs.claimPoll(ALICE,second.job.id);assert.equal(poll.kind,'acquired');await stores.jobs.markProviderFailed(ALICE,second.job.id,'known-request',poll.token);assert.equal(await f.balance(),500);assert.equal(await stores.jobs.confirmFailureRefund(ALICE,second.job.id,'known-request'),true);
  const q3=await stores.quotes.create({...quoteArgs,userId:ALICE}),quote3=await stores.quotes.getOwned(ALICE,q3.id),unknown=await stores.jobs.begin({userId:ALICE,quoteId:q3.id,idempotencyKey:'unknown-held',quote:quote3});await stores.jobs.authorizeDispatch(ALICE,unknown.job.id);await stores.jobs.markUnknown(ALICE,unknown.job.id);assert.equal(await f.balance(),400);await assert.rejects(stores.jobs.markPreparationFailed(ALICE,unknown.job.id));assert.equal(await stores.jobs.confirmFailureRefund(ALICE,unknown.job.id),false);assert.equal(await f.balance(),400);
 }finally{await f.mf.dispose()}
});

test('production feature off, wrong tenant and explicit test DB cannot prepare or spend purchased credits',async()=>{
 const f=await fixture();try{
  for(const extra of [{RIG_PRODUCTION_VIDEO_ENABLED:'no'},{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_SITE_ORIGIN:'https://attacker.example'}]){const h=await f.service(ALICE,extra);assert.equal((await f.call(h,'/api/video-config')).status,503);assert.equal((await f.call(h,'/api/generations',{quoteId:'q',idempotencyKey:'k'})).status,503)}
  assert.deepEqual(f.stats(),{mediaCalls:0,dispatches:0});assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
});

test('owner EUR0: private upload, USD quote, approval, one Fal submission and owned result never touch the EUR ledger',async()=>{
 const f=await fixture({owner:true});try{
  const h=await f.service(),context=await createProductionGenerationContext(f.env),approvals=createChatgptApprovals(f.db,{mode:'live',productionContext:context});
  assert.equal(await f.balance(),0);
  let r=await f.call(h,'/api/video-config');assert.deepEqual(await r.json(),{enabled:true,funding:'owner-provider',mode:'live',providerCurrency:'USD',qualities:['standard','pro','edit-standard']});
  const preview=await(await f.call(h,'/api/estimate/fal?quality=pro&duration=4')).json();assert.equal(preview.funding,'owner-provider');assert.equal(preview.customerProposal,undefined);assert.equal(preview.providerEstimate.usdMicros,400000);assert.equal(f.stats().dispatches,0);
  r=await h(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:f.image}));assert.equal(r.status,201,await r.clone().text());const uploaded=await r.json();assert.equal(uploaded.kind,'image');
  const selected={imageId:uploaded.id,videoId:f.videoId,quality:'pro',prompt:'Follow the reference movements.',keepSound:false,steadyCamera:false};
  r=await f.call(h,'/api/generation-quotes',selected);assert.equal(r.status,201,await r.clone().text());const q=await r.json();assert.equal(q.funding,'owner-provider');assert.equal(q.providerCurrency,'USD');assert.equal(q.providerEstimateUsdMicros,400000);assert.equal(q.priceCents,undefined);assert.equal(q.currency,undefined);
  assert.equal(await approvals.issue(BOB,{quoteId:q.id}),null);const approval=await approvals.issue(ALICE,{quoteId:q.id});assert.ok(approval);assert.ok(await approvals.consume(ALICE,{quoteId:q.id,approvalToken:approval.approvalToken}));
  const submit={quoteId:q.id,idempotencyKey:approval.idempotencyKey};const responses=await Promise.all([f.call(h,'/api/generations',submit),f.call(h,'/api/generations',submit)]);const accepted=responses.find(x=>x.status===202);assert.ok(accepted,await Promise.all(responses.map(x=>x.clone().text())));const job=await accepted.json();assert.equal(job.funding,'owner-provider');assert.equal(job.priceCents,undefined);assert.equal(job.providerEstimateUsdMicros,400000);
  assert.equal(f.stats().dispatches,1);assert.equal((await f.call(h,'/api/generations',submit)).status,200);assert.equal(f.stats().dispatches,1);
  // Recovery follows the persisted funding even if owner access is revoked.
  const recovery=await f.service(ALICE,{RIG_PRODUCTION_OWNER_USER_ID:BOB});r=await f.call(recovery,'/api/generations/'+job.id);assert.equal(r.status,200,await r.clone().text());const completed=await r.json();assert.equal(completed.state,'completed');assert.equal(completed.funding,'owner-provider');
  const revokedApprovals=createChatgptApprovals(f.db,{mode:'live',productionContext:await createProductionGenerationContext({...f.env,RIG_PRODUCTION_OWNER_USER_ID:BOB})});assert.deepEqual(await revokedApprovals.consume(ALICE,{quoteId:q.id,approvalToken:approval.approvalToken}),{idempotencyKey:approval.idempotencyKey});assert.equal((await f.call(recovery,'/api/generations',submit)).status,200);assert.equal(f.stats().dispatches,1);
  assert.equal((await f.call(recovery,completed.videoPath)).status,200);const bob=await f.service(BOB);assert.equal((await f.call(bob,completed.videoPath)).status,404);
  const usage=await f.db.prepare('SELECT * FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first();assert.equal(usage.state,'completed');assert.equal(usage.estimated_usd_micros,400000);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
});

test('owner funding cannot be selected by a customer or granted by a forged context',async()=>{
 const f=await fixture({owner:true});try{
  const h=await f.service(BOB),select={imageId:await f.source('image',BOB),videoId:await f.source('video',BOB),quality:'pro',funding:'owner-provider',ownerId:BOB,providerEstimateUsdMicros:1};
  const r=await f.call(h,'/api/generation-quotes',select);assert.equal(r.status,400);assert.equal(f.stats().dispatches,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
  await f.fund(BOB);const priced=await f.call(h,'/api/generation-quotes',select);assert.equal(priced.status,201,await priced.clone().text());const q=await priced.json();assert.equal(q.currency,'EUR');assert.equal(q.priceCents,100);assert.equal(q.funding,undefined);
  assert.equal((await f.call(h,'/api/generations',{quoteId:q.id,idempotencyKey:'customer-forged-owner'})).status,202);assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(BOB).first()).n,400);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
  const context=await createProductionGenerationContext(f.env);assert.throws(()=>createD1GenerationStores(f.db,{mode:'live',dispatchMode:'paid',productionContext:{...context}}));
  await f.db.prepare('INSERT INTO rig_frozen_accounts VALUES(?,?,CURRENT_TIMESTAMP)').bind(ALICE,'fixture freeze').run();const owner=await f.service();assert.equal((await owner(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:f.image}))).status,403);
 }finally{await f.mf.dispose()}
});

for(const outcome of ['failure','unknown','higher-price'])test(`owner ${outcome}: no fictitious EUR refund, no automatic second submission`,async()=>{
 const f=await fixture({owner:true});try{
  const h=await f.service(),select={imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false};
  const q=await(await f.call(h,'/api/generation-quotes',select)).json();assert.ok(q.id);
  if(outcome==='higher-price')f.setPrice(.2);else f.setOutcome(outcome);
  const submit={quoteId:q.id,idempotencyKey:'owner-lifecycle-'+outcome};let r=await f.call(h,'/api/generations',submit);assert.ok([200,202].includes(r.status),await r.clone().text());let job=await r.json();assert.equal(job.funding,'owner-provider');
  if(outcome==='failure')job=await(await f.call(h,'/api/generations/'+job.id)).json();
  assert.equal(job.state,outcome==='unknown'?'unknown':'failed');assert.equal(job.refundConfirmed,undefined);assert.equal(job.finalizationConfirmed,outcome==='unknown'?undefined:true);
  assert.equal(f.stats().dispatches,outcome==='higher-price'?0:1);await f.call(h,'/api/generations',submit);assert.equal(f.stats().dispatches,outcome==='higher-price'?0:1);
  const usage=await f.db.prepare('SELECT state FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first();assert.equal(usage.state,outcome==='unknown'?'authorized':'failed');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
  if(outcome==='unknown'){const q2=await(await f.call(h,'/api/generation-quotes',select)).json();assert.ok(q2.id);assert.equal((await f.call(h,'/api/generations',{quoteId:q2.id,idempotencyKey:'must-not-create-another'})).status,409);assert.equal(f.stats().dispatches,1)}
 }finally{await f.mf.dispose()}
});

test('existing owner credit quotes retain EUR funding after direct Fal access is enabled',async()=>{
 const f=await fixture();try{
  await f.fund();const select={imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false},paid=await f.service();
  const q=await(await f.call(paid,'/api/generation-quotes',select)).json();assert.equal(q.currency,'EUR');
  const owner=await f.service(ALICE,{RIG_PRODUCTION_OWNER_USER_ID:ALICE});const r=await f.call(owner,'/api/generations',{quoteId:q.id,idempotencyKey:'historical-owner-credit'});assert.equal(r.status,202,await r.clone().text());const job=await r.json();assert.equal(job.currency,'EUR');assert.equal(job.priceCents,100);assert.equal(job.funding,undefined);assert.equal(await f.balance(),400);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
 }finally{await f.mf.dispose()}
});

test('revoked owner access cannot issue or consume a new provider-funded approval',async()=>{
 const f=await fixture({owner:true});try{
  const h=await f.service(),q=await(await f.call(h,'/api/generation-quotes',{imageId:f.imageId,videoId:f.videoId,quality:'pro'})).json();assert.ok(q.id);
  const current=createChatgptApprovals(f.db,{mode:'live',productionContext:await createProductionGenerationContext(f.env)}),issued=await current.issue(ALICE,{quoteId:q.id});assert.ok(issued);
  const revoked=createChatgptApprovals(f.db,{mode:'live',productionContext:await createProductionGenerationContext({...f.env,RIG_PRODUCTION_OWNER_USER_ID:BOB})});
  assert.equal(await revoked.issue(ALICE,{quoteId:q.id}),null);assert.equal(await revoked.consume(ALICE,{quoteId:q.id,approvalToken:issued.approvalToken}),null);assert.equal(f.stats().dispatches,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
 }finally{await f.mf.dispose()}
});
