import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {handleOwnerAccounting,handleOwnedPaymentReceipt,accountingCSV} from './accounting-export.mjs';
import {verificationFor,installTestOwnerCredential} from './owner-security-test-helper.mjs';
import {loadProfitPolicy,createProfitSnapshot} from './profit-policy.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc',BUYER='u-22345678-1234-4123-8123-123456789abc',OTHER='u-32345678-1234-4123-8123-123456789abc',NOW=Date.parse('2026-11-09T12:00:00Z');
const stamp=at=>new Date(at).toISOString().slice(0,19).replace('T',' ');
async function migrate(db,path){const sql=(await readFile(new URL(path,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const part of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(part).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}}),db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');
 await migrate(db,'./production-schema.sql');if(!await db.prepare("SELECT 1 FROM sqlite_master WHERE name='rig_accounting_documents'").first())await migrate(db,'./production-migrations/0006_accounting_handoff.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('accounting-fixture','live',PROJECT,SITE,BRIDGE,'pfl_ACCOUNTING',BRIDGE+'/api/payments/webhook').run();
 const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_ACCOUNTING',RIG_PRODUCTION_ENVIRONMENT_ID:'accounting-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 await installTestOwnerCredential(db,OWNER,{now:NOW});
 const req=(path,data)=>new Request(SITE+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{origin:SITE,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const call=(path='/api/owner/accounting',data,options={})=>handleOwnerAccounting(req(path,data),options.env??env,{userId:options.userId??OWNER,now:NOW});
 const receipt=(requestId,userId=BUYER)=>handleOwnedPaymentReceipt(req('/api/payments/orders/'+requestId+'/receipt'),env,{userId,requestId});
 async function order({user=BUYER,state='paid',credit=true,amount=500,at=NOW,payment=true}={}){
  const id=crypto.randomUUID(),requestId=crypto.randomUUID();await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,user,requestId,'five',amount,amount,payment?'tr_'+id.replaceAll('-',''):null,state,stamp(at)).run();
  if(credit)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta,created_at) VALUES(?,?,?,?,?)').bind('credit:'+id,user,id,amount,stamp(at)).run();return {id,requestId,user};
 }
 const document=(order,overrides={})=>({idempotencyKey:crypto.randomUUID(),orderId:order.id,externalInvoiceReference:'ACC-'+crypto.randomUUID(),documentDate:'2026-11-09',recordType:'invoice',deliveryStatus:'prepared',note:'Handmatig in Accountable',...overrides});
 const signed=async data=>({...data,verification:await verificationFor(db,OWNER,'accounting-document',data,NOW,{env})});
 return {mf,db,legacy,env,req,call,receipt,order,document,signed};
}

test('owner handoff cannot be read by customers, forged roles, a test DB or foreign-origin writes',async()=>{
 const f=await fixture();try{
  await f.order();for(const userId of [BUYER,OTHER,'forged'])assert.equal((await f.call('/api/owner/accounting',undefined,{userId})).status,403);
  assert.equal((await f.call('/api/owner/accounting',undefined,{env:{...f.env,PRODUCTION_DB:f.legacy}})).status,503);
  const request=new Request(SITE+'/api/owner/accounting/documents',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'});assert.equal((await handleOwnerAccounting(request,f.env,{userId:OWNER,now:NOW})).status,403);
  for(const query of ['?user=other','?month=2026-13','?month=2026-11&month=2026-10','?month=2026%2D11'])assert.equal((await f.call('/api/owner/accounting'+query)).status,400);
  assert.equal((await f.call('/api/owner/accounting/export/unknown.csv')).status,404);
 }finally{await f.mf.dispose();}
});

test('export distinguishes received cash, unused credit and estimates; unknown fees/net and Peppol stay unconfirmed',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),expired=await f.order({user:OTHER,state:'expired',credit:false,amount:2500});await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,200)').bind('promo:gift',BUYER).run();
  const response=await f.call(),value=await response.json();assert.equal(response.status,200);assert.equal(value.verifiedGrossReceiptsCents,500);assert.equal(value.paidPurchaseCount,1);assert.equal(value.purchasesWithoutReference,1);assert.equal(value.availableCreditLiabilityCents,700);assert.equal(value.formalAccountingComplete,false);assert.equal(value.actualProfitCents,null);assert.equal(value.accountableAPIConnected,false);assert.equal(value.automaticPeppolDelivery,false);
  const active=value.purchases.find(p=>p.orderId===paid.id),inactive=value.purchases.find(p=>p.orderId===expired.id);assert.equal(active.mollieFeeCents,null);assert.equal(active.netPayoutCents,null);assert.equal(active.cashRefundCents,null);assert.equal(inactive.verifiedReceiptCents,0);assert.equal(inactive.orderAmountCents,2500);assert.equal(value.exports.length,4);
  const csv=await f.call('/api/owner/accounting/export/purchases.csv');assert.equal(csv.status,200);assert.match(csv.headers.get('content-disposition'),/attachment/);assert.equal(csv.headers.get('cache-control'),'private, no-store');const text=await csv.text();assert.match(text,/verified_receipt_cents/);assert.match(text,/not-imported/);assert.doesNotMatch(text,/live_fixture|subject_hash|public_key|FAL_KEY/);
  const events=await(await f.call('/api/owner/accounting/export/credit-events.csv')).text();assert.match(events,/credit-journal-not-additional-cash-revenue/);assert.match(events,/promo:gift/);
 }finally{await f.mf.dispose();}
});

