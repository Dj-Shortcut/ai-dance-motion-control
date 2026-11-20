import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {ACCOUNT_DELETION_PATH,ACCOUNT_REPORT_PATH,ACCOUNT_SERVICE_OWNER_PATH,sitesAccountServicePath,ownerAccountServicePath,parseAccountServiceCursor} from './account-service-path.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REASONS=new Set(['sexual','violence','hate','unsafe','other']);
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const URL_TEXT=/(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)/iu;
const validTime=x=>Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const fail=(error,status=503)=>json({error},status);
const acknowledgement=type=>type==='account-deletion'
 ?'Je verwijderverzoek is ontvangen. De beheerder beoordeelt en verwerkt je verzoek. Je account en tegoed zijn nog niet gewijzigd.'
 :'Je melding is ontvangen. De beheerder beoordeelt de gemelde video. Je video en tegoed zijn niet gewijzigd.';
function receipt(row,replayed=false){
 if(!UUID.test(row.id)||!['account-deletion','video-report'].includes(row.type)||!['pending','resolved','declined'].includes(row.status)||!validTime(row.created_at))throw Error('Invalid receipt');
 return {id:row.id,type:row.type,status:row.status,createdAt:row.created_at,replayed,acknowledgement:acknowledgement(row.type),actionPerformed:false,...(row.type==='video-report'?{jobId:row.job_id}:{})};
}
async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;
 const chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('body timeout')),5000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))return null;size+=value.length;if(size>8192||length!==null&&size>Number(length))return null;chunks.push(value)}
  if(length!==null&&size!==Number(length))return null;
  const bytes=new Uint8Array(size);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
 }catch{return null}finally{clearTimeout(timer);void reader.cancel().catch(()=>{})}
}
function input(data,type){
 if(!data||typeof data.requestId!=='string'||!UUID.test(data.requestId))return null;
 const keys=Object.keys(data);
 if(type==='account-deletion')return keys.length===1&&keys[0]==='requestId'?{requestId:data.requestId,reason:null,details:''}:null;
 if(keys.some(k=>!['requestId','reason','details'].includes(k))||!REASONS.has(data.reason))return null;
 const details=Object.hasOwn(data,'details')?data.details:'';
 return typeof details==='string'&&Array.from(details).length<=1000&&!CONTROL.test(details)&&!URL_TEXT.test(details)
  ?{requestId:data.requestId,reason:data.reason,details}:null;
}
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('')}

