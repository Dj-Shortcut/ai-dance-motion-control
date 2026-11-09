// Local D1 + private R2 integration. Mail is always injected; no external
// payment, generation, OAuth or actual message delivery occurs in these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {unzipSync,strFromU8} from 'fflate';
import {prepareCommercialCheckout} from './commercial-checkout.mjs';
import {COMMERCE_VERSION} from './commerce-profile.mjs';
import {ensurePaidPurchaseInvoice} from './invoice-store.mjs';
import {archiveInvoicePDF,handleInvoiceRoute,collectInvoiceDocuments} from './invoice-delivery.mjs';
import {accountableMailReady} from './invoice-mail.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',OWNER='u-32345678-1234-4123-8123-123456789abc',NOW=Date.parse('2026-11-09T18:00:00Z');
const SHA=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',value)).toString('hex');
const mailConfig={RIG_ACCOUNTABLE_MAIL_ENABLED:'yes',RIG_ACCOUNTABLE_ALIAS_CONFIRMED:'yes',RIG_ACCOUNTABLE_SENDER:'info@andyarijs.dev',ZOHO_CLIENT_ID:'1000.fixtureclient',ZOHO_CLIENT_SECRET:'fixturesecret123',ZOHO_REFRESH_TOKEN:'1000.fixturerefresh',ZOHO_MAIL_ACCOUNT_ID:'123456789'};
function minimalPDF(label='fixture'){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>','<< /Length '+('% '+label+'\n').length+' >>\nstream\n% '+label+'\nendstream'];
 let output='%PDF-1.4\n',offsets=[0];for(const [i,body]of objects.entries()){offsets.push(output.length);output+=(i+1)+' 0 obj\n'+body+'\nendobj\n';}const xref=output.length;output+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return new TextEncoder().encode(output);
}
const render=async invoice=>minimalPDF(invoice.number);
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'},r2Buckets:{BUCKET:'invoice-archive'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');await migrate(db,'./production-schema.sql');
  for(const [table,file]of [['rig_issued_invoices','0011_automatic_invoices.sql'],['rig_purchase_billing','0012_purchase_billing.sql'],['rig_invoice_archives','0013_invoice_delivery.sql']])if(!await db.prepare('SELECT name FROM sqlite_master WHERE name=?').bind(table).first())await migrate(db,'./production-migrations/'+file);
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('delivery-fixture','live',PROJECT,SITE,BRIDGE,'pfl_DELIVERY',BRIDGE+'/api/payments/webhook').run();
  // Miniflare's Node RPC cannot serialize native Headers. Preserve the exact
  // production precondition while mapping it to the equivalent R2 DTO.
  const archiveBucket={get:(...args)=>bucket.get(...args),put:(key,bytes,options)=>{assert.equal(options.onlyIf.get('If-None-Match'),'*');return bucket.put(key,bytes,{...options,onlyIf:{etagDoesNotMatch:'*'}});}};
  const env={DB:legacy,PRODUCTION_DB:db,BUCKET:archiveBucket,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_DELIVERY',RIG_PRODUCTION_ENVIRONMENT_ID:'delivery-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]',RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes',RIG_AUTOMATIC_INVOICES_ENABLED:'yes',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
  async function purchase({userId=ALICE,issued=true,now=NOW}={}){
   const id=crypto.randomUUID(),requestId=crypto.randomUUID(),data={packageId:'five',requestId,commerce:{version:COMMERCE_VERSION,accepted:true,customerType:'consumer',country:'BE'},billing:{name:'Tester Archief',street:'Stationsstraat 12',postalCode:'9400',city:'Ninove'}};
   const prepared=await prepareCommercialCheckout(new Request(SITE+'/api/payments/create',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify(data)}),env,{userId,now:NOW-60000});assert.equal(prepared.response?.status??200,200,prepared.response&&await prepared.response.text());
   await db.prepare("INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,'five',500,500,?,'paid','2026-11-09 17:59:30')").bind(id,userId,requestId,'tr_'+id.replaceAll('-','')).run();await db.prepare("INSERT INTO rig_ledger(event_id,user_id,order_id,delta,created_at) VALUES(?,?,?,500,'2026-11-09 17:59:30')").bind('credit:'+id,userId,id).run();
   const result=issued?await ensurePaidPurchaseInvoice(env,{orderId:id,now}):null;if(issued)assert.equal(result.state,'issued',JSON.stringify(result));return {id,requestId,userId,invoice:result?.invoice};
  }
  const call=(path,{userId=OWNER,now=NOW,method='GET',extraEnv={},renderer=render}={})=>handleInvoiceRoute(new Request(SITE+path,{method}),{...env,...extraEnv},{userId,now,render:renderer});
  const table=name=>db.prepare('SELECT * FROM '+name+' ORDER BY 1').all().then(r=>r.results);
  const money=async()=>({orders:await table('rig_orders'),ledger:await table('rig_ledger'),expenses:await table('rig_finance_expenses')});
  return {mf,db,legacy,bucket,env,purchase,call,table,money};
 }catch(error){await mf.dispose();throw error;}
}

