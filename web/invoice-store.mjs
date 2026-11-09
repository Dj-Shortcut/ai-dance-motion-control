// Private production document store. Its callers must derive customer identity
// from the signed bridge. Issuance has no provider transport or money mutation.
import {validateProductionTenant} from './production-tenant.mjs';
import {normalizePurchaseBilling} from './purchase-billing.mjs';
const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUEST=/^[A-Za-z0-9_-]{12,80}$/;
const HASH=/^[a-f0-9]{64}$/;
const PAYMENT=/^tr_[A-Za-z0-9]{6,80}$/;
const MAX_SEQUENCE=999999999999;
const EXEMPTION='Bijzondere vrijstellingsregeling van belasting';
const result=(state,reason)=>({state,...(reason?{reason}:{})});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const validNow=value=>Number.isSafeInteger(value)&&value>=Date.UTC(2000,0,1)&&value<=Date.UTC(9999,11,31,22,59,59);
const text=(value,min,max)=>typeof value==='string'&&Array.from(value).length>=min&&Array.from(value).length<=max&&!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
function localDate(now){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),get=key=>p.find(x=>x.type===key)?.value;return get('year')+'-'+get('month')+'-'+get('day');}
function utcTime(value){if(typeof value!=='string')return null;const candidate=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)?value.replace(' ','T')+'Z':value;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(candidate))return null;const time=Date.parse(candidate);return Number.isSafeInteger(time)?time:null;}
function sellerData(json){
 try{const value=JSON.parse(json);if(!value||Array.isArray(value)||typeof value!=='object'||!['legalName','enterpriseNumber','vatNumber','address','email','phone'].every(key=>text(value[key],1,500))||value.country!=='BE'||!/^BE[\d. ]+$/.test(value.vatNumber)||value.vatNumber.replace(/[. ]/g,'').length!==12)return null;
  return Object.fromEntries(['legalName','enterpriseNumber','vatNumber','address','email','phone','country'].map(key=>[key,value[key]]));
 }catch{return null;}
}
function billingData(row){
 if(row.billing_delivery!=='rig-download-v1'||row.billing_hash!==row.acceptance_hash||row.billing_country!==row.buyer_country)return null;
 const value=normalizePurchaseBilling({name:row.billing_name,street:row.billing_street,postalCode:row.billing_postal_code,city:row.billing_city},row.billing_country);
 if(!value||value.name!==row.billing_name||value.street!==row.billing_street||value.postalCode!==row.billing_postal_code||value.city!==row.billing_city||value.country!==row.billing_country)return null;
 return {name:value.name,addressLine1:value.street,addressLine2:'',postalCode:value.postalCode,city:value.city,country:value.country};
}
const proofSelect=`SELECT o.*,l.created_at AS credited_at,
 EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='reverse:'||o.id) AS has_reversal,
 EXISTS(SELECT 1 FROM rig_accounting_documents WHERE order_id=o.id) AS has_external_document,
 a.version AS terms_version,a.buyer_country,a.customer_type,a.package_id AS agreed_package_id,a.amount_cents AS agreed_amount_cents,a.credits AS agreed_credits,a.currency AS agreed_currency,a.request_hash AS acceptance_hash,a.seller_json,a.terms_text,a.created_at AS accepted_at,
 b.name AS billing_name,b.street AS billing_street,b.postal_code AS billing_postal_code,b.city AS billing_city,b.country AS billing_country,b.electronic_delivery AS billing_delivery,b.request_hash AS billing_hash,b.created_at AS billing_at
 FROM rig_orders o LEFT JOIN rig_ledger l ON l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits
 LEFT JOIN rig_purchase_acceptances a ON a.user_id=o.user_id AND a.request_id=o.request_id
 LEFT JOIN rig_purchase_billing b ON b.user_id=o.user_id AND b.request_id=o.request_id WHERE o.id=?`;

