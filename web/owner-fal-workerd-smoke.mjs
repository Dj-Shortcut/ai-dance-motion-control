// Owner-only job end-to-end with real local D1 and completely fake fal/assets.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createD1GenerationStores} from './d1.mjs';
import {createGenerationHandler} from './generation.mjs';
import {createOwnerTrialGuard} from './owner-fal-guard.mjs';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
try{
 const db=await mf.getD1Database('DB');const schema=(await readFile('cloudflare-migrations/0001_test_baseline.sql','utf8')).replace(/^\s*--.*$/gm,'');for(const stmt of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
 await db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('fund','owner',500)").run();
 const env={DB:db,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_OWNER_FAL_TEST_ENABLED:'yes',RIG_STAGING_OWNER:'owner',FAL_KEY:'fake',RIG_MEDIA_SECRET:'x'.repeat(64),RIG_MEDIA:{fetch(){}},BUCKET:{get(){},put(){},head(){}},RIG_PRICE_STANDARD:'10',RIG_PRICE_PRO:'20',RIG_OWNER_FAL_MAX_PRICE_CENTS:'100',RIG_OWNER_FAL_MAX_USD_MICROS:'1000000',RIG_PRICE_VERSION:'owner-test'};
 const stores=createD1GenerationStores(db,{mode:'test'}),sha='a'.repeat(64);let uploadCalls=0,submitCalls=0;
 const assets={getOwned:async(_owner,id)=>({id,kind:id==='video'?'video':'image',verified:true,sha256:sha,...(id==='video'?{durationVerified:true,durationSeconds:3.034}:{})}),uploadOwned:async(_owner,id)=>{uploadCalls++;return{kind:id==='video'?'video':'image',verified:true,url:`https://v3b.fal.media/files/b/test/${id}.mp4`}}};
 let proRate=.168;const priceFetch=async()=>({currency:'USD',unit:'second',prices:{standard:.126,pro:proRate}});
 const services={...stores,mode:'test',trustedOrigin:'https://rig.example',authenticate:async()=>({id:'owner'}),assets,results:{store:async()=>'',read:async()=>new Response()},falKey:'fake',pricing:{standard:10,pro:20,version:'owner-test'},trialGuard:createOwnerTrialGuard(env,'owner',{priceFetch})};
 const fetchFake=async(url,options)=>{if(options.method==='POST'){submitCalls++;return Response.json({request_id:'fake-request'})}return Response.json({request_id:'fake-request',status:'COMPLETED',error:'fake failure'})};
 const handler=createGenerationHandler(services,fetchFake),post=(path,body)=>new Request('https://rig.example'+path,{method:'POST',headers:{'content-type':'application/json',origin:'https://rig.example'},body:JSON.stringify(body)});
 async function quote(){const r=await handler(post('/api/generation-quotes',{imageId:'image',videoId:'video',quality:'pro'}));assert.equal(r.status,201);return await r.json();}
 const stale=await quote();proRate=.18;let changed=await handler(post('/api/generations',{quoteId:stale.id,idempotencyKey:'price-changed'}));assert.equal((await changed.json()).refundConfirmed,true);assert.equal(submitCalls,0);assert.equal(uploadCalls,0);proRate=.168;
 const q=await quote();assert.equal(q.priceCents,80);assert.equal(q.providerEstimateUsdMicros,672000);assert.equal(uploadCalls,0);assert.equal(submitCalls,0);
 const input={quoteId:q.id,idempotencyKey:'first'};let r=await handler(post('/api/generations',input));assert.equal(r.status,202);const job=await r.json();assert.equal(submitCalls,1);assert.equal(uploadCalls,2);
 r=await handler(post('/api/generations',input));assert.equal(r.status,200);assert.equal(submitCalls,1);
 r=await handler(new Request('https://rig.example/api/generations/'+job.id));assert.equal((await r.json()).state,'failed');
 const q2=await quote();r=await handler(post('/api/generations',{quoteId:q2.id,idempotencyKey:'second'}));const blocked=await r.json();assert.equal(blocked.state,'failed');assert.equal(blocked.refundConfirmed,true);assert.equal(submitCalls,1);assert.equal(uploadCalls,2);
 assert.equal((await db.prepare("SELECT SUM(delta) AS total FROM rig_ledger WHERE user_id='owner'").first()).total,500);
 console.log('local workerd/D1: quote precedes upload; one fake paid attempt; retry blocked and refunded');
}finally{await mf.dispose()}
