import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {mintProofProviderInput} from './rig-provider-inputs.mjs';
import {GATEWAY_PROOF_JOB,gatewayProofBucket} from './rig-gateway-verification.mjs';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const origin='https://rig-bridge.example.workers.dev',site='https://rig.example.chatgpt.site',privateOrigin='https://rig.local',project='https://abcdefghijklmnopqrst.supabase.co';
const owner='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',image='11111111-1111-4111-8111-111111111111',video='22222222-2222-4222-8222-222222222222',quote='33333333-3333-4333-8333-333333333333',secret='x'.repeat(40);
const bytes=new TextEncoder().encode('test image bytes');
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
test('actual HTTP HEAD, GET and range traverse public workerd relay, service binding, private worker and private media',async()=>{
 const sha=await hash(bytes),now=Date.now();
 const config=await readFile('wrangler.closed-video.toml','utf8');assert.match(config,/^compatibility_flags\s*=\s*\[\s*"global_fetch_strictly_public"\s*\]/m);
 const publicBundle=await build({stdin:{contents:`import relay from './sites-bridge-ingress.mjs';export default {fetch(req,env){const u=new URL(req.url);const bridge=new Request('${origin}'+u.pathname+u.search,req);return relay.fetch(bridge,{...env,RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})}})}}`,resolveDir:process.cwd(),sourcefile:'http-relay-fixture.mjs'},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
 const privateBundle=await build({entryPoints:['closed-video-worker.mjs'],bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
 const publicEnv={RIG_SITES_RELAY_ENABLED:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_SITES_BRIDGE_ORIGIN:origin,RIG_SITES_PRODUCER_ORIGIN:site};
 const privateEnv={RIG_CLOSED_VIDEO_ENABLED:'yes',RIG_VIDEO_PRIVATE_SERVICE_ONLY:'yes',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:privateOrigin,RIG_SITES_BRIDGE_ORIGIN:origin,RIG_TEST_ENVIRONMENT_ID:'closed-test-1',SUPABASE_URL:project,RIG_VIDEO_OWNER_USER_ID:owner,RIG_MEDIA_SECRET:secret,FAL_KEY:'fake-no-network',RIG_PRICE_STANDARD:'25',RIG_PRICE_PRO:'30',RIG_PRICE_VERSION:'fixture-1',RIG_CLOSED_VIDEO_MAX_CENTS:'300',RIG_CLOSED_VIDEO_MAX_USD_MICROS:'500000'};
 const media=`export default {fetch(req){if(req.headers.get('x-rig-user')!=='${owner}'||req.headers.get('authorization')!=='Bearer ${secret}'||new URL(req.url).pathname!=='/v1/assets/${image}')return new Response(null,{status:403});return new Response('test image bytes',{headers:{'content-type':'image/jpeg','content-length':'16','x-rig-asset-kind':'image','x-rig-sha256':'${sha}'}})}}`;
 const mf=new Miniflare({workers:[{name:'relay',modules:true,script:publicBundle.outputFiles[0].text,compatibilityDate:'2026-01-01',bindings:publicEnv,serviceBindings:{CLOSED_VIDEO_SERVICE:'private'}},{name:'private',modules:true,script:privateBundle.outputFiles[0].text,compatibilityDate:'2026-01-01',compatibilityFlags:['global_fetch_strictly_public'],bindings:privateEnv,d1Databases:{DB:'gateway'},r2Buckets:{BUCKET:'gateway'},serviceBindings:{RIG_MEDIA:'media'}},{name:'media',modules:true,script:media,compatibilityDate:'2026-01-01'}]});
 try{
  const db=await mf.getD1Database('DB','private');
  for(const f of ['0001_test_baseline.sql','0002_public_identity.sql','0003_closed_tenant.sql','0004_test_media_work_lock.sql'])for(const s of (await readFile('closed-payment-migrations/'+f,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-test-1','test',privateOrigin,project,'','').run();
  await db.prepare('INSERT INTO rig_external_identities(issuer,subject,user_id) VALUES(?,?,?)').bind(project+'/auth/v1','owner',owner).run();
  const input={data:{quality:'edit-standard',faceId:null,steadyCamera:false,angleIds:[],imageId:image,videoId:video},refs:[{id:image,kind:'image',sha256:sha},{id:video,kind:'video',sha256:'b'.repeat(64)}]};
  await db.prepare('INSERT INTO rig_generation_quotes VALUES(?,?,?,?,?,?,?,?,?)').bind(quote,owner,'fal-ai/kling-video/o3/standard/video-to-video/edit',JSON.stringify(input),100,'fixture',5,now+60000,now).run();
  await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,fal_request_id,failure_code,created_at) VALUES(?,?,?,?,100,'failed','01a1b727-0a43-7331-b508-6b03cfd8bcfb','provider_input_unavailable',?)").bind(GATEWAY_PROOF_JOB,owner,quote,'original',now).run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?),(?,?,?)').bind('reserve:'+GATEWAY_PROOF_JOB,owner,-100,'release:'+GATEWAY_PROOF_JOB,owner,100).run();
  await db.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1)').bind(gatewayProofBucket(),now).run();
  const capability=await mintProofProviderInput({origin,secret,jobId:GATEWAY_PROOF_JOB,assetId:image,sha256:sha,kind:'image',issuedAt:now}),target=new URL(new URL(capability).pathname,await mf.ready),base={'cf-connecting-ip':'192.0.2.1'};
  const automaticIp=await fetch(target,{method:'HEAD'});assert.equal(automaticIp.status,200);assert.equal(automaticIp.headers.get('content-length'),'16');
  const head=await fetch(target,{method:'HEAD',headers:base});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'image/jpeg');assert.equal(head.headers.get('content-length'),'16');assert.equal(head.headers.get('accept-ranges'),'bytes');assert.equal(await head.text(),'');
  const partial=await fetch(target,{headers:{...base,range:'bytes=2-5'}});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-length'),'4');assert.equal(partial.headers.get('content-range'),'bytes 2-5/16');assert.equal(await partial.text(),'st i');
  const full=await fetch(target,{headers:base});assert.equal(full.status,200);assert.equal(full.headers.get('content-length'),'16');assert.equal(await full.text(),'test image bytes');
 }finally{await mf.dispose()}
});
