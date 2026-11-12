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
import {installTestOwnerCredential,verificationFor} from './owner-security-test-helper.mjs';
import {RECAST_BILLING} from './price-preflight.mjs';

const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc';
const quoteArgs={model:'fal-ai/kling-video/v3/pro/motion-control',priceCents:100,pricingVersion:'paid-v1',durationSeconds:4,input:{data:{quality:'pro'},providerEstimateUsdMicros:400000}};
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const q of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(q).run()}
async function fixture({owner=false,editVideo=false,recastVideoDuration=null}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'},r2Buckets:['BUCKET']});
 const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 await migrate(db,'./production-schema.sql');await migrate(legacy,'./cloudflare-migrations/0001_test_baseline.sql');await migrate(legacy,'./closed-payment-migrations/0004_test_media_work_lock.sql');
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE name='rig_preparation_reservations'").first())await migrate(db,'./production-migrations/0005_preparation_budget.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('prod-fixture','live','appgprj_6aeec13b50448191b88da670dac8aa98',SITE,BRIDGE,'pfl_TESTPROFILE',BRIDGE+'/api/payments/webhook').run();
 await legacy.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,1000)').bind('legacy-only',ALICE).run();
 const image=new Uint8Array(await readFile(new URL('./test/fixtures/input.jpg',import.meta.url))),video=new Uint8Array(await readFile(new URL('./test/fixtures/silent.mp4',import.meta.url)));
 const assets=new Map(),cdn=new Map(),temporaryCdn=new Set(),priceReads=[];let mediaCalls=0,dispatches=0,providerOutcome='complete',priceRate=.1,uploadPrice=null,temporaryResult=false,recastPricing={provider:'fal',currency:'USD',unit:'second',prices:{'human-recast':RECAST_BILLING.usdMicrosPerSecond/1e6},billingContracts:{'human-recast':{...RECAST_BILLING}}};
 async function source(kind,owner=ALICE){const bytes=kind==='image'?image:video,id=crypto.randomUUID(),sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');assets.set(id,{id,kind,bytes,owner,sha256});return id}
 const imageId=await source('image'),videoId=await source('video');
 const media={async fetch(req){mediaCalls++;const u=new URL(req.url);if(req.headers.get('authorization')!=='Bearer '+'x'.repeat(40))return new Response(null,{status:401});
  if(req.method==='POST'&&u.pathname==='/v1/normalize/image'){const user=req.headers.get('x-rig-user'),id=await source('image',user),a=assets.get(id);return Response.json({id,ownerId:user,kind:'image',mime:'image/jpeg',sha256:a.sha256,size:a.bytes.length,width:360,height:360},{status:201})}
  const id=u.pathname.split('/').at(-1),a=assets.get(id);if(!a||req.headers.get('x-rig-user')!==a.owner)return new Response(null,{status:404});return new Response(a.bytes.slice(),{headers:{'content-type':a.kind==='image'?'image/jpeg':'video/mp4','content-length':String(a.bytes.length),'x-rig-asset-kind':a.kind,'x-rig-sha256':a.sha256,'x-rig-width':a.kind==='video'&&editVideo?'1280':'360','x-rig-height':a.kind==='video'&&editVideo?'720':'360',...(a.kind==='video'?{'x-rig-duration-seconds':String(recastVideoDuration??(editVideo?5:4)),'x-rig-fps':'30'}:{})}})}};
 const env={DB:legacy,PRODUCTION_DB:db,BUCKET:{get:(...args)=>bucket.get(...args),head:(...args)=>bucket.head(...args),put:(key,bytes,options)=>{assert.equal(options.onlyIf.get('If-None-Match'),'*');return bucket.put(key,bytes,{...options,onlyIf:{etagDoesNotMatch:'*'}})}},RIG_MEDIA:media,RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fake-provider-key',RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_PRICE_STANDARD:'20',RIG_PRICE_PRO:'25',RIG_PRICE_EDIT:'20',RIG_EDIT_ENABLED:'yes',RIG_PRICE_VERSION:'paid-v1',RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',RIG_PRODUCTION_VIDEO_ENABLED:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]'};
 if(owner){env.RIG_PRODUCTION_OWNER_USER_ID=ALICE;await installTestOwnerCredential(db,ALICE);}
 const provider=async(input,init={})=>{const u=new URL(String(input)),h=new Headers(init.headers);
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/upload/initiate'){const id=crypto.randomUUID(),url='https://v3b.fal.media/files/b/fixture/'+id;cdn.set(url,null);if(h.get('x-fal-object-lifecycle-preference')==='{"expiration_duration_seconds":86400}')temporaryCdn.add(url);return Response.json({upload_url:'https://v3b.fal.media/upload/'+id,file_url:url})}
  if(u.origin==='https://v3b.fal.media'&&u.pathname.startsWith('/upload/')&&init.method==='PUT'){const value='https://v3b.fal.media/files/b/fixture/'+u.pathname.split('/').at(-1);cdn.set(value,{bytes:new Uint8Array(await init.body.arrayBuffer()),mime:h.get('content-type')});if(uploadPrice!==null)priceRate=uploadPrice;return new Response('OK')}
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/files/acl')return Response.json({default:'forbid',rules:[]});
  if(u.origin==='https://rest.fal.ai'&&u.pathname==='/storage/auth/token')return Response.json({token:'fixture-token'});
  if(u.origin==='https://v3b.fal.media'&&u.pathname.endsWith('/sign'))return new Response(u.origin+u.pathname.slice(0,-5)+'?identity=fixture');
  if(u.origin==='https://v3b.fal.media'&&u.search==='?identity=fixture'){const c=cdn.get(u.origin+u.pathname);if(!c)throw Error('missing CDN input');return new Response(c.bytes.slice(),{headers:{'content-type':c.mime,'content-length':String(c.bytes.length)}})}
  if(u.origin==='https://v3b.fal.media'&&temporaryCdn.has(u.origin+u.pathname)&&!u.search){const c=cdn.get(u.origin+u.pathname);if(!c)throw Error('missing temporary CDN input');return new Response(c.bytes.slice(),{headers:{'content-type':c.mime,'content-length':String(c.bytes.length)}})}
  if(u.origin==='https://v3b.fal.media'&&u.pathname==='/files/b/fixture/result.mp4'&&(h.get('authorization')==='Bearer fixture-token'||temporaryResult))return new Response(video.slice(),{headers:{'content-type':'video/mp4','content-length':String(video.length)}});
  if(u.origin==='https://v3b.fal.media')return new Response(null,{status:403});
  if(u.origin==='https://queue.fal.run'&&init.method==='POST'){dispatches++;temporaryResult=temporaryCdn.has(JSON.parse(init.body).video_url);if(providerOutcome==='unknown')throw Error('Lost response after submission');return Response.json({request_id:'provider-request-'+dispatches})}
  if(u.origin==='https://queue.fal.run'&&u.pathname.endsWith('/status'))return Response.json({status:'COMPLETED',request_id:'provider-request-'+dispatches,...(providerOutcome==='failure'?{error:'Fixture terminal failure'}:{})});
  if(u.origin==='https://queue.fal.run')return Response.json({video:{url:'https://v3b.fal.media/files/b/fixture/result.mp4'}});
  throw Error('Unexpected provider destination');
 };
 const priceFetch=async(_key,quality)=>{priceReads.push(quality);return quality==='human-recast'?recastPricing:({currency:'USD',unit:'second',prices:{standard:priceRate,pro:priceRate,'edit-standard':.14}});};
 const service=async(user=ALICE,extra={})=>createProductionVideoService({...env,...extra},{trustedUserId:user,providerFetch:provider,priceFetch});
 const call=async(handler,path,data)=>{
  if(owner&&path==='/api/generations'&&data&&!data.verification){
   const q=await db.prepare('SELECT funding_kind FROM rig_generation_quotes WHERE id=? AND user_id=?').bind(data.quoteId,ALICE).first();
   const prior=await db.prepare('SELECT id FROM rig_generation_jobs WHERE user_id=? AND idempotency_key=?').bind(ALICE,data.idempotencyKey).first();
   if(q?.funding_kind==='owner-provider'&&!prior)data={...data,verification:await verificationFor(db,ALICE,'owner-generation',data,Date.now(),{env})};
  }
  return handler(new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})}));
 };
 const balance=async()=> (await db.prepare('SELECT COALESCE(SUM(delta),0) AS cents FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).cents;
 async function fund(user=ALICE){let payment;
  const transport=async(input,init={})=>{const u=new URL(input);if(u.pathname==='/v2/profiles/me')return Response.json({id:'pfl_TESTPROFILE'});if(u.pathname==='/v2/payments'&&init.method==='POST'){const data=JSON.parse(init.body);payment={id:'tr_Fixture001',mode:'live',profileId:'pfl_TESTPROFILE',amount:data.amount,metadata:data.metadata,status:'open',_links:{checkout:{href:'https://www.mollie.com/checkout/fixture'}}};return Response.json(payment)}if(u.pathname.endsWith('/refunds'))return Response.json({_embedded:{refunds:[]}});if(u.pathname.endsWith('/chargebacks'))return Response.json({_embedded:{chargebacks:[]}});return Response.json(payment)};
  const payments=createProductionPayment({transport});const result=await payments.user(new Request(SITE+'/api/payments/create',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify({packageId:'five',requestId:crypto.randomUUID()})}),env,user);assert.equal(result.status,200,await result.clone().text());payment.status='paid';
  for(let i=0;i<2;i++)assert.equal((await payments.webhook(new Request(env.RIG_PRODUCTION_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+payment.id}),env)).status,200);
 }
 return {mf,db,legacy,env,imageId,videoId,image,source,service,call,balance,fund,setOutcome:value=>{providerOutcome=value},setPrice:value=>{priceRate=value},setPriceDuringUpload:value=>{uploadPrice=value},setRecastPricing:value=>{recastPricing=value},priceReads:()=>[...priceReads],stats:()=>({mediaCalls,dispatches})};
}

