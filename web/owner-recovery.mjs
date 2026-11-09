// Owner-only investigation. A case note never unlocks a wallet or retries a
// provider request. Payment adoption needs provider-proved attribution first.
import {validateProductionTenant} from './production-tenant.mjs';
import {prepareOwnerMutation,ownerSecurityHash} from './owner-security.mjs';
import {createProductionPayment} from './production-payment.mjs';
import {d1Limit} from './router.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,PAYMENT=/^tr_[A-Za-z0-9]{6,80}$/;
const paymentStates=new Set(['creating','unknown','credit_pending_review','reversal_review']);
const statuses=new Set(['investigating','waiting-provider','reviewed']);
const mode="EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')";
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const error=(message,status=400)=>json({error:message},status);
const money=cents=>(cents/100).toFixed(2);
const whole=value=>Number.isSafeInteger(value)&&value>=0;
const timestamp=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)?value.replace(' ','T')+'Z':value):NaN;
const cleanNote=value=>typeof value==='string'&&Array.from(value.trim()).length>=1&&Array.from(value).length<=1000&&!/[\u0000-\u001f\u007f]/.test(value);
const exact=(data,required,optional=[])=>data&&required.every(key=>Object.hasOwn(data,key))&&Object.keys(data).every(key=>required.includes(key)||optional.includes(key));
async function body(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0;const parts=[];let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timeout')),10000)});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;if(!(value instanceof Uint8Array)||(size+=value.length)>8192)return null;parts.push(value);}const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
const rowSQL=kind=>kind==='payment'?'SELECT * FROM rig_orders WHERE id=?':'SELECT j.*,q.funding_kind,q.model FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id WHERE j.id=?';
const snapshotFields=kind=>kind==='payment'?['id','user_id','request_id','state','payment_id','amount_cents','credits','created_at']:['id','user_id','quote_id','state','fal_request_id','price_cents','funding_kind','created_at'];
const snapshot=(kind,row)=>JSON.stringify(snapshotFields(kind).map(field=>row[field]??null));
export const recoveryCaseVersion=async(kind,row)=>ownerSecurityHash(kind+'\0'+snapshot(kind,row));
const orderCAS=row=>({sql:'id=? AND user_id=? AND request_id=? AND state=? AND payment_id IS ? AND amount_cents=? AND credits=? AND created_at=?',params:[row.id,row.user_id,row.request_id,row.state,row.payment_id,row.amount_cents,row.credits,row.created_at]});
const jobCAS=row=>({sql:'j.id=? AND j.user_id=? AND j.quote_id=? AND j.state=? AND j.fal_request_id IS ? AND j.price_cents=? AND q.funding_kind=? AND j.created_at=?',params:[row.id,row.user_id,row.quote_id,row.state,row.fal_request_id,row.price_cents,row.funding_kind,row.created_at]});
const inReview=(kind,row,now)=>kind==='payment'?paymentStates.has(row.state)&&(row.state!=='creating'||timestamp(row.created_at)<=now-300000):row.state==='unknown'||row.state==='submitting'&&whole(row.created_at)&&row.created_at<=now-600000;
async function notes(db,kind,id){return (await db.prepare('SELECT id,status,note,created_at FROM rig_owner_recovery_events WHERE case_kind=? AND case_id=? ORDER BY created_at DESC,id DESC LIMIT 3').bind(kind,id).all()).results.map(row=>({id:row.id,status:row.status,note:row.note,createdAt:row.created_at}));}
async function publicCase(db,kind,row,now){
 const payment=kind==='payment',known=payment?PAYMENT.test(row.payment_id||''):typeof row.fal_request_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(row.fal_request_id);
 return {kind,id:row.id,userId:row.user_id,state:row.state,createdAt:whole(timestamp(row.created_at))?timestamp(row.created_at):null,amountCents:payment?row.amount_cents:row.price_cents,
  ...(payment?{credits:row.credits}:{fundingKind:row.funding_kind,model:row.model}),providerRequestId:known?(payment?row.payment_id:row.fal_request_id):null,
  version:await recoveryCaseVersion(kind,row),action:payment?'verify-payment':'contact-provider',fundingLocked:true,
  reason:payment?(known?'payment_requires_review':'payment_id_unknown'):(known?'generation_requires_review':'generation_id_unknown'),
  nextStep:payment?'Zoek deze RIG-bestelling in Mollie. Een betaalbewijs of schermafbeelding schrijft geen tegoed bij. Alleen een door Mollie bevestigde koppeling wordt verwerkt.':'Onderzoek dit verzoek bij Fal. Start niet opnieuw en geef geen tegoed vrij zolang de uitkomst onbekend is. Een onderzoeksnotitie verandert de video of het gereserveerde tegoed niet.',
  notes:await notes(db,kind,row.id)};
}
async function listCases(db,now){
 const payments=(await db.prepare("SELECT * FROM rig_orders WHERE state IN ('unknown','credit_pending_review','reversal_review') OR (state='creating' AND CAST(strftime('%s',created_at) AS INTEGER)*1000<=?) ORDER BY created_at,id LIMIT 20").bind(now-300000).all()).results;
 const jobs=(await db.prepare("SELECT j.*,q.funding_kind,q.model FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id WHERE j.state='unknown' OR (j.state='submitting' AND j.created_at<=?) ORDER BY j.created_at,j.id LIMIT 20").bind(now-600000).all()).results;
 const [paymentCount,generationCount]=await Promise.all([db.prepare("SELECT COUNT(*) n FROM rig_orders WHERE state IN ('unknown','credit_pending_review','reversal_review') OR (state='creating' AND CAST(strftime('%s',created_at) AS INTEGER)*1000<=?)").bind(now-300000).first(),db.prepare("SELECT COUNT(*) n FROM rig_generation_jobs WHERE state='unknown' OR (state='submitting' AND created_at<=?)").bind(now-600000).first()]);
 return {cases:await Promise.all([...payments.map(row=>publicCase(db,'payment',row,now)),...jobs.map(row=>publicCase(db,'generation',row,now))]),counts:{payment:paymentCount.n,generation:generationCount.n},automaticResubmission:false,automaticUnknownRefund:false};
}
async function priorEvent(db,owner,key,hash){
 const prior=await db.prepare('SELECT * FROM rig_owner_recovery_events WHERE idempotency_key=?').bind(key).first();
 if(!prior)return null;
 return prior.owner_id===owner&&prior.request_hash===hash?prior:false;
}
async function saveNote(req,mapped,owner,now){
 const data=await body(req),required=['idempotencyKey','kind','caseId','expectedVersion','status','note'];
 if(!exact(data,required,['verification'])||!UUID.test(data.idempotencyKey||'')||!['payment','generation'].includes(data.kind)||!UUID.test(data.caseId||'')||!HASH.test(data.expectedVersion||'')||!statuses.has(data.status)||!cleanNote(data.note))return error('Controleer de onderzoeksnotitie.');
 const {verification,...payload}=data,hash=await ownerSecurityHash('recovery-note\0'+JSON.stringify(required.map(key=>[key,payload[key]]))),db=mapped.DB;
 const prior=await priorEvent(db,owner,data.idempotencyKey,hash);if(prior===false)return error('Deze aanvraagcode is al gebruikt.',409);if(prior)return json({id:prior.id,recorded:true,replayed:true,fundingChanged:false});
 const row=await db.prepare(rowSQL(data.kind)).bind(data.caseId).first();
 if(!row||!inReview(data.kind,row,now)||await recoveryCaseVersion(data.kind,row)!==data.expectedVersion)return error('Dit dossier is ondertussen gewijzigd. Vernieuw het overzicht.',409);
 const proof=await prepareOwnerMutation(db,{ownerId:owner,operation:'recovery-note',payload,verification,now});if(!proof.ok)return proof.response;
 const cas=data.kind==='payment'?orderCAS(row):jobCAS(row),exists=data.kind==='payment'?`SELECT 1 FROM rig_orders WHERE ${cas.sql}`:`SELECT 1 FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id WHERE ${cas.sql}`;
 const id=crypto.randomUUID(),insert=db.prepare(`INSERT INTO rig_owner_recovery_events(id,idempotency_key,owner_id,case_kind,case_id,action,status,note,provider_id,request_hash,evidence_json,created_at)
  SELECT ?,?,?,?,?, 'note',?,?,NULL,?,'{}',? WHERE (${proof.gate.sql}) AND ${mode} AND EXISTS(${exists}) ON CONFLICT(idempotency_key) DO NOTHING`).bind(id,data.idempotencyKey,owner,data.kind,data.caseId,data.status,data.note.trim(),hash,now,...proof.gate.params,...cas.params);
 const results=await db.batch([...proof.before,insert]);if(results.at(-1)?.meta?.changes===1)return json({id,recorded:true,replayed:false,fundingChanged:false},201);
 const concurrent=await priorEvent(db,owner,data.idempotencyKey,hash);if(concurrent)return json({id:concurrent.id,recorded:true,replayed:true,fundingChanged:false});
 return error('De notitie kon niet veilig worden opgeslagen. Vernieuw het dossier.',409);
}
async function providerJSON(response){
 if(!response?.ok||!['application/json','application/hal+json'].includes((response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()))throw Error('Unverified provider response');
 const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>65536))throw Error('Large provider response');
 const reader=response.body?.getReader();if(!reader)throw Error('Missing provider response');let size=0,parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array)||(size+=value.length)>65536)throw Error('Large provider response');parts.push(value);}const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid provider response');return value;}finally{void reader.cancel().catch(()=>{});}
}
async function paymentProof(mapped,row,id,network){
 const read=path=>network('https://api.mollie.com'+path,{method:'GET',headers:{authorization:'Bearer '+mapped.MOLLIE_API_KEY,accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)}).then(providerJSON);
 const profile=await read('/v2/profiles/me');if(profile.id!==mapped.RIG_MOLLIE_PROFILE_ID||profile.status==='blocked')throw Error('Profile mismatch');
 const payment=await read('/v2/payments/'+id);
 if(payment.id!==id||payment.mode!=='live'||payment.profileId!==profile.id||payment.metadata?.order_id!==row.id||payment.amount?.currency!=='EUR'||payment.amount?.value!==money(row.amount_cents)||!['open','pending','authorized','paid','failed','expired','canceled'].includes(payment.status))throw Error('Payment mismatch');
 return {paymentId:id,profileId:profile.id,orderId:row.id,amountCents:row.amount_cents,currency:'EUR',providerState:payment.status};
}
async function reconciliationReceipt(env,mapped,row,id,replayed,network){
 let checked=false;
 try{const payments=createProductionPayment({transport:network}),response=await payments.user(new Request(mapped.RIG_PUBLIC_ORIGIN+'/api/payments/orders/'+encodeURIComponent(row.request_id)+'/reconcile',{method:'POST',headers:{origin:mapped.RIG_PUBLIC_ORIGIN,'content-type':'application/json'},body:'{}'}),env,row.user_id);checked=response.ok;void response.body?.cancel().catch(()=>{});}catch{}
 // Keep an adopted but unverified outcome visible and locked for review. A
 // concurrent paid/terminal webhook wins: never overwrite its newer state.
 if(!checked)await mapped.DB.prepare(`UPDATE rig_orders SET state='unknown' WHERE id=? AND user_id=? AND state='open' AND payment_id IS NOT NULL AND ${mode}`).bind(row.id,row.user_id).run();
 const current=await mapped.DB.prepare('SELECT state FROM rig_orders WHERE id=? AND user_id=?').bind(row.id,row.user_id).first(),credit=await mapped.DB.prepare('SELECT 1 found FROM rig_ledger WHERE event_id=? AND order_id=? AND user_id=? AND delta=?').bind('credit:'+row.id,row.id,row.user_id,row.credits).first();
 const held=await mapped.DB.prepare('SELECT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen,EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?) AS reversed').bind(row.user_id,'reverse:'+row.id).first();
 return json({id,linked:true,replayed,reconciled:checked,orderState:current?.state??'unknown',creditConfirmed:current?.state==='paid'&&credit?.found===1&&held?.frozen===0&&held?.reversed===0,reviewRequired:held?.frozen===1||['credit_pending_review','reversal_review','unknown'].includes(current?.state),message:checked?'Mollie-koppeling gecontroleerd. Alleen bevestigd betaalde aankopen krijgen tegoed.':'De Mollie-koppeling is bewaard. De betaalstatus moet nog opnieuw worden gecontroleerd.'});
}
async function adoptPayment(req,env,mapped,owner,orderId,nowOf,network){
 const data=await body(req);
 if(!exact(data,['idempotencyKey','expectedVersion','providerPaymentId'],['verification'])||!UUID.test(data.idempotencyKey||'')||!HASH.test(data.expectedVersion||'')||!PAYMENT.test(data.providerPaymentId||''))return error('Controleer het Mollie-betalingsnummer.');
 const {verification,...fields}=data,payload={orderId,...fields},hash=await ownerSecurityHash('recovery-payment\0'+JSON.stringify([orderId,data.idempotencyKey,data.expectedVersion,data.providerPaymentId])),db=mapped.DB;
 const prior=await priorEvent(db,owner,data.idempotencyKey,hash);if(prior===false)return error('Deze aanvraagcode is al gebruikt.',409);
 let row=await db.prepare(rowSQL('payment')).bind(orderId).first();
 if(!row)return error('Dossier niet gevonden.',404);
 if(prior)return reconciliationReceipt(env,mapped,row,prior.id,true,network);
 if(!inReview('payment',row,nowOf())||await recoveryCaseVersion('payment',row)!==data.expectedVersion||row.payment_id!==null&&row.payment_id!==data.providerPaymentId){
  const completed=await priorEvent(db,owner,data.idempotencyKey,hash);if(completed)return reconciliationReceipt(env,mapped,row,completed.id,true,network);
  return error('Deze bestelling is ondertussen gewijzigd. Vernieuw het dossier.',409);
 }
 let evidence;try{evidence=await paymentProof(mapped,row,data.providerPaymentId,network);}catch{return error('Mollie kon deze betaling niet aan precies deze RIG-bestelling koppelen. Er is geen tegoed toegekend.',409);}
 const now=nowOf(),proof=await prepareOwnerMutation(db,{ownerId:owner,operation:'recovery-payment',payload,verification,now});if(!proof.ok)return proof.response;
 const cas=orderCAS(row),id=crypto.randomUUID(),update=db.prepare(`UPDATE rig_orders SET payment_id=?,state=CASE WHEN state IN ('creating','unknown') AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=rig_orders.user_id) THEN 'open' ELSE state END
  WHERE ${cas.sql} AND (${proof.gate.sql}) AND ${mode} AND NOT EXISTS(SELECT 1 FROM rig_orders other WHERE other.payment_id=? AND other.id<>rig_orders.id)`)
  .bind(data.providerPaymentId,...cas.params,...proof.gate.params,data.providerPaymentId);
 const audit=db.prepare(`INSERT INTO rig_owner_recovery_events(id,idempotency_key,owner_id,case_kind,case_id,action,status,note,provider_id,request_hash,evidence_json,created_at)
  SELECT ?,?,?,'payment',?,'payment-adopted','provider-linked','Mollie-identiteit en bedrag door de server gecontroleerd.',?,?,?,?
  WHERE changes()=1 AND (${proof.gate.sql}) AND EXISTS(SELECT 1 FROM rig_orders WHERE id=? AND user_id=? AND payment_id=?)`).bind(id,data.idempotencyKey,owner,row.id,data.providerPaymentId,hash,JSON.stringify(evidence),now,...proof.gate.params,row.id,row.user_id,data.providerPaymentId);
 try{const results=await db.batch([...proof.before,update,audit]);if(results.at(-2)?.meta?.changes===1&&results.at(-1)?.meta?.changes===1)return reconciliationReceipt(env,mapped,row,id,false,network);}catch{return error('Deze koppeling kon niet veilig worden vastgelegd. Controleer eerst het bestaande dossier.',409);}
 const concurrent=await priorEvent(db,owner,data.idempotencyKey,hash);if(concurrent)return reconciliationReceipt(env,mapped,row,concurrent.id,true,network);
 return error('Deze bestelling of bevestiging is ondertussen gewijzigd. Vernieuw het dossier.',409);
}
export async function handleOwnerRecovery(req,env,{userId,now,clock=Date.now,network=fetch}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return error('Geen toegang.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return error('Dossierbeheer is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url),nowOf=()=>now??clock();
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.search||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return error('Aanvraag geweigerd.',403);
 try{
  const at=nowOf();if(!whole(at))throw Error('Invalid recovery time');
  if(await d1Limit({env:mapped,category:'finance',userId,method:req.method})!==true)return error('Te veel aanvragen. Probeer later opnieuw.',429);
  if(req.method==='GET'&&url.pathname==='/api/owner/recovery')return json(await listCases(mapped.DB,at));
  if(req.method==='POST'&&url.pathname==='/api/owner/recovery/notes')return saveNote(req,mapped,userId,at);
  const adopt=/^\/api\/owner\/recovery\/payments\/([0-9a-f-]{36})\/adopt$/.exec(url.pathname);
  if(req.method==='POST'&&adopt&&UUID.test(adopt[1]))return adoptPayment(req,env,mapped,userId,adopt[1],nowOf,network);
  return error('Niet gevonden.',404);
 }catch{return error('Dossierbeheer is tijdelijk niet beschikbaar. Start geen nieuwe betaling of video zolang de bestaande status onbekend is.',503);}
}
