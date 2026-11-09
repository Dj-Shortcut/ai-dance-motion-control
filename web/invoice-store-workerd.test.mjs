import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {ensurePaidPurchaseInvoice,getOwnedPurchaseInvoice,getOwnerPurchaseInvoice,ensurePendingInvoices} from './invoice-store.mjs';
import {prepareCommercialCheckout} from './commercial-checkout.mjs';
import {COMMERCE_VERSION} from './commerce-profile.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const ALICE='u-12345678-1234-4123-8123-123456789abc',BOB='u-22345678-1234-4123-8123-123456789abc',OWNER='u-32345678-1234-4123-8123-123456789abc';
const NOW=Date.parse('2026-11-09T18:00:00Z'),PAID_AT='2026-11-01 12:00:00';
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:{DB:'test',PRODUCTION_DB:'production'}});
 try{
  const db=await mf.getD1Database('PRODUCTION_DB'),legacy=await mf.getD1Database('DB');await migrate(db,'./production-schema.sql');
  for(const [table,file]of [['rig_issued_invoices','0011_automatic_invoices.sql'],['rig_purchase_billing','0012_purchase_billing.sql']])if(!await db.prepare('SELECT name FROM sqlite_master WHERE name=?').bind(table).first())await migrate(db,'./production-migrations/'+file);
  await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare('INSERT INTO rig_production_tenant VALUES(1,?,?,?,?,?,?,?)').bind('invoice-fixture','live',PROJECT,SITE,BRIDGE,'pfl_INVOICE',BRIDGE+'/api/payments/webhook').run();
  const env={DB:legacy,PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_INVOICE',RIG_PRODUCTION_ENVIRONMENT_ID:'invoice-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"five","amountCents":500,"credits":500}]',RIG_COMMERCIAL_CHECKOUT_REQUIRED:'yes',RIG_AUTOMATIC_INVOICES_ENABLED:'yes',RIG_PRODUCTION_OWNER_USER_ID:OWNER};
  async function order({userId=ALICE,acceptance=true,billing=true,state='paid',credit=true,paidAt=PAID_AT,createdAt='2026-11-01 11:00:00',acceptedAt=Date.parse('2026-11-01T11:00:00Z')}={}){
   const id=crypto.randomUUID(),requestId=crypto.randomUUID();
   if(acceptance){const data={packageId:'five',requestId,commerce:{version:COMMERCE_VERSION,accepted:true,customerType:'consumer',country:'NL'},billing:{name:'Anne-Marie van Dijk',street:'Dorpsstraat 12',postalCode:'1234 AB',city:'Middelburg'}};
    const prepared=await prepareCommercialCheckout(new Request(SITE+'/api/payments/create',{method:'POST',headers:{origin:SITE,'content-type':'application/json'},body:JSON.stringify(data)}),env,{userId,now:acceptedAt});assert.equal(prepared.response?.status??200,200,prepared.response&&await prepared.response.text());
    if(!billing)await db.prepare('DELETE FROM rig_purchase_billing WHERE user_id=? AND request_id=?').bind(userId,requestId).run();
   }
   await db.prepare('INSERT INTO rig_orders(id,user_id,request_id,package_id,amount_cents,credits,payment_id,state,created_at) VALUES(?,?,?,?,500,500,?,?,?)').bind(id,userId,requestId,'five','tr_'+id.replaceAll('-',''),state,createdAt).run();
   if(credit)await db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta,created_at) VALUES(?,?,?,500,?)').bind('credit:'+id,userId,id,paidAt).run();return {id,requestId,userId};
  }
  const issue=(o,{extraEnv={},now=NOW}={})=>ensurePaidPurchaseInvoice({...env,...extraEnv},{orderId:typeof o==='string'?o:o.id,now});
  const rows=()=>db.prepare('SELECT * FROM rig_issued_invoices ORDER BY issue_year,sequence').all().then(r=>r.results);
  const counters=()=>db.prepare('SELECT * FROM rig_invoice_counters ORDER BY issue_year').all().then(r=>r.results);
  const money=async()=>({orders:(await db.prepare('SELECT * FROM rig_orders ORDER BY id').all()).results,ledger:(await db.prepare('SELECT * FROM rig_ledger ORDER BY event_id').all()).results,expenses:(await db.prepare('SELECT * FROM rig_finance_expenses ORDER BY id').all()).results});
  return {mf,db,legacy,env,order,issue,rows,counters,money};
 }catch(error){await mf.dispose();throw error;}
}
async function manualDocument(db,orderId){const id=crypto.randomUUID();await db.prepare("INSERT INTO rig_accounting_documents(id,idempotency_key,order_id,provider,external_invoice_reference,reference_key,document_date,record_type,delivery_status,note,replaces_document_id,request_hash,recorded_by,created_at) VALUES(?,?,?,'accountable','MANUAL-1','manual-1','2026-11-01','invoice','prepared','',NULL,?,?,?)").bind(id,crypto.randomUUID(),orderId,'a'.repeat(64),OWNER,NOW).run();}

