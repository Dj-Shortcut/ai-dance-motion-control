import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {build} from 'esbuild';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {createClosedVideoService,closedVideoTesting} from './closed-video-service.mjs';
import {Miniflare} from 'miniflare';
import {createD1GenerationStores} from './d1.mjs';
async function migrate(db,file){const sql=(await readFile(file,'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
const config={LOCAL_FIXTURE:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.local',RIG_SITES_BRIDGE_ORIGIN:'https://gateway.example',RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'local-fake-not-a-key',RIG_PRICE_STANDARD:'25',RIG_PRICE_PRO:'25',RIG_PRICE_VERSION:'fixture-1',RIG_CLOSED_VIDEO_MAX_CENTS:'300',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'500000'};
const send=(mf,user,path,{method='GET',body,headers={}}={})=>mf.dispatchFetch('https://rig.local'+path,{method,headers:{'x-local-user':user,...(method==='POST'?{origin:'https://rig.local'}:{}),...headers},...(body?{body}:{})});
const json=(mf,user,path,obj)=>send(mf,user,path,{method:'POST',body:JSON.stringify(obj),headers:{'content-type':'application/json'}});
test('30-second owner media is prepared and priced without submitting a generation',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.closed-video-30-'));let mf;try{
  const videoPath=join(dir,'thirty.mp4');await promisify(execFile)('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','color=c=blue:s=360x360:r=30:d=30','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',videoPath]);
  for(const [input,out] of [['closed-video-test-fixture.mjs','main.mjs'],['cloud-media-workerd-fixture.mjs','media.mjs']])await build({entryPoints:[input],outfile:join(dir,out),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  mf=new Miniflare({cf:false,workers:[{name:'main',modules:true,scriptPath:join(dir,'main.mjs'),compatibilityDate:'2026-01-01',bindings:{...config,RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000'},d1Databases:{DB:'closed-video'},r2Buckets:{BUCKET:'closed-video'},serviceBindings:{RIG_MEDIA:'media'}},{name:'media',modules:true,scriptPath:join(dir,'media.mjs'),compatibilityDate:'2026-01-01',r2Buckets:{BUCKET:'closed-video'}}]});
  const db=await mf.getD1Database('DB','main');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');await migrate(db,'closed-payment-migrations/0004_test_media_work_lock.sql');await db.prepare('CREATE TABLE rig_fixture_fal_dispatch(id TEXT PRIMARY KEY,created_at INTEGER)').run();
  async function upload(kind,data){const r=await send(mf,'alice','/api/assets',{method:'POST',body:data,headers:{'content-type':kind==='image'?'image/jpeg':'video/mp4','x-rig-asset-kind':kind,...(kind==='video'?{'x-rig-duration-seconds':'30','x-rig-keep-sound':'false'}:{})}});assert.equal(r.status,201,await r.clone().text());return (await r.json()).id}
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('thirty-fund','alice',1000).run();const imageId=await upload('image',await readFile('test/fixtures/input.jpg')),videoId=await upload('video',await readFile(videoPath));
  const response=await json(mf,'alice','/api/generation-quotes',{imageId,videoId,quality:'pro',keepSound:false,steadyCamera:false});assert.equal(response.status,201,await response.clone().text());const quote=await response.json();assert.equal(quote.durationSeconds,30);assert.equal(quote.billedSeconds,30);assert.equal(quote.priceCents,750);assert.equal(quote.providerEstimateUsdMicros,3000000);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,0);assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_rate_limits WHERE bucket='rig-closed-video-global-one-attempt-v1'").first()).n,0);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
test('missing configuration, untrusted transport and live modes fail closed',async()=>{const db={prepare(){throw Error('not reached')},batch(){}};const env={...config,DB:db,RIG_MEDIA:{fetch(){}},BUCKET:{get(){},put(){},head(){}}};assert.equal(closedVideoTesting.valid(env),true);assert.equal(closedVideoTesting.valid({...env,RIG_CLOSED_VIDEO_MAX_CENTS:'800',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000'}),true);for(const e of [{...env,RIG_CLOSED_VIDEO_ENABLED:undefined},{...env,RIG_MODE:'live'},{...env,RIG_MOLLIE_MODE:'live'},{...env,RIG_PRICE_VERSION:''},{...env,RIG_CLOSED_VIDEO_MAX_CENTS:'801'},{...env,RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000001'},{...env,RIG_MEDIA_SECRET:''}])assert.equal(closedVideoTesting.valid(e),false);const disabled=await createClosedVideoService(env,{trustedUserId:'alice'});assert.equal((await disabled(new Request('https://rig.local/api/generations/recent'))).status,503);let calls=0;const transport=closedVideoTesting.providerTransport(async()=>{calls++;return new Response(null,{status:302})});await assert.rejects(transport('https://attacker.example/',{redirect:'manual'}));await assert.rejects(transport('https://queue.fal.run/',{redirect:'follow'}));assert.equal(calls,0);await assert.rejects(transport('https://queue.fal.run/',{redirect:'manual'}));assert.equal(calls,1);});
test('O3 composition requires operator enablement and a price, then reserves the exact verified edit quote once',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.closed-video-edit-'));let mf;try{
  const path=join(dir,'five.mp4');await promisify(execFile)('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=30:d=5','-an','-c:v','libx264','-threads','2','-movflags','+faststart','-y',path]);
  for(const [input,out] of [['closed-video-test-fixture.mjs','main.mjs'],['cloud-media-workerd-fixture.mjs','media.mjs']])await build({entryPoints:[input],outfile:join(dir,out),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  const create=extra=>new Miniflare({cf:false,d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workers:[{name:'main',modules:true,scriptPath:join(dir,'main.mjs'),compatibilityDate:'2026-01-01',bindings:{...config,RIG_CLOSED_VIDEO_MAX_USD_MICROS:'6000000',...extra},d1Databases:{DB:'edit'},r2Buckets:{BUCKET:'edit'},serviceBindings:{RIG_MEDIA:'media'}},{name:'media',modules:true,scriptPath:join(dir,'media.mjs'),compatibilityDate:'2026-01-01',r2Buckets:{BUCKET:'edit'}}]});
  mf=create({RIG_PRICE_EDIT:'20'});let db=await mf.getD1Database('DB','main');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');await migrate(db,'closed-payment-migrations/0004_test_media_work_lock.sql');await db.prepare('CREATE TABLE rig_fixture_fal_dispatch(id TEXT PRIMARY KEY,created_at INTEGER)').run();await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('edit-fund','alice',500).run();
  const upload=async(kind,data)=>{const r=await send(mf,'alice','/api/assets',{method:'POST',body:data,headers:{'content-type':kind==='image'?'image/jpeg':'video/mp4','x-rig-asset-kind':kind,...(kind==='video'?{'x-rig-duration-seconds':'5','x-rig-keep-sound':'false'}:{})}});assert.equal(r.status,201,await r.clone().text());return (await r.json()).id};
  await db.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',123).run();
  const imageId=await upload('image',await readFile('test/fixtures/input.jpg')),videoId=await upload('video',await readFile(path)),selection={imageId,videoId,quality:'edit-standard',keepSound:false,prompt:'Use the dog in @Image1.'};
  assert.equal((await json(mf,'alice','/api/generation-quotes',selection)).status,503);await mf.dispose();
  mf=create({RIG_EDIT_ENABLED:'yes'});assert.equal((await json(mf,'alice','/api/generation-quotes',selection)).status,503);await mf.dispose();
  mf=create({RIG_EDIT_ENABLED:'yes',RIG_PRICE_EDIT:'20'});db=await mf.getD1Database('DB','main');
  let r=await json(mf,'alice','/api/generation-quotes',selection);assert.equal(r.status,201,await r.clone().text());const quote=await r.json();assert.equal(quote.priceCents,100);assert.equal(quote.durationSeconds,5);assert.equal(quote.providerEstimateUsdMicros,700000);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,0);assert.equal((await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind('alice').first()).n,500);
  const spare=await (await json(mf,'alice','/api/generation-quotes',selection)).json(),request={quoteId:quote.id,idempotencyKey:'edit-attempt'};
  const unchanged=async()=>{assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_generation_jobs').first()).n,0);assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'reserve:%'").first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,0)};
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-low-balance','alice',-450).run();
  assert.equal((await json(mf,'alice','/api/generations',request)).status,409);await unchanged();
  await db.prepare("DELETE FROM rig_ledger WHERE event_id='fixture-low-balance'").run();
  await db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES('alice','fixture')").run();
  assert.equal((await json(mf,'alice','/api/generations',request)).status,409);await unchanged();
  await db.prepare("DELETE FROM rig_frozen_accounts WHERE user_id='alice'").run();
  const confirms=await Promise.all([json(mf,'alice','/api/generations',request),json(mf,'alice','/api/generations',request)]);r=confirms.find(x=>x.status===202);assert.ok(r);const job=(await r.json()).id;
  assert.equal((await json(mf,'alice','/api/generations',request)).status,200);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,1);assert.equal((await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind('alice').first()).n,400);
  assert.equal((await json(mf,'alice','/api/generations',{quoteId:spare.id,idempotencyKey:'edit-next'})).status,409);assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,1);
  r=await send(mf,'alice',`/api/generations/${job}`);assert.equal((await r.json()).state,'completed');assert.equal((await send(mf,'bob',`/api/generations/${job}/video`)).status,404);
  r=await json(mf,'alice','/api/generations',{quoteId:spare.id,idempotencyKey:'edit-next'});assert.equal(r.status,202,await r.clone().text());assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,2);assert.equal((await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind('alice').first()).n,300);
  assert.deepEqual(await db.prepare('SELECT window_start,requests FROM rig_rate_limits WHERE bucket=?').bind('rig-closed-video-global-one-attempt-v1').first(),{window_start:123,requests:1});
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
test('owner allowance requires the exact live ledger reservation and ignores historical trial markers',async()=>{
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'owner-allowance'}});
 try{
  const db=await mf.getD1Database('DB');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fund','alice',500).run();
  await db.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',123).run();
  const stores=createD1GenerationStores(db,{mode:'test'}),created=await stores.quotes.create({userId:'alice',model:'fal-ai/kling-video/o3/standard/video-to-video/edit',input:{data:{quality:'edit-standard'}},priceCents:100,pricingVersion:'v1',durationSeconds:5}),quote=await stores.quotes.getOwned('alice',created.id);
  const allowance=closedVideoTesting.guard({...config,DB:db},async()=>{}, {trustedUserId:'alice',accessMode:'owner'});
  assert.equal(await allowance.permits({durationSeconds:5,priceCents:100}),true);
  const start=await stores.jobs.begin({userId:'alice',quoteId:quote.id,idempotencyKey:'confirmed',quote});assert.equal(start.kind,'created');
  const input={userId:'alice',jobId:start.job.id,quote};assert.equal(await allowance.claimOnce(input),true);
  for(const bad of [{...input,userId:'bob'},{...input,jobId:crypto.randomUUID()},{...input,quote:{...quote,id:crypto.randomUUID()}},{...input,quote:{...quote,model:'fal-ai/kling-video/v3/pro/motion-control'}},{...input,quote:{...quote,priceCents:99}},{...input,quote:{...quote,userId:'bob'}}])assert.equal(await allowance.claimOnce(bad),false);
  await db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES('alice','fixture')").run();assert.equal(await allowance.claimOnce(input),false);assert.equal(await allowance.permits({durationSeconds:5,priceCents:100}),false);await db.prepare("DELETE FROM rig_frozen_accounts WHERE user_id='alice'").run();
  for(const [event,delta] of [[`release:${start.job.id}`,100],[`settle:${start.job.id}`,0],['fixture-overdrawn',-401]]){
   await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind(event,'alice',delta).run();assert.equal(await allowance.claimOnce(input),false);await db.prepare('DELETE FROM rig_ledger WHERE event_id=?').bind(event).run();
  }
  assert.equal(await allowance.claimOnce(input),true);assert.equal(await stores.jobs.authorizeDispatch('alice',start.job.id),true);assert.equal(await allowance.claimOnce(input),false);assert.equal(await stores.jobs.authorizeDispatch('alice',start.job.id),false);
  assert.deepEqual(await db.prepare('SELECT window_start,requests FROM rig_rate_limits WHERE bucket=?').bind('rig-closed-video-global-one-attempt-v1').first(),{window_start:123,requests:1});
 }finally{await mf.dispose()}
});
test('tenant verifier must explicitly succeed before acquiring a lease',async()=>{let acquired=0;const db={prepare:()=>({first:async()=>({mode:'test'})}),batch(){}};const env={...config,DB:db,RIG_MEDIA:{fetch(){}},BUCKET:{get(){},put(){},head(){}}};const lease={acquire:async()=>{acquired++;return {state:'acquired',token:'token'}},complete:async()=>{}};for(const verifyTenant of [undefined,async()=>false,async()=>{throw Error('no tenant')}]){const h=await createClosedVideoService(env,{trustedUserId:'alice',lease,verifyTenant});assert.equal((await h(new Request('https://rig.local/api/assets',{method:'POST'}))).status,503)}assert.equal(acquired,0);});
test('media lock records explicit settled versus uncertain and status bypasses it',async()=>{
 const db={prepare(sql){return {bind(){return this},async first(){if(sql.includes('rig_payment_environment'))return {mode:'test'};if(sql==='SELECT bucket FROM rig_rate_limits WHERE bucket=?')return null;if(sql.includes('rig_rate_limits'))return {requests:1};return null}}},batch(){}};
 let mode='connection-failed',acquired=0,outcomes=[];
 const env={...config,DB:db,BUCKET:{get(){},put(){},head(){}},RIG_MEDIA:{fetch:async()=>{
  if(mode==='connection-failed')throw Error('lost response');
  return new Response(null,{status:422,headers:mode==='settled'?{'x-rig-media-settled':'1','x-rig-media-diagnostic':'fps'}:{'x-rig-media-settled':'1','x-rig-media-uncertain':'1'}});
 }}};
 const lease={acquire:async()=>{acquired++;return {state:'acquired',token:crypto.randomUUID()}},complete:async(_token,outcome)=>{outcomes.push(outcome)}};
 const service=await createClosedVideoService(env,{trustedUserId:'alice',lease,verifyTenant:async()=>true,providerFetch:async()=>{throw Error('no provider')}});
 const asset=()=>new Request('https://rig.local/api/assets',{method:'POST',headers:{origin:'https://rig.local','content-type':'image/jpeg','x-rig-asset-kind':'image'},body:new Uint8Array(64)});
 let response=await service(asset());assert.equal(response.status,503);assert.equal(outcomes.at(-1),'uncertain');assert.equal(response.headers.get('x-rig-media-uncertain'),null);
 mode='settled';response=await service(asset());assert.equal(response.status,503);assert.equal(outcomes.at(-1),'settled');
 mode='contradictory';await service(asset());assert.equal(outcomes.at(-1),'uncertain');
 const before=acquired;response=await service(new Request('https://rig.local/api/generations/recent'));assert.equal(response.status,200);assert.equal(acquired,before);
});
test('closed composition: private assets, scoped jobs and per-request ledger budget',async()=>{const dir=await mkdtemp(join(process.cwd(),'.closed-video-'));let mf;try{
 for(const [input,out] of [['closed-video-test-fixture.mjs','main.mjs'],['cloud-media-workerd-fixture.mjs','media.mjs']])await build({entryPoints:[input],outfile:join(dir,out),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
 const create=bindings=>new Miniflare({cf:false,d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workers:[{name:'main',modules:true,scriptPath:join(dir,'main.mjs'),compatibilityDate:'2026-01-01',bindings,d1Databases:{DB:'closed-video'},r2Buckets:{BUCKET:'closed-video'},serviceBindings:{RIG_MEDIA:'media'}},{name:'media',modules:true,scriptPath:join(dir,'media.mjs'),compatibilityDate:'2026-01-01',r2Buckets:{BUCKET:'closed-video'}}]});
 mf=create({...config,RIG_CLOSED_VIDEO_ENABLED:'no'});assert.equal((await send(mf,'alice','/api/generations/recent')).status,503);await mf.dispose();
 mf=create(config);const db=await mf.getD1Database('DB','main');await migrate(db,'cloudflare-migrations/0001_test_baseline.sql');await migrate(db,'closed-payment-migrations/0004_test_media_work_lock.sql');await db.prepare('CREATE TABLE rig_fixture_fal_dispatch(id TEXT PRIMARY KEY,created_at INTEGER)').run();for(const u of ['alice','bob'])await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fund-'+u,u,1000).run();
 const image=await readFile('test/fixtures/input.jpg'),video=await readFile('test/fixtures/silent.mp4');
 async function upload(user,kind,data){let r=await send(mf,user,'/api/assets',{method:'POST',body:data,headers:{'content-type':kind==='image'?'image/jpeg':'video/mp4','x-rig-asset-kind':kind,...(kind==='video'?{'x-rig-duration-seconds':'4','x-rig-keep-sound':'false'}:{})}});assert.equal(r.status,201,await r.clone().text());return (await r.json()).id;}
 const ai=await upload('alice','image',image),av=await upload('alice','video',video),bi=await upload('bob','image',image),bv=await upload('bob','video',video);
 const selection=(imageId,videoId)=>({imageId,videoId,quality:'pro',keepSound:false,steadyCamera:false});
 assert.equal((await json(mf,'bob','/api/generation-quotes',selection(ai,av))).status,400);
 let r=await json(mf,'alice','/api/generation-quotes',selection(ai,av));assert.equal(r.status,201,await r.clone().text());const aq=await r.json();assert.equal(aq.priceCents,100);
 r=await json(mf,'bob','/api/generation-quotes',selection(bi,bv));assert.equal(r.status,201,await r.clone().text());const bq=await r.json();
 assert.equal((await json(mf,'bob','/api/generations',{quoteId:aq.id,idempotencyKey:'bob-steal'})).status,409);
 const submit={quoteId:aq.id,idempotencyKey:'same-request'};const concurrent=await Promise.all([json(mf,'alice','/api/generations',submit),json(mf,'alice','/api/generations',submit)]);assert.ok(concurrent.every(x=>[200,202,503].includes(x.status)));const accepted=concurrent.find(x=>x.status===202);assert.ok(accepted);const job=(await accepted.json()).id;
 r=await json(mf,'alice','/api/generations',submit);assert.equal(r.status,200);assert.equal((await r.json()).id,job);
 assert.equal((await db.prepare('SELECT count(*) n FROM rig_fixture_fal_dispatch').first()).n,1);
 assert.equal((await send(mf,'bob',`/api/generations/${job}`)).status,404);assert.equal((await send(mf,'bob',`/api/generations/${job}/video`)).status,404);
 r=await send(mf,'alice',`/api/generations/${job}`);assert.equal((await r.json()).state,'completed');r=await send(mf,'alice',`/api/generations/${job}/video`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),video);
 r=await json(mf,'bob','/api/generations',{quoteId:bq.id,idempotencyKey:'bob-own'});assert.equal(r.status,202);assert.equal((await db.prepare('SELECT count(*) n FROM rig_fixture_fal_dispatch').first()).n,2);assert.equal((await db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind('bob').first()).n,900);
 assert.equal((await send(mf,'alice','/api/payments/balance')).status,404);
 // An uncertain transform blocks new transforms, not status/recovery/results.
 await db.prepare("INSERT INTO rig_media_work_lock(id,token,user_id,state,created_at,updated_at) VALUES(1,?,?,'uncertain',1,1)").bind(crypto.randomUUID(),'alice').run();
 assert.equal((await send(mf,'alice','/api/assets',{method:'POST',body:image,headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'}})).status,503);
 assert.equal((await send(mf,'alice','/api/generations/recent')).status,200);
 r=await json(mf,'alice','/api/generation-intents/unseen-attempt/reconcile',{quoteId:'unseen-quote'});assert.equal(r.status,200);assert.equal((await r.json()).state,'canceled');
 assert.equal((await send(mf,'alice',`/api/generations/${job}/video`)).status,200);
 await mf.dispose();mf=create(config);r=await send(mf,'alice',`/api/generations/${job}/video`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),video);
 await mf.dispose();mf=create({...config,RIG_CLOSED_VIDEO_MAX_USD_MICROS:'300000'});r=await json(mf,'bob','/api/generation-quotes',selection(bi,bv));assert.equal(r.status,503);assert.equal((await (await mf.getD1Database('DB','main')).prepare('SELECT count(*) n FROM rig_fixture_fal_dispatch').first()).n,2);
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}});