test('private PDF archive checks frozen snapshot and hash; retries never rerender or replace the stored bytes',async()=>{
 const f=await fixture();try{
  const o=await f.purchase(),before=await f.money();let renders=0;const first=await archiveInvoicePDF(f.env,o.invoice,{now:NOW,render:async invoice=>{renders++;return render(invoice);}});assert.equal(renders,1);assert.equal(first.sha256,await SHA(first.bytes));assert.match(first.key,/^administration\/invoices\/2026\/[a-f0-9-]+\.pdf$/);
  const again=await archiveInvoicePDF(f.env,o.invoice,{now:NOW+1000,render:async()=>{throw Error('Must not render twice');}});assert.deepEqual(again.bytes,first.bytes);assert.equal(again.sha256,first.sha256);assert.equal((await f.table('rig_invoice_archives')).length,1);assert.deepEqual(await f.money(),before);
  await assert.rejects(archiveInvoicePDF(f.env,{...o.invoice,amountCents:501},{now:NOW,render}),/mismatch/);assert.deepEqual(new Uint8Array(await(await f.bucket.get(first.key)).arrayBuffer()),first.bytes);
 }finally{await f.mf.dispose();}
});

test('concurrent first renders converge on one conditional R2 object and one immutable archive row',async()=>{
 const f=await fixture();try{
  const o=await f.purchase();let renders=0;const varied=async()=>minimalPDF('race-'+(++renders)),values=await Promise.all(Array.from({length:16},()=>archiveInvoicePDF(f.env,o.invoice,{now:NOW,render:varied})));
  assert.equal(new Set(values.map(v=>v.sha256)).size,1);assert.ok(values.every(v=>Buffer.from(v.bytes).equals(Buffer.from(values[0].bytes))));assert.equal((await f.table('rig_invoice_archives')).length,1);assert.equal((await f.bucket.list({prefix:'administration/invoices/'})).objects.length,1);
 }finally{await f.mf.dispose();}
});

test('a missing or corrupt original blob fails closed and cannot silently generate a replacement',async()=>{
 const f=await fixture();try{
  const o=await f.purchase(),archived=await archiveInvoicePDF(f.env,o.invoice,{now:NOW,render});await f.bucket.delete(archived.key);let renders=0;
  await assert.rejects(archiveInvoicePDF(f.env,o.invoice,{now:NOW,render:async()=>{renders++;return minimalPDF('replacement');}}));assert.equal(renders,0);assert.equal((await f.bucket.list()).objects.length,0);assert.equal((await f.call('/api/payments/orders/'+o.requestId+'/invoice',{userId:ALICE})).status,503);
  await f.bucket.put(archived.key,minimalPDF('corrupt'));await assert.rejects(archiveInvoicePDF(f.env,o.invoice,{now:NOW,render}));assert.equal((await f.table('rig_invoice_archives')).length,1);
 }finally{await f.mf.dispose();}
});

test('customer and owner PDF routes enforce ownership; owner list exposes no seller/buyer or source internals',async()=>{
 const f=await fixture();try{
  const a=await f.purchase(),b=await f.purchase({userId:BOB});let response=await f.call('/api/payments/orders/'+a.requestId+'/invoice',{userId:ALICE});assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('content-disposition'),new RegExp(a.invoice.number+'\\.pdf'));const pdf=new Uint8Array(await response.arrayBuffer());assert.equal(new TextDecoder().decode(pdf.slice(0,5)),'%PDF-');
  assert.equal((await f.call('/api/payments/orders/'+a.requestId+'/invoice',{userId:BOB})).status,404);assert.equal((await f.call('/api/owner/invoices/'+a.invoice.id+'/pdf',{userId:ALICE})).status,403);assert.equal((await f.call('/api/owner/invoices',{userId:ALICE})).status,403);assert.equal((await f.call('/api/owner/invoices/'+b.invoice.id+'/pdf')).status,200);
  for(const path of ['/api/payments/orders/'+a.requestId+'/invoice?user=other','/api/owner/invoices/'+a.invoice.id+'/pdf?download=1','/api/owner/invoices/unknown/pdf'])assert.equal((await f.call(path)).status,404,path);
  assert.equal((await f.call('/api/owner/invoices',{method:'POST'})).status,404);assert.equal((await f.call('/api/owner/invoices?month=2026-13')).status,400);
  response=await f.call('/api/owner/invoices?month=2026-11');assert.equal(response.status,200);const list=await response.json();assert.equal(list.invoices.length,2);assert.equal(list.accountableValidated,false);assert.equal(list.peppolDeliveryVerified,false);assert.doesNotMatch(JSON.stringify(list),/Tester Archief|Stationsstraat|snapshot_json|request_hash|live_fixture|ZOHO_|seller_json/);
 }finally{await f.mf.dispose();}
});

