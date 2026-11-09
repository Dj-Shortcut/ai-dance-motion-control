// Private invoice documents. Rendering and delivery never create money events.
import {zipSync,strToU8} from 'fflate';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {ensurePendingInvoices,getOwnedPurchaseInvoice,getOwnerPurchaseInvoice} from './invoice-store.mjs';
import {renderInvoicePDF} from './invoice-pdf.mjs';
import notoBase64 from './fonts/noto-sans-regular.mjs';
import {accountableMailReady,sendAccountableInvoiceMail} from './invoice-mail.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const NUMBER=/^RIG-20\d{2}-\d{6,12}$/;
const MAX_PDF=3*1024*1024,MAX_EXPORT=12*1024*1024;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY'};
const json=(data,status=200)=>Response.json(data,{status,headers});
const fail=(message,status=503)=>json({error:message},status);
let font;
const fontBytes=()=>font??=Uint8Array.from(atob(notoBase64),x=>x.charCodeAt(0));
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value)),x=>x.toString(16).padStart(2,'0')).join('');
const snapshotHash=invoice=>hash(JSON.stringify(invoice));
function validateInvoice(value){if(!UUID.test(value?.id||'')||!NUMBER.test(value.number||'')||!/^20\d{2}-\d\d-\d\d$/.test(value.issuedDate||''))throw Error('Invalid immutable invoice');}
async function readBytes(object,max){
 if(!object||!Number.isSafeInteger(object.size)||object.size<1||object.size>max)throw Error('Invalid archive length');
 const response=new Response(object.body),bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==object.size||bytes.length>max)throw Error('Invalid archive');return bytes;
}
function pdfBytes(bytes){if(!(bytes instanceof Uint8Array)||bytes.length<100||bytes.length>MAX_PDF||new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('Invalid PDF');}
export async function archiveInvoicePDF(env,invoice,{now=Date.now(),render=renderInvoicePDF}={}){
 validateInvoice(invoice);if(!Number.isSafeInteger(now)||now<1)throw Error('Invalid archive time');
 const mapped=await validateProductionTenant(env);if(!mapped||!env.BUCKET?.get||!env.BUCKET?.put)throw Error('Invoice archive unavailable');
 const key='administration/invoices/'+invoice.issuedDate.slice(0,4)+'/'+invoice.id+'.pdf',snapshot=await snapshotHash(invoice),db=mapped.DB;
 let row=await db.prepare('SELECT * FROM rig_invoice_archives WHERE invoice_id=?').bind(invoice.id).first();
 if(row){
  if(row.storage_key!==key||row.snapshot_sha256!==snapshot||!HASH.test(row.pdf_sha256))throw Error('Archive evidence mismatch');
  const bytes=await readBytes(await env.BUCKET.get(key),MAX_PDF);pdfBytes(bytes);if(bytes.length!==row.byte_length||await hash(bytes)!==row.pdf_sha256)throw Error('Archive bytes mismatch');return {bytes,sha256:row.pdf_sha256,key};
 }
 let object=await env.BUCKET.get(key);
 if(!object){
  const bytes=await render(invoice,{fontBytes:fontBytes()});pdfBytes(bytes);const digest=await hash(bytes);
  await env.BUCKET.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/pdf',cacheControl:'private, no-store'},customMetadata:{invoiceId:invoice.id,snapshotSha256:snapshot,pdfSha256:digest}});
  object=await env.BUCKET.get(key);
 }
 if(object?.customMetadata?.invoiceId!==invoice.id||object.customMetadata.snapshotSha256!==snapshot||!HASH.test(object.customMetadata.pdfSha256||''))throw Error('Untrusted archive object');
 const bytes=await readBytes(object,MAX_PDF);pdfBytes(bytes);const digest=await hash(bytes);if(digest!==object.customMetadata.pdfSha256)throw Error('Archive checksum mismatch');
 await db.prepare('INSERT INTO rig_invoice_archives(invoice_id,storage_key,snapshot_sha256,pdf_sha256,byte_length,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING').bind(invoice.id,key,snapshot,digest,bytes.length,now).run();
 row=await db.prepare('SELECT * FROM rig_invoice_archives WHERE invoice_id=?').bind(invoice.id).first();if(!row||row.storage_key!==key||row.snapshot_sha256!==snapshot||row.pdf_sha256!==digest||row.byte_length!==bytes.length)throw Error('Archive race mismatch');
 return {bytes,sha256:digest,key};
}
function downloadable(bytes,filename,type){return new Response(bytes,{headers:{...headers,'content-type':type,'content-disposition':`attachment; filename="${filename}"`,'content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});}
const owner=(env,userId)=>typeof userId==='string'&&userId===env.RIG_PRODUCTION_OWNER_USER_ID;
function period(url){if(!url.search)return {month:null};if(!/^\?month=20\d{2}-(?:0[1-9]|1[0-2])$/.test(url.search))return null;return {month:url.searchParams.get('month')};}
async function invoiceRows(db,month,limit){
 return (await db.prepare(`SELECT i.*,m.state AS mail_state,m.started_at AS mail_started_at,m.completed_at AS mail_completed_at,m.provider_message_id,a.byte_length AS pdf_bytes FROM rig_issued_invoices i LEFT JOIN rig_invoice_mail_outbox m ON m.invoice_id=i.id LEFT JOIN rig_invoice_archives a ON a.invoice_id=i.id WHERE (? IS NULL OR substr(i.issued_date,1,7)=?) ORDER BY i.issue_year,i.sequence LIMIT ?`).bind(month,month,limit).all()).results;
}
export async function handleInvoiceRoute(req,env,{userId,now=Date.now(),render=renderInvoicePDF}={}){
 const u=new URL(req.url),customer=/^\/api\/payments\/orders\/([A-Za-z0-9_-]{12,80})\/invoice$/.exec(u.pathname),pdf=/^\/api\/owner\/invoices\/([a-f0-9-]{36})\/pdf$/.exec(u.pathname),isOwner=u.pathname.startsWith('/api/owner/invoices');
 if(!customer&&!isOwner)return null;
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Facturen zijn tijdelijk niet beschikbaar.');
 if(req.method!=='GET'||u.origin!==mapped.RIG_PUBLIC_ORIGIN)return fail('Niet gevonden.',404);
 if(isOwner&&!owner(env,userId))return fail('Alleen beschikbaar voor de eigenaar.',403);
 if(await d1Limit({env:mapped,category:'payment',userId,method:'GET'})!==true)return fail('Te veel aanvragen. Probeer later opnieuw.',429);
 try{
  if(customer){
   if(u.search)return fail('Niet gevonden.',404);const result=await getOwnedPurchaseInvoice(env,{userId,requestId:customer[1],now});
   if(!result.invoice)return fail(result.state==='review-required'?'Deze factuur moet door de verkoper worden gecontroleerd.':'Je factuur is nog niet beschikbaar.',result.state==='not-eligible'?404:503);
   const {bytes}=await archiveInvoicePDF(env,result.invoice,{now,render});return downloadable(bytes,result.invoice.number+'.pdf','application/pdf');
  }
  if(pdf){
   if(u.search||!UUID.test(pdf[1]))return fail('Niet gevonden.',404);
   const row=await mapped.DB.prepare('SELECT order_id FROM rig_issued_invoices WHERE id=?').bind(pdf[1]).first();if(!row)return fail('Niet gevonden.',404);
   const result=await getOwnerPurchaseInvoice(env,{userId,orderId:row.order_id,now});if(!result.invoice)return fail('Factuur moet worden gecontroleerd.');
   const {bytes}=await archiveInvoicePDF(env,result.invoice,{now,render});return downloadable(bytes,result.invoice.number+'.pdf','application/pdf');
  }
  if(!['/api/owner/invoices','/api/owner/invoices/export.zip'].includes(u.pathname))return fail('Niet gevonden.',404);
  const selected=period(u);if(!selected)return fail('Kies een geldige maand.',400);
  const rows=await invoiceRows(mapped.DB,selected.month,u.pathname.endsWith('.zip')?51:201);
  if(u.pathname.endsWith('.zip')){
   if(rows.length>50)return fail('Meer dan 50 facturen. Kies een kleinere periode.',413);
   const files={};let size=0;
   for(const row of rows){const result=await getOwnerPurchaseInvoice(env,{userId,orderId:row.order_id,now});if(!result.invoice)throw Error('Invalid invoice');const {bytes}=await archiveInvoicePDF(env,result.invoice,{now,render});size+=bytes.length;if(size>MAX_EXPORT)return fail('Deze export is te groot.',413);files[result.invoice.number+'.pdf']=[bytes,{level:0}];}
   files['LEESMIJ.txt']=strToU8('Deze PDF-bestanden zijn de originele RIG-verkoopfacturen. Importeer ze als externe facturen; maak geen tweede factuur. Accountable vraagt nog controle. Een RIG-export bewijst geen ontvangst of boeking door Accountable.');
   return downloadable(zipSync(files,{level:0}),`RIG-facturen-${selected.month??'alle-periodes'}.zip`,'application/zip');
  }
  return json({automaticIssuanceEnabled:env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes',accountableDeliveryConfigured:accountableMailReady(env),accountableValidated:false,peppolDeliveryVerified:false,month:selected.month,hasMore:rows.length>200,invoices:rows.slice(0,200).map(row=>({id:row.id,orderId:row.order_id,number:row.invoice_number,issuedDate:row.issued_date,amountCents:row.amount_cents,currency:'EUR',pdfReady:row.pdf_bytes!=null,mailState:row.mail_state??'not-sent',mailSentAt:row.mail_completed_at,accountableValidated:false,pdfPath:'/api/owner/invoices/'+row.id+'/pdf'}))});
 }catch{return fail('Facturen zijn tijdelijk niet beschikbaar. Je aankoop en tegoed zijn niet gewijzigd.');}
}
export async function collectInvoiceDocuments(env,{now=Date.now(),limit=4,render=renderInvoicePDF,send=sendAccountableInvoiceMail}={}){
 const stats={issued:0,archived:0,mailSent:0,needsReview:0,unavailable:0};
 if(env.RIG_AUTOMATIC_INVOICES_ENABLED!=='yes')return stats;
 const mapped=await validateProductionTenant(env);if(!mapped||!Number.isInteger(limit)||limit<1||limit>4)return stats;
 try{
  const issued=await ensurePendingInvoices(env,{now,limit});stats.issued=issued.issued??0;stats.needsReview+=issued.reviewNeeded??0;stats.unavailable+=issued.unavailable??0;
  // Attempt-based ordering prevents one corrupt document from starving others.
  const rows=(await mapped.DB.prepare('SELECT i.id,i.order_id FROM rig_issued_invoices i LEFT JOIN rig_invoice_archives a ON a.invoice_id=i.id LEFT JOIN rig_invoice_mail_outbox m ON m.invoice_id=i.id LEFT JOIN rig_invoice_delivery_attempts d ON d.invoice_id=i.id WHERE a.invoice_id IS NULL OR (?=1 AND m.invoice_id IS NULL) ORDER BY COALESCE(d.last_checked_at,0),i.issued_at,i.id LIMIT ?').bind(accountableMailReady(env)?1:0,limit).all()).results;
  for(const row of rows){
   try{
    await mapped.DB.prepare("INSERT INTO rig_invoice_delivery_attempts(invoice_id,last_checked_at,last_state) VALUES(?,?,'checking') ON CONFLICT(invoice_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,last_state='checking'").bind(row.id,now).run();
    const result=await getOwnerPurchaseInvoice(env,{userId:env.RIG_PRODUCTION_OWNER_USER_ID,orderId:row.order_id,now});if(!result.invoice){stats.needsReview++;await mapped.DB.prepare("UPDATE rig_invoice_delivery_attempts SET last_state='review' WHERE invoice_id=?").bind(row.id).run();continue;}
    const invoice=result.invoice,pdf=await archiveInvoicePDF(env,invoice,{now,render});stats.archived++;
    await mapped.DB.prepare("UPDATE rig_invoice_delivery_attempts SET last_state='archived' WHERE invoice_id=?").bind(row.id).run();
    if(!accountableMailReady(env))continue;
    const token=crypto.randomUUID(),claimed=await mapped.DB.prepare("INSERT INTO rig_invoice_mail_outbox(invoice_id,state,attempt_token,pdf_sha256,started_at) VALUES(?,'sending',?,?,?) ON CONFLICT(invoice_id) DO NOTHING").bind(invoice.id,token,pdf.sha256,now).run();if(claimed.meta?.changes!==1)continue;
    try{
     const receipt=await send(env,{invoice,pdf:pdf.bytes,idempotencyKey:'rig-invoice/'+invoice.id});
     if(typeof receipt?.messageId!=='string'||receipt.messageId.length<1||receipt.messageId.length>250)throw Error('Unknown delivery');
     const saved=await mapped.DB.prepare("UPDATE rig_invoice_mail_outbox SET state='sent',provider_message_id=?,completed_at=? WHERE invoice_id=? AND attempt_token=? AND state='sending'").bind(receipt.messageId,now,invoice.id,token).run();if(saved.meta?.changes!==1)throw Error('Delivery state changed');stats.mailSent++;
    }catch{
     await mapped.DB.prepare("UPDATE rig_invoice_mail_outbox SET state='unknown',last_error='delivery_requires_review',completed_at=? WHERE invoice_id=? AND attempt_token=? AND state='sending'").bind(now,invoice.id,token).run();stats.needsReview++;
    }
   }catch{stats.unavailable++;await mapped.DB.prepare("UPDATE rig_invoice_delivery_attempts SET last_state='unavailable' WHERE invoice_id=?").bind(row.id).run();}
  }
  await mapped.DB.prepare("UPDATE rig_invoice_mail_outbox SET state='unknown',last_error='delivery_interrupted',completed_at=? WHERE state='sending' AND started_at<?").bind(now,now-900000).run();
 }catch{stats.unavailable++;}
 return stats;
}
