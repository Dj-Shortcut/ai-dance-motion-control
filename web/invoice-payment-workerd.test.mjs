import {testCheckoutFunding} from './funding-test-support.mjs';
// Actual payment/invoice/collector composition with local D1 + R2 and a fixed
// in-process Mollie transport. No real bank, Fal, email or OAuth request exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createProductionPayment} from './production-payment.mjs';
import {getOwnedPurchaseInvoice} from './invoice-store.mjs';
import {collectProduction} from './production-collector.mjs';
import {COMMERCE_VERSION} from './commerce-profile.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',HOOK=BRIDGE+'/api/payments/webhook';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',OWNER='u-32345678-1234-4123-8123-123456789abc';
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'legacy',PRODUCTION_DB:'production'},r2Buckets:{BUCKET:'invoices'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');await migrate(db,'./production-schema.sql');
  for(const [table,file]of [['rig_issued_invoices','0011_automatic_invoices.sql'],['rig_purchase_billing','0012_purchase_billing.sql'],['rig_invoice_archives','0013_invoice_delivery.sql']])if(!await db.prepare('SELECT name FROM sqlite_master WHERE name=?').bind(table).first())await migrate(db,'./production-migrations/'+file);
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('invoice-payment-fixture','live',PROJECT,SITE,BRIDGE,'pfl_PAYINVOICE',HOOK).run();
  const env={DB:legacy,PRODUCTION_DB:db,BUCKET:{get:(...args)=>bucket.get(...args),put:(key,bytes,options)=>{assert.equal(options.onlyIf.get('If-None-Match'),'*');return bucket.put(key,bytes,{...options,onlyIf:{etagDoesNotMatch:'*'}});}},RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_VIDEO_ENABLED:'no',RIG_PRODUCTION_COLLECTION_ENABLED:'no',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_PAYINVOICE',RIG_PRODUCTION_ENVIRONMENT_ID:'invoice-payment-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:HOOK,RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]',RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes',RIG_AUTOMATIC_INVOICES_ENABLED:'yes',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
  let created=0;const payments=new Map(),calls=[];
  const network=async(input,init={})=>{
   const url=new URL(input instanceof Request?input.url:String(input)),method=init.method??'GET';assert.equal(url.origin,'https://api.mollie.com');assert.equal(new Headers(init.headers).get('authorization'),'Bearer live_fixture');assert.ok(['GET','POST'].includes(method));calls.push({path:url.pathname,method});
   if(url.pathname==='/v2/profiles/me'){assert.equal(method,'GET');return Response.json({id:'pfl_PAYINVOICE'});}
   if(url.pathname==='/v2/payments'){assert.equal(method,'POST');created++;const body=JSON.parse(init.body),payment={id:'tr_Pay'+String(created).padStart(6,'0'),mode:'live',profileId:'pfl_PAYINVOICE',status:'open',amount:body.amount,metadata:body.metadata,_links:{checkout:{href:'https://www.mollie.com/checkout/fixture'}}};payments.set(payment.id,payment);return Response.json(payment,{status:201});}
   assert.equal(method,'GET');const match=/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/.exec(url.pathname);assert.ok(match,'Only known payment status can be read');assert.ok(payments.has(match[1]));return match[2]?Response.json({_embedded:{[match[2]]:[]}}):Response.json(payments.get(match[1]));
  };
  const payment=createProductionPayment({...testCheckoutFunding,transport:network});
  const request=(path,data)=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const body=()=>({packageId:'five',requestId:crypto.randomUUID(),commerce:{version:COMMERCE_VERSION,accepted:true,customerType:'consumer',country:'BE'},billing:{name:'Testklant Facturen',street:'Stationsstraat 12',postalCode:'9400',city:'Ninove'}});
  const create=async({userId=ALICE}={})=>{const data=body(),response=await payment.user(request('/api/payments/create',data),env,userId);assert.equal(response.status,200,await response.clone().text());const row=await db.prepare('SELECT * FROM rig_orders WHERE user_id=? AND request_id=?').bind(userId,data.requestId).first();assert.ok(row.payment_id);return {...row,data};};
  const webhook=(id,extraEnv={})=>payment.webhook(new Request(HOOK,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'id='+id}),{...env,...extraEnv});
  const reconcile=(o,{userId=ALICE,extraEnv={}}={})=>payment.user(request('/api/payments/orders/'+o.request_id+'/reconcile',{}),{...env,...extraEnv},userId);
  const count=table=>db.prepare('SELECT COUNT(*) n FROM '+table).first().then(row=>row.n);
  const balance=user=>db.prepare('SELECT COALESCE(SUM(delta),0) n FROM rig_ledger WHERE user_id=?').bind(user).first().then(row=>row.n);
  return {mf,db,legacy,bucket,env,payment,network,create,webhook,reconcile,request,payments,calls,count,balance,get created(){return created;}};
 }catch(error){await mf.dispose();throw error;}
}

