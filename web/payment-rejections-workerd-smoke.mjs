// Real local workerd/D1 with a fake, never-networked Mollie response.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {handlePaymentRoute} from './payment.mjs';
const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');
const {Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-01-01',d1Databases:['DB']});
const nativeFetch=globalThis.fetch;
try{
 const db=await mf.getD1Database('DB');
 const schema=(await readFile('cloudflare-migrations/0001_test_baseline.sql','utf8')).replace(/^\s*--.*$/gm,'');
 for(const stmt of schema.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run();
 const env={DB:db,MOLLIE_API_KEY:'test_mock',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://hook.example/mollie',RIG_PACKAGES:JSON.stringify([{id:'test',amountCents:500,credits:500}])};
 globalThis.fetch=async(url,options)=>String(url)==='https://api.mollie.com/v2/payments'?Response.json({status:422,title:'Rejected',detail:'private'}, {status:422}):nativeFetch(url,options);
 const req=new Request('https://rig.example/api/payments/create',{method:'POST',headers:{origin:'https://rig.example','content-type':'application/json'},body:JSON.stringify({packageId:'test',requestId:'request_real_d1_123'})});
 const result=await handlePaymentRoute(req,env,'owner');assert.equal(result.status,422);assert.doesNotMatch(await result.text(),/private/);
 const row=await db.prepare('SELECT state,payment_id FROM rig_orders WHERE user_id=?').bind('owner').first();assert.equal(row.state,'failed');assert.equal(row.payment_id,null);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM rig_ledger').first()).n,0);
 console.log('local workerd/D1: confirmed 422 releases test order without ledger credit');
}finally{globalThis.fetch=nativeFetch;await mf.dispose()}