test('paid receipt is account-owned, stable and never a formal invoice or a provider-cost disclosure',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),other=await f.order({user:OTHER}),unpaid=await f.order({user:BUYER,state:'expired',credit:false}),unproven=await f.order({user:BUYER,state:'paid',credit:false});
  const response=await f.receipt(paid.requestId);assert.equal(response.status,200);const html=await response.text();assert.match(html,/Geen btw-factuur/);assert.match(html,new RegExp('RIG-'+paid.id));assert.match(html,/€ 5,00/);assert.equal((await(await f.receipt(paid.requestId)).text()),html);assert.match(response.headers.get('content-disposition'),/RIG-betalingsbewijs-/);assert.doesNotMatch(html,/providerEstimate|marge|profitSnapshot|Accountable|user_id|u-22345678/);
  for(const requestId of [other.requestId,unpaid.requestId,unproven.requestId,crypto.randomUUID()])assert.equal((await f.receipt(requestId)).status,404);
  assert.equal((await f.receipt(paid.requestId,OTHER)).status,404);
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,499)').bind('credit:'+unproven.id,BUYER,unproven.id).run();assert.equal((await f.receipt(unproven.requestId)).status,404);
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,-500)').bind('reverse:'+paid.id,BUYER,paid.id).run();assert.equal((await f.receipt(paid.requestId)).status,404);
 }finally{await f.mf.dispose();}
});

test('CSV escapes formula-like references and hostile text while signed integer credit values remain numeric',()=>{
 const output=accountingCSV(['reference','cents','unknown'],[{reference:'=HYPERLINK("https://attacker.invalid")',cents:-500,unknown:null},{reference:' \t+CMD',cents:0,unknown:null},{reference:'line\n"quote"',cents:1,unknown:null}]);
 assert.match(output,/"'=HYPERLINK\(""https:\/\/attacker.invalid""\)";-500;""/);assert.match(output,/"' \t\+CMD";0;/);assert.match(output,/"line\n""quote""";1;/);assert.throws(()=>accountingCSV(['amount'],[{amount:Infinity}]));
});

test('manual Accountable reference needs device proof and never changes money or claims provider delivery',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),data=f.document(paid);const before=(await f.db.prepare('SELECT * FROM rig_ledger').all()).results;
  assert.equal((await f.call('/api/owner/accounting/documents',data)).status,428);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_documents').first()).n,0);
  let response=await f.call('/api/owner/accounting/documents',await f.signed(data));assert.equal(response.status,201,await response.clone().text());const created=await response.json();assert.equal(created.providerConfirmed,false);assert.equal(created.peppolDeliveryVerified,false);
  response=await f.call('/api/owner/accounting/documents',data);assert.equal(response.status,200);assert.equal((await response.json()).replayed,true);
  const report=await(await f.call()).json();assert.equal(report.purchasesWithoutReference,0);assert.equal(report.formalAccountingComplete,false);assert.equal(report.documents[0].providerConfirmed,false);assert.equal(report.documents[0].externalInvoiceReference,data.externalInvoiceReference);assert.deepEqual((await f.db.prepare('SELECT * FROM rig_ledger').all()).results,before);
 }finally{await f.mf.dispose();}
});

