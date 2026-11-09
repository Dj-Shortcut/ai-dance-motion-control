// Owner-only handoff for manually maintained Accountable books. CSV files are
// evidence, not an Accountable API import or a tax journal. Nothing issues or
// sends an invoice, changes credit, or claims Peppol delivery was verified.
import {validateProductionTenant} from './production-tenant.mjs';
import {prepareOwnerMutation} from './owner-security.mjs';
import {validProfitSnapshot} from './profit-policy.mjs';
import {d1Limit} from './router.mjs';
import {accountableMailReady} from './invoice-mail.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST=/^[A-Za-z0-9_-]{12,80}$/;
const PAYMENT=/^tr_[A-Za-z0-9]{6,80}$/;
const KINDS=new Set(['purchases','credit-events','costs','estimates']);
const MAX_ROWS=5000,OVERVIEW_ROWS=200;
const ISSUE_STATES=new Set(['disabled','not-eligible','review-required','unavailable','issued','existing']);
const ISSUE_REASONS=new Set(['payment_not_verified','credit_not_verified','payment_reversed','external_document_exists','acceptance_missing','acceptance_invalid','seller_invalid','billing_missing','billing_invalid','invoice_snapshot_invalid','number_collision','numbering_exhausted','source_changed','invoice_storage_unavailable','production_unavailable']);
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value,status=200)=>Response.json(value,{status,headers});
const error=(message,status=400)=>json({error:message},status);
const whole=value=>Number.isSafeInteger(value);
const effectiveDocument=`SELECT d.* FROM rig_accounting_documents d WHERE NOT EXISTS(SELECT 1 FROM rig_accounting_documents r WHERE r.replaces_document_id=d.id)`;
const credited=`EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits)`;
const paidProof=`o.state='paid' AND o.payment_id IS NOT NULL AND ${credited} AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='reverse:'||o.id)`;
const purchaseTime="COALESCE((SELECT l.created_at FROM rig_ledger l WHERE l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits),o.created_at)";
const periodSQL=column=>`(? IS NULL OR ${column}>=?) AND (? IS NULL OR ${column}<?)`;
const periodArgs=period=>[period.start,period.start,period.end,period.end];
const sqlTime=column=>`CAST(strftime('%s',${column}) AS INTEGER)*1000`;
const reference=value=>value.normalize('NFKC').trim().toLowerCase();
const dateValid=value=>typeof value==='string'&&/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const localDate=now=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=type=>parts.find(p=>p.type===type).value;return get('year')+'-'+get('month')+'-'+get('day');};
function monthStart(year,month){
 const n=Date.UTC(year,month-1,1),value=new Intl.DateTimeFormat('en',{timeZone:'Europe/Brussels',timeZoneName:'shortOffset'}).formatToParts(n).find(p=>p.type==='timeZoneName')?.value,offset=/^GMT\+([12])$/.exec(value||'');
 if(!offset)throw Error('Unsupported report timezone');return n-Number(offset[1])*3600000;
}
function reportPeriod(url){
 if(!url.search)return {month:null,start:null,end:null,timeZone:'Europe/Brussels'};
 if(!/^\?month=20\d{2}-(?:0[1-9]|1[0-2])$/.test(url.search))return null;
 const month=url.searchParams.get('month'),[year,m]=month.split('-').map(Number);
 return {month,start:monthStart(year,m),end:m===12?monthStart(year+1,1):monthStart(year,m+1),timeZone:'Europe/Brussels'};
}
function checkedInt(value){if(!whole(value))throw Error('Unsafe accounting number');return value;}
function externalDocument(row){return row&&({id:row.id,orderId:row.order_id,provider:'accountable',externalInvoiceReference:row.external_invoice_reference,documentDate:row.document_date,recordType:row.record_type,deliveryStatus:row.delivery_status,recordedByOwner:true,providerConfirmed:false,peppolDeliveryVerified:false,note:row.note,replacesDocumentId:row.replaces_document_id,createdAt:row.created_at});}
const purchaseSelect=`SELECT o.*,CASE WHEN ${credited} THEN 1 ELSE 0 END AS credit_proved,
 CASE WHEN ${paidProof} THEN 1 ELSE 0 END AS currently_paid,
 COALESCE((SELECT -delta FROM rig_ledger WHERE event_id='reverse:'||o.id AND order_id=o.id AND user_id=o.user_id AND delta=-o.credits),0) AS credit_reversal_cents,
 (SELECT created_at FROM rig_ledger WHERE event_id='credit:'||o.id AND order_id=o.id AND user_id=o.user_id AND delta=o.credits) AS credit_at,
 a.buyer_country,a.customer_type,a.version AS accepted_terms_version,a.created_at AS accepted_at,a.package_id AS agreed_package_id,a.amount_cents AS agreed_amount_cents,a.credits AS agreed_credits,a.currency AS agreed_currency,
 ia.last_state AS invoice_issue_state,ia.last_reason AS invoice_issue_reason,ia.last_checked_at AS invoice_checked_at,
 i.id AS issued_invoice_id,i.invoice_number,i.issued_date AS invoice_issued_date,p.byte_length AS invoice_pdf_bytes,m.state AS invoice_mail_state,m.completed_at AS invoice_mail_at,
 d.id AS document_id,d.external_invoice_reference,d.document_date,d.record_type,d.delivery_status,d.note AS document_note,d.replaces_document_id,d.created_at AS document_created_at
 FROM rig_orders o LEFT JOIN (${effectiveDocument}) d ON d.order_id=o.id LEFT JOIN rig_purchase_acceptances a ON a.user_id=o.user_id AND a.request_id=o.request_id LEFT JOIN rig_issued_invoices i ON i.order_id=o.id LEFT JOIN rig_invoice_archives p ON p.invoice_id=i.id LEFT JOIN rig_invoice_mail_outbox m ON m.invoice_id=i.id LEFT JOIN rig_invoice_issuance_attempts ia ON ia.order_id=o.id`;
