// Internal production payment boundary. The authenticated payment dispatcher
// must apply its durable per-user payment limiter BEFORE calling this helper.
// Acceptance is evidence only: it never creates a payment or grants credit.
import {merchant,COMMERCE_VERSION,publicCommerce} from './commerce-profile.mjs';
import {commerceDocument} from './commerce-documents.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {closedPaymentWithFetch} from './closed-test-payment.mjs';
import {automaticInvoicesEnabled,BILLING_ELECTRONIC_DELIVERY,normalizePurchaseBilling,purchaseBillingStatements} from './purchase-billing.mjs';

const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const json=(data,status=400)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const failed=(error,status=503)=>({response:json({error},status)});
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
// Decode the embedded font once per isolate, and only for invoice checkouts.
// Concurrent checkouts share the in-flight import/decode promise. No name or
// address is replaced with a fallback character to make a payment succeed.
let invoiceFont;
async function supportsCheckoutInvoice(billing){
 invoiceFont??=Promise.all([import('./invoice-pdf.mjs'),import('./fonts/noto-sans-regular.mjs')]).then(([renderer,font])=>({supports:renderer.supportsInvoiceText,bytes:Uint8Array.from(atob(font.default),char=>char.charCodeAt(0))}));
 const font=await invoiceFont;
 return font.supports([...Object.values(billing),merchant.legalName,merchant.address,merchant.enterpriseNumber,merchant.vatNumber,merchant.email,merchant.phone,merchant.country].join(' '),font.bytes);
}
// Reuse the payment module's actual configuration/package validator through a
// read-only route. A future accidental provider call is refused locally.
const configReader=closedPaymentWithFetch(async()=>{throw Error('No provider access during acceptance');},class extends Error{},{allowLive:true});

export function commercialCheckoutRequired(env){return env.RIG_COMMERCIAL_CHECKOUT_REQUIRED==='yes'||automaticInvoicesEnabled(env);}
export function commercialPackageData(env){return commercialCheckoutRequired(env)?{commerce:{...publicCommerce(),required:true,...(automaticInvoicesEnabled(env)?{billingRequired:true,electronicDelivery:BILLING_ELECTRONIC_DELIVERY}:{})}}:{};}

async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0,timer;const chunks=[];
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Request timeout')),5000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))return null;size+=value.length;if(size>8192||length!==null&&size>Number(length))return null;chunks.push(value);}
  if(length!==null&&size!==Number(length))return null;
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch{return null;}finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{});}catch{}}
}

