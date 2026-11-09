// Private production composition only: identity is supplied by the signed Sites
// bridge. A request receipt is never a refund decision or a monetary operation.
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST=/^[A-Za-z0-9_-]{12,80}$/;
const BASE='/api/payments/support-requests';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value,status=200)=>Response.json(value,{status,headers});
const fail=(error,status=503)=>json({error},status);
const validTime=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const acknowledgement='Je verzoek is ontvangen. Dit bevestigt alleen de ontvangst; er is nog geen beslissing over een terugbetaling genomen. Je tegoed is niet gewijzigd en er is geen geld teruggestort.';
const publicCase=row=>({id:row.id,orderRequestId:row.order_request_id,kind:row.kind,message:row.message,createdAt:new Date(row.created_at).toISOString(),state:'received',orderStateAtRequest:row.order_state_at_request,amountCents:row.amount_cents,credits:row.credits,currency:'EUR',confirmationPath:`${BASE}/${row.id}/confirmation`,monetaryActionPerformed:false,refundDecision:'not_decided'});

async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0,timer;const chunks=[];
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Request timeout')),5000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))return null;size+=value.length;if(size>8192||length!==null&&size>Number(length))return null;chunks.push(value);}
  if(length!==null&&size!==Number(length))return null;
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
 }catch{return null;}finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{});}catch{}}
}
function validInput(data){
 return data&&Object.keys(data).length===4&&['idempotencyKey','orderRequestId','kind','message'].every(key=>Object.hasOwn(data,key))
  &&typeof data.idempotencyKey==='string'&&UUID.test(data.idempotencyKey)&&typeof data.orderRequestId==='string'&&REQUEST.test(data.orderRequestId)&&['withdrawal','payment-help'].includes(data.kind)
  &&typeof data.message==='string'&&Array.from(data.message).length<=1000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.message);
}
function confirmation(row,origin){
 const item=publicCase(row),label=item.kind==='withdrawal'?'Herroepingsverzoek':'Vraag over een betaling';
 const html=`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RIG · Ontvangstbevestiging verzoek</title><style>body{font:16px/1.6 system-ui;color:#17251d;max-width:760px;margin:40px auto;padding:0 24px}h1{line-height:1.2}dt{font-weight:600;margin-top:16px}dd{margin-left:0;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f2;padding:16px}small{color:#425449}a{color:#175b37}</style></head><body><h1>Je verzoek is ontvangen</h1><p>${escape(acknowledgement)}</p><dl><dt>Verzoek</dt><dd>${escape(label)}</dd><dt>Aanvraagcode</dt><dd>${escape(item.id)}</dd><dt>Ontvangen op</dt><dd>${escape(new Intl.DateTimeFormat('nl-BE',{timeZone:'Europe/Brussels',dateStyle:'long',timeStyle:'long'}).format(new Date(row.created_at)))}</dd><dt>Aankoopreferentie</dt><dd>${escape(item.orderRequestId)}</dd><dt>Bedrag van de aankoop</dt><dd>€${(item.amountCents/100).toFixed(2).replace('.',',')}</dd></dl><h2>Je toelichting</h2><pre>${escape(item.message||'Geen toelichting meegegeven.')}</pre><p>De verkoper beoordeelt je verzoek. Bewaar deze bevestiging en vermeld je aanvraagcode bij verder contact via de betaalhulp in RIG. Deze ontvangstbevestiging beperkt je wettelijke rechten niet.</p><p><a href="${escape(origin+'/')}">Open RIG</a></p><small>Ontvangstbevestiging van een klantverzoek — geen factuur, creditnota of bevestiging van terugbetaling.</small></body></html>`;
 return new Response(html,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-disposition':`attachment; filename="RIG-verzoek-${row.id}.html"`,'x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}

export async function handleCustomerSupport(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(userId||''))return fail('Meld je aan bij RIG.',401);
 if(!validTime(now))return fail('Je verzoek is tijdelijk niet beschikbaar.');
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Je verzoek is tijdelijk niet beschikbaar.');
 const url=new URL(req.url),match=new RegExp('^'+BASE+'/([0-9a-f-]{36})/confirmation$').exec(url.pathname),isBase=url.pathname===BASE,isConfirmation=match&&UUID.test(match[1]);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.search||url.hash||!isBase&&!isConfirmation)return fail('Niet gevonden.',404);
 if(isBase&&!['GET','POST'].includes(req.method)||isConfirmation&&req.method!=='GET')return fail('Methode niet toegestaan.',405);
 if(req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return fail('Aanvraag geweigerd.',403);
 try{
  if(await d1Limit({env:mapped,category:'payment',userId,method:req.method})!==true)return fail('Te veel aanvragen. Probeer even later opnieuw.',429);
  if(isConfirmation){const row=await mapped.DB.prepare('SELECT * FROM rig_customer_support_requests WHERE id=? AND user_id=?').bind(match[1],userId).first();return row?confirmation(row,mapped.RIG_PUBLIC_ORIGIN):fail('Verzoek niet gevonden.',404);}
  if(req.method==='GET'){
   const rows=(await mapped.DB.prepare('SELECT * FROM rig_customer_support_requests WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20').bind(userId).all()).results;
   return json({requests:rows.map(publicCase),acknowledgement,monetaryActionPerformed:false});
  }
  const data=await readJSON(req);if(!validInput(data))return fail('Controleer je aankoopreferentie en toelichting (maximaal 1000 tekens).',400);
  const digest=await hash(JSON.stringify({orderRequestId:data.orderRequestId,kind:data.kind,message:data.message})),db=mapped.DB;
  const prior=await db.prepare('SELECT * FROM rig_customer_support_requests WHERE user_id=? AND idempotency_key=?').bind(userId,data.idempotencyKey).first();
  if(prior)return prior.request_hash===digest?json({...publicCase(prior),replayed:true,acknowledgement}):fail('Deze aanvraagcode is al gebruikt voor een ander verzoek.',409);
  const order=await db.prepare('SELECT * FROM rig_orders WHERE user_id=? AND request_id=?').bind(userId,data.orderRequestId).first();
  if(!order)return fail('Aankoop niet gevonden.',404);
  if(data.kind==='withdrawal'&&order.state!=='paid')return fail('Deze aankoop heeft nog geen bevestigde betaalstatus. Je kunt wel een vraag over de betaling indienen of contact opnemen via de betaalhulp; dit is geen beslissing over je wettelijke rechten.',409);
  const id=crypto.randomUUID();
  const result=await db.prepare(`INSERT INTO rig_customer_support_requests(id,user_id,order_id,order_request_id,idempotency_key,kind,message,request_hash,order_state_at_request,amount_cents,credits,created_at)
   SELECT ?,o.user_id,o.id,o.request_id,?,?,?,?,o.state,o.amount_cents,o.credits,? FROM rig_orders o
   WHERE o.user_id=? AND o.request_id=? AND (?<>'withdrawal' OR o.state='paid')
   AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
   ON CONFLICT(user_id,idempotency_key) DO NOTHING`).bind(id,data.idempotencyKey,data.kind,data.message,digest,now,userId,data.orderRequestId,data.kind).run();
  const saved=await db.prepare('SELECT * FROM rig_customer_support_requests WHERE user_id=? AND idempotency_key=?').bind(userId,data.idempotencyKey).first();
  if(saved?.request_hash!==digest)return fail('Het verzoek kon niet worden vastgelegd. Controleer de bestaande aanvraag voordat je opnieuw probeert.',409);
  return json({...publicCase(saved),replayed:result.meta?.changes!==1,acknowledgement},result.meta?.changes===1?201:200);
 }catch{return fail('Je verzoek kon niet worden gecontroleerd. Controleer je eerdere verzoeken voordat je opnieuw indient.');}
}

// Owner-only read queue. A future resolution must append a separate audited
// event; this immutable customer receipt must not be edited to imply a refund.
export async function ownerSupportCases(env,{userId,now=Date.now(),limit=50}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return fail('Geen toegang.',403);
 if(!validTime(now)||!Number.isInteger(limit)||limit<1||limit>100)return fail('Controleer de aanvraag.',400);
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Klantverzoeken zijn tijdelijk niet beschikbaar.');
 try{
  const rows=(await mapped.DB.prepare(`SELECT r.*,o.state AS current_order_state,o.payment_id FROM rig_customer_support_requests r JOIN rig_orders o ON o.id=r.order_id AND o.user_id=r.user_id
   ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(limit).all()).results;
  return json({cases:rows.map(row=>({...publicCase(row),userId:row.user_id,currentOrderState:row.current_order_state,paymentId:/^tr_[A-Za-z0-9]{6,80}$/.test(row.payment_id||'')?row.payment_id:null})),limit,monetaryActionPerformed:false});
 }catch{return fail('Klantverzoeken zijn tijdelijk niet beschikbaar.');}
}