test('fresh paid wallet: verified purchase, owned quote, one reserve, private result and isolated test balance',async()=>{
 const f=await fixture();try{
  const h=await f.service(),select={imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false};
  let r=await f.call(h,'/api/video-config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{enabled:true,funding:'credits',mode:'live',currency:'EUR',qualities:['standard','pro','edit-standard']});
  r=await f.call(h,'/api/estimate/fal?quality=pro&duration=4');assert.equal(r.status,200);const estimate=await r.json();assert.equal(estimate.customerProposal.priceCents,125);assert.equal(estimate.customerProposal.testOnly,false);assert.equal(estimate.providerEstimate,undefined);assert.doesNotMatch(JSON.stringify(estimate),/USD|usdMicros|providerEstimate|profitSnapshot|marginCents|providerVat/);
  const before=f.stats();r=await h(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:new Uint8Array(64)}));assert.equal(r.status,402);assert.equal(f.stats().mediaCalls,before.mediaCalls);
  assert.equal((await f.call(h,'/api/generation-quotes',select)).status,400);assert.equal(await f.balance(),0);
  await f.fund();assert.equal(await f.balance(),500);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,1);
  const bob=await f.service(BOB);assert.equal((await f.call(bob,'/api/generation-quotes',select)).status,400);
  r=await f.call(h,'/api/generation-quotes',select);assert.equal(r.status,201,await r.clone().text());const quote=await r.json();assert.equal(quote.priceCents,125);assert.equal(quote.providerEstimateUsdMicros,undefined);assert.doesNotMatch(JSON.stringify(quote),/USD|usdMicros|providerEstimate|profitSnapshot|marginCents|providerVat/);
  const submission={quoteId:quote.id,idempotencyKey:'paid-generation-001'};
  const results=await Promise.all([f.call(h,'/api/generations',submission),f.call(h,'/api/generations',submission)]);assert.ok(results.every(x=>[200,202,503].includes(x.status)));const accepted=results.find(x=>x.status===202);assert.ok(accepted,await Promise.all(results.map(x=>x.clone().text())));const job=await accepted.json();
  assert.equal(f.stats().dispatches,1);assert.equal(await f.balance(),375);assert.equal((await f.call(h,'/api/generations',submission)).status,200);assert.equal(f.stats().dispatches,1);
  await f.db.prepare('INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,?)').bind(ALICE,'test freeze after dispatch').run();
  r=await f.call(h,'/api/generations/'+job.id);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).state,'completed');
  r=await f.call(h,'/api/generations/'+job.id+'/video');assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>1000);
  assert.equal((await f.call(bob,'/api/generations/'+job.id)).status,404);assert.equal((await f.call(bob,'/api/generations/'+job.id+'/video')).status,404);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'reserve:%'").first()).n,1);assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'settle:%'").first()).n,1);
  assert.equal((await f.legacy.prepare('SELECT SUM(delta) cents FROM rig_ledger WHERE user_id=?').bind(ALICE).first()).cents,1000);
 }finally{await f.mf.dispose()}
});