async function makeSnapshot(row,now){
 if(!UUID.test(row.id||'')||!USER.test(row.user_id||'')||!REQUEST.test(row.request_id||'')||row.state!=='paid'||!PAYMENT.test(row.payment_id||'')||!Number.isSafeInteger(row.amount_cents)||row.amount_cents<1||row.amount_cents>1000000||!Number.isSafeInteger(row.credits)||row.credits<1||row.credits>100000000||!text(row.package_id,1,40))return result('not-eligible','payment_not_verified');
 const paidAt=utcTime(row.credited_at);if(paidAt===null||paidAt>now)return result('not-eligible','credit_not_verified');
 if(row.has_reversal)return result('review-required','payment_reversed');
 if(row.has_external_document)return result('review-required','external_document_exists');
 if(row.terms_version==null)return result('review-required','acceptance_missing');
 if(!text(row.terms_version,1,100)||!['BE','NL'].includes(row.buyer_country)||row.customer_type!=='consumer'||row.agreed_package_id!==row.package_id||row.agreed_amount_cents!==row.amount_cents||row.agreed_credits!==row.credits||row.agreed_currency!=='EUR'||!HASH.test(row.acceptance_hash||'')||!Number.isSafeInteger(row.accepted_at)||row.accepted_at<1||row.accepted_at>now||typeof row.terms_text!=='string'||row.terms_text.length<1||row.terms_text.length>65536||row.terms_text.includes('\u0000'))return result('review-required','acceptance_invalid');
 const seller=sellerData(row.seller_json);if(!seller)return result('review-required','seller_invalid');
 if(row.billing_name==null)return result('review-required','billing_missing');
 const buyer=billingData(row);if(!buyer||!Number.isSafeInteger(row.billing_at)||row.billing_at<row.accepted_at||row.billing_at>now)return result('review-required','billing_invalid');
 // Verify the original commercial acceptance digest, including invoice consent
 // and the exact billing identity. Older evidence without this consent requires
 // review rather than silently creating an invoice after the purchase.
 const billing={name:buyer.name,street:buyer.addressLine1,postalCode:buyer.postalCode,city:buyer.city,country:buyer.country};
 const acceptedHash=await digest(JSON.stringify({packageId:row.agreed_package_id,amountCents:row.agreed_amount_cents,credits:row.agreed_credits,currency:'EUR',country:row.buyer_country,customerType:row.customer_type,version:row.terms_version,accepted:true,seller:row.seller_json,terms:row.terms_text,billing,invoiceConsent:'rig-download-v1'}));
 if(acceptedHash!==row.acceptance_hash)return result('review-required','acceptance_invalid');
 return {snapshot:{format:'rig-invoice-v1',seller,buyer,description:'RIG-tegoed voor AI-videogeneratie',quantity:1,packageId:row.package_id,amountCents:row.amount_cents,creditCents:row.credits,currency:'EUR',vatAmountCents:0,taxExemption:EXEMPTION,paidAt:new Date(paidAt).toISOString(),orderReference:'RIG-'+row.id,paymentReference:row.payment_id,terms:{version:row.terms_version,acceptedAt:new Date(row.accepted_at).toISOString(),sha256:await digest(row.terms_text),path:'/voorwaarden'},source:{acceptanceHash:row.acceptance_hash,sellerJson:row.seller_json,billingJson:JSON.stringify({name:row.billing_name,street:row.billing_street,postalCode:row.billing_postal_code,city:row.billing_city,country:row.billing_country,electronicDelivery:row.billing_delivery}),acceptedAt:row.accepted_at,billingAt:row.billing_at,creditAt:row.credited_at}}};
}
async function invoiceDTO(row){
 if(!row)return null;
 try{
  if(!UUID.test(row.id||'')||!UUID.test(row.order_id||'')||!USER.test(row.user_id||'')||!REQUEST.test(row.order_request_id||'')||!validNow(row.issued_at)||!Number.isSafeInteger(row.sequence)||row.sequence<1||row.sequence>MAX_SEQUENCE||row.invoice_number!=='RIG-'+row.issue_year+'-'+String(row.sequence).padStart(6,'0')||row.issued_date!==localDate(row.issued_at)||Number(row.issued_date.slice(0,4))!==row.issue_year||row.currency!=='EUR'||!HASH.test(row.snapshot_sha256||'')||await digest(row.snapshot_json)!==row.snapshot_sha256)return null;
  const s=JSON.parse(row.snapshot_json),seller=sellerData(JSON.stringify(s.seller)),buyer=s.buyer;
  const normalized=normalizePurchaseBilling({name:buyer?.name,street:buyer?.addressLine1,postalCode:buyer?.postalCode,city:buyer?.city},buyer?.country);
  if(s.format!=='rig-invoice-v1'||!seller||!normalized||buyer.addressLine2!==''||normalized.name!==buyer.name||normalized.street!==buyer.addressLine1||normalized.postalCode!==buyer.postalCode||normalized.city!==buyer.city||s.amountCents!==row.amount_cents||s.creditCents!==row.credit_cents||s.currency!=='EUR'||s.vatAmountCents!==0||s.taxExemption!==EXEMPTION||s.orderReference!=='RIG-'+row.order_id||!PAYMENT.test(s.paymentReference||'')||s.description!=='RIG-tegoed voor AI-videogeneratie'||s.quantity!==1||!text(s.packageId,1,40)||utcTime(s.paidAt)===null||Date.parse(s.paidAt)>row.issued_at||!text(s.terms?.version,1,100)||utcTime(s.terms?.acceptedAt)===null||!HASH.test(s.terms?.sha256||'')||s.terms.path!=='/voorwaarden')return null;
  return {id:row.id,orderId:row.order_id,number:row.invoice_number,issuedDate:row.issued_date,issuedAt:row.issued_at,paidAt:s.paidAt,orderReference:s.orderReference,paymentReference:s.paymentReference,packageId:s.packageId,description:s.description,quantity:1,amountCents:s.amountCents,creditCents:s.creditCents,currency:'EUR',vatAmountCents:0,taxExemption:s.taxExemption,seller,buyer:{name:buyer.name,addressLine1:buyer.addressLine1,addressLine2:'',postalCode:buyer.postalCode,city:buyer.city,country:buyer.country},terms:{version:s.terms.version,acceptedAt:s.terms.acceptedAt,sha256:s.terms.sha256,path:s.terms.path},accountableConfirmed:false,peppolDeliveryVerified:false};
 }catch{return null;}
}
async function existing(db,orderId,userId){const row=await db.prepare('SELECT * FROM rig_issued_invoices WHERE order_id=?'+(userId?' AND user_id=?':'')).bind(orderId,...(userId?[userId]:[])).first();if(!row)return null;const invoice=await invoiceDTO(row);return invoice?{state:'existing',invoice}:result('review-required','invoice_snapshot_invalid');}
async function attempt(db,orderId,now,value){await db.prepare('INSERT INTO rig_invoice_issuance_attempts(order_id,last_checked_at,last_state,last_reason) VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET last_checked_at=MAX(last_checked_at,excluded.last_checked_at),last_state=excluded.last_state,last_reason=excluded.last_reason').bind(orderId,now,value.state,value.reason??null).run();return value;}