test('explicit flag and independently live production tenant gate automatic invoices without touching money',async()=>{
 assert.deepEqual(await ensurePaidPurchaseInvoice({},{}),{state:'disabled'});
 const f=await fixture();try{
  const o=await f.order(),before=await f.money();
  for(const extraEnv of [{RIG_AUTOMATIC_INVOICES_ENABLED:undefined},{RIG_AUTOMATIC_INVOICES_ENABLED:'no'}])assert.equal((await f.issue(o,{extraEnv})).state,'disabled');
  for(const extraEnv of [{PRODUCTION_DB:f.legacy},{RIG_PRODUCTION_PAYMENTS_ENABLED:'no'},{RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_wrong'},{MOLLIE_LIVE_API_KEY:'test_wrong'}])assert.equal((await f.issue(o,{extraEnv})).state,'unavailable');
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();assert.equal((await f.issue(o)).state,'unavailable');await f.db.prepare("UPDATE rig_payment_environment SET mode='live'").run();
  assert.equal((await f.issue('bad-id')).state,'not-eligible');assert.equal((await f.issue(o,{now:NaN})).state,'not-eligible');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[]);assert.deepEqual(await f.money(),before);
 }finally{await f.mf.dispose();}
});

test('verified paid purchase issues an immutable seller/buyer/terms invoice on actual Brussels issue date',async()=>{
 const f=await fixture();try{
  const o=await f.order(),before=await f.money(),issued=await f.issue(o);assert.equal(issued.state,'issued',JSON.stringify(issued));const v=issued.invoice;
  assert.equal(v.number,'RIG-2026-000001');assert.equal(v.issuedDate,'2026-11-09');assert.equal(v.issuedAt,NOW);assert.equal(v.paidAt,'2026-11-01T12:00:00.000Z');assert.equal(v.orderReference,'RIG-'+o.id);assert.equal(v.buyer.name,'Anne-Marie van Dijk');assert.equal(v.buyer.addressLine1,'Dorpsstraat 12');assert.equal(v.buyer.country,'NL');assert.equal(v.seller.country,'BE');assert.equal(v.amountCents,500);assert.equal(v.creditCents,500);assert.equal(v.currency,'EUR');assert.equal(v.vatAmountCents,0);assert.equal(v.taxExemption,'Bijzondere vrijstellingsregeling van belasting');assert.equal(v.terms.version,COMMERCE_VERSION);assert.match(v.terms.sha256,/^[a-f0-9]{64}$/);assert.equal(v.accountableConfirmed,false);assert.equal(v.peppolDeliveryVerified,false);
  const [saved]=await f.rows(),a=await f.db.prepare('SELECT seller_json FROM rig_purchase_acceptances WHERE user_id=? AND request_id=?').bind(ALICE,o.requestId).first();assert.equal(JSON.parse(saved.snapshot_json).source.sellerJson,a.seller_json);assert.equal(saved.issued_at,NOW);assert.equal(saved.issue_year,2026);assert.equal(saved.sequence,1);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:2}]);assert.deepEqual(await f.money(),before);
  assert.equal((await f.issue(o,{now:NOW+86400000})).state,'existing');assert.deepEqual(await f.rows(),[saved]);
 }finally{await f.mf.dispose();}
});

