// Identity comes only from the signed production payment composition. These
// helpers store invoice evidence; they never create a payment or an invoice.
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';

const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BAD_TEXT=/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const BILLING_ELECTRONIC_DELIVERY='rig-download-v1';
export const automaticInvoicesEnabled=env=>env?.RIG_AUTOMATIC_INVOICES_ENABLED==='yes';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value,status=200)=>Response.json(value,{status,headers});

function text(value,min,max){
 if(typeof value!=='string'||value.length>1024||BAD_TEXT.test(value))return null;
 const normalized=value.normalize('NFC').replace(/\p{Zs}+/gu,' ').trim(),length=Array.from(normalized).length;
 return length>=min&&length<=max?normalized:null;
}

export function normalizePurchaseBilling(value,country){
 if(!['BE','NL'].includes(country)||!exact(value,['name','street','postalCode','city']))return null;
 const name=text(value.name,1,120),street=text(value.street,3,180),city=text(value.city,1,100),postal=text(value.postalCode,1,16);
 if(name===null||street===null||city===null||postal===null)return null;
 let postalCode;
 if(country==='BE'){if(!/^\d{4}$/.test(postal))return null;postalCode=postal;}
 else{if(!/^\d{4} ?[a-z]{2}$/i.test(postal))return null;postalCode=postal.replace(' ','').toUpperCase();postalCode=postalCode.slice(0,4)+' '+postalCode.slice(4);}
 return {name,street,postalCode,city,country};
}

// The caller batches these after its immutable acceptance INSERT. Every write
// is gated by the exact winning acceptance hash, so conflicting races cannot
// attach a second buyer's data or profile to the winning purchase intent.
export function purchaseBillingStatements(db,{userId,requestId,billing,requestHash,now}){
 const {name,street,postalCode,city,country}=billing;
 const eligible=`EXISTS(SELECT 1 FROM rig_purchase_acceptances WHERE user_id=? AND request_id=? AND request_hash=? AND buyer_country=? AND customer_type='consumer')
  AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
  AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)`;
 const args=[userId,requestId,requestHash,country,userId];
 const immutable=db.prepare(`INSERT INTO rig_purchase_billing(user_id,request_id,name,street,postal_code,city,country,electronic_delivery,request_hash,created_at)
  SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${eligible}
  ON CONFLICT(user_id,request_id) DO NOTHING`).bind(userId,requestId,name,street,postalCode,city,country,BILLING_ELECTRONIC_DELIVERY,requestHash,now,...args);
 const profile=db.prepare(`INSERT INTO rig_billing_profiles(user_id,name,street,postal_code,city,country,electronic_delivery,updated_at)
  SELECT ?,?,?,?,?,?,?,(SELECT created_at FROM rig_purchase_acceptances WHERE user_id=? AND request_id=? AND request_hash=?) WHERE ${eligible}
  AND EXISTS(SELECT 1 FROM rig_purchase_billing WHERE user_id=? AND request_id=? AND request_hash=? AND name=? AND street=? AND postal_code=? AND city=? AND country=? AND electronic_delivery=?)
  ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,street=excluded.street,postal_code=excluded.postal_code,city=excluded.city,country=excluded.country,electronic_delivery=excluded.electronic_delivery,updated_at=excluded.updated_at
  WHERE excluded.updated_at>rig_billing_profiles.updated_at`).bind(userId,name,street,postalCode,city,country,BILLING_ELECTRONIC_DELIVERY,userId,requestId,requestHash,...args,userId,requestId,requestHash,name,street,postalCode,city,country,BILLING_ELECTRONIC_DELIVERY);
 return [immutable,profile];
}

export async function handlePurchaseBilling(req,env,{userId,now=Date.now()}={}){
 if(typeof userId!=='string'||!USER.test(userId))return json({error:'Meld je aan bij RIG.'},401);
 if(!automaticInvoicesEnabled(env))return json({error:'Niet gevonden.'},404);
 let url;try{url=new URL(req.url);}catch{return json({error:'Niet gevonden.'},404);}
 if(url.pathname!=='/api/payments/billing'||url.search||url.hash)return json({error:'Niet gevonden.'},404);
 if(req.method!=='GET')return json({error:'Methode niet toegestaan.'},405);
 const mapped=await validateProductionTenant(env);if(!mapped||!Number.isSafeInteger(now)||now<=0||now>8640000000000000)return json({error:'Factuurgegevens zijn tijdelijk niet beschikbaar.'},503);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN)return json({error:'Aanvraag geweigerd.'},403);
 try{
  if(await d1Limit({env:mapped,category:'payment',userId,method:'GET'})!==true)return json({error:'Te veel aanvragen. Probeer later opnieuw.'},429);
  const row=await mapped.DB.prepare('SELECT name,street,postal_code,city,country,electronic_delivery FROM rig_billing_profiles WHERE user_id=?').bind(userId).first();
  let billing=null;
  if(row){billing=normalizePurchaseBilling({name:row.name,street:row.street,postalCode:row.postal_code,city:row.city},row.country);if(!billing||row.electronic_delivery!==BILLING_ELECTRONIC_DELIVERY)return json({error:'Factuurgegevens zijn tijdelijk niet beschikbaar.'},503);}
  return json({billing,electronicDelivery:BILLING_ELECTRONIC_DELIVERY});
 }catch{return json({error:'Factuurgegevens zijn tijdelijk niet beschikbaar.'},503);}
}
