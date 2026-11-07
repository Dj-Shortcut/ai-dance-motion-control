// Integration test: concurrent cron invocations share the real D1 poll lease.
// All provider calls below are fictional and do not leave this process.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createD1GenerationStores} from './d1.mjs';
import {createGenerationHandler} from './generation.mjs';
import {collectQueued} from './background-collector.mjs';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
try {
 const db=await mf.getD1Database('DB');
 const sql=(await readFile('cloudflare-migrations/0001_test_baseline.sql','utf8')).replace(/^\s*--.*$/gm,'');
 for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
 const fairness=(await readFile('cloudflare-migrations/0003_test_collector_fairness.sql','utf8')).replace(/^\s*--.*$/gm,'');
 for(const stmt of fairness.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
 for(const user of ['owner','other'])await db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,500)').bind(`fund:${user}`,user).run();
 const stores=createD1GenerationStores(db,{mode:'test'});
 async function queued(user,key='first'){const quote=await stores.quotes.create({userId:user,model:'fal-ai/kling-video/v3/pro/motion-control',input:{},priceCents:200,pricingVersion:'1',durationSeconds:4});const job=await stores.jobs.begin({userId:user,quoteId:quote.id,idempotencyKey:key,quote:{priceCents:200}});await stores.jobs.markSubmitted(user,job.job.id,`request-${user}`);return job.job.id;}
 const id=await queued('owner');const other=await queued('other');let statusCalls=0,resultCalls=0,writes=0;
 const provider=async url=>{if(url.endsWith('/status')){statusCalls++;await new Promise(r=>setTimeout(r,50));return Response.json({status:'COMPLETED',request_id:'request-owner'});}resultCalls++;return Response.json({video:{url:'https://v3b.fal.media/files/b/example/output.mp4'}})};
 const services={...stores,mode:'test',trustedOrigin:'https://owner.example',authenticate:async()=>({id:'owner'}),falKey:'fake',pricing:{standard:1,pro:1,version:'1'},assets:{getOwned:async()=>null,uploadOwned:async()=>null},results:{store:async job=>{writes++;return `rig-results/${job.id}.mp4`},read:async()=>new Response()}};
 const handler=createGenerationHandler(services,provider);
 const args={enabled:true,db,owner:'owner',origin:'https://owner.example',handler};
 await Promise.all([collectQueued(args),collectQueued(args)]);
 assert.equal(statusCalls,1);assert.equal(resultCalls,1);assert.equal(writes,1);
 assert.equal((await stores.jobs.getOwned('owner',id)).state,'completed');
 assert.equal((await stores.jobs.getOwned('other',other)).state,'queued');
 const ledger=await db.prepare("SELECT COUNT(*) AS n FROM rig_ledger WHERE event_id=?").bind(`settle:${id}`).first();assert.equal(ledger.n,1);
 // Browser remains closed: a later scheduled run safely retries a provider
 // outage and then an R2 write failure. Neither failure settles or refunds.
 const retryId=await queued('owner','second');let statusAttempts=0,storeAttempts=0;
 const retryProvider=async url=>{
  if(url.endsWith('/status')){statusAttempts++;if(statusAttempts===1)return new Response('',{status:503});return Response.json({status:'COMPLETED',request_id:'request-owner'});}
  return Response.json({video:{url:'https://v3b.fal.media/files/b/example/output.mp4'}});
 };
 const retryServices={...services,results:{...services.results,store:async job=>{storeAttempts++;if(storeAttempts===1)throw Error('R2 unavailable');return `rig-results/${job.id}.mp4`;}}};
 const retryArgs={...args,handler:createGenerationHandler(retryServices,retryProvider)};
 for(let i=0;i<2;i++){
  const result=await collectQueued(retryArgs);assert.equal(result.failed,1);assert.equal(result.completed,0);
  assert.equal((await stores.jobs.getOwned('owner',retryId)).state,'queued');
  const count=await db.prepare('SELECT COUNT(*) AS n FROM rig_ledger WHERE event_id IN (?,?)').bind(`settle:${retryId}`,`release:${retryId}`).first();assert.equal(count.n,0);
 }
 const recovered=await collectQueued(retryArgs);assert.equal(recovered.completed,1);assert.equal(recovered.failed,0);
 assert.equal((await stores.jobs.getOwned('owner',retryId)).state,'completed');
 assert.equal((await stores.jobs.getOwned('other',other)).state,'queued');
 const finalLedger=await db.prepare('SELECT COUNT(*) AS n FROM rig_ledger WHERE event_id=?').bind(`settle:${retryId}`).first();assert.equal(finalLedger.n,1);
 assert.equal(statusAttempts,3);assert.equal(storeAttempts,2);
 console.log('Local workerd/D1: concurrent collector, provider and storage recovery, one settlement, other owner untouched');
} finally {await mf.dispose()}