export async function handleAccountServiceRequest(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(userId||''))return fail('Meld je aan bij RIG.',401);
 if(!validTime(now))return fail('Je verzoek is tijdelijk niet beschikbaar.');
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Je verzoek is tijdelijk niet beschikbaar.');
 const url=new URL(req.url),path=url.pathname+url.search;
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.hash||url.username||url.password||!sitesAccountServicePath(path,req.method))return fail('Niet gevonden.',404);
 if(req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return fail('Aanvraag geweigerd.',403);
 try{
  if(await d1Limit({env:mapped,category:'account-service',userId,method:req.method})!==true)return fail('Te veel aanvragen. Probeer even later opnieuw.',429);
  const db=mapped.DB,site=env.RIG_PRODUCTION_SITE_ID;
  if(!await db.prepare('SELECT user_id FROM rig_sites_identities WHERE site_id=? AND user_id=?').bind(site,userId).first())return fail('Meld je opnieuw aan bij RIG.',401);
  if(req.method==='GET'){
   const rows=(await db.prepare("SELECT * FROM rig_account_service_requests WHERE site_id=? AND user_id=? AND type='account-deletion' ORDER BY created_at DESC,id DESC LIMIT 20").bind(site,userId).all()).results;
   return json({requests:rows.map(row=>receipt(row)),limit:20});
  }
  const report=ACCOUNT_REPORT_PATH.exec(url.pathname),type=report?'video-report':'account-deletion',jobId=report?.[1]??null;
  const data=input(await readJSON(req),type);if(!data)return fail('Controleer je verzoek. Kies een reden en maximaal 1000 tekens zonder links.',400);
  const hash=await digest(JSON.stringify([type,jobId,data.reason,data.details]));
  const prior=await db.prepare(`SELECT r.*,k.request_hash AS key_hash FROM rig_account_service_request_keys k
   JOIN rig_account_service_requests r ON r.id=k.case_id AND r.site_id=k.site_id AND r.user_id=k.user_id AND r.request_hash=k.request_hash
   WHERE k.site_id=? AND k.user_id=? AND k.request_id=?`).bind(site,userId,data.requestId).first();
  if(prior)return prior.key_hash===hash?json(receipt(prior,true)):fail('Deze aanvraagcode is al gebruikt voor een ander verzoek.',409);
  if(jobId){
   const job=await db.prepare('SELECT state,result_key FROM rig_generation_jobs WHERE id=? AND user_id=?').bind(jobId,userId).first();
   if(!job)return fail('Video niet gevonden.',404);
   if(job.state!=='completed'||!job.result_key)return fail('Deze video is nog niet beschikbaar om te melden.',409);
  }
  const id=crypto.randomUUID();
  // Both inserts are one D1 transaction. The pending-hash index deduplicates
  // reopened dialogs; the immutable alias binds every accepted request key.
  const [created]=await db.batch([
   db.prepare(`INSERT INTO rig_account_service_requests(id,site_id,user_id,type,job_id,reason,details,request_hash,status,created_at)
    SELECT ?,i.site_id,i.user_id,?,?,?,?,?,'pending',? FROM rig_sites_identities i
    WHERE i.site_id=? AND i.user_id=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
    AND NOT EXISTS(SELECT 1 FROM rig_account_service_request_keys WHERE site_id=? AND user_id=? AND request_id=?)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM rig_generation_jobs j WHERE j.id=? AND j.user_id=i.user_id AND j.state='completed' AND j.result_key IS NOT NULL AND j.result_key<>''))
    ON CONFLICT DO NOTHING`).bind(id,type,jobId,data.reason,data.details,hash,now,site,userId,site,userId,data.requestId,jobId,jobId),
   db.prepare(`INSERT INTO rig_account_service_request_keys(site_id,user_id,request_id,request_hash,case_id,created_at)
    SELECT r.site_id,r.user_id,?,?,r.id,? FROM rig_account_service_requests r
    WHERE r.site_id=? AND r.user_id=? AND r.type=? AND r.request_hash=? AND r.status='pending'
    ORDER BY r.created_at,r.id LIMIT 1 ON CONFLICT DO NOTHING`).bind(data.requestId,hash,now,site,userId,type,hash)
  ]);
  const saved=await db.prepare(`SELECT r.*,k.request_hash AS key_hash FROM rig_account_service_request_keys k
   JOIN rig_account_service_requests r ON r.id=k.case_id AND r.site_id=k.site_id AND r.user_id=k.user_id AND r.request_hash=k.request_hash
   WHERE k.site_id=? AND k.user_id=? AND k.request_id=?`).bind(site,userId,data.requestId).first();
  if(!saved||saved.key_hash!==hash)return fail('Het verzoek kon niet worden bevestigd. Controleer je bestaande verzoek voordat je opnieuw indient.',409);
  return json(receipt(saved,created.meta?.changes!==1),created.meta?.changes===1?201:200);
 }catch{return fail('Je verzoek kon niet worden gecontroleerd. Probeer je bestaande verzoek opnieuw met dezelfde aanvraagcode.');}
}

export async function handleOwnerAccountServiceRequests(req,env,{userId}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return fail('Geen toegang.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Klantverzoeken zijn tijdelijk niet beschikbaar.');
 const url=new URL(req.url),path=url.pathname+url.search;
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.hash||url.username||url.password||!ownerAccountServicePath(path,req.method))return fail('Niet gevonden.',404);
 let cursor;try{cursor=parseAccountServiceCursor(url.search)}catch{return fail('Controleer de pagina.',400)}
 try{
  if(await d1Limit({env:mapped,category:'finance',userId,method:'GET'})!==true)return fail('Te veel aanvragen. Probeer even later opnieuw.',429);
  const rows=(await mapped.DB.prepare(`SELECT r.*,p.display_name,p.email FROM rig_account_service_requests r
   LEFT JOIN rig_account_profiles p ON p.site_id=r.site_id AND p.user_id=r.user_id
   WHERE r.site_id=? AND r.status='pending'${cursor?' AND (r.created_at>? OR (r.created_at=? AND r.id>?))':''}
   ORDER BY r.created_at,r.id LIMIT 51`).bind(env.RIG_PRODUCTION_SITE_ID,...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[])).all()).results;
  const page=rows.slice(0,50),last=page.at(-1);
  return json({requests:page.map(row=>({...receipt(row),userId:row.user_id,displayName:row.display_name??null,email:row.email??null,reason:row.reason,details:row.details})),limit:50,nextCursor:rows.length>50?`${last.created_at}.${last.id}`:null});
 }catch{return fail('Klantverzoeken zijn tijdelijk niet beschikbaar.');}
}