function publicPurchase(row){
 const amount=checkedInt(row.amount_cents),credits=checkedInt(row.credits),proved=row.credit_proved===1&&['paid','reversal_review'].includes(row.state);
 return {orderId:row.id,orderReference:'RIG-'+row.id,accountReference:row.user_id,paymentReference:row.payment_id,state:row.state,createdAt:row.created_at,creditedAt:row.credit_at,currency:'EUR',orderAmountCents:amount,verifiedReceiptCents:proved?amount:0,issuedPurchasedCreditCents:proved?credits:0,currentlyPaid:row.currently_paid===1,creditReversalCents:checkedInt(row.credit_reversal_cents),mollieFeeCents:null,netPayoutCents:null,cashRefundCents:null,bankReconciliation:'not-imported',declaredCountry:row.buyer_country??null,declaredCustomerType:row.customer_type??null,acceptedTermsVersion:row.accepted_terms_version??null,acceptedAt:row.accepted_at==null?null:new Date(row.accepted_at).toISOString(),countryEvidence:row.buyer_country?'customer-declaration-not-verified-tax-determination':null,agreedPackageId:row.agreed_package_id??null,agreedAmountCents:row.agreed_amount_cents??null,agreedCreditCents:row.agreed_credits??null,agreedCurrency:row.agreed_currency??null,acceptanceMatchesOrder:row.accepted_terms_version?row.agreed_package_id===row.package_id&&row.agreed_amount_cents===row.amount_cents&&row.agreed_credits===row.credits&&row.agreed_currency==='EUR':null,invoiceIssueState:row.issued_invoice_id?'issued':ISSUE_STATES.has(row.invoice_issue_state)?row.invoice_issue_state:proved?'not-issued':null,invoiceIssueReason:row.issued_invoice_id?null:ISSUE_REASONS.has(row.invoice_issue_reason)?row.invoice_issue_reason:null,invoiceLastCheckedAt:row.invoice_checked_at??null,invoice:row.issued_invoice_id?{id:row.issued_invoice_id,number:row.invoice_number,issuedDate:row.invoice_issued_date,pdfReady:row.invoice_pdf_bytes!=null,pdfPath:'/api/owner/invoices/'+row.issued_invoice_id+'/pdf',mailState:row.invoice_mail_state??'not-sent',mailSentAt:row.invoice_mail_at,accountableValidated:false,peppolDeliveryVerified:false}:null,document:row.document_id?{id:row.document_id,provider:'accountable',externalInvoiceReference:row.external_invoice_reference,documentDate:row.document_date,recordType:row.record_type,deliveryStatus:row.delivery_status,recordedByOwner:true,providerConfirmed:false,peppolDeliveryVerified:false}:null};
}
function csvCell(value){
 if(typeof value==='number')return String(checkedInt(value));
 if(typeof value==='boolean')return value?'true':'false';
 let text=value==null?'':String(value);if(/^[\s]*[=+\-@]/u.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function accountingCSV(columns,rows){return '\ufeff'+[columns.map(csvCell).join(';'),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(';'))].join('\r\n')+'\r\n';}
async function bounded(db,statement){const result=await statement.all();if(!Array.isArray(result.results)||result.results.length>MAX_ROWS)throw Error('Accounting export exceeds row limit');return result.results;}
async function purchases(db,period,limit=MAX_ROWS,newestFirst=false){const direction=newestFirst?'DESC':'ASC';return (await db.prepare(purchaseSelect+` WHERE ${periodSQL(sqlTime(purchaseTime))} ORDER BY ${purchaseTime} ${direction},o.id ${direction} LIMIT ?`).bind(...periodArgs(period),limit+1).all()).results;}
const actualExpenses=`SELECT e.* FROM rig_finance_expenses e WHERE NOT EXISTS(SELECT 1 FROM rig_finance_expenses r WHERE r.replaces_expense_id=e.id)`;
async function exportData(db,kind,period){
 if(kind==='purchases'){
  const raw=await purchases(db,period);if(raw.length>MAX_ROWS)throw Error('Accounting export exceeds row limit');
  return {columns:['order_id','order_reference','account_reference','payment_reference','state','created_at_utc','credited_at_utc','currency','order_amount_cents','verified_receipt_cents','purchased_credit_issued_cents','credit_reversal_cents','currently_paid','mollie_fee_cents','cash_refund_cents','net_payout_cents','bank_reconciliation','declared_country','declared_customer_type','accepted_terms_version','accepted_at_utc','country_evidence','agreed_package_id','agreed_amount_cents','agreed_credit_cents','agreed_currency','acceptance_matches_order','rig_invoice_number','rig_invoice_date','rig_invoice_pdf_ready','rig_invoice_issue_state','rig_invoice_issue_reason','accountable_mail_state','accountable_validated','accountable_reference','record_type','owner_recorded_status','peppol_delivery_verified'],rows:raw.map(row=>{const p=publicPurchase(row);return {order_id:p.orderId,order_reference:p.orderReference,account_reference:p.accountReference,payment_reference:p.paymentReference,state:p.state,created_at_utc:p.createdAt,credited_at_utc:p.creditedAt,currency:'EUR',order_amount_cents:p.orderAmountCents,verified_receipt_cents:p.verifiedReceiptCents,purchased_credit_issued_cents:p.issuedPurchasedCreditCents,credit_reversal_cents:p.creditReversalCents,currently_paid:p.currentlyPaid,mollie_fee_cents:null,cash_refund_cents:null,net_payout_cents:null,bank_reconciliation:'not-imported',declared_country:p.declaredCountry,declared_customer_type:p.declaredCustomerType,accepted_terms_version:p.acceptedTermsVersion,accepted_at_utc:p.acceptedAt,country_evidence:p.countryEvidence,agreed_package_id:p.agreedPackageId,agreed_amount_cents:p.agreedAmountCents,agreed_credit_cents:p.agreedCreditCents,agreed_currency:p.agreedCurrency,acceptance_matches_order:p.acceptanceMatchesOrder,rig_invoice_number:p.invoice?.number,rig_invoice_date:p.invoice?.issuedDate,rig_invoice_pdf_ready:p.invoice?.pdfReady,rig_invoice_issue_state:p.invoiceIssueState,rig_invoice_issue_reason:p.invoiceIssueReason,accountable_mail_state:p.invoice?.mailState,accountable_validated:false,accountable_reference:p.document?.externalInvoiceReference,record_type:p.document?.recordType,owner_recorded_status:p.document?.deliveryStatus,peppol_delivery_verified:false};})};
 }
 if(kind==='credit-events'){
  const rows=await bounded(db,db.prepare(`SELECT event_id,user_id,order_id,delta,created_at FROM rig_ledger WHERE ${periodSQL(sqlTime('created_at'))} ORDER BY created_at,event_id LIMIT ?`).bind(...periodArgs(period),MAX_ROWS+1));
  return {columns:['event_id','account_reference','order_id','event_kind','credit_delta_cents','currency','created_at_utc','accounting_treatment'],rows:rows.map(row=>({event_id:row.event_id,account_reference:row.user_id,order_id:row.order_id,event_kind:row.event_id.split(':')[0],credit_delta_cents:checkedInt(row.delta),currency:'EUR',created_at_utc:row.created_at,accounting_treatment:'credit-journal-not-additional-cash-revenue'}))};
 }
 if(kind==='costs'){
  const rows=await bounded(db,db.prepare(`SELECT * FROM (${actualExpenses}) WHERE ${periodSQL(sqlTime("expense_date||' 00:00:00'"))} ORDER BY expense_date,id LIMIT ?`).bind(...periodArgs(period),MAX_ROWS+1));
  return {columns:['record_id','category','expense_date','recorded_amount_cents','currency','description_or_reference','job_id','replaces_record_id','evidence','treatment'],rows:rows.map(row=>({record_id:row.id,category:row.category,expense_date:row.expense_date,recorded_amount_cents:checkedInt(row.amount_cents),currency:'EUR',description_or_reference:row.note,job_id:row.job_id,replaces_record_id:row.replaces_expense_id,evidence:'owner-recorded-not-provider-imported',treatment:row.category==='fal-topup'?'cash-topup-not-additional-usage-expense':row.category==='refund'?'cash-refund-record-only-not-credit-or-revenue-adjustment':'recorded-cost'}))};
 }
 const at="CASE WHEN j.state='completed' AND j.finalized_at IS NOT NULL THEN j.finalized_at ELSE c.authorized_at END";
 const rows=await bounded(db,db.prepare(`SELECT c.*,q.price_cents,j.state,${at} AS report_at FROM rig_generation_costs c JOIN rig_generation_quotes q ON q.id=c.quote_id AND q.user_id=c.user_id JOIN rig_generation_jobs j ON j.id=c.job_id AND j.user_id=c.user_id WHERE ${periodSQL(at)} ORDER BY report_at,c.job_id LIMIT ?`).bind(...periodArgs(period),MAX_ROWS+1));
 return {columns:['job_id','account_reference','funding_kind','state','report_at_utc','provider_estimate_usd_micros','provider_cost_estimate_eur_cents','payment_fee_reserve_eur_cents','failure_reserve_eur_cents','preparation_reserve_eur_cents','total_estimate_eur_cents','evidence','accounting_treatment'],rows:rows.map(row=>{let snapshot;try{const s=JSON.parse(row.snapshot_json);if(validProfitSnapshot(s,{policy:{...s,version:s.policyVersion},fundingKind:row.funding_kind,retailPriceCents:row.price_cents,providerEstimateUsdMicros:row.provider_estimate_usd_micros}))snapshot=s;}catch{}return {job_id:row.job_id,account_reference:row.user_id,funding_kind:row.funding_kind,state:row.state,report_at_utc:new Date(row.report_at).toISOString(),provider_estimate_usd_micros:checkedInt(row.provider_estimate_usd_micros),provider_cost_estimate_eur_cents:snapshot?.providerCostCents,payment_fee_reserve_eur_cents:snapshot?.paymentFeeReserveCents,failure_reserve_eur_cents:snapshot?.failureReserveCents,preparation_reserve_eur_cents:snapshot?.preparationCents,total_estimate_eur_cents:snapshot?.estimatedCostCents,evidence:snapshot?'estimate-not-invoice':'missing-or-invalid-estimate',accounting_treatment:'planning-only-do-not-book-as-actual-cost'};})};
}
async function overview(db,period,env){
 const raw=await purchases(db,period,OVERVIEW_ROWS,true),hasMore=raw.length>OVERVIEW_ROWS;
 const [documents,balances,counts,holds]=await db.batch([
  db.prepare(`SELECT d.* FROM (${effectiveDocument}) d JOIN rig_orders o ON o.id=d.order_id WHERE ${periodSQL(sqlTime(purchaseTime))} ORDER BY d.created_at DESC LIMIT ?`).bind(...periodArgs(period),OVERVIEW_ROWS),
  db.prepare(`SELECT COALESCE(SUM(MAX(balance,0)),0) AS available,COALESCE(SUM(MAX(-balance,0)),0) AS negative FROM (SELECT user_id,SUM(delta) AS balance FROM rig_ledger GROUP BY user_id)`),
  db.prepare(`SELECT COUNT(*) AS paid_count,COALESCE(SUM(o.amount_cents),0) AS gross_cents,SUM(CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END) AS linked_count,SUM(CASE WHEN o.state='reversal_review' THEN 1 ELSE 0 END) AS reversal_review_count FROM rig_orders o LEFT JOIN (${effectiveDocument}) d ON d.order_id=o.id WHERE o.payment_id IS NOT NULL AND o.state IN ('paid','reversal_review') AND ${credited} AND ${periodSQL(sqlTime(purchaseTime))}`).bind(...periodArgs(period)),
  db.prepare("SELECT COALESCE(SUM(-l.delta),0) AS held FROM rig_ledger l WHERE l.event_id LIKE 'reserve:%' AND l.delta<0 AND NOT EXISTS(SELECT 1 FROM rig_ledger f WHERE f.event_id IN ('release:'||substr(l.event_id,9),'settle:'||substr(l.event_id,9)))")
 ]);
 const total=counts.results?.[0],balance=balances.results?.[0],held=holds.results?.[0];if(!total||!balance||!held)throw Error('Accounting overview unavailable');
 return {provider:'accountable',connection:'manual',period:{month:period.month,timeZone:period.timeZone},automaticInvoiceIssuance:env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes',accountableDeliveryConfigured:accountableMailReady(env),accountableValidationRequired:true,accountableValidated:false,automaticPeppolDelivery:false,accountableAPIConnected:false,formalAccountingComplete:false,actualProfitCents:null,actualFeeAndPayoutImportAvailable:false,paidPurchaseCount:checkedInt(total.paid_count),verifiedGrossReceiptsCents:checkedInt(total.gross_cents),purchasesWithOwnerRecordedReference:checkedInt(total.linked_count??0),purchasesWithoutReference:checkedInt(total.paid_count-(total.linked_count??0)),availableCreditLiabilityCents:checkedInt(balance.available),heldCreditLiabilityCents:checkedInt(held.held),outstandingCreditLiabilityCents:checkedInt(balance.available+held.held),reversalReviewCount:checkedInt(total.reversal_review_count??0),negativeCreditCents:checkedInt(balance.negative),purchases:raw.slice(0,OVERVIEW_ROWS).map(publicPurchase),hasMorePurchases:hasMore,documents:(documents.results||[]).map(externalDocument),exports:[...KINDS].map(kind=>({kind,path:'/api/owner/accounting/export/'+kind+'.csv'+(period.month?'?month='+period.month:'')})),checklist:[{id:'sales-evidence',state:total.paid_count===(total.linked_count??0)?'owner-references-recorded':'needs-owner-action',text:env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes'?'Importeer de originele RIG-factuur als externe factuur in Accountable. Maak geen tweede factuur; controleer de invoer en leg daarna de verwerkingsreferentie vast.':'Maak de juiste verkoopregistratie in Accountable en koppel de externe referentie. Een RIG-betalingsbewijs is geen btw-factuur.'},{id:'provider-invoices',state:'external-review-required',text:'Verwerk echte Fal-, Mollie- en hostingfacturen in Accountable. Raming en voorschot zijn geen tweede werkelijke kost.'},{id:'bank-reconciliation',state:'external-review-required',text:'Stem bruto aankopen, Mollie-kosten, terugbetalingen en netto uitbetalingen af met Mollie en je bank.'},{id:'payment-reversals',state:(total.reversal_review_count??0)>0?'needs-owner-action':'none-recorded',text:'Controleer terugboekingen in Mollie en verwerk eventuele creditnota’s apart in Accountable; een credit-terugboeking is geen bewezen bankterugbetaling.'},{id:'peppol',state:'external-review-required',text:'Eventuele Peppol-verzending gebeurt in Accountable. RIG controleert geen bezorging en ontvangt geen Peppol-bevestiging.'}],warnings:['Een verzonden factuurmail bewijst geen ontvangst, validatie of boeking in Accountable.','Deze bestanden zijn een handmatige overdracht, geen automatische Accountable-import of volledige boekhouding.','Tegoedaankopen en later videogebruik zijn verschillende gebeurtenissen; tel ze niet beide als ontvangen geld.','Een credit-terugboeking bewijst niet het daadwerkelijk teruggestorte bankbedrag.','Mollie-kosten, bankuitbetalingen, fiscale behandeling en btw zijn niet automatisch vastgesteld.','Openstaand RIG-tegoed omvat ook gratis tegoed; dit is een operationele verplichting, geen automatische fiscale boeking.']};
}
async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const len=req.headers.get('content-length');if(len!==null&&(!/^\d+$/.test(len)||Number(len)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;const chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Body timeout')),10000);});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>8192)return null;chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
async function saveDocument(req,db,ownerId,now){
 const data=await readJSON(req),required=['idempotencyKey','orderId','externalInvoiceReference','documentDate','recordType','deliveryStatus','note'],optional=['replacesDocumentId','verification'];
 if(!data||required.some(key=>!Object.hasOwn(data,key))||Object.keys(data).some(key=>!required.includes(key)&&!optional.includes(key))||!UUID.test(data.idempotencyKey||'')||!UUID.test(data.orderId||'')||typeof data.externalInvoiceReference!=='string'||Array.from(data.externalInvoiceReference.trim()).length<1||Array.from(data.externalInvoiceReference).length>80||/[\u0000-\u001f\u007f]/.test(data.externalInvoiceReference)||!dateValid(data.documentDate)||data.documentDate>localDate(now)||!['invoice','accounting-entry'].includes(data.recordType)||!['prepared','recorded-in-accountable','peppol-sent-manually'].includes(data.deliveryStatus)||(data.deliveryStatus==='peppol-sent-manually'&&data.recordType!=='invoice')||typeof data.note!=='string'||Array.from(data.note).length>240||/[\u0000-\u001f\u007f]/.test(data.note)||Object.hasOwn(data,'replacesDocumentId')&&!UUID.test(data.replacesDocumentId||''))return error('Controleer de aankoop, Accountable-referentie en datum.');
 const {verification,...payload}=data,normalized={...payload,externalInvoiceReference:data.externalInvoiceReference.trim(),note:data.note.trim()},digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.keys(normalized).sort().map(key=>[key,normalized[key]])))))),x=>x.toString(16).padStart(2,'0')).join('');
 const prior=await db.prepare('SELECT id,request_hash FROM rig_accounting_documents WHERE idempotency_key=?').bind(data.idempotencyKey).first();
 if(prior)return prior.request_hash===digest?json({recorded:true,id:prior.id,replayed:true,providerConfirmed:false}):error('Deze aanvraagcode hoort bij een andere registratie.',409);
 const security=await prepareOwnerMutation(db,{ownerId,operation:'accounting-document',payload,verification,now});if(!security.ok)return security.response;
 const id=crypto.randomUUID(),ref=reference(data.externalInvoiceReference),replaces=data.replacesDocumentId??null;
 const eligible=`EXISTS(SELECT 1 FROM rig_orders o WHERE o.id=? AND ${paidProof}
   AND NOT EXISTS(SELECT 1 FROM rig_issued_invoices i WHERE lower(i.invoice_number)=? AND i.order_id<>o.id)
   AND (?<>'invoice' OR NOT EXISTS(SELECT 1 FROM rig_issued_invoices i WHERE i.order_id=o.id) OR EXISTS(SELECT 1 FROM rig_issued_invoices i WHERE i.order_id=o.id AND i.invoice_number=?)))
  AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM rig_accounting_documents WHERE order_id=?)) OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM rig_accounting_documents d WHERE d.id=? AND d.order_id=? AND NOT EXISTS(SELECT 1 FROM rig_accounting_documents r WHERE r.replaces_document_id=d.id))))`;
 const eligibleArgs=[data.orderId,ref,data.recordType,data.externalInvoiceReference.trim(),replaces,data.orderId,replaces,replaces,data.orderId];
 const reserve=db.prepare(`INSERT INTO rig_accounting_references(reference_key,order_id,created_at) SELECT ?,?,? WHERE (${security.gate.sql}) AND ${eligible} ON CONFLICT(reference_key) DO NOTHING`).bind(ref,data.orderId,now,...security.gate.params,...eligibleArgs);
 const insert=db.prepare(`INSERT INTO rig_accounting_documents(id,idempotency_key,order_id,provider,external_invoice_reference,reference_key,document_date,record_type,delivery_status,note,replaces_document_id,request_hash,recorded_by,created_at)
  SELECT ?,?,?,'accountable',?,?,?,?,?,?,?,?,?,? WHERE (${security.gate.sql}) AND ${eligible} AND EXISTS(SELECT 1 FROM rig_accounting_references WHERE reference_key=? AND order_id=?)`).bind(id,data.idempotencyKey,data.orderId,data.externalInvoiceReference.trim(),ref,data.documentDate,data.recordType,data.deliveryStatus,data.note.trim(),replaces,digest,ownerId,now,...security.gate.params,...eligibleArgs,ref,data.orderId);
 try{const results=await db.batch([...security.before,reserve,insert]);if(results.at(-1)?.meta?.changes===1)return json({id,recorded:true,replayed:false,recordedByOwner:true,providerConfirmed:false,peppolDeliveryVerified:false},201);}catch{}
 const concurrent=await db.prepare('SELECT id,request_hash FROM rig_accounting_documents WHERE idempotency_key=?').bind(data.idempotencyKey).first();if(concurrent?.request_hash===digest)return json({id:concurrent.id,recorded:true,replayed:true,providerConfirmed:false});
 return error('Niet opgeslagen. Controleer of de aankoop betaald is, de referentie uniek is en je de meest recente registratie corrigeert. Bij een uitgegeven RIG-factuur moet het factuurnummer exact overeenkomen; kies Boekingsreferentie voor een ander extern registratienummer.',409);
}
// userId must be supplied by the signed private Sites composition.
export async function handleOwnerAccounting(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return error('Geen toegang.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return error('Administratie is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url);if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return error('Aanvraag geweigerd.',403);
 if(await d1Limit({env:mapped,category:'finance',userId,method:req.method})!==true)return error('Te veel aanvragen. Probeer later opnieuw.',429);
 try{
  if(req.method==='POST'&&url.pathname==='/api/owner/accounting/documents'&&!url.search)return await saveDocument(req,mapped.DB,userId,now);
  if(req.method!=='GET')return error('Niet gevonden.',404);
  const period=reportPeriod(url);if(!period)return error('Kies een geldige maand.');
  if(url.pathname==='/api/owner/accounting')return json(await overview(mapped.DB,period,env));
  const match=/^\/api\/owner\/accounting\/export\/([a-z-]+)\.csv$/.exec(url.pathname);if(!match||!KINDS.has(match[1]))return error('Niet gevonden.',404);
  const result=await exportData(mapped.DB,match[1],period),csv=accountingCSV(result.columns,result.rows);
  if(new TextEncoder().encode(csv).length>8*1024*1024)return error('Deze export is te groot. Kies een afzonderlijke maand.',413);
  return new Response(csv,{headers:{...headers,'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="rig-${match[1]}-${period.month??'alle-periodes'}.csv"`}});
 }catch(errorValue){return error(errorValue?.message==='Accounting export exceeds row limit'?'Deze export bevat te veel regels. Kies een afzonderlijke maand.':'Administratie is tijdelijk niet beschikbaar.',errorValue?.message==='Accounting export exceeds row limit'?413:503);}
}
const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function receiptAcceptance(row){
 if(typeof row.accepted_terms_version!=='string'||row.accepted_terms_version.length<1||row.accepted_terms_version.length>120||!['BE','NL'].includes(row.buyer_country)||row.customer_type!=='consumer'||(!whole(row.accepted_at)||row.accepted_at<=0)||row.agreed_package_id!==row.package_id||row.agreed_amount_cents!==row.amount_cents||row.agreed_credits!==row.credits||row.agreed_currency!=='EUR'||typeof row.terms_text!=='string'||row.terms_text.length<1||row.terms_text.length>262144)return null;
 try{const seller=JSON.parse(row.seller_json);if(!seller||typeof seller!=='object'||Array.isArray(seller)||!['legalName','enterpriseNumber','vatNumber','address','email','phone'].every(key=>typeof seller[key]==='string'&&seller[key].length>0&&seller[key].length<=500))return null;return {seller,version:row.accepted_terms_version,country:row.buyer_country,at:row.accepted_at,terms:row.terms_text};}catch{return null;}
}
// This is text formatting, not HTML sanitization. Escape the complete body
// before removing encoded tag markers. Every later replacement emits only
// whitespace, an empty string, or text passed through htmlEscape again.
function formatEscapedTerms(html){
 const body=/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1]??html;
 const escaped=htmlEscape(body);
 const formatted=escaped.replace(/&lt;br\s*\/?&gt;/gi,'\n').replace(/&lt;\/(?:p|h[1-6]|li|section|div|header|footer|main|dl|dd|dt|nav)&gt;/gi,'\n\n').replace(/&lt;[\s\S]*?&gt;/gi,'');
 return formatted.replace(/&amp;(amp|lt|gt|quot|apos|nbsp|#39|#x[0-9a-f]+|#\d+);/gi,(entity,name)=>{
  const standard={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ','#39':"'"},key=name.toLowerCase();
  if(Object.hasOwn(standard,key))return htmlEscape(standard[key]);
  const number=key.startsWith('#x')?parseInt(name.slice(2),16):Number(name.slice(1));return number>0&&number<=0x10ffff&&!(number>=0xd800&&number<=0xdfff)?htmlEscape(String.fromCodePoint(number)):entity;
 }).replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export async function handleOwnedPaymentReceipt(req,env,{userId,requestId}={}){
 if(!USER.test(userId||''))return error('Meld je aan bij RIG.',401);
 if(!REQUEST.test(requestId||''))return error('Niet gevonden.',404);
 const mapped=await validateProductionTenant(env);if(!mapped)return error('Betalingsbewijs is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url);if(req.method!=='GET'||url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.pathname!=='/api/payments/orders/'+requestId+'/receipt'||url.search)return error('Niet gevonden.',404);
 if(await d1Limit({env:mapped,category:'payment',userId,method:'GET'})!==true)return error('Te veel aanvragen. Probeer later opnieuw.',429);
 try{
  const row=await mapped.DB.prepare(`SELECT o.id,o.package_id,o.amount_cents,o.credits,o.payment_id,l.created_at,a.version AS accepted_terms_version,a.buyer_country,a.customer_type,a.seller_json,a.terms_text,a.created_at AS accepted_at,a.package_id AS agreed_package_id,a.amount_cents AS agreed_amount_cents,a.credits AS agreed_credits,a.currency AS agreed_currency FROM rig_orders o LEFT JOIN rig_purchase_acceptances a ON a.user_id=o.user_id AND a.request_id=o.request_id JOIN rig_ledger l ON l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits WHERE o.request_id=? AND o.user_id=? AND ${paidProof}`).bind(requestId,userId).first();
  if(!row||!UUID.test(row.id)||!PAYMENT.test(row.payment_id||'')||!whole(row.amount_cents)||row.amount_cents<=0||!whole(row.credits)||row.credits<=0)return error('Betalingsbewijs niet beschikbaar.',404);
  const acceptance=receiptAcceptance(row);if((env.RIG_COMMERCIAL_CHECKOUT_REQUIRED==='yes'||row.accepted_terms_version!==null)&&!acceptance)return error('Dit betalingsbewijs moet door de verkoper worden gecontroleerd.',503);
  const acceptanceHTML=acceptance?`<section><h2>Verkoper bij aankoop</h2><dl>${[['Naam',acceptance.seller.legalName],['Ondernemingsnummer',acceptance.seller.enterpriseNumber],['Btw-nummer',acceptance.seller.vatNumber],['Adres',acceptance.seller.address],['E-mail',acceptance.seller.email],['Telefoon',acceptance.seller.phone]].map(([label,value])=>`<dt>${htmlEscape(label)}</dt><dd>${htmlEscape(value)}</dd>`).join('')}</dl><h2>Aankoopbevestiging</h2><p>Opgegeven klantland: ${htmlEscape(acceptance.country)} (klantverklaring; geen geverifieerde fiscale beoordeling). Klanttype: particulier. Voorwaardenversie: ${htmlEscape(acceptance.version)}. Bevestigd op: ${htmlEscape(new Date(acceptance.at).toISOString())}.</p><details><summary>Geaccepteerde verkoopvoorwaarden bij deze aankoop</summary><pre>${formatEscapedTerms(acceptance.terms)}</pre></details></section>`:'';
  const money=value=>'€ '+(value/100).toFixed(2).replace('.',','),html=`<!doctype html><html lang="nl"><meta charset="utf-8"><title>RIG-betalingsbewijs</title><body><h1>RIG-betalingsbewijs</h1><p><strong>Geen btw-factuur.</strong> Dit is het betalings- en tegoedbewijs van deze RIG-aankoop.</p><dl><dt>Aankoopreferentie</dt><dd>${htmlEscape('RIG-'+row.id)}</dd><dt>Betaalreferentie</dt><dd>${htmlEscape(row.payment_id)}</dd><dt>Bevestigd op (UTC)</dt><dd>${htmlEscape(row.created_at)}</dd><dt>Bedrag</dt><dd>${money(row.amount_cents)}</dd><dt>Bijgeschreven RIG-tegoed</dt><dd>${money(row.credits)}</dd></dl><p>Deze aankoop is als betaald gecontroleerd en het tegoed is bijgeschreven. Dit bewijs bevestigt geen bankuitbetaling aan de verkoper en geen geleverde video. Een eventuele formele factuur of boekingsregistratie wordt apart verwerkt.</p>${acceptanceHTML}</body></html>`;
  return new Response(html,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-disposition':`attachment; filename="RIG-betalingsbewijs-${row.id}.html"`,'content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
 }catch{return error('Betalingsbewijs is tijdelijk niet beschikbaar.',503);}
}