test('real paid webhooks credit once and issue one sequential invoice despite duplicate callback races',async()=>{
 const f=await fixture();try{
  const o=await f.create();assert.equal(o.state,'open');assert.equal(await f.count('rig_issued_invoices'),0);assert.equal(await f.balance(ALICE),0);f.payments.get(o.payment_id).status='paid';
  const callbacks=await Promise.all(Array.from({length:16},()=>f.webhook(o.payment_id)));assert.ok(callbacks.every(r=>r.status===200),await Promise.all(callbacks.map(r=>r.clone().text())));assert.equal(await f.balance(ALICE),500);assert.equal(await f.count('rig_ledger'),1);assert.equal(await f.count('rig_issued_invoices'),1);assert.equal(f.created,1);
  const invoice=await getOwnedPurchaseInvoice(f.env,{userId:ALICE,requestId:o.request_id});assert.equal(invoice.state,'existing');assert.match(invoice.invoice.number,/^RIG-20\d{2}-000001$/);assert.equal(invoice.invoice.paymentReference,o.payment_id);assert.equal(invoice.invoice.amountCents,500);assert.equal(invoice.invoice.buyer.name,'Testklant Facturen');
  const orders=await(await f.payment.user(f.request('/api/payments/orders'),f.env,ALICE)).json();assert.equal(orders.automaticInvoices,true);assert.equal(orders.orders[0].invoiceAvailable,true);assert.equal(orders.orders[0].invoiceNumber,invoice.invoice.number);assert.equal((await(await f.payment.user(f.request('/api/payments/orders'),f.env,BOB)).json()).orders.length,0);
  assert.equal(await f.count('rig_invoice_archives'),0);assert.equal(await f.count('rig_invoice_mail_outbox'),0);
 }finally{await f.mf.dispose();}
});

test('owned reconcile issues the same single invoice and cannot reconcile another customer purchase',async()=>{
 const f=await fixture();try{
  const o=await f.create();f.payments.get(o.payment_id).status='paid';const before=f.calls.length;
  // A missing owned intent is conservatively tombstoned rather than revealing
  // whether another customer has a payment with this request identifier.
  const foreign=await f.reconcile(o,{userId:BOB});assert.equal(foreign.status,200);const ownMissing=await foreign.json();assert.equal(ownMissing.state,'canceled');assert.equal(ownMissing.amountCents,0);assert.equal(ownMissing.credits,0);assert.doesNotMatch(JSON.stringify(ownMissing),new RegExp(o.payment_id));assert.equal(f.calls.length,before);assert.equal(await f.count('rig_issued_invoices'),0);
  const results=await Promise.all([f.reconcile(o),f.reconcile(o),f.webhook(o.payment_id)]);assert.ok(results.every(r=>r.status===200));assert.equal(await f.count('rig_issued_invoices'),1);assert.equal(await f.count('rig_ledger'),1);assert.equal(await f.balance(ALICE),500);assert.equal(f.created,1);assert.equal((await f.db.prepare('SELECT next_sequence FROM rig_invoice_counters').first()).next_sequence,2);
 }finally{await f.mf.dispose();}
});

test('an invoice-store outage cannot hide paid success or trigger a second bank transaction; owned repair recovers later',async()=>{
 const f=await fixture();try{
  const o=await f.create();f.payments.get(o.payment_id).status='paid';const failing={prepare(sql){if(/\brig_issued_invoices\b/.test(sql))throw Error('Simulated document database outage');return f.db.prepare(sql);},batch:statements=>f.db.batch(statements)};
  const response=await f.webhook(o.payment_id,{PRODUCTION_DB:failing});assert.equal(response.status,200,await response.clone().text());assert.equal(await f.balance(ALICE),500);assert.equal((await f.db.prepare('SELECT state FROM rig_orders WHERE id=?').bind(o.id).first()).state,'paid');assert.equal(await f.count('rig_issued_invoices'),0);assert.equal(f.created,1);
  const recovered=await getOwnedPurchaseInvoice(f.env,{userId:ALICE,requestId:o.request_id});assert.equal(recovered.state,'issued');assert.equal(await f.count('rig_issued_invoices'),1);assert.equal(await f.count('rig_ledger'),1);assert.equal(f.created,1);assert.equal((await f.reconcile(o)).status,200);assert.equal(await f.count('rig_issued_invoices'),1);
 }finally{await f.mf.dispose();}
});

test('scheduled production collector issues and archives a paid purchase with no open customer page or video service',async()=>{
 const f=await fixture();try{
  const o=await f.create();f.payments.get(o.payment_id).status='paid';assert.equal((await f.webhook(o.payment_id,{RIG_AUTOMATIC_INVOICES_ENABLED:'no'})).status,200);assert.equal(await f.count('rig_issued_invoices'),0);const before=f.calls.length,now=Date.now();let videoCalls=0;
  const stats=await collectProduction(f.env,{limit:1,clock:()=>now,network:async()=>{throw Error('Invoice collector cannot contact payment provider or Fal');},videoFactory:async()=>{videoCalls++;throw Error('Video remains paused');}});
  assert.equal(stats.invoices.issued,1);assert.equal(stats.invoices.archived,1);assert.equal(stats.invoices.mailSent,0);assert.equal(stats.videosChecked,0);assert.equal(stats.paymentsChecked,0);assert.equal(videoCalls,0);assert.equal(f.calls.length,before);assert.equal(await f.count('rig_issued_invoices'),1);assert.equal(await f.count('rig_invoice_archives'),1);assert.equal(await f.count('rig_invoice_mail_outbox'),0);assert.equal((await f.bucket.list({prefix:'administration/invoices/'})).objects.length,1);assert.equal(await f.balance(ALICE),500);
  const second=await collectProduction(f.env,{limit:1,clock:()=>now+1000,network:async()=>{throw Error('No provider');}});assert.equal(second.invoices.issued,0);assert.equal(second.invoices.archived,0);assert.equal(f.created,1);assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rig_issued_invoices'").first()).n,0);
 }finally{await f.mf.dispose();}
});