test('concurrent idempotent records remain one; an invoice reference cannot be reused for another order',async()=>{
 const f=await fixture();try{
  const a=await f.order(),b=await f.order({user:OTHER}),data=f.document(a,{externalInvoiceReference:'AC-2026-01'}),proof=await f.signed(data);
  const responses=await Promise.all([f.call('/api/owner/accounting/documents',proof),f.call('/api/owner/accounting/documents',proof)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_documents').first()).n,1);
  const other=f.document(b,{externalInvoiceReference:'ac-2026-01'});assert.equal((await f.call('/api/owner/accounting/documents',await f.signed(other))).status,409);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_references').first()).n,1);
  assert.equal((await f.call('/api/owner/accounting/documents',{...data,note:'changed'})).status,409);
 }finally{await f.mf.dispose();}
});

test('corrections are append-only and cannot replace another purchase or an already superseded entry',async()=>{
 const f=await fixture();try{
  const a=await f.order(),b=await f.order({user:OTHER}),first=f.document(a,{externalInvoiceReference:'AC-01'});const id=(await(await f.call('/api/owner/accounting/documents',await f.signed(first))).json()).id;
  const update=f.document(a,{externalInvoiceReference:'AC-02',deliveryStatus:'peppol-sent-manually',replacesDocumentId:id}),changed=await f.call('/api/owner/accounting/documents',await f.signed(update));assert.equal(changed.status,201,await changed.clone().text());
  const report=await(await f.call()).json();assert.equal(report.documents.length,1);assert.equal(report.documents[0].externalInvoiceReference,'AC-02');assert.equal(report.documents[0].peppolDeliveryVerified,false);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_documents').first()).n,2);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_references').first()).n,2);
  for(const bad of [f.document(a,{replacesDocumentId:id}),f.document(b,{replacesDocumentId:id})])assert.equal((await f.call('/api/owner/accounting/documents',await f.signed(bad))).status,409);
 }finally{await f.mf.dispose();}
});

test('invalid metadata and unverified purchases cannot create accounting handoff records',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),data=f.document(paid),unpaid=await f.order({user:OTHER,state:'expired',credit:false});
  for(const patch of [{documentDate:'2026-02-31'},{documentDate:'2099-01-01'},{externalInvoiceReference:''},{externalInvoiceReference:'bad\nreference'},{externalInvoiceReference:'x'.repeat(81)},{note:'bad\nline'},{unknown:true},{deliveryStatus:'api-confirmed'},{recordType:'accounting-entry',deliveryStatus:'peppol-sent-manually'},{orderId:'bad'}])assert.equal((await f.call('/api/owner/accounting/documents',{...data,...patch})).status,400,JSON.stringify(patch));
  const wrong=f.document(unpaid);assert.equal((await f.call('/api/owner/accounting/documents',await f.signed(wrong))).status,409);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_accounting_documents').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('actual costs, topups and planning estimates remain separate exports',async()=>{
 const f=await fixture();try{
  for(const [category,amount] of [['hosting',500],['fal-topup',2000],['refund',100]])await f.db.prepare('INSERT INTO rig_finance_expenses(id,idempotency_key,category,expense_date,amount_cents,note,request_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),crypto.randomUUID(),category,'2026-11-09',amount,'=InvoiceRef','a'.repeat(64),OWNER,NOW).run();
  const policy=await loadProfitPolicy(f.db),snapshot=createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:150,providerEstimateUsdMicros:630000}),qid=crypto.randomUUID(),jid=crypto.randomUUID();
  await f.db.prepare('INSERT INTO rig_generation_quotes(id,user_id,model,input_json,funding_kind,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(qid,BUYER,'fixture',JSON.stringify({}), 'credits',150,'fixture',5,NOW+10000,NOW).run();
  await f.db.prepare('INSERT INTO rig_generation_jobs(id,user_id,quote_id,idempotency_key,price_cents,state,created_at) VALUES(?,?,?,?,?,?,?)').bind(jid,BUYER,qid,crypto.randomUUID(),150,'queued',NOW).run();
  await f.db.prepare('INSERT INTO rig_generation_costs(job_id,quote_id,user_id,funding_kind,provider_estimate_usd_micros,budget_day,authorized_at,snapshot_json) VALUES(?,?,?,?,?,?,?,?)').bind(jid,qid,BUYER,'credits',630000,'2026-11-09',NOW,JSON.stringify(snapshot)).run();
  const costs=await(await f.call('/api/owner/accounting/export/costs.csv')).text(),estimates=await(await f.call('/api/owner/accounting/export/estimates.csv')).text();
  assert.match(costs,/cash-topup-not-additional-usage-expense/);assert.match(costs,/cash-refund-record-only-not-credit-or-revenue-adjustment/);assert.match(costs,/"'=InvoiceRef"/);assert.doesNotMatch(costs,/630000/);assert.match(estimates,/630000/);assert.match(estimates,/estimate-not-invoice/);assert.match(estimates,/planning-only-do-not-book-as-actual-cost/);assert.doesNotMatch(estimates,/missing-or-invalid-estimate/);
 }finally{await f.mf.dispose();}
});