test('one genuine renderer PDF is archived and returned byte-for-byte on the owned route',async()=>{
 const f=await fixture();try{
  const o=await f.purchase();const response=await handleInvoiceRoute(new Request(SITE+'/api/payments/orders/'+o.requestId+'/invoice'),f.env,{userId:ALICE,now:NOW});assert.equal(response.status,200,await response.clone().text());const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.length>1000);assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');
  const [row]=await f.table('rig_invoice_archives');assert.equal(row.pdf_sha256,await SHA(bytes));const stored=await f.bucket.get(row.storage_key);assert.deepEqual(new Uint8Array(await stored.arrayBuffer()),bytes);
 }finally{await f.mf.dispose();}
});

test('owner ZIP contains original PDFs and handoff instructions; period, count and byte limits are enforced',async()=>{
 const f=await fixture();try{
  const a=await f.purchase(),b=await f.purchase({userId:BOB}),response=await f.call('/api/owner/invoices/export.zip?month=2026-11');assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('content-type'),'application/zip');const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));assert.deepEqual(Object.keys(zip).sort(),['LEESMIJ.txt',a.invoice.number+'.pdf',b.invoice.number+'.pdf'].sort());assert.match(strFromU8(zip['LEESMIJ.txt']),/maak geen tweede factuur/);assert.deepEqual(zip[a.invoice.number+'.pdf'],minimalPDF(a.invoice.number));assert.equal((await f.call('/api/owner/invoices/export.zip',{userId:ALICE})).status,403);assert.equal((await f.call('/api/owner/invoices/export.zip?month=2026-11&month=2026-10')).status,400);
  for(let i=0;i<49;i++)await f.purchase();assert.equal((await f.call('/api/owner/invoices/export.zip')).status,413);assert.equal((await f.table('rig_invoice_archives')).length,2);
 }finally{await f.mf.dispose();}
 const big=await fixture();try{
  for(let i=0;i<5;i++)await big.purchase();const oversized=async invoice=>{const bytes=new Uint8Array(3*1024*1024);bytes.set(minimalPDF(invoice.number));return bytes;};assert.equal((await big.call('/api/owner/invoices/export.zip',{renderer:oversized})).status,413);
 }finally{await big.mf.dispose();}
});

test('16 duplicate collectors archive once and claim exactly one mail attempt without claiming Accountable validation',async()=>{
 const f=await fixture();try{
  const o=await f.purchase({issued:false}),before=await f.money(),env={...f.env,...mailConfig};assert.equal(accountableMailReady(env),true);let sends=0;
  const send=async(_env,payload)=>{sends++;assert.equal(payload.invoice.orderId,o.id);assert.equal(payload.idempotencyKey,'rig-invoice/'+payload.invoice.id);assert.equal(new TextDecoder().decode(payload.pdf.slice(0,5)),'%PDF-');return {messageId:'fixture-mail-1'};};
  const stats=await Promise.all(Array.from({length:16},()=>collectInvoiceDocuments(env,{now:NOW,limit:4,render,send})));assert.equal(sends,1);assert.equal(stats.reduce((n,v)=>n+v.issued,0),1);assert.equal(stats.reduce((n,v)=>n+v.mailSent,0),1);
  const [outbox]=await f.table('rig_invoice_mail_outbox');assert.equal(outbox.state,'sent');assert.equal(outbox.provider_message_id,'fixture-mail-1');assert.equal((await f.table('rig_invoice_archives')).length,1);assert.deepEqual(await f.money(),before);
  await collectInvoiceDocuments(env,{now:NOW+10000,render,send});assert.equal(sends,1);const owner=await(await f.call('/api/owner/invoices',{extraEnv:mailConfig})).json();assert.equal(owner.accountableDeliveryConfigured,true);assert.equal(owner.accountableValidated,false);assert.equal(owner.invoices[0].accountableValidated,false);
 }finally{await f.mf.dispose();}
});

