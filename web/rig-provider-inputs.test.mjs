import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {mintProviderInput,mintProofProviderInput,handleProviderInput,isProviderInputUrl,verifyProviderInput} from './rig-provider-inputs.mjs';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const origin='https://gateway.example', secret='x'.repeat(40),job='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',image='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',video='cccccccc-cccc-4ccc-8ccc-cccccccccccc',user='u-owner';
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
const bytes=new TextEncoder().encode('test image bytes');
const model='fal-ai/kling-video/o3/standard/video-to-video/edit';
test('invalid capabilities do not reach tenant, database or media',async()=>{
 let calls=0;const sha=await hash(bytes),url=await mintProviderInput({origin,secret,jobId:job,assetId:image,sha256:sha,kind:'image'});
 const env={RIG_SITES_BRIDGE_ORIGIN:origin,RIG_MEDIA_SECRET:secret,DB:{prepare(){calls++;throw Error()}},RIG_MEDIA:{fetch(){calls++;throw Error()}}};
 const verifyTenant=()=>{calls++;return true};
 for(const bad of [url.replace(/\.[a-f0-9]{64}\//,'.'+'0'.repeat(64)+'/'),url+'?identity=x',url.replace(origin,'https://evil.example'),url.replace('.jpg','.mp4')]){
  if(bad.endsWith('.mp4'))continue;assert.equal((await handleProviderInput(new Request(bad),env,{verifyTenant})).status,404);
 }
 assert.equal((await handleProviderInput(new Request(url),env,{verifyTenant,now:Date.now()+6*3600*1000+1})).status,404);
 assert.equal((await handleProviderInput(new Request(url,{method:'POST'}),env,{verifyTenant})).status,404);
 assert.equal(calls,0);
 assert.equal(isProviderInputUrl(url,origin,'image'),true);assert.equal(isProviderInputUrl(url+'?x',origin,'image'),false);
});
test('real D1 checks funding, ownership, hashes, status, HEAD and single byte ranges',async()=>{
 const sha=await hash(bytes),vsha='b'.repeat(64);
 const bundle=await build({stdin:{contents:"import {handleProviderInput} from './rig-provider-inputs.mjs';export default {fetch:(req,env)=>handleProviderInput(req,env,{verifyTenant:async()=>true})}",resolveDir:process.cwd(),sourcefile:'gateway-fixture.mjs'},bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});
 const media=`export default {fetch(req){if(req.headers.get('X-Rig-User')!=='${user}'||req.headers.get('authorization')!=='Bearer ${secret}')return new Response(null,{status:403});return new Response('test image bytes',{headers:{'content-type':'image/jpeg','content-length':'16','x-rig-asset-kind':'image','x-rig-sha256':'${sha}'}})}}`;
 const mf=new Miniflare({workers:[{name:'gateway',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',bindings:{RIG_SITES_BRIDGE_ORIGIN:origin,RIG_MEDIA_SECRET:secret,RIG_MODE:'test',RIG_MOLLIE_MODE:'test'},d1Databases:{DB:'gateway'},serviceBindings:{RIG_MEDIA:'media'}},{name:'media',modules:true,script:media,compatibilityDate:'2026-01-01'}]});
 try{
  const db=await mf.getD1Database('DB','gateway');
  for(const f of ['schema.sql','generation-schema.sql'])for(const s of (await readFile(f,'utf8')).replace(/^\s*--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();
  await db.prepare("INSERT INTO rig_payment_environment(id,mode) VALUES(1,'test')").run();
  const inp={data:{quality:'edit-standard',imageId:image,videoId:video},refs:[{id:image,kind:'image',sha256:sha},{id:video,kind:'video',sha256:vsha}]};
  await db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind('quote',user,model,JSON.stringify(inp),100,'v',5,Date.now()+10000,Date.now()).run();
  await db.prepare("INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,'submitting',?)").bind(job,user,'quote','key',100,Date.now()).run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,NULL,?)').bind('reserve:'+job,user,-100).run();
  const url=await mintProviderInput({origin,secret,jobId:job,assetId:image,sha256:sha,kind:'image'}),get=(init={})=>mf.dispatchFetch(url,init);
  let r=await get();assert.equal(r.status,200);assert.equal(await r.text(),'test image bytes');assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(r.headers.get('accept-ranges'),'bytes');
  await verifyProviderInput(url,{origin,kind:'image',bytes,fetchImpl:(u,i)=>mf.dispatchFetch(u,i)});
  r=await get({method:'HEAD'});assert.equal(r.status,200);assert.equal(await r.text(),'');assert.equal(r.headers.get('content-length'),'16');
  r=await get({headers:{range:'bytes=2-5'}});assert.equal(r.status,206);assert.equal(await r.text(),'st i');assert.equal(r.headers.get('content-range'),'bytes 2-5/16');
  for(const range of ['bytes=0-1,3-4','bytes=99-','bytes=-0']){r=await get({headers:{range}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */16')}
  const wrongsha=await mintProviderInput({origin,secret,jobId:job,assetId:image,sha256:'c'.repeat(64),kind:'image'});assert.equal((await mf.dispatchFetch(wrongsha)).status,404);
  const wrongkind=await mintProviderInput({origin,secret,jobId:job,assetId:image,sha256:sha,kind:'video'});assert.equal((await mf.dispatchFetch(wrongkind)).status,404);
  await db.prepare("UPDATE rig_generation_jobs SET state='unknown'").run();assert.equal((await get()).status,404);
  await db.prepare("UPDATE rig_generation_jobs SET poll_token='dispatch-authorized',poll_lease_until=-1").run();assert.equal((await get()).status,200);
  await db.prepare("UPDATE rig_generation_jobs SET state='queued'").run();assert.equal((await get()).status,200);
  await db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'test')").bind(user).run();assert.equal((await get()).status,404);
  await db.prepare('DELETE FROM rig_frozen_accounts').run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,NULL,?)').bind('release:'+job,user,100).run();assert.equal((await get()).status,404);
  await db.prepare("DELETE FROM rig_ledger WHERE event_id=?").bind('release:'+job).run();
  await db.prepare("UPDATE rig_generation_jobs SET state='failed'").run();assert.equal((await get()).status,404);
  await db.prepare("UPDATE rig_generation_jobs SET state='completed'").run();assert.equal((await get()).status,404);
 }finally{await mf.dispose()}
});

test('proof capabilities have separate five-minute scope and require the dedicated authorizer',async()=>{
 const sha=await hash(bytes),issuedAt=Date.now(),url=await mintProofProviderInput({origin,secret,jobId:job,assetId:image,sha256:sha,kind:'image',issuedAt});
 const input={data:{quality:'edit-standard',imageId:image,videoId:video},refs:[{id:image,kind:'image',sha256:sha},{id:video,kind:'video',sha256:'b'.repeat(64)}]};
 let calls=0;const env={RIG_SITES_BRIDGE_ORIGIN:origin,RIG_MEDIA_SECRET:secret,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',DB:{prepare(){throw Error('generation query forbidden')}},RIG_MEDIA:{fetch:async(req)=>{assert.equal(req.headers.get('x-rig-user'),user);return new Response(bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length),'x-rig-asset-kind':'image','x-rig-sha256':sha}})}}};
 const options={verifyTenant:async()=>true,authorizeProof:async({token})=>{calls++;assert.equal(token.scope,'proof');assert.equal(token.issuedAt,issuedAt);return {user_id:user,model,input_json:JSON.stringify(input)}}};
 assert.equal(isProviderInputUrl(url,origin,'image'),false);
 assert.equal((await handleProviderInput(new Request(url),env,{verifyTenant:options.verifyTenant})).status,404);
 assert.equal((await handleProviderInput(new Request(url),env,options)).status,200);assert.equal(calls,1);
 assert.equal((await handleProviderInput(new Request(url),env,{...options,now:issuedAt+300000})).status,404);assert.equal(calls,1);
});

test('O3 upload requires anonymous matching gateway readback before returning; motion stays on existing provider path',async()=>{
 const {createAssets}=await import('./assets.mjs'),sha=await hash(bytes);let gatewayCalls=0,providerCalls=0,bad=true;
 const media={fetch:async()=>new Response(bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length),'x-rig-asset-kind':'image','x-rig-sha256':sha,'x-rig-width':'720','x-rig-height':'720'}})};
 const assets=createAssets({mode:'test',origin:'https://rig.example',media,mediaSecret:secret,falKey:'test-key',gatewayOrigin:origin,authenticate:async()=>({id:user}),limit:async()=>true,providerFetch:async()=>{providerCalls++;throw Error('motion upload was reached')},gatewayFetch:async(url,init)=>{gatewayCalls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers,undefined);assert.ok(isProviderInputUrl(url,origin,'image'));return new Response(bad?'bad input':bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length)}})}});
 const context={jobId:job,model};
 await assert.rejects(assets.uploadOwned(user,image,sha,context));assert.equal(providerCalls,0);
 bad=false;const prepared=await assets.uploadOwned(user,image,sha,context);assert.equal(prepared.verified,true);assert.equal(gatewayCalls,2);assert.equal(providerCalls,0);
 await assert.rejects(assets.uploadOwned(user,image,sha,{jobId:job,model:'fal-ai/kling-video/v3/pro/motion-control'}));assert.equal(providerCalls,1);
});