test('month filter uses Brussels purchase boundaries and export refuses silent truncation',async()=>{
 const f=await fixture();try{
  await f.order({at:Date.parse('2026-10-31T22:30:00Z')});const november=await f.order({user:OTHER,at:Date.parse('2026-10-31T23:30:00Z')});
  const report=await(await f.call('/api/owner/accounting?month=2026-11')).json();assert.equal(report.paidPurchaseCount,1);assert.equal(report.purchases[0].orderId,november.id);
  await f.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,state,created_at) SELECT 'bulk-'||x,'bulk-user-'||x,'bulk-request-'||x,'bulk',1,1,'expired','2026-11-09 12:00:00' FROM n`).run();
  const exported=await f.call('/api/owner/accounting/export/purchases.csv?month=2026-11');assert.equal(exported.status,413);assert.match((await exported.json()).error,/te veel regels/);
 }finally{await f.mf.dispose();}
});

test('reserved credit remains an obligation and later use is not a second receipt',async()=>{
 const f=await fixture();try{
  await f.order();const job=crypto.randomUUID();await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,-150)').bind('reserve:'+job,BUYER).run();
  let report=await(await f.call()).json();assert.equal(report.availableCreditLiabilityCents,350);assert.equal(report.heldCreditLiabilityCents,150);assert.equal(report.outstandingCreditLiabilityCents,500);assert.equal(report.verifiedGrossReceiptsCents,500);
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,0)').bind('settle:'+job,BUYER).run();report=await(await f.call()).json();assert.equal(report.outstandingCreditLiabilityCents,350);assert.equal(report.verifiedGrossReceiptsCents,500);
 }finally{await f.mf.dispose();}
});

test('purchase handoff follows verified credit date while reversal keeps gross receipt and asks separate review',async()=>{
 const f=await fixture();try{
  const order=await f.order({at:Date.parse('2026-10-31T20:00:00Z')});await f.db.prepare("UPDATE rig_ledger SET created_at='2026-11-01 12:00:00' WHERE event_id=?").bind('credit:'+order.id).run();
  const october=await(await f.call('/api/owner/accounting?month=2026-10')).json();assert.equal(october.paidPurchaseCount,0);
  let november=await(await f.call('/api/owner/accounting?month=2026-11')).json();assert.equal(november.verifiedGrossReceiptsCents,500);
  await f.db.prepare("UPDATE rig_orders SET state='reversal_review' WHERE id=?").bind(order.id).run();await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,-500)').bind('reverse:'+order.id,BUYER,order.id).run();
  november=await(await f.call('/api/owner/accounting?month=2026-11')).json();assert.equal(november.verifiedGrossReceiptsCents,500);assert.equal(november.reversalReviewCount,1);assert.equal(november.purchases[0].cashRefundCents,null);assert.equal(november.purchases[0].creditReversalCents,500);assert.equal(november.checklist.find(item=>item.id==='payment-reversals').state,'needs-owner-action');
 }finally{await f.mf.dispose();}
});

test('purchase handoff includes customer-declared country and accepted version without treating it as verified tax evidence',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),legacy=await f.order({user:OTHER});
  const seller={legalName:'Verkoper bij aankoop',enterpriseNumber:'0123.456.789',vatNumber:'BE0123456789',address:'Oud adres 1, België',email:'test@example.invalid',phone:'+32 400 00 00 00'};
  await f.db.prepare('INSERT INTO rig_purchase_acceptances(user_id,request_id,version,buyer_country,customer_type,request_hash,seller_json,terms_text,created_at,package_id,amount_cents,credits,currency) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(BUYER,paid.requestId,'terms-before-checkout','NL','consumer','a'.repeat(64),JSON.stringify(seller),'<body><p>De voorwaarden bij aankoop.</p></body>',NOW-5000,'five',500,500,'EUR').run();
  const report=await(await f.call()).json(),declared=report.purchases.find(p=>p.orderId===paid.id),missing=report.purchases.find(p=>p.orderId===legacy.id);
  assert.equal(declared.declaredCountry,'NL');assert.equal(declared.declaredCustomerType,'consumer');assert.equal(declared.acceptedTermsVersion,'terms-before-checkout');assert.equal(declared.acceptedAt,new Date(NOW-5000).toISOString());assert.equal(declared.countryEvidence,'customer-declaration-not-verified-tax-determination');assert.equal(declared.agreedPackageId,'five');assert.equal(declared.agreedAmountCents,500);assert.equal(declared.agreedCreditCents,500);assert.equal(declared.agreedCurrency,'EUR');assert.equal(declared.acceptanceMatchesOrder,true);assert.equal(missing.declaredCountry,null);assert.equal(missing.acceptedTermsVersion,null);assert.equal(report.formalAccountingComplete,false);
  const csv=await(await f.call('/api/owner/accounting/export/purchases.csv')).text();assert.match(csv,/"declared_country";"declared_customer_type";"accepted_terms_version"/);assert.match(csv,/"NL";"consumer";"terms-before-checkout"/);assert.match(csv,/customer-declaration-not-verified-tax-determination/);assert.doesNotMatch(csv,/seller_json|De voorwaarden bij aankoop|Verkoper bij aankoop/);
 }finally{await f.mf.dispose();}
});

test('commercial payment proof uses the immutable seller and accepted terms snapshot; missing or damaged evidence fails closed',async()=>{
 const f=await fixture();try{
  const paid=await f.order(),seller={legalName:'Verkoper vóór profielwijziging <img src=x>',enterpriseNumber:'0123.456.789',vatNumber:'BE0123456789',address:'Oud adres 1, België',email:'old@example.invalid',phone:'+32 400 00 00 00'},snapshot='<html><head><style>PRIVATE_STYLE</style></head><body><h1>Oude verkoopvoorwaarden</h1><p>Prijs &amp; rechten blijven bewaard. &lt;img src=x onerror=alert(1)&gt;</p><script>PRIVATE_SCRIPT</script></body></html>';
  f.env.RIG_COMMERCIAL_CHECKOUT_REQUIRED='yes';assert.equal((await f.receipt(paid.requestId)).status,503);
  await f.db.prepare('INSERT INTO rig_purchase_acceptances(user_id,request_id,version,buyer_country,customer_type,request_hash,seller_json,terms_text,created_at,package_id,amount_cents,credits,currency) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(BUYER,paid.requestId,'terms-original-v1','BE','consumer','b'.repeat(64),JSON.stringify(seller),snapshot,NOW-1000,'five',500,500,'EUR').run();
  const response=await f.receipt(paid.requestId);assert.equal(response.status,200);const html=await response.text();assert.match(html,/Geen btw-factuur/);assert.match(html,/Verkoper vóór profielwijziging &lt;img src=x&gt;/);assert.match(html,/Oude verkoopvoorwaarden/);assert.match(html,/Prijs &amp; rechten blijven bewaard/);assert.match(html,/terms-original-v1/);assert.match(html,/BE \(klantverklaring; geen geverifieerde fiscale beoordeling\)/);assert.match(html,/old@example.invalid/);assert.doesNotMatch(html,/<script>|<img |PRIVATE_SCRIPT|PRIVATE_STYLE|Andy Arys|info@andyarijs.dev/);assert.equal(await(await f.receipt(paid.requestId)).text(),html);assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  await f.db.prepare("UPDATE rig_purchase_acceptances SET amount_cents=501 WHERE user_id=? AND request_id=?").bind(BUYER,paid.requestId).run();assert.equal((await f.receipt(paid.requestId)).status,503);
  await f.db.prepare("UPDATE rig_purchase_acceptances SET seller_json='{}',amount_cents=500 WHERE user_id=? AND request_id=?").bind(BUYER,paid.requestId).run();assert.equal((await f.receipt(paid.requestId)).status,503);
 }finally{await f.mf.dispose();}
});
