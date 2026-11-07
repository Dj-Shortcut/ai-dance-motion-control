import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {build} from 'esbuild';

import {Miniflare} from 'miniflare';
const createWorker=(dir,enabled)=>new Miniflare({cf:false,d1Persist:join(dir,'d1'),r2Persist:join(dir,'r2'),workers:[
 {name:'ingress',modules:true,scriptPath:join(dir,'ingress.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},serviceBindings:{PRIVATE_ROUTER:'private'}},
 {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:enabled?{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'}:{},d1Databases:{DB:'rig-video-fixture'},r2Buckets:{BUCKET:'rig-video-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_FAL:'mock-fal',MOCK_MOLLIE:'mock-mollie'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-fal',modules:true,scriptPath:join(dir,'mock-fal.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},d1Databases:{DB:'rig-video-fixture'}},
 {name:'mock-mollie',modules:true,scriptPath:join(dir,'mock-mollie.mjs'),compatibilityDate:'2026-01-01'}
]});
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();}
const hdr=token=>({authorization:`Bearer ${token}`});
function send(mf,token,path,{method='GET',body,headers={}}={}){return mf.dispatchFetch(`https://rig.local${path}`,{method,headers:{...hdr(token),...(method==='POST'?{origin:'https://rig.local'}:{}),...headers},...(body?{body}: {})});}
const postJson=(mf,token,path,data)=>send(mf,token,path,{method:'POST',body:JSON.stringify(data),headers:{'content-type':'application/json'}});

test('the injected payment fixture matches the existing test ledger implementation',async()=>{
 const source=await readFile('payment.mjs','utf8'),[imp,...rest]=source.split('\n');
 const body=rest.join('\n').replace('export function getConfig(', 'function getConfig(').replace('export async function handlePaymentRoute(', 'async function handlePaymentRoute(').replace('export const paymentTesting =', 'const paymentTesting =');
 const expected=imp+'\n// Mechanical test-only wrapper around payment.mjs; injected fetch cannot reach the network.\nexport function fixturePaymentWithFetch(fetch) {\n'+body+'\nreturn handlePaymentRoute;\n}\n';
 assert.equal(await readFile('local-fixture-payment.mjs','utf8'),expected);
});

test('two users buy mock credits and generate private videos through local workerd D1 and R2',async()=>{
 const directory=await mkdtemp(join(process.cwd(),'.rig-video-test-'));let mf;
 try{
  for(const [input,output] of [['local-combined-ingress.mjs','ingress.mjs'],['local-combined-private.mjs','private.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-fal.mjs','mock-fal.mjs'],['local-mock-mollie.mjs','mock-mollie.mjs']])
   await build({entryPoints:[input],outfile:join(directory,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  mf=createWorker(directory,false);assert.equal((await send(mf,'a.b.c','/api/session')).status,503);await mf.dispose();
  mf=createWorker(directory,true);let db=await mf.getD1Database('DB','private');
  for(const file of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./local-video-schema.sql'])await migrate(db,file);
  const a=(await (await send(mf,'a.b.c','/api/session')).json()).userId,b=(await (await send(mf,'d.e.f','/api/session')).json()).userId;
  assert.notEqual(a,b);
  assert.equal((await postJson(mf,'a.b.c','/api/payments/create',{packageId:'test-5',requestId:'payment-alice-0001',amountCents:1})).status,200);
  assert.equal((await postJson(mf,'d.e.f','/api/payments/create',{packageId:'test-5',requestId:'payment-bob-000001'})).status,200);
  const orderA=await db.prepare('SELECT payment_id,amount_cents FROM rig_orders WHERE user_id=?').bind(a).first(),orderB=await db.prepare('SELECT payment_id,amount_cents FROM rig_orders WHERE user_id=?').bind(b).first();
  assert.equal(orderA.amount_cents,500);assert.equal(orderB.amount_cents,500);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,0);
  const mollie=await mf.getWorker('mock-mollie'),privateWorker=await mf.getWorker('private');
  const paid=id=>mollie.fetch(`https://api.mollie.com/v2/payments/${id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}});
  const hook=id=>privateWorker.fetch('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'x-local-fixture':'mock-callback-only','content-type':'application/x-www-form-urlencoded'},body:`id=${id}`});
  assert.equal((await paid(orderA.payment_id)).status,200);assert.ok((await Promise.all([hook(orderA.payment_id),hook(orderA.payment_id)])).every(r=>r.status===200));
  assert.equal((await paid(orderB.payment_id)).status,200);assert.equal((await hook(orderB.payment_id)).status,200);assert.equal((await hook(orderB.payment_id)).status,200);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,500);
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,500);
  assert.equal((await send(mf,'d.e.f','/api/payments/orders/payment-alice-0001')).status,404);
  const picture=await readFile('test/fixtures/input.jpg'),clip=await readFile('test/fixtures/silent.mp4');
  let res=await send(mf,'a.b.c','/api/assets',{method:'POST',body:picture,headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'}});assert.equal(res.status,201,await res.clone().text());const imageId=(await res.json()).id;
  res=await send(mf,'a.b.c','/api/assets',{method:'POST',body:clip,headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'}});assert.equal(res.status,201,await res.clone().text());const videoId=(await res.json()).id;
  const r2=await mf.getR2Bucket('BUCKET','private');assert.ok(await r2.get(`rig-fixture-inputs/${a}/${videoId}`));
  const input={imageId,videoId,quality:'pro',prompt:'',keepSound:false,steadyCamera:false};
  res=await postJson(mf,'d.e.f','/api/generation-quotes',input);assert.equal(res.status,400);
  res=await send(mf,'d.e.f','/api/assets',{method:'POST',body:picture,headers:{'content-type':'image/jpeg','x-rig-asset-kind':'image'}});assert.equal(res.status,201);const bobImage=(await res.json()).id;
  res=await send(mf,'d.e.f','/api/assets',{method:'POST',body:clip,headers:{'content-type':'video/mp4','x-rig-asset-kind':'video'}});assert.equal(res.status,201);const bobVideo=(await res.json()).id;
  res=await postJson(mf,'d.e.f','/api/generation-quotes',{...input,imageId:bobImage,videoId:bobVideo});assert.equal(res.status,201);const bobQuote=await res.json();
  assert.equal(bobQuote.priceCents,100);
  res=await postJson(mf,'a.b.c','/api/generation-quotes',input);assert.equal(res.status,201,await res.clone().text());const quote=await res.json();assert.equal(quote.priceCents,100);assert.equal(quote.durationSeconds,4);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,0);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,500);
  const submit={quoteId:quote.id,idempotencyKey:'same-fixture-request'};
  const responses=await Promise.all([postJson(mf,'a.b.c','/api/generations',submit),postJson(mf,'a.b.c','/api/generations',submit)]);
  assert.ok(responses.every(x=>[200,202].includes(x.status)),await Promise.all(responses.map(x=>x.clone().text())));
  const submitted=await Promise.all(responses.map(x=>x.json()));assert.equal(submitted[0].id,submitted[1].id);const job=submitted[0].id;
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,1);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,400);
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,500);
  res=await postJson(mf,'d.e.f','/api/generations',{quoteId:bobQuote.id,idempotencyKey:'bob-fixture-request'});assert.equal(res.status,202,await res.clone().text());const bobJob=(await res.json()).id;
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,400);
  assert.equal((await send(mf,'d.e.f',`/api/generations/${job}`)).status,404);
  res=await send(mf,'a.b.c',`/api/generations/${job}`);assert.equal(res.status,200,await res.clone().text());assert.equal((await res.json()).state,'completed');
  assert.ok(await r2.get(`rig-results/${job}.mp4`));
  assert.equal((await send(mf,'d.e.f',`/api/generations/${job}/video`)).status,404);
  res=await send(mf,'a.b.c',`/api/generations/${job}/video`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  assert.equal((await send(mf,'a.b.c',`/api/generations/${bobJob}/video`)).status,404);
  res=await send(mf,'d.e.f',`/api/generations/${bobJob}`);assert.equal(res.status,200);assert.equal((await res.json()).state,'completed');
  res=await send(mf,'d.e.f',`/api/generations/${bobJob}/video`);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  await mf.dispose();mf=createWorker(directory,true);db=await mf.getD1Database('DB','private');
  res=await send(mf,'a.b.c',`/api/generations/${job}/video`);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  res=await send(mf,'d.e.f',`/api/generations/${bobJob}/video`);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),clip);
  res=await send(mf,'a.b.c','/api/generations/recent');assert.equal((await res.json()).job.id,job);
  res=await postJson(mf,'a.b.c','/api/generations',submit);assert.equal(res.status,200);assert.equal((await res.json()).id,job);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM rig_fixture_fal_dispatch').first()).n,2);
  assert.equal((await (await send(mf,'a.b.c','/api/payments/balance')).json()).balance,400);
  assert.equal((await (await send(mf,'d.e.f','/api/payments/balance')).json()).balance,400);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,2);
  assert.equal((await send(mf,'z.y.x','/api/session')).status,401);
 }finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