test('one cent cannot fund unlimited preparation: cumulative quota stops work without a wallet debit or Fal generation',async()=>{
 const f=await fixture();try{
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,1)').bind('preparation-fixture-only',ALICE).run();
  const h=await f.service(),before=f.stats();
  // Absent length is conservatively charged at 16 MiB, giving eight attempts
  // under the 128 MiB allowance, even though these fixture images are small.
  for(let i=0;i<8;i++){
   const r=await h(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:f.image.slice()}));
   assert.equal(r.status,201,await r.clone().text());
   // Advance only the burst limiter's fixture window; the persisted daily
   // quota must still stop attempts made across otherwise quiet minutes.
   await f.db.prepare('UPDATE rig_rate_limits SET window_start=0').run();
  }
  const denied=await h(new Request(SITE+'/api/assets',{method:'POST',headers:{origin:SITE,'content-type':'image/jpeg','x-rig-asset-kind':'image'},body:f.image.slice()}));
  assert.equal(denied.status,429);assert.equal(f.stats().mediaCalls-before.mediaCalls,8);assert.equal(f.stats().dispatches,0);assert.equal(await f.balance(),1);
 }finally{await f.mf.dispose();}
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

const temporaryEdit={quality:'edit-standard',prompt:'Replace only the person with my identity. Keep the outdoor scene and source camera.',keepSound:true,steadyCamera:false,transferPolicy:'fal-temporary-links-v1'};
const recastFlags={RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:'no',RIG_OWNER_RECAST_VALIDATION_ENABLED:'yes',RIG_PRICE_RECAST:'30'};
const recastSelection={...temporaryEdit,quality:'human-recast',prompt:'Replace the person with reference 1.'};
test('Recast is a separate default-off owner capability, never a customer flag, stale context or O3 fallback',async()=>{
 const f=await fixture({owner:true,recastVideoDuration:6});try{
  for(const patch of [{RIG_OWNER_RECAST_VALIDATION_ENABLED:undefined},{RIG_OWNER_RECAST_VALIDATION_ENABLED:'no'},{RIG_OWNER_RECAST_VALIDATION_ENABLED:true},{RIG_PRICE_RECAST:undefined},{RIG_PRICE_RECAST:'0'},{RIG_PRICE_RECAST:30}]){
   const h=await f.service(ALICE,{...recastFlags,...patch});assert.deepEqual((await(await f.call(h,'/api/video-config')).json()).qualities,['standard','pro']);assert.equal((await f.call(h,'/api/estimate/fal?quality=human-recast&duration=6')).status,400);
  }
  const owner=await f.service(ALICE,recastFlags);assert.deepEqual((await(await f.call(owner,'/api/video-config')).json()).qualities,['standard','pro','human-recast']);
  for(const user of [BOB]){
   const customer=await f.service(user,recastFlags);assert.deepEqual((await(await customer(new Request(SITE+'/api/video-config',{headers:{'x-rig-user':ALICE,'x-rig-owner':'yes'}}))).json()).qualities,['standard','pro']);
   assert.equal((await f.call(customer,'/api/generation-quotes',{...recastSelection,imageId:f.imageId,videoId:f.videoId,funding:'owner-provider',ownerId:ALICE,RIG_OWNER_RECAST_VALIDATION_ENABLED:'yes'})).status,503);
  }
  const context=await createProductionGenerationContext({...f.env,...recastFlags});
  const forged=await createProductionVideoService({...f.env,...recastFlags},{trustedUserId:ALICE,productionContext:{...context}});assert.equal((await f.call(forged,'/api/video-config')).status,503);
  for(const [env,capability] of [[{...f.env,...recastFlags,RIG_OWNER_RECAST_VALIDATION_ENABLED:'no'},context],[{...f.env,...recastFlags},await createProductionGenerationContext({...f.env,...recastFlags,RIG_OWNER_RECAST_VALIDATION_ENABLED:'no'})]]){
   const h=await createProductionVideoService(env,{trustedUserId:ALICE,productionContext:capability});assert.deepEqual((await(await f.call(h,'/api/video-config')).json()).qualities,['standard','pro']);
  }
  const changedPin=await createProductionVideoService({...f.env,...recastFlags,RIG_PRODUCTION_OWNER_USER_ID:BOB},{trustedUserId:ALICE,productionContext:context});assert.deepEqual((await(await f.call(changedPin,'/api/video-config')).json()).qualities,['standard','pro']);
  for(const seconds of ['4.999','15.001','30'])assert.equal((await f.call(owner,'/api/estimate/fal?quality=human-recast&duration='+seconds)).status,400);
  assert.deepEqual(f.stats(),{mediaCalls:0,dispatches:0});assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
});
test('1080P Recast prices six seconds at USD2.70 and keeps normal consent, passkey, one dispatch and recovery after disabling it',async()=>{
 const f=await fixture({owner:true,recastVideoDuration:6});try{
  const env={...f.env,...recastFlags},h=await f.service(ALICE,recastFlags),selection={...recastSelection,imageId:f.imageId,videoId:f.videoId};
  let response=await f.call(h,'/api/estimate/fal?quality=human-recast&duration=6');assert.equal(response.status,200);assert.equal((await response.json()).providerEstimate.usdMicros,2700000);
  response=await f.call(h,'/api/generation-quotes',selection);assert.equal(response.status,201,await response.clone().text());const q=await response.json();assert.equal(q.quality,'human-recast');assert.equal(q.funding,'owner-provider');assert.equal(q.providerEstimateUsdMicros,2700000);assert.equal(q.durationSeconds,6);assert.equal(q.priceCents,undefined);assert.equal(q.transferConsentRequired,true);
  const stored=await f.db.prepare('SELECT model,input_json FROM rig_generation_quotes WHERE id=?').bind(q.id).first();assert.equal(stored.model,'minimax/h3-max/recast');assert.deepEqual(JSON.parse(stored.input_json).providerSettings,{resolution:'1080P',enhance_realism:true,enable_safety_checker:true});
  const context=await createProductionGenerationContext(env),approvals=createChatgptApprovals(f.db,{mode:'live',productionContext:context}),approval=await approvals.issue(ALICE,{quoteId:q.id});assert.ok(approval);
  const submit={quoteId:q.id,idempotencyKey:approval.idempotencyKey,transferConsent:'fal-temporary-links-v1'},raw=data=>h(new Request(SITE+'/api/generations',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify(data)}));
  assert.equal((await raw({quoteId:q.id,idempotencyKey:submit.idempotencyKey})).status,400);response=await raw(submit);assert.equal(response.status,428);assert.equal((await response.json()).code,'step_up_required');assert.equal(f.stats().dispatches,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
  assert.ok(await approvals.consume(ALICE,{quoteId:q.id,approvalToken:approval.approvalToken}));const verification=await verificationFor(f.db,ALICE,'owner-generation',submit,Date.now(),{env});
  response=await raw({...submit,verification});assert.equal(response.status,202,await response.clone().text());const job=await response.json();assert.equal(f.stats().dispatches,1);
  const paused=await f.service(ALICE,{...recastFlags,RIG_OWNER_RECAST_VALIDATION_ENABLED:'no'});assert.deepEqual((await(await f.call(paused,'/api/video-config')).json()).qualities,['standard','pro']);
  assert.equal((await f.call(paused,'/api/generation-quotes',selection)).status,503);response=await f.call(paused,'/api/generations/'+job.id);assert.equal(response.status,200,await response.clone().text());const completed=await response.json();assert.equal(completed.state,'completed');assert.equal((await f.call(paused,completed.videoPath)).status,200);assert.equal((await f.call(paused,'/api/generations',submit)).status,200);assert.equal(f.stats().dispatches,1);
  const usage=await f.db.prepare('SELECT state,estimated_usd_micros FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first();assert.deepEqual(usage,{state:'completed',estimated_usd_micros:2700000});
  await f.db.prepare("UPDATE rig_finance_policy SET daily_provider_limit_usd_micros=4000000,version='recast-budget-fixture' WHERE id=1").run();
  const next=await f.call(h,'/api/generation-quotes',selection);assert.equal(next.status,201,await next.clone().text());const nextQuote=await next.json();
  response=await f.call(h,'/api/generations',{quoteId:nextQuote.id,idempotencyKey:'recast-over-daily-cap',transferConsent:'fal-temporary-links-v1'});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).state,'failed');assert.equal(f.stats().dispatches,1);
  assert.equal(await f.balance(),0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('1080P Recast keeps the USD6 cap: thirteen seconds fits and fourteen is refused without another quality or higher limit',async()=>{
 const f=await fixture({owner:true,recastVideoDuration:13});try{
  const h=await f.service(ALICE,recastFlags);
  let r=await f.call(h,'/api/estimate/fal?quality=human-recast&duration=13');assert.equal(r.status,200);const estimate=await r.json();assert.equal(estimate.providerEstimate.usdMicros,5850000);assert.equal(estimate.providerEstimate.rateUsdMicrosPerSecond,450000);
  r=await f.call(h,'/api/generation-quotes',{...recastSelection,imageId:f.imageId,videoId:f.videoId});assert.equal(r.status,201,await r.clone().text());const q=await r.json();assert.equal(q.providerEstimateUsdMicros,5850000);assert.equal(JSON.parse((await f.db.prepare('SELECT input_json FROM rig_generation_quotes WHERE id=?').bind(q.id).first()).input_json).providerSettings.resolution,'1080P');
  for(const duration of ['13.001','14','15']){r=await f.call(h,'/api/estimate/fal?quality=human-recast&duration='+duration);assert.equal(r.status,400);const denied=await r.json();assert.equal(denied.code,'provider_limit_exceeded');assert.match(denied.error,/Fal-limiet.*korter/);}
  assert.ok(f.priceReads().every(quality=>quality==='human-recast'));assert.equal(f.env.RIG_CLOSED_VIDEO_MAX_USD_MICROS,'6000000');assert.equal(f.stats().dispatches,0);assert.equal(await f.balance(),0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
 }finally{await f.mf.dispose()}
 const over=await fixture({owner:true,recastVideoDuration:14});try{
  const h=await over.service(ALICE,recastFlags),r=await over.call(h,'/api/generation-quotes',{...recastSelection,imageId:over.imageId,videoId:over.videoId});assert.equal(r.status,503);assert.equal((await over.db.prepare('SELECT COUNT(*) n FROM rig_generation_quotes').first()).n,0);assert.equal(over.stats().dispatches,0);
 }finally{await over.mf.dispose()}
});
test('Recast never treats generic units as seconds, exceeds the provider cap, or extends a too-short verified source to five seconds',async()=>{
 const f=await fixture({owner:true,recastVideoDuration:6});try{
  const selection={...recastSelection,imageId:f.imageId,videoId:f.videoId};
  const capped=await f.service(ALICE,{...recastFlags,RIG_CLOSED_VIDEO_MAX_USD_MICROS:'1000000'}),denied=await f.call(capped,'/api/estimate/fal?quality=human-recast&duration=6');assert.equal(denied.status,400);assert.match((await denied.json()).error,/korter/);assert.equal((await f.call(capped,'/api/generation-quotes',selection)).status,503);
  f.setRecastPricing({provider:'fal',currency:'USD',unit:'units',prices:{'human-recast':.05}});const h=await f.service(ALICE,recastFlags);assert.equal((await f.call(h,'/api/estimate/fal?quality=human-recast&duration=6')).status,503);assert.equal((await f.call(h,'/api/generation-quotes',selection)).status,503);assert.equal(f.stats().dispatches,0);assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
 const short=await fixture({owner:true,recastVideoDuration:4.99});try{
  const h=await short.service(ALICE,recastFlags),r=await short.call(h,'/api/generation-quotes',{...recastSelection,imageId:short.imageId,videoId:short.videoId});assert.equal(r.status,400);assert.equal(short.stats().dispatches,0);assert.equal((await short.db.prepare('SELECT COUNT(*) n FROM rig_generation_quotes').first()).n,0);
 }finally{await short.mf.dispose()}
});
test('private Edit validation requires the exact pinned production owner and an explicit server switch',async()=>{
 const f=await fixture({owner:true,editVideo:true});try{
  const selection={...temporaryEdit,imageId:f.imageId,videoId:f.videoId};
  for(const flag of [undefined,'no','true',true]){
   const h=await f.service(ALICE,{RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:flag});
   assert.deepEqual((await(await f.call(h,'/api/video-config')).json()).qualities,['standard','pro']);
   assert.equal((await f.call(h,'/api/estimate/fal?quality=edit-standard&duration=5')).status,400);
   assert.equal((await f.call(h,'/api/generation-quotes',selection)).status,503);
  }
  const flags={RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:'yes'};
  const owner=await f.service(ALICE,flags);assert.deepEqual((await(await f.call(owner,'/api/video-config')).json()).qualities,['standard','pro','edit-standard']);
  for(const [user,extra] of [[BOB,{}],[ALICE,{RIG_PRODUCTION_OWNER_USER_ID:BOB}]]){
   const customer=await f.service(user,{...flags,...extra});
   const forged=new Request(SITE+'/api/video-config',{headers:{'x-rig-user':ALICE,'x-rig-owner':'true'}});
   const config=await(await customer(forged)).json();assert.equal(config.funding,'credits');assert.deepEqual(config.qualities,['standard','pro']);
   assert.equal((await f.call(customer,'/api/estimate/fal?quality=edit-standard&duration=5')).status,400);
   assert.equal((await f.call(customer,'/api/generation-quotes',{...selection,ownerId:ALICE,funding:'owner-provider',RIG_OWNER_EDIT_VALIDATION_ENABLED:'yes'})).status,503);
  }
  const context=await createProductionGenerationContext({...f.env,...flags});
  const forged=await createProductionVideoService({...f.env,...flags},{trustedUserId:ALICE,productionContext:{...context}});
  assert.equal((await f.call(forged,'/api/video-config')).status,503);
  // A private switch supplied outside the validated immutable context is not
  // enough either, even when the caller supplies the correct owner UUID.
  const noValidationContext=await createProductionGenerationContext({...f.env,RIG_EDIT_ENABLED:'no'});
  const mismatch=await createProductionVideoService({...f.env,...flags},{trustedUserId:ALICE,productionContext:noValidationContext});
  assert.deepEqual((await(await f.call(mismatch,'/api/video-config')).json()).qualities,['standard','pro']);
  // A public reduction must win over a previously created capability, and a
  // newer server flag cannot enable a capability which did not allow it.
  for(const [contextFlag,currentFlag] of [['yes','no'],['no','yes']]){
   const stale=await createProductionGenerationContext({...f.env,RIG_EDIT_ENABLED:contextFlag,RIG_OWNER_EDIT_VALIDATION_ENABLED:'yes'});
   const customer=await createProductionVideoService({...f.env,...flags,RIG_EDIT_ENABLED:currentFlag},{trustedUserId:BOB,productionContext:stale});
   assert.deepEqual((await(await f.call(customer,'/api/video-config')).json()).qualities,['standard','pro']);
   assert.equal((await f.call(customer,'/api/generation-quotes',selection)).status,503);
  }
  const staleOwner=await createProductionGenerationContext(f.env);
  const noOwnerFlagInContext=await createProductionVideoService({...f.env,...flags},{trustedUserId:ALICE,productionContext:staleOwner});
  assert.deepEqual((await(await f.call(noOwnerFlagInContext,'/api/video-config')).json()).qualities,['standard','pro']);
  assert.deepEqual(f.stats(),{mediaCalls:0,dispatches:0});assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
});

test('pausing public Edit blocks new and cached customer requests before spending while Motion and purchased credits remain usable',async()=>{
 const f=await fixture({editVideo:true});try{
  await f.fund();const selection={...temporaryEdit,imageId:f.imageId,videoId:f.videoId},open=await f.service();
  const quoted=await f.call(open,'/api/generation-quotes',selection);assert.equal(quoted.status,201,await quoted.clone().text());const quote=await quoted.json();
  const paused=await f.service(ALICE,{RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:'yes'}),before=f.stats();
  assert.deepEqual(await(await f.call(paused,'/api/video-config')).json(),{enabled:true,funding:'credits',mode:'live',currency:'EUR',qualities:['standard','pro']});
  assert.equal((await f.call(paused,'/api/generation-quotes',selection)).status,503);
  assert.equal((await f.call(paused,'/api/generations',{quoteId:quote.id,idempotencyKey:'cached-customer-edit',transferConsent:'fal-temporary-links-v1'})).status,409);
  assert.deepEqual(f.stats(),before);assert.equal(await f.balance(),500);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
  const estimate=await f.call(paused,'/api/estimate/fal?quality=pro&duration=5');assert.equal(estimate.status,200);assert.equal((await estimate.json()).customerProposal.currency,'EUR');
  const motion=await f.call(paused,'/api/generation-quotes',{imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false});assert.equal(motion.status,201,await motion.clone().text());
  assert.equal(await f.balance(),500);assert.equal(f.stats().dispatches,0);
 }finally{await f.mf.dispose()}
});

test('five-second owner Edit validation keeps the USD price, transfer consent and passkey gate and preserves accepted-job recovery',async()=>{
 const f=await fixture({owner:true,editVideo:true});try{
  const flags={RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:'yes'},env={...f.env,...flags},h=await f.service(ALICE,flags);
  const selection={...temporaryEdit,imageId:f.imageId,videoId:f.videoId};
  const estimate=await f.call(h,'/api/estimate/fal?quality=edit-standard&duration=5');assert.equal(estimate.status,200);assert.equal((await estimate.json()).providerEstimate.usdMicros,700000);
  const quoted=await f.call(h,'/api/generation-quotes',selection);assert.equal(quoted.status,201,await quoted.clone().text());const q=await quoted.json();
  assert.equal(q.funding,'owner-provider');assert.equal(q.providerCurrency,'USD');assert.equal(q.providerEstimateUsdMicros,700000);assert.equal(q.priceCents,undefined);assert.equal(q.currency,undefined);assert.equal(q.transferConsentRequired,true);
  const context=await createProductionGenerationContext(env),approvals=createChatgptApprovals(f.db,{mode:'live',productionContext:context});
  assert.equal(await approvals.issue(BOB,{quoteId:q.id}),null);const approval=await approvals.issue(ALICE,{quoteId:q.id});assert.ok(approval);
  const submit={quoteId:q.id,idempotencyKey:approval.idempotencyKey,transferConsent:'fal-temporary-links-v1'};
  const raw=data=>h(new Request(SITE+'/api/generations',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify(data)}));
  const before=f.stats();let response=await raw({quoteId:q.id,idempotencyKey:submit.idempotencyKey});assert.equal(response.status,400);
  response=await raw(submit);assert.equal(response.status,428);assert.equal((await response.json()).code,'step_up_required');
  assert.deepEqual(f.stats(),before);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);
  assert.ok(await approvals.consume(ALICE,{quoteId:q.id,approvalToken:approval.approvalToken}));
  const verification=await verificationFor(f.db,ALICE,'owner-generation',submit,Date.now(),{env});
  response=await raw({...submit,verification});assert.equal(response.status,202,await response.clone().text());const job=await response.json();assert.equal(job.funding,'owner-provider');assert.equal(job.providerEstimateUsdMicros,700000);assert.equal(f.stats().dispatches,1);
  const paused=await f.service(ALICE,{RIG_EDIT_ENABLED:'no',RIG_OWNER_EDIT_VALIDATION_ENABLED:'no'});
  assert.deepEqual((await(await f.call(paused,'/api/video-config')).json()).qualities,['standard','pro']);
  response=await f.call(paused,'/api/generations/'+job.id);assert.equal(response.status,200,await response.clone().text());const completed=await response.json();assert.equal(completed.state,'completed');
  assert.equal((await f.call(paused,completed.videoPath)).status,200);assert.equal((await f.call(paused,'/api/generations',submit)).status,200);assert.equal(f.stats().dispatches,1);
  const usage=await f.db.prepare('SELECT state,estimated_usd_micros FROM rig_owner_provider_usage WHERE job_id=?').bind(job.id).first();assert.deepEqual(usage,{state:'completed',estimated_usd_micros:700000});
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal(await f.balance(),0);
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
  await f.fund(BOB);const priced=await f.call(h,'/api/generation-quotes',select);assert.equal(priced.status,201,await priced.clone().text());const q=await priced.json();assert.equal(q.currency,'EUR');assert.equal(q.priceCents,125);assert.equal(q.funding,undefined);
  assert.equal((await f.call(h,'/api/generations',{quoteId:q.id,idempotencyKey:'customer-forged-owner'})).status,202);assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(BOB).first()).n,375);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
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
  const owner=await f.service(ALICE,{RIG_PRODUCTION_OWNER_USER_ID:ALICE});const r=await f.call(owner,'/api/generations',{quoteId:q.id,idempotencyKey:'historical-owner-credit'});assert.equal(r.status,202,await r.clone().text());const job=await r.json();assert.equal(job.currency,'EUR');assert.equal(job.priceCents,125);assert.equal(job.funding,undefined);assert.equal(await f.balance(),375);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_owner_provider_usage').first()).n,0);
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

for(const [quality,providerRate,expected]of [['standard',.126,125],['pro',.168,163]])test(`${quality} four-second preview and final quote share the minimal safe retail price`,async()=>{
 const f=await fixture();try{
  await f.fund();f.setPrice(providerRate);
  const h=await f.service(ALICE,{RIG_PRICE_STANDARD:'30',RIG_PRICE_PRO:'40',RIG_PRICE_EDIT:'35',RIG_CLOSED_VIDEO_MAX_CENTS:'1200'});
  const preview=await(await f.call(h,`/api/estimate/fal?quality=${quality}&duration=4`)).json();assert.equal(preview.customerProposal.priceCents,expected);
  const response=await f.call(h,'/api/generation-quotes',{imageId:f.imageId,videoId:f.videoId,quality,keepSound:false,steadyCamera:false});assert.equal(response.status,201,await response.clone().text());
  const quoted=await response.json();assert.equal(quoted.priceCents,expected);assert.doesNotMatch(JSON.stringify(quoted),/profitSnapshot|providerEstimate|marginCents/);
  const stored=await f.db.prepare('SELECT input_json FROM rig_generation_quotes WHERE id=?').bind(quoted.id).first(),snapshot=JSON.parse(stored.input_json).profitSnapshot;assert.equal(snapshot.retailPriceCents,expected);assert.ok(snapshot.marginBps>=3000);assert.equal(f.stats().dispatches,0);
 }finally{await f.mf.dispose();}
});

test('a provider price increase during upload is checked again, refunds once and never submits inference or changes the confirmed price',async()=>{
 const f=await fixture();try{
  await f.fund();const h=await f.service(),select={imageId:f.imageId,videoId:f.videoId,quality:'pro',keepSound:false,steadyCamera:false};
  const quoted=await(await f.call(h,'/api/generation-quotes',select)).json();assert.equal(quoted.priceCents,125);
  f.setPriceDuringUpload(.2);const submit={quoteId:quoted.id,idempotencyKey:'rate-changed-during-upload'};
  let response=await f.call(h,'/api/generations',submit);assert.equal(response.status,200,await response.clone().text());const failed=await response.json();assert.equal(failed.state,'failed');assert.equal(failed.refundConfirmed,true);assert.equal(failed.priceCents,125);assert.match(failed.message,/nieuwe prijsopgave/);assert.doesNotMatch(failed.message,/Bestanden konden/);
  assert.equal(f.stats().dispatches,0);assert.equal(await f.balance(),500);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_generation_costs').first()).n,0);
  response=await f.call(h,'/api/generations',submit);assert.equal(response.status,200);assert.equal((await response.json()).state,'failed');assert.equal(await f.balance(),500);assert.equal(f.stats().dispatches,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'release:%'").first()).n,1);
 }finally{await f.mf.dispose();}
});