test('concurrent callbacks allocate one document per order and a gap-free sequence across distinct purchases',async()=>{
 const f=await fixture();try{
  const first=await f.order(),results=await Promise.all(Array.from({length:16},()=>f.issue(first)));assert.equal(results.filter(v=>v.state==='issued').length,1);assert.ok(results.every(v=>['issued','existing'].includes(v.state)),JSON.stringify(results));assert.equal(new Set(results.map(v=>v.invoice.number)).size,1);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:2}]);
  const purchases=[];for(let i=0;i<9;i++)purchases.push(await f.order());const issued=await Promise.all(purchases.map(o=>f.issue(o)));assert.ok(issued.every(v=>v.state==='issued'),JSON.stringify(issued));
  assert.deepEqual((await f.rows()).map(row=>row.sequence),[1,2,3,4,5,6,7,8,9,10]);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:11}]);assert.equal(new Set((await f.rows()).map(row=>row.invoice_number)).size,10);
 }finally{await f.mf.dispose();}
});

test('unpaid state, missing or mismatched exact credit, reversals and malformed source proof cannot issue',async()=>{
 const f=await fixture();try{
  const o=await f.order();
  for(const state of ['creating','open','unknown','failed','expired','credit_pending_review','reversal_review']){await f.db.prepare('UPDATE rig_orders SET state=? WHERE id=?').bind(state,o.id).run();assert.notEqual((await f.issue(o)).state,'issued',state);}await f.db.prepare("UPDATE rig_orders SET state='paid' WHERE id=?").bind(o.id).run();
  for(const patch of ["delta=499","user_id='"+BOB+"'","order_id=NULL"]){const before=await f.db.prepare('SELECT * FROM rig_ledger WHERE event_id=?').bind('credit:'+o.id).first();await f.db.prepare('UPDATE rig_ledger SET '+patch+' WHERE event_id=?').bind('credit:'+o.id).run();assert.equal((await f.issue(o)).reason,'credit_not_verified');await f.db.prepare('UPDATE rig_ledger SET delta=?,user_id=?,order_id=? WHERE event_id=?').bind(before.delta,before.user_id,before.order_id,before.event_id).run();}
  for(const patch of ["amount_cents=501","credits=501","package_id='other'"]){await f.db.prepare('UPDATE rig_orders SET '+patch+' WHERE id=?').bind(o.id).run();assert.notEqual((await f.issue(o)).state,'issued',patch);await f.db.prepare("UPDATE rig_orders SET amount_cents=500,credits=500,package_id='five' WHERE id=?").bind(o.id).run();}
  await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,-500)').bind('reverse:'+o.id,ALICE,o.id).run();assert.equal((await f.issue(o)).reason,'payment_reversed');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[]);
 }finally{await f.mf.dispose();}
});

test('legacy acceptance, missing billing and existing external invoice require review instead of backfill duplicates',async()=>{
 const f=await fixture();try{
  const absent=await f.order({acceptance:false});assert.equal((await f.issue(absent)).reason,'acceptance_missing');
  const noBilling=await f.order({billing:false});assert.equal((await f.issue(noBilling)).reason,'billing_missing');
  const manual=await f.order();await manualDocument(f.db,manual.id);assert.equal((await f.issue(manual)).reason,'external_document_exists');
  const malformed=await f.order();await f.db.prepare("UPDATE rig_purchase_billing SET postal_code='1234ZZ' WHERE user_id=? AND request_id=?").bind(ALICE,malformed.requestId).run();assert.equal((await f.issue(malformed)).reason,'billing_invalid');
  const changed=await f.order();await f.db.prepare("UPDATE rig_purchase_billing SET name='Other person' WHERE user_id=? AND request_id=?").bind(ALICE,changed.requestId).run();assert.equal((await f.issue(changed)).reason,'acceptance_invalid');
  assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[]);
 }finally{await f.mf.dispose();}
});

