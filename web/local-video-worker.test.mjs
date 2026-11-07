import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {Miniflare}=require('miniflare');
const createWorker=(dir,enabled)=>new Miniflare({d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workers:[
 {name:'ingress',modules:true,scriptPath:join(dir,'ingress.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},serviceBindings:{PRIVATE_ROUTER:'private'}},
 {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},d1Databases:{DB:'rig-video-fixture'},r2Buckets:{BUCKET:'rig-video-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_FAL:'mock-fal'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-fal',modules:true,scriptPath:join(dir,'mock-fal.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},d1Databases:{DB:'rig-video-fixture'}}
]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();}
const hdr=token=>({authorization:`Bearer ${token}`});
function send(mf,token,path,{method='GET',body,headers={}}={}){return mf.dispatchFetch(`https://rig.local${path}`,{method,headers:{...hdr(token),...(method==='POST'?{origin:'https://rig.local'}:{}),...headers},...(body?{body}: {})});}
const postJson=(mf,token,path,data)=>send(mf,token,path,{method:'POST',body:JSON.stringify(data),headers:{'content-type':'application/json'}});

test('real local workerd D1 and R2: isolated uploads, consent, one mock dispatch and durable result',async()=>{
 const directory=await mkdtemp(join(process.cwd(),'.rig-video-test-'));let mf;
 try{
  for(const [input,output] of [['local-fixture-ingress.mjs','ingress.mjs'],['local-private-router.mjs','private.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-fal.mjs','mock-fal.mjs']])
   await build({entryPoints:[input],outfile:join(directory,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  mf=createWorker(directory,false);assert.equal((await send(mf,'a.b.c','/api/session')).status,503);await mf.dispose();
  mf=createWorker(directory,true);let db=await mf.getD1Database('DB','private');
  for(const file of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./local-video-schema.sql'])await migrate(db,file);
  const a=(await (await send(mf,'a.b.c','/api/session')).json()).userId,b=(await (await send(mf,'d.e.f','/api/session')).json()).userId;
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-fund-a',a,500).run();
  await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-fund-b',b,50).run();
  const picture=await readFile('trial-fixtures/synthetic.jpg'),clip=await readFile('trial-fixtures/synthetic.mp4');
  let res=await send(mf,'a.b.c','/api/assets',{method:'POST',body:picture,headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'}});assert.equal(res.status,201,await res.clone().text());const imageId=(await res.json()).id;
  res=await send(mf,'a.b.c','/api/assets',{method:'POST',body:clip,headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'}});assert.equal(res.status,201,await res.clone().text());const videoId=(await res.json()).id;
  const r2=await mf.getR2Bucket('BUCKET','private');assert.ok(await r2.get(`rig-fixture-inputs/${a}/${videoId}`));
  const input={imageId,videoId,quality:'pro',prompt:'',keepSound:false,steadyCamera:false};
  res=await postJson(mf,'d.e.f','/api/generation-quotes',input);assert.equal(res.status,400);
  res=await send(mf,'d.e.f','/api/assets',{method:'POST',body:picture,headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'}});assert.equal(res.status,201);const bobImage=(await res.json()).id;
  res=await send(mf,'d.e.f','/api/assets',{method:'POST',body:clip,headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'}});assert.equal(res.status,201);const bobVideo=(await res.json()).id;
  res=await postJson(mf,'d.e.f','/api/generation-quotes',{...input,imageId:bobImage,videoId:bobVideo});assert.equal(res.status,201);const bobQuote=await res.json();
  res=await postJson(mf,'d.e.f','/api/generations',{quoteId:bobQuote.id,idempotencyKey:'bob-fixture-request'});assert.equal(res.status,402);
  res=await postJson(mf,'a.b.c','/api/generation-quotes',input);assert.equal(res.status,201,await res.clone().text());const quote=await res.json();assert.equal(quote.priceCents,100);assert.equal(quote.durationSeconds,4);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,0);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,500);
  const submit={quoteId:quote.id,idempotencyKey:'same-fixture-request'};
  const responses=await Promise.all([postJson(mf,'a.b.c','/api/generations',submit),postJson(mf,'a.b.c','/api/generations',submit)]);
  assert.ok(responses.every(x=>[200,202].includes(x.status)),await Promise.all(responses.map(x=>x.clone().text())));
  const submitted=await Promise.all(responses.map(x=>x.json()));assert.equal(submitted[0].id,submitted[1].id);const job=submitted[0].id;
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,1);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,400);
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,50);
  assert.equal((await send(mf,'d.e.f',`/api/generations/${job}`)).status,404);
  res=await send(mf,'a.b.c',`/api/generations/${job}`);assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json()).state,'completed');
  assert.ok(await r2.get(`rig-results/${job}.mp4`));
  assert.equal((await send(mf,'d.e.f',`/api/generations/${job}/video`)).status,404);
  res=await send(mf,'a.b.c',`/api/generations/${job}/video`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  await mf.dispose();mf=createWorker(directory,true);db=await mf.getD1Database('DB','private');
  res=await send(mf,'a.b.c',`/api/generations/${job}/video`);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  res=await send(mf,'a.b.c','/api/generations/recent');assert.equal((await res.json()).job.id,job);
  res=await postJson(mf,'a.b.c','/api/generations',submit);assert.equal(res.status,200);assert.equal((await res.json()).id,job);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,1);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,400);
  assert.equal((await send(mf,'z.y.x','/api/session')).status,401);
 }finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