test('ambiguous mail dispatch is never retried automatically, including a stale claimed sending row',async()=>{
 const f=await fixture();try{
  await f.purchase();const env={...f.env,...mailConfig};let sends=0;const send=async()=>{sends++;throw Error('ambiguous network result with secret-token-value');};
  const first=await collectInvoiceDocuments(env,{now:NOW,render,send});assert.equal(first.needsReview,1);assert.equal(sends,1);const [unknown]=await f.table('rig_invoice_mail_outbox');assert.equal(unknown.state,'unknown');assert.equal(unknown.last_error,'delivery_requires_review');assert.doesNotMatch(JSON.stringify(unknown),/secret-token-value/);
  await collectInvoiceDocuments(env,{now:NOW+3600000,render,send});assert.equal(sends,1);
  const pending=await f.purchase();await archiveInvoicePDF(f.env,pending.invoice,{now:NOW,render});await f.db.prepare("INSERT INTO rig_invoice_mail_outbox(invoice_id,state,attempt_token,pdf_sha256,started_at) VALUES(?,'sending',?,?,?)").bind(pending.invoice.id,crypto.randomUUID(),'a'.repeat(64),NOW-1000000).run();await collectInvoiceDocuments(env,{now:NOW,render,send});assert.equal(sends,1);const stale=await f.db.prepare('SELECT state,last_error FROM rig_invoice_mail_outbox WHERE invoice_id=?').bind(pending.invoice.id).first();assert.equal(stale.state,'unknown');assert.equal(stale.last_error,'delivery_interrupted');
 }finally{await f.mf.dispose();}
});

test('mail readiness requires confirmed flags and secrets; configuration off still archives with zero sends',async()=>{
 for(const key of Object.keys(mailConfig))assert.equal(accountableMailReady({...mailConfig,[key]:undefined}),false,key);assert.equal(accountableMailReady(mailConfig),true);assert.equal(accountableMailReady({...mailConfig,RIG_ACCOUNTABLE_SENDER:'attacker@invalid.test'}),false);
 const f=await fixture();try{
  await f.purchase({issued:false});let sends=0;const stats=await collectInvoiceDocuments(f.env,{now:NOW,render,send:async()=>{sends++;throw Error('No mail when config is off');}});assert.equal(stats.issued,1);assert.equal(stats.archived,1);assert.equal(stats.mailSent,0);assert.equal(sends,0);assert.deepEqual(await f.table('rig_invoice_mail_outbox'),[]);const owner=await(await f.call('/api/owner/invoices')).json();assert.equal(owner.accountableDeliveryConfigured,false);
  assert.equal((await f.call('/api/owner/invoices',{extraEnv:{PRODUCTION_DB:f.legacy}})).status,503);assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rig_invoice_archives'").first()).n,0);
 }finally{await f.mf.dispose();}
});

test('a broken oldest archive cannot starve the next eligible document in a bounded collector',async()=>{
 const f=await fixture();try{
  const broken=await f.purchase(),healthy=await f.purchase({now:NOW+1}),archived=await archiveInvoicePDF(f.env,broken.invoice,{now:NOW,render});await f.bucket.delete(archived.key);
  const env={...f.env,...mailConfig};assert.equal(accountableMailReady(env),true);const sent=[];const send=async(_env,{invoice})=>{sent.push(invoice.id);return {messageId:'fixture-healthy'};};
  await collectInvoiceDocuments(env,{now:NOW+2,limit:1,render,send});await collectInvoiceDocuments(env,{now:NOW+3,limit:1,render,send});
  assert.deepEqual(sent,[healthy.invoice.id]);assert.equal((await f.db.prepare('SELECT state FROM rig_invoice_mail_outbox WHERE invoice_id=?').bind(healthy.invoice.id).first())?.state,'sent');assert.equal(await f.bucket.get(archived.key),null);
 }finally{await f.mf.dispose();}
});
test('unissued purchases needing review remain visible in the scheduled processing summary',async()=>{
 const f=await fixture();try{
  const purchase=await f.purchase({issued:false});await f.db.prepare('DELETE FROM rig_purchase_billing WHERE user_id=? AND request_id=?').bind(purchase.userId,purchase.requestId).run();
  const stats=await collectInvoiceDocuments(f.env,{now:NOW,render});assert.equal(stats.issued,0);assert.equal(stats.needsReview,1);assert.equal(stats.unavailable,0);assert.equal(stats.archived,0);
  const attempt=await f.db.prepare('SELECT last_state,last_reason FROM rig_invoice_issuance_attempts WHERE order_id=?').bind(purchase.id).first();assert.equal(attempt.last_state,'review-required');assert.equal(attempt.last_reason,'billing_missing');
 }finally{await f.mf.dispose();}
});
