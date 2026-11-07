import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createD1GenerationStores} from './d1.mjs';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
try{
 const db=await mf.getD1Database('DB');
 const sql=(await readFile('cloudflare-migrations/0001_test_baseline.sql','utf8')).replace(/^\s*--.*$/gm,'');
 for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
 await db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('fund','user1',500)").run();
 const {quotes,jobs}=createD1GenerationStores(db,{mode:'test'});
 const q=await quotes.create({userId:'user1',model:'model',input:{},priceCents:200,pricingVersion:'1',durationSeconds:4});
 const started=await jobs.begin({userId:'user1',quoteId:q.id,idempotencyKey:'one',quote:{priceCents:200}});
 assert.equal(started.kind,'created');
 const [a,b]=await Promise.all([jobs.markPreparationFailed('user1',started.job.id),jobs.markPreparationFailed('user1',started.job.id)]);
 assert.equal(a.state,'failed');assert.equal(b.state,'failed');
 let balance=await db.prepare("SELECT SUM(delta) sum,COUNT(*) n FROM rig_ledger WHERE user_id='user1'").first();assert.equal(balance.sum,500);assert.equal(balance.n,3);
 const q2=await quotes.create({userId:'user1',model:'model',input:{},priceCents:200,pricingVersion:'1',durationSeconds:4});
 const queued=await jobs.begin({userId:'user1',quoteId:q2.id,idempotencyKey:'two',quote:{priceCents:200}});await jobs.markSubmitted('user1',queued.job.id,'provider-job');
 await assert.rejects(jobs.markPreparationFailed('user1',queued.job.id));
 balance=await db.prepare("SELECT SUM(delta) sum FROM rig_ledger WHERE user_id='user1'").first();assert.equal(balance.sum,300);
 console.log('Cloudflare workerd/D1: preparation failure refunds once; queued jobs cannot be refunded');
}finally{await mf.dispose()}
