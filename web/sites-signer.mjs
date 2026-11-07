// OWNER-ONLY STAGING. This signer MUST run exclusively behind a verified Sites
// ingress that overwrites untrusted identity headers. A private one-path spoof
// test is not proof of this property across all routes or direct hostnames.
// Do not set the operator attestation or deploy until the complete ingress,
// auth, service binding, nonce cleanup and data isolation have been verified.
import {gatewayTesting} from './gateway.mjs';
const USER=/^[A-Za-z0-9_-]{1,100}$/;
const KEY=/^[a-f0-9]{64}$/;
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const bytes=h=>Uint8Array.from(h.match(/../g),x=>parseInt(x,16));
const fail=(code,message)=>Response.json({error:message},{status:code,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const allowed=path=>['/api/fal/preflight','/api/media/test','/api/payments/packages','/api/payments/balance','/api/payments/create','/api/payments/orders','/api/generation-quotes','/api/generations','/api/generations/recent','/api/assets'].includes(path)||/^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}(?:\/reconcile)?$/.test(path)||/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(path)||/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(path);
function validConfig(env){
 try{const url=new URL(env.RIG_PUBLIC_ORIGIN);return url.protocol==='https:'&&url.origin===env.RIG_PUBLIC_ORIGIN&&env.RIG_MODE==='test'&&env.RIG_MOLLIE_MODE==='test'&&env.RIG_SITES_VERIFIED_PRIVATE_INGRESS==='yes'&&USER.test(env.RIG_STAGING_OWNER||'')&&KEY.test(env.RIG_GATEWAY_KEY||'')&&env.DB&&typeof env.RIG_STAGING_SERVICE?.fetch==='function'}catch{return false}
}
export async function acquireSitesMediaLease(db,now=Date.now()) {
 const token=crypto.randomUUID();const row=await db.prepare(`INSERT INTO rig_sites_signer_lease(id,token,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE rig_sites_signer_lease.expires_at < ? RETURNING token`).bind(token,now+600000,now).first();return row?.token===token?token:null;
}
export async function releaseSitesMediaLease(db,token){await db.prepare('DELETE FROM rig_sites_signer_lease WHERE id=1 AND token=?').bind(token).run()}
// Callers supply a durable rate limiter. Acquire a different shared media lease
// than the staging receiver, before reading bytes. Never use per-isolate memory.
export function createSitesSigner({limit,acquire=acquireSitesMediaLease,release=releaseSitesMediaLease,allowMedia,serviceTimeoutMs=240000}={}){
 return async function sign(req,env){
  if(!validConfig(env)||typeof limit!=='function'||typeof acquire!=='function'||typeof release!=='function'||!Number.isInteger(serviceTimeoutMs)||serviceTimeoutMs<10||serviceTimeoutMs>240000)return fail(503,'Testomgeving is niet beschikbaar.');
  const url=new URL(req.url),user=req.headers.get('oai-authenticated-user-id');
  if(url.origin!==env.RIG_PUBLIC_ORIGIN||url.search.length>1024||!allowed(url.pathname)||!['GET','POST'].includes(req.method))return fail(404,'Niet gevonden.');
  if(!USER.test(user||'')||user!==env.RIG_STAGING_OWNER)return fail(401,'Aanmelden vereist.');
  if(req.method==='POST'&&req.headers.get('origin')!==env.RIG_PUBLIC_ORIGIN)return fail(403,'Ongeldige oorsprong.');
  const site=req.headers.get('sec-fetch-site');if(site&&!['same-origin','none'].includes(site))return fail(403,'Ongeldige oorsprong.');
  let lease=null, dispatched=false,gotResponse=false;
  try{
   if(await limit({env,user,path:url.pathname,method:req.method})!==true)return fail(429,'Te veel aanvragen.');
   const isAsset=url.pathname==='/api/assets'||url.pathname==='/api/media/test';
   if(isAsset){
    // A lease expiry is not evidence that a remote transcoder stopped. Until
    // a trusted runtime supplies an independently enforced termination and
    // fencing policy, uploads remain blocked even with valid credentials.
    if(typeof allowMedia!=='function'||await allowMedia({env,user,path:url.pathname})!==true)return fail(503,'Mediaverwerking is nog niet beschikbaar.');
    lease=await acquire(env.DB);if(!lease)return fail(429,'Media wordt al verwerkt.');
   }
   const body=await gatewayTesting.bounded(req.body,isAsset?16*1024*1024:8192,30000);
   const headers=new Headers();for(const n of ['origin','content-type','x-rig-asset-kind','x-rig-duration-seconds','x-rig-keep-sound']){const v=req.headers.get(n);if(v!==null)headers.set(n,v)}
   const now=String(Date.now()),nonce=hex(crypto.getRandomValues(new Uint8Array(16))),digest=hex(await crypto.subtle.digest('SHA-256',body));
   const key=await crypto.subtle.importKey('raw',bytes(env.RIG_GATEWAY_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
   const message=new TextEncoder().encode(gatewayTesting.canonical(req.method,url.pathname+url.search,user,now,nonce,digest,headers));
   const signature=hex(await crypto.subtle.sign('HMAC',key,message));
   headers.set('x-rig-gateway-user',user);headers.set('x-rig-gateway-time',now);headers.set('x-rig-gateway-nonce',nonce);headers.set('x-rig-gateway-body-sha256',digest);headers.set('x-rig-gateway-signature',signature);
   const controller=new AbortController();let timer;
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('service timeout'))},serviceTimeoutMs)});
   const clean=new Request(url.href,{method:req.method,headers,redirect:'manual',signal:controller.signal,...(body.length?{body,duplex:'half'}:{})});
   dispatched=true;let response;try{response=await Promise.race([env.RIG_STAGING_SERVICE.fetch(clean),deadline]);gotResponse=response?.headers?.get('x-rig-media-uncertain')!=='1'}finally{clearTimeout(timer)}
   if(!(response instanceof Response)||response.status>=300&&response.status<400)return fail(503,'Testomgeving is tijdelijk niet beschikbaar.');
   const out=new Headers(response.headers);out.delete('x-rig-media-uncertain');out.delete('access-control-allow-origin');out.delete('access-control-allow-credentials');out.set('cache-control','no-store');out.set('x-content-type-options','nosniff');out.set('referrer-policy','no-referrer');out.set('x-frame-options','DENY');
   return new Response(response.body,{status:response.status,headers:out});
  }catch{return fail(503,'Testomgeving is tijdelijk niet beschikbaar.')}
  finally{
   // On an uncertain dispatched request, keep the shared lease until expiry;
   // downstream work might still be running after a network/service failure.
   if(lease&&(!dispatched||gotResponse))try{await release(env.DB,lease)}catch{}
  }
 };
}
export const sitesSignerTesting={allowed,validConfig};