function beforeBatch(db,mutate){return {prepare:sql=>db.prepare(sql),async batch(statements){await mutate();return db.batch(statements);}};}
test('atomic issuance rechecks a newly recorded manual invoice, reversal, tenant or changed source before numbering',async()=>{
 for(const kind of ['manual','reversal','billing','tenant']){
  const f=await fixture();try{
   const o=await f.order(),mutate=()=>kind==='manual'?manualDocument(f.db,o.id):kind==='reversal'?f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,-500)').bind('reverse:'+o.id,ALICE,o.id).run():kind==='billing'?f.db.prepare("UPDATE rig_purchase_billing SET city='Amsterdam' WHERE user_id=? AND request_id=?").bind(ALICE,o.requestId).run():f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();
   const value=await f.issue(o,{extraEnv:{PRODUCTION_DB:beforeBatch(f.db,mutate)}});assert.equal(value.state,'review-required',kind+' '+JSON.stringify(value));assert.equal(value.reason,'source_changed');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:1}]);
  }finally{await f.mf.dispose();}
 }
});

test('D1 transaction rollback consumes no invoice number and storage errors never create a money event',async()=>{
 const f=await fixture();try{
  const o=await f.order(),before=await f.money(),broken={prepare:sql=>f.db.prepare(sql),batch:statements=>f.db.batch([...statements,f.db.prepare('INSERT INTO deliberately_missing_table VALUES(1)')])};
  assert.equal((await f.issue(o,{extraEnv:{PRODUCTION_DB:broken}})).state,'unavailable');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[]);assert.deepEqual(await f.money(),before);
  assert.equal((await f.issue(o)).invoice.number,'RIG-2026-000001');await f.db.prepare('DROP TABLE rig_issued_invoices').run();assert.equal((await f.issue(o)).state,'unavailable');assert.deepEqual(await f.money(),before);
 }finally{await f.mf.dispose();}
});

test('Brussels midnight selects the actual issue year and each year starts at one without backdating',async()=>{
 const f=await fixture();try{
  const a=await f.order(),b=await f.order(),oldYear=await f.issue(a,{now:Date.parse('2026-12-31T22:59:59.999Z')}),newYear=await f.issue(b,{now:Date.parse('2026-12-31T23:00:00Z')});
  assert.equal(oldYear.invoice.number,'RIG-2026-000001');assert.equal(oldYear.invoice.issuedDate,'2026-12-31');assert.equal(newYear.invoice.number,'RIG-2027-000001');assert.equal(newYear.invoice.issuedDate,'2027-01-01');assert.equal(newYear.invoice.paidAt,'2026-11-01T12:00:00.000Z');assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:2},{issue_year:2027,next_sequence:2}]);
 }finally{await f.mf.dispose();}
});

test('existing invoice survives a credit reversal and changed profiles; reads remain scoped when issuance is paused',async()=>{
 const f=await fixture();try{
  const o=await f.order(),initial=await f.issue(o),frozen=await f.rows();await f.db.prepare("UPDATE rig_purchase_billing SET name='Changed profile',street='Other street 55' WHERE user_id=? AND request_id=?").bind(ALICE,o.requestId).run();await f.db.prepare("UPDATE rig_orders SET state='reversal_review' WHERE id=?").bind(o.id).run();await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,order_id,delta) VALUES(?,?,?,-500)').bind('reverse:'+o.id,ALICE,o.id).run();
  const env={...f.env,RIG_AUTOMATIC_INVOICES_ENABLED:'no'},owned=await getOwnedPurchaseInvoice(env,{userId:ALICE,requestId:o.requestId,now:NOW+1000});assert.equal(owned.state,'existing');assert.deepEqual(owned.invoice,initial.invoice);assert.deepEqual(await f.rows(),frozen);
  assert.equal((await getOwnedPurchaseInvoice(env,{userId:BOB,requestId:o.requestId,now:NOW})).reason,'not_found');assert.equal((await getOwnerPurchaseInvoice(env,{userId:ALICE,orderId:o.id,now:NOW})).state,'forbidden');assert.equal((await getOwnerPurchaseInvoice(env,{userId:OWNER,orderId:o.id,now:NOW})).invoice.number,initial.invoice.number);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_issued_invoices').first()).n,1);
  await f.db.prepare("UPDATE rig_issued_invoices SET snapshot_json=json_set(snapshot_json,'$.amountCents',1) WHERE order_id=?").bind(o.id).run();assert.equal((await getOwnedPurchaseInvoice(env,{userId:ALICE,requestId:o.requestId,now:NOW})).reason,'invoice_snapshot_invalid');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_finance_expenses').first()).n,0);
 }finally{await f.mf.dispose();}
});