export async function ensurePaidPurchaseInvoice(env,{orderId,now=Date.now()}={}){
 if(env?.RIG_AUTOMATIC_INVOICES_ENABLED!=='yes')return result('disabled');
 if(typeof orderId!=='string'||!UUID.test(orderId)||!validNow(now))return result('not-eligible','invalid_request');
 const mapped=await validateProductionTenant(env);if(!mapped)return result('unavailable','production_unavailable');
 try{
  const db=mapped.DB,prior=await existing(db,orderId);if(prior)return prior;
  const row=await db.prepare(proofSelect).bind(orderId).first();if(!row)return result('not-eligible','order_not_found');
  const prepared=await makeSnapshot(row,now);if(!prepared.snapshot)return attempt(db,orderId,now,prepared);
  const snapshotJSON=JSON.stringify(prepared.snapshot),snapshotHash=await digest(snapshotJSON),issuedDate=localDate(now),year=Number(issuedDate.slice(0,4)),invoiceId=crypto.randomUUID();
  // Recheck every source field and financial proof under the same transaction
  // as sequential allocation. A preflight race cannot issue stale evidence.
  const eligibility=`o.id=? AND o.user_id=? AND o.request_id=? AND o.package_id=? AND o.amount_cents=? AND o.credits=? AND o.payment_id=? AND o.state='paid'
   AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits AND l.created_at=?)
   AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id='reverse:'||o.id)
   AND NOT EXISTS(SELECT 1 FROM rig_accounting_documents WHERE order_id=o.id)
   AND a.version=? AND a.buyer_country=? AND a.customer_type='consumer' AND a.package_id=o.package_id AND a.amount_cents=o.amount_cents AND a.credits=o.credits AND a.currency='EUR' AND a.request_hash=? AND a.seller_json=? AND a.terms_text=? AND a.created_at=?
   AND b.name=? AND b.street=? AND b.postal_code=? AND b.city=? AND b.country=a.buyer_country AND b.electronic_delivery='rig-download-v1' AND b.request_hash=a.request_hash AND b.created_at=?
   AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
   AND EXISTS(SELECT 1 FROM rig_production_tenant WHERE id=1 AND mode='live' AND environment_id=? AND site_id=? AND site_origin=? AND bridge_origin=? AND mollie_profile=? AND webhook_url=?)`;
  const args=[orderId,row.user_id,row.request_id,row.package_id,row.amount_cents,row.credits,row.payment_id,row.credited_at,row.terms_version,row.buyer_country,row.acceptance_hash,row.seller_json,row.terms_text,row.accepted_at,row.billing_name,row.billing_street,row.billing_postal_code,row.billing_city,row.billing_at,env.RIG_PRODUCTION_ENVIRONMENT_ID,env.RIG_PRODUCTION_SITE_ID,env.RIG_PRODUCTION_SITE_ORIGIN,env.RIG_PRODUCTION_BRIDGE_ORIGIN,env.RIG_PRODUCTION_MOLLIE_PROFILE,env.RIG_PRODUCTION_WEBHOOK_URL];
  const writes=await db.batch([
   db.prepare('INSERT INTO rig_invoice_counters(issue_year,next_sequence) VALUES(?,1) ON CONFLICT(issue_year) DO NOTHING').bind(year),
   db.prepare(`INSERT INTO rig_issued_invoices(id,order_id,user_id,order_request_id,invoice_number,issue_year,sequence,issued_date,issued_at,currency,amount_cents,credit_cents,snapshot_json,snapshot_sha256)
    SELECT ?,o.id,o.user_id,o.request_id,'RIG-'||c.issue_year||'-'||printf('%06d',c.next_sequence),c.issue_year,c.next_sequence,?,?,'EUR',o.amount_cents,o.credits,?,?
    FROM rig_orders o JOIN rig_purchase_acceptances a ON a.user_id=o.user_id AND a.request_id=o.request_id JOIN rig_purchase_billing b ON b.user_id=o.user_id AND b.request_id=o.request_id JOIN rig_invoice_counters c ON c.issue_year=?
    WHERE ${eligibility} AND c.next_sequence<=?
    AND NOT EXISTS(SELECT 1 FROM rig_accounting_references WHERE reference_key=lower('RIG-'||c.issue_year||'-'||printf('%06d',c.next_sequence)))
    AND NOT EXISTS(SELECT 1 FROM rig_accounting_documents WHERE lower(trim(external_invoice_reference))=lower('RIG-'||c.issue_year||'-'||printf('%06d',c.next_sequence)))
    ON CONFLICT(order_id) DO NOTHING`).bind(invoiceId,issuedDate,now,snapshotJSON,snapshotHash,year,...args,MAX_SEQUENCE),
   db.prepare('UPDATE rig_invoice_counters SET next_sequence=next_sequence+1 WHERE issue_year=? AND EXISTS(SELECT 1 FROM rig_issued_invoices WHERE id=? AND order_id=? AND issue_year=rig_invoice_counters.issue_year AND sequence=rig_invoice_counters.next_sequence)').bind(year,invoiceId,orderId)
  ]);
  const saved=await existing(db,orderId);if(saved?.invoice)return attempt(db,orderId,now,{...saved,state:writes[1]?.meta?.changes===1?'issued':'existing'});
  const counter=await db.prepare('SELECT next_sequence FROM rig_invoice_counters WHERE issue_year=?').bind(year).first();
  const candidate='RIG-'+year+'-'+String(counter?.next_sequence).padStart(6,'0');
  const collision=await db.prepare('SELECT 1 FROM rig_accounting_references WHERE reference_key=? UNION SELECT 1 FROM rig_accounting_documents WHERE lower(trim(external_invoice_reference))=? LIMIT 1').bind(candidate.toLowerCase(),candidate.toLowerCase()).first();
  if(collision)return attempt(db,orderId,now,result('review-required','number_collision'));
  return attempt(db,orderId,now,result('review-required',counter?.next_sequence>MAX_SEQUENCE?'numbering_exhausted':'source_changed'));
 }catch{return result('unavailable','invoice_storage_unavailable');}
}

