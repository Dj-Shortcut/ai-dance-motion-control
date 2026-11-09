// Explicit, operation-bound payloads for future owner administration features.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const administrationFields=Object.freeze({
 'accounting-document':['idempotencyKey','orderId','externalInvoiceReference','documentDate','recordType','deliveryStatus','note','replacesDocumentId'],
 'recovery-note':['idempotencyKey','kind','caseId','expectedVersion','status','note'],
 'recovery-payment':['orderId','idempotencyKey','expectedVersion','providerPaymentId']
});
const date=value=>typeof value==='string'&&/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const text=(value,min,max)=>typeof value==='string'&&Array.from(value.trim()).length>=min&&Array.from(value).length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateAdministrationPayload(operation,payload){
 const fields=administrationFields[operation];if(!fields)throw Error('Unknown owner operation');
 const required=fields.filter(x=>x!=='replacesDocumentId');
 if(required.some(k=>!Object.hasOwn(payload,k))||Object.keys(payload).some(k=>!fields.includes(k))||!UUID.test(payload.idempotencyKey||''))throw Error('Invalid administration request');
 if(operation==='accounting-document'){
  if(!UUID.test(payload.orderId||'')||!text(payload.externalInvoiceReference,1,80)||!date(payload.documentDate)||!['invoice','accounting-entry'].includes(payload.recordType)||!['prepared','recorded-in-accountable','peppol-sent-manually'].includes(payload.deliveryStatus)||(payload.deliveryStatus==='peppol-sent-manually'&&payload.recordType!=='invoice')||!text(payload.note,0,240)||Object.hasOwn(payload,'replacesDocumentId')&&!UUID.test(payload.replacesDocumentId))throw Error('Invalid document');
 }else if(operation==='recovery-note'){
  if(!['payment','generation'].includes(payload.kind)||!UUID.test(payload.caseId||'')||!HASH.test(payload.expectedVersion||'')||!['investigating','waiting-provider','reviewed'].includes(payload.status)||!text(payload.note,1,1000))throw Error('Invalid case note');
 }else if(!UUID.test(payload.orderId||'')||!HASH.test(payload.expectedVersion||'')||!/^tr_[A-Za-z0-9]{6,80}$/.test(payload.providerPaymentId||''))throw Error('Invalid payment proof');
}
export function administrationSummary(operation,payload){
 if(operation==='accounting-document')return `Administratiereferentie vastleggen voor bestelling ${payload.orderId}: ${payload.externalInvoiceReference}, ${payload.documentDate}, ${payload.recordType}, ${payload.deliveryStatus}. Dit is een door jou ingevoerde status, geen bevestiging door Accountable of Peppol.`;
 if(operation==='recovery-note')return `Onderzoeksnotitie bewaren voor ${payload.kind==='payment'?'betaling':'video'} ${payload.caseId}: ${payload.status}; ${payload.note}. Dit verandert geen tegoed en start geen betaling of video.`;
 if(operation==='recovery-payment')return `Mollie-betaling ${payload.providerPaymentId} controleren en koppelen aan bestelling ${payload.orderId}. Alleen bij overeenkomend profiel, bedrag en bestelgegevens wordt de bestaande betaling verwerkt. Er wordt geen nieuwe betaling aangemaakt.`;
 return null;
}
