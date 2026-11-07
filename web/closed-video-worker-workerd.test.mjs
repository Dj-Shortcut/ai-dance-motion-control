import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const origin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co',owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('real workerd composition gates owner through private identity and test D1',async()=>{
 const bundled=await build({stdin:{contents:"import {createClosedVideoWorker} from './closed-video-worker.mjs'; export default createClosedVideoWorker({pricePreflight:async()=>({provider:'fal',currency:'USD',unit:'second',prices:{standard:0.06,pro:0.11}})});",resolveDir:process.cwd(),sourcefile:'video-fixture.mjs'},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
 const vars={RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,RIG_TEST_ENVIRONMENT_ID:'closed-test-1',SUPABASE_URL:project,RIG_VIDEO_OWNER_USER_ID:owner,RIG_MEDIA_SECRET:'x'.repeat(40),FAL_KEY:'fake-no-network',RIG_PRICE_STANDARD:'25',RIG_PRICE_PRO:'30',RIG_PRICE_VERSION:'fixture-1',RIG_CLOSED_VIDEO_MAX_CENTS:'300',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'500000'};
 const identity=`export default {fetch(req){if(new URL(req.url).pathname!='/api/session'||req.headers.has('oai-authenticated-user-id'))return new Response(null,{status:400});const a=req.headers.get('authorization');return a==='Bearer a.b.c'?Response.json({userId:'${owner}'}):a==='Bearer d.e.f'?Response.json({userId:'${other}'}):new Response(null,{status:401})}}`;
 const mf=new Miniflare({cf:false,workers:[{name:'video',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-01-01',bindings:vars,d1Databases:{DB:'closed-video'},r2Buckets:{BUCKET:'closed-video'},serviceBindings:{CLOSED_IDENTITY_SERVICE:'identity',RIG_MEDIA:'media'}},{name:'identity',modules:true,script:identity,compatibilityDate:'2026-01-01'},{name:'media',modules:true,script:'export default {fetch(){return new Response(null,{status:503})}}',compatibilityDate:'2026-01-01'}]});
 try{
  const db=await mf.getD1Database('DB','video');
  for(const file of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql']){const sql=(await readFile(`closed-payment-migrations/${file}`,'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run()}
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-test-1','test',origin,project,'','').run();
  await db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(`${project}/auth/v1`,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner).run();
  const get=(path,token,extra={})=>mf.dispatchFetch(origin+path,{headers:{authorization:`Bearer ${token}`,...extra}});
  assert.deepEqual(await (await get('/api/video-config','a.b.c')).json(),{enabled:true,funding:'owner'});
  assert.deepEqual(await (await get('/api/video-config','d.e.f',{'oai-authenticated-user-id':owner})).json(),{enabled:false});
  assert.equal((await get('/api/generations/recent','d.e.f')).status,503);
  assert.equal((await get('/api/generations/recent','a.b.c')).status,200);
  const estimate=await get('/api/estimate/fal?quality=pro&duration=4','a.b.c');assert.equal(estimate.status,200);assert.equal((await estimate.json()).providerEstimate.usdMicros,440000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rig_rate_limits WHERE bucket='rig-closed-video-global-one-attempt-v1'").first()).n,0);
  await db.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1)').bind('rig-closed-video-global-one-attempt-v1',1).run();
  const before=await db.prepare('SELECT (SELECT COUNT(*) FROM rig_generation_jobs) jobs,(SELECT COUNT(*) FROM rig_generation_quotes) quotes,(SELECT COUNT(*) FROM rig_ledger) ledger').first();
  assert.deepEqual(await (await get('/api/video-config','a.b.c')).json(),{enabled:true,funding:'owner'});
  for(const path of ['/api/assets','/api/generation-quotes']){
   const response=await mf.dispatchFetch(origin+path,{method:'POST',headers:{authorization:'Bearer a.b.c',origin,'content-type':'application/json'},body:'{}'});
   assert.equal(response.status,400);assert.notEqual((await response.json()).code,'test_limit_reached');
  }
  assert.equal((await get('/api/generations/recent','a.b.c')).status,200);
  assert.deepEqual(await db.prepare('SELECT (SELECT COUNT(*) FROM rig_generation_jobs) jobs,(SELECT COUNT(*) FROM rig_generation_quotes) quotes,(SELECT COUNT(*) FROM rig_ledger) ledger').first(),before);
 }finally{await mf.dispose()}
});