// Both read helpers can repair a missed issuance without ever creating a new
// payment. Existing immutable documents remain accessible after a reversal or
// after automatic issuance is paused; neither event creates a credit note.
export async function getOwnedPurchaseInvoice(env,{userId,requestId,now=Date.now()}={}){
 if(typeof userId!=='string'||!USER.test(userId)||typeof requestId!=='string'||!REQUEST.test(requestId)||!validNow(now))return result('not-eligible','not_found');
 const mapped=await validateProductionTenant(env);if(!mapped)return result('unavailable','production_unavailable');
 try{
  const order=await mapped.DB.prepare('SELECT id FROM rig_orders WHERE user_id=? AND request_id=?').bind(userId,requestId).first();if(!order)return result('not-eligible','not_found');
  const prior=await existing(mapped.DB,order.id,userId);if(prior)return prior;
  const issued=await ensurePaidPurchaseInvoice(env,{orderId:order.id,now});if(!['issued','existing'].includes(issued.state))return issued;
  const scoped=await existing(mapped.DB,order.id,userId);return scoped?.invoice?{...scoped,state:issued.state}:result('not-eligible','not_found');
 }catch{return result('unavailable','invoice_storage_unavailable');}
}
export async function getOwnerPurchaseInvoice(env,{userId,orderId,now=Date.now()}={}){
 if(typeof userId!=='string'||!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return result('forbidden');
 if(typeof orderId!=='string'||!UUID.test(orderId)||!validNow(now))return result('not-eligible','not_found');
 const mapped=await validateProductionTenant(env);if(!mapped)return result('unavailable','production_unavailable');
 try{return await existing(mapped.DB,orderId)??await ensurePaidPurchaseInvoice(env,{orderId,now});}catch{return result('unavailable','invoice_storage_unavailable');}
}
export async function ensurePendingInvoices(env,{now=Date.now(),limit=4}={}){
 const stats={checked:0,issued:0,existing:0,reviewNeeded:0,unavailable:0,disabled:env?.RIG_AUTOMATIC_INVOICES_ENABLED!=='yes'};
 if(stats.disabled)return stats;
 if(!validNow(now)||!Number.isInteger(limit)||limit<1||limit>20)throw Error('Invalid invoice collection request');
 const mapped=await validateProductionTenant(env);if(!mapped){stats.unavailable++;return stats;}
 try{
  const rows=(await mapped.DB.prepare("SELECT o.id FROM rig_orders o LEFT JOIN rig_issued_invoices i ON i.order_id=o.id LEFT JOIN rig_invoice_issuance_attempts a ON a.order_id=o.id WHERE o.state='paid' AND i.id IS NULL ORDER BY COALESCE(a.last_checked_at,0),o.created_at,o.id LIMIT ?").bind(limit).all()).results;
  for(const row of rows){const value=await ensurePaidPurchaseInvoice(env,{orderId:row.id,now});stats.checked++;if(value.state==='issued')stats.issued++;else if(value.state==='existing')stats.existing++;else if(value.state==='unavailable')stats.unavailable++;else stats.reviewNeeded++;}
 }catch{stats.unavailable++;}
 return stats;
}