test('owned read repair is isolated, collector is bounded and old review cases do not starve eligible purchases',async()=>{
 const f=await fixture();try{
  const old=await f.order({acceptance:false,createdAt:'2026-10-01 00:00:00'}),valid=await f.order({createdAt:'2026-11-01 00:00:00'});
  assert.equal((await getOwnedPurchaseInvoice(f.env,{userId:BOB,requestId:valid.requestId,now:NOW})).reason,'not_found');assert.deepEqual(await f.rows(),[]);
  let stats=await ensurePendingInvoices(f.env,{now:NOW,limit:1});assert.equal(stats.checked,1);assert.equal(stats.reviewNeeded,1);assert.deepEqual(await f.rows(),[]);
  stats=await ensurePendingInvoices(f.env,{now:NOW+1,limit:1});assert.equal(stats.checked,1);assert.equal(stats.issued,1);assert.equal((await f.rows())[0].order_id,valid.id);
  const repair=await f.order();assert.equal((await getOwnedPurchaseInvoice(f.env,{userId:ALICE,requestId:repair.requestId,now:NOW+2})).state,'issued');assert.equal((await getOwnedPurchaseInvoice(f.env,{userId:ALICE,requestId:repair.requestId,now:NOW+3})).state,'existing');
  for(const limit of [0,21,1.5])await assert.rejects(ensurePendingInvoices(f.env,{now:NOW,limit}));assert.deepEqual(await ensurePendingInvoices({...f.env,RIG_AUTOMATIC_INVOICES_ENABLED:'no'}),{checked:0,issued:0,existing:0,reviewNeeded:0,unavailable:0,disabled:true});assert.equal((await f.legacy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rig_issued_invoices'").first()).n,0);
 }finally{await f.mf.dispose();}
});

test('exhausted numbering requires review and cannot wrap or reuse an invoice number',async()=>{
 const f=await fixture();try{
  const o=await f.order();await f.db.prepare('INSERT INTO rig_invoice_counters(issue_year,next_sequence) VALUES(2026,1000000000000)').run();const value=await f.issue(o);assert.equal(value.state,'review-required');assert.equal(value.reason,'numbering_exhausted');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:1000000000000}]);
 }finally{await f.mf.dispose();}
});

test('a reserved manual number on another purchase cannot collide with the automatic sequence',async()=>{
 const f=await fixture();try{
  const manual=await f.order(),automatic=await f.order();await manualDocument(f.db,manual.id);await f.db.prepare("UPDATE rig_accounting_documents SET external_invoice_reference='RIG-2026-000001',reference_key='rig-2026-000001' WHERE order_id=?").bind(manual.id).run();await f.db.prepare("INSERT INTO rig_accounting_references(reference_key,order_id,created_at) VALUES('rig-2026-000001',?,?)").bind(manual.id,NOW).run();
  const value=await f.issue(automatic);assert.equal(value.state,'review-required');assert.equal(value.reason,'number_collision');assert.deepEqual(await f.rows(),[]);assert.deepEqual(await f.counters(),[{issue_year:2026,next_sequence:1}]);
 }finally{await f.mf.dispose();}
});
