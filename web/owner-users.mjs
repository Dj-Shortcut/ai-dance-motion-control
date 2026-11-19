import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
import {sitesDigest,sitesHmac,sitesInternalAccountActivityPath} from './sites-bridge-protocol.mjs';
import {parseOwnerUsersQuery,OWNER_USERS_CURSOR,OWNER_USERS_CURSOR_MAX} from './owner-users-query.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const fail=(error,status)=>json({error},status);
const equals=(a,b)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0};
const reference=id=>'RIG-'+id.slice(2).toUpperCase();
const validTime=value=>Number.isSafeInteger(value)&&value>=0;
const encoded=value=>btoa(value).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const cursorMessage=(env,payload)=>'rig-owner-users-cursor-v1\n'+env.RIG_PRODUCTION_SITE_ID+'\n'+payload;
const searchDigest=q=>sitesDigest(new TextEncoder().encode(q));
async function makeCursor(env,row,q){
 const payload=encoded(JSON.stringify([1,row.created_at,row.user_id,await searchDigest(q)]));
 return payload+'.'+await sitesHmac(env.RIG_PRODUCTION_SITES_BRIDGE_KEY,cursorMessage(env,payload));
}
async function openCursor(env,token,q){
 if(token===null)return null;
 if(typeof token!=='string'||token.length>OWNER_USERS_CURSOR_MAX||!OWNER_USERS_CURSOR.test(token))throw Error('cursor');
 const [payload,signature]=token.split('.');
 if(!equals(signature,await sitesHmac(env.RIG_PRODUCTION_SITES_BRIDGE_KEY,cursorMessage(env,payload))))throw Error('cursor');
 let data;try{const raw=atob(payload.replaceAll('-','+').replaceAll('_','/'));if(encoded(raw)!==payload)throw Error('cursor');data=JSON.parse(raw)}catch{throw Error('cursor')}
 if(!Array.isArray(data)||data.length!==4||data[0]!==1||!validTime(data[1])||!USER.test(data[2]||'')||data[3]!==await searchDigest(q))throw Error('cursor');
 return {createdAt:data[1],id:data[2]};
}
function publicUser(row){
 if(!USER.test(row.user_id)||!validTime(row.created_at)||row.last_active_at!==null&&!validTime(row.last_active_at))throw Error('Invalid account');
 return {id:row.user_id,reference:reference(row.user_id),displayName:row.display_name??null,email:row.email??null,firstSeenAt:row.created_at,lastActiveAt:row.last_active_at??null};
}

// userId is accepted exclusively from the verified production bridge. Neither
// platform display names/emails nor caller headers confer owner authority.
export async function handleOwnerUsers(req,env,{userId}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return fail('Geen toegang.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Het gebruikersoverzicht is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.username||url.password||url.hash)return fail('Aanvraag geweigerd.',403);
 if(req.method!=='GET'||url.pathname!=='/api/owner/users')return fail('Niet gevonden.',404);
 const query=parseOwnerUsersQuery(url.pathname+url.search);if(!query)return fail('Controleer de zoekopdracht of pagina.',400);
 let cursor;
 try{cursor=await openCursor(env,query.cursor,query.q)}catch{return fail('Deze pagina is niet geldig. Vernieuw het overzicht.',400)}
 try{
  if(await d1Limit({env:mapped,category:'finance',userId,method:'GET'})!==true)return fail('Te veel aanvragen. Probeer later opnieuw.',429);
  const filters=['i.site_id=?'],params=[env.RIG_PRODUCTION_SITE_ID];
  if(query.q){
   const literal='%'+query.q.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%';
   filters.push("(p.display_name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR i.user_id LIKE ? ESCAPE '\\' OR ('RIG-' || upper(substr(i.user_id,3))) LIKE ? ESCAPE '\\')");params.push(literal,literal,literal,literal);
  }
  const joined=' FROM rig_sites_identities i LEFT JOIN rig_account_profiles p ON p.site_id=i.site_id AND p.user_id=i.user_id WHERE '+filters.join(' AND ');
  const after=cursor?' AND (i.created_at<? OR (i.created_at=? AND i.user_id>?))':'';
  const pageParams=[...params,...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[]),query.limit+1];
  const [count,page]=await mapped.DB.batch([
   mapped.DB.prepare('SELECT COUNT(*) AS n'+joined).bind(...params),
   mapped.DB.prepare('SELECT i.user_id,i.created_at,p.display_name,p.email,p.last_active_at'+joined+after+' ORDER BY i.created_at DESC,i.user_id ASC LIMIT ?').bind(...pageParams)
  ]);
  const totalCount=count.results?.[0]?.n,rows=page.results??[];
  if(!Number.isSafeInteger(totalCount)||totalCount<0)throw Error('Invalid account count');
  const users=rows.slice(0,query.limit).map(publicUser),nextCursor=rows.length>query.limit?await makeCursor(env,rows[query.limit-1],query.q):null;
  return json({users,nextCursor,totalCount,profileTrackingAvailable:true});
 }catch{return fail('Het gebruikersoverzicht is tijdelijk niet beschikbaar.',503)}
}

function metadata(value,max,{email=false}={}){
 if(value===null)return true;
 return typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!FORBIDDEN.test(value)&&(!email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
}
async function readActivity(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>2048))return null;
 const reader=req.body?.getReader();if(!reader)return null;
 let size=0;const parts=[];
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)return null;parts.push(value)}
  if(length!==null&&Number(length)!==size)return null;
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  return data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===2&&Object.hasOwn(data,'displayName')&&Object.hasOwn(data,'email')&&metadata(data.displayName,120)&&metadata(data.email,254,{email:true})?data:null;
 }catch{return null}finally{void reader.cancel().catch(()=>{})}
}

// Internal signed producer endpoint only. A browser route must never forward a
// supplied profile here. Request body cannot supply identity or timestamps.
export async function handleAccountActivity(req,env,{userId,siteId,now=Date.now()}={}){
 if(!USER.test(userId||'')||siteId!==env?.RIG_PRODUCTION_SITE_ID||!validTime(now))return fail('Aanvraag geweigerd.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return fail('Accountactiviteit is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.username||url.password||url.hash||url.search||!sitesInternalAccountActivityPath(url.pathname,req.method)||req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return fail('Aanvraag geweigerd.',403);
 const data=await readActivity(req);if(!data)return fail('Controleer de accountgegevens.',400);
 try{
  // The conditional UPSERT is atomic even across concurrent requests. Missing
  // platform metadata preserves known fields; no historical activity is filled.
  await mapped.DB.prepare(`INSERT INTO rig_account_profiles(site_id,user_id,display_name,email,last_active_at)
   SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_sites_identities WHERE site_id=? AND user_id=?)
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
   ON CONFLICT(site_id,user_id) DO UPDATE SET
    display_name=COALESCE(excluded.display_name,rig_account_profiles.display_name),
    email=COALESCE(excluded.email,rig_account_profiles.email),last_active_at=excluded.last_active_at
   WHERE rig_account_profiles.last_active_at<=?`).bind(siteId,userId,data.displayName,data.email,now,siteId,userId,now-60000).run();
  return new Response(null,{status:204,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 }catch{return fail('Accountactiviteit is tijdelijk niet beschikbaar.',503)}
}