export async function prepareCommercialCheckout(req,env,{userId,now=Date.now()}={}){
 if(!commercialCheckoutRequired(env))return {request:req};
 if(typeof userId!=='string'||!USER.test(userId))return failed('Meld je aan bij RIG.',401);
 if(!Number.isSafeInteger(now)||now<=0||now>8640000000000000)return failed('De aankoop is tijdelijk niet beschikbaar.');
 const mapped=await validateProductionTenant(env);if(!mapped)return failed('De aankoop is tijdelijk niet beschikbaar.');
 const url=new URL(req.url);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.pathname!=='/api/payments/create'||url.search||url.hash)return failed('Niet gevonden.',404);
 if(req.method!=='POST')return failed('Methode niet toegestaan.',405);
 const fetchSite=req.headers.get('sec-fetch-site');
 if(req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN||fetchSite&&!['same-origin','none'].includes(fetchSite))return failed('Aanvraag geweigerd.',403);
 try{
  const db=mapped.DB;
  if(await db.prepare('SELECT 1 FROM rig_frozen_accounts WHERE user_id=?').bind(userId).first())return failed('Je account vereist eerst controle.',403);
  const data=await readJSON(req);
  const invoiceRequired=automaticInvoicesEnabled(env);
  if(!exact(data,['packageId','requestId','commerce',...(invoiceRequired?['billing']:[])])||typeof data.packageId!=='string'||typeof data.requestId!=='string'||!UUID.test(data.requestId))return failed('Controleer je aankoopgegevens.',400);
  const consent=data.commerce;
  if(!exact(consent,['version','accepted','customerType','country'])||consent.version!==COMMERCE_VERSION||consent.accepted!==true||consent.customerType!=='consumer'||typeof consent.country!=='string'||!merchant.customerCountries.includes(consent.country))return {response:json({error:'Kies je klantland en bevestig de verkoopvoorwaarden voor je betaalt.',code:'commerce_acceptance_required'},400)};
  const billing=invoiceRequired?normalizePurchaseBilling(data.billing,consent.country):null;
  if(invoiceRequired&&!billing)return {response:json({error:'Vul je volledige naam en factuuradres in. Controleer ook je postcode en klantland.',code:'billing_required'},400)};
  if(invoiceRequired&&!await supportsCheckoutInvoice(billing))return {response:json({error:'Je naam of adres bevat tekens die RIG nog niet op een factuur kan weergeven. Wijzig je echte naam niet; neem contact op voordat je de aankoop vervolgt.',code:'billing_characters_unsupported'},400)};
  const packageReply=await configReader(new Request(mapped.RIG_PUBLIC_ORIGIN+'/api/payments/packages'),mapped,userId);
  if(!packageReply?.ok)return failed('De aankoop is tijdelijk niet beschikbaar.');
  const packages=(await packageReply.json()).packages,pkg=packages.find(item=>item.id===data.packageId);
  if(!pkg)return failed('Dit tegoedpakket is niet beschikbaar.',400);
  const seller=JSON.stringify(merchant),terms=await commerceDocument('/voorwaarden').text();
  const digest=await hash(JSON.stringify({packageId:pkg.id,amountCents:pkg.amountCents,credits:pkg.credits,currency:'EUR',country:consent.country,customerType:consent.customerType,version:consent.version,accepted:true,seller,terms,...(invoiceRequired?{billing,invoiceConsent:BILLING_ELECTRONIC_DELIVERY}:{})}));
  // DO NOTHING keeps the first seller, terms and price snapshot intact. Reading
  // the winning hash after INSERT also detects concurrent conflicting reuse.
  const acceptance=db.prepare(`INSERT INTO rig_purchase_acceptances(user_id,request_id,version,buyer_country,customer_type,package_id,amount_cents,credits,currency,request_hash,seller_json,terms_text,created_at)
   SELECT ?,?,?,?,?,?,?,?,'EUR',?,?,?,?
   WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
   AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
   ON CONFLICT(user_id,request_id) DO NOTHING`).bind(userId,data.requestId,COMMERCE_VERSION,consent.country,consent.customerType,pkg.id,pkg.amountCents,pkg.credits,digest,seller,terms,now,userId);
  if(invoiceRequired)await db.batch([acceptance,...purchaseBillingStatements(db,{userId,requestId:data.requestId,billing,requestHash:digest,now})]);
  else await acceptance.run();
  const saved=await db.prepare('SELECT request_hash FROM rig_purchase_acceptances WHERE user_id=? AND request_id=?').bind(userId,data.requestId).first();
  if(!saved)return failed('De aankoopbevestiging kon niet veilig worden vastgelegd.');
  if(saved.request_hash!==digest)return failed('Deze aankoop is al gestart met andere gegevens. Controleer eerst de bestaande betaling.',409);
  if(await db.prepare('SELECT 1 FROM rig_frozen_accounts WHERE user_id=?').bind(userId).first())return failed('Je account vereist eerst controle.',403);
  if(invoiceRequired){
   const savedBilling=await db.prepare('SELECT name,street,postal_code,city,country,electronic_delivery,request_hash FROM rig_purchase_billing WHERE user_id=? AND request_id=?').bind(userId,data.requestId).first();
   if(!savedBilling||savedBilling.request_hash!==digest||savedBilling.name!==billing.name||savedBilling.street!==billing.street||savedBilling.postal_code!==billing.postalCode||savedBilling.city!==billing.city||savedBilling.country!==billing.country||savedBilling.electronic_delivery!==BILLING_ELECTRONIC_DELIVERY)return failed('Je factuurgegevens konden niet veilig worden vastgelegd.');
  }
  // Preserve only the original payment route's two allowed body fields. The
  // incoming Content-Length describes another body and must not be forwarded.
  const headers=new Headers(req.headers);headers.delete('content-length');
  return {request:new Request(req.url,{method:'POST',headers,body:JSON.stringify({packageId:pkg.id,requestId:data.requestId})})};
 }catch{return failed('De aankoopbevestiging kon niet veilig worden gecontroleerd.');}
}
