// Public, credential-free relay. Signatures are verified by the bound private
// service; Mollie notifications carry only an ID and are re-read at Mollie.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,sitesRequestBodyLimit,sitesPath} from './sites-bridge-protocol.mjs';
import {productionTenantTesting} from './production-tenant.mjs';
import {nativePath,nativeApiPath} from './native-api.mjs';
import {START_PHOTO_BODY_MAX} from './native-start-photo.mjs';
const {BRIDGE_ORIGIN,SITE_ORIGIN}=productionTenantTesting;
const deny=status=>Response.json({error:'Deze RIG-aanvraag is tijdelijk niet beschikbaar.'},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const provider=/^\/provider-inputs\/[A-Za-z0-9_-]{32,1536}\.[a-f0-9]{64}\/[0-9a-f-]{36}\.(?:jpg|mp4)$/;
export default {async fetch(req,env){
 try{
  if(env.RIG_PRODUCTION_RELAY_ENABLED!=='yes'||env.RIG_PRODUCTION_BRIDGE_ORIGIN!==BRIDGE_ORIGIN||typeof env.CLOSED_VIDEO_SERVICE?.fetch!=='function'||['DB','PRODUCTION_DB','BUCKET','FAL_KEY','MOLLIE_API_KEY','MOLLIE_LIVE_API_KEY','RIG_MEDIA_SECRET','RIG_PRODUCTION_SITES_BRIDGE_KEY','GOOGLE_PLAY_SERVICE_ACCOUNT_JSON','RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY','RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON','RIG_OPENAI_IMAGES_KEY'].some(k=>env[k]))return deny(503);
  const u=new URL(req.url),hook=u.pathname==='/api/payments/webhook',googleHook=u.pathname==='/api/payments/google-play/rtdn',input=provider.test(u.pathname),native=nativePath(u.pathname+u.search,req.method);
  if(u.origin!==BRIDGE_ORIGIN||u.username||u.password||u.hash||(hook||googleHook)&&(u.search||req.method!=='POST')||input&&(u.search||!['GET','HEAD'].includes(req.method))||!hook&&!googleHook&&!input&&!native&&!sitesPath(u.pathname+u.search,req.method))return deny(404);
  if(native&&req.headers.has('origin'))return deny(403);
  if(!hook&&!googleHook&&!input&&!native&&req.method==='POST'&&req.headers.get('origin')!==SITE_ORIGIN)return deny(403);
  const ip=req.headers.get('cf-connecting-ip');
  if(!ip||ip.length>45||!/^[a-fA-F0-9:.]+$/.test(ip)||typeof env.RIG_PUBLIC_LIMITER?.limit!=='function')return deny(503);
  if((await env.RIG_PUBLIC_LIMITER.limit({key:ip}))?.success!==true)return deny(429);
  const max=native&&u.pathname==='/api/native/start-photo'&&req.method==='POST'?START_PHOTO_BODY_MAX:hook?2048:googleHook?49152:native&&u.pathname.startsWith('/api/native/auth/')?1024:sitesRequestBodyLimit(native?nativeApiPath(u.pathname+u.search,req.method):u.pathname,req.method),length=req.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))return deny(413);
  const headers=new Headers();
  if(hook){
   if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return deny(400);
   headers.set('content-type','application/x-www-form-urlencoded');
  }else if(googleHook){
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return deny(400);
   const authorization=req.headers.get('authorization');
   if(typeof authorization!=='string'||authorization.length>16384||!/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization))return deny(401);
   headers.set('content-type','application/json');headers.set('authorization',authorization);
  }else if(input){
   if(req.body||length!==null&&length!=='0')return deny(400);
   const range=req.headers.get('range');if(range!==null){if(range.length>40||!/^bytes=(?:\d{1,12}-\d{0,12}|-\d{1,12})$/.test(range))return deny(416);headers.set('range',range)}
  }else if(native){
   const exchange=u.pathname==='/api/native/auth/exchange',authorization=req.headers.get('authorization');
   if(exchange?authorization!==null:typeof authorization!=='string'||!/^Bearer rig_native_[A-Za-z0-9_-]{43}$/.test(authorization))return deny(401);
   if(!exchange)headers.set('authorization',authorization);
   for(const name of SIGNED_CONTENT_HEADERS){const value=req.headers.get(name);if(value!==null){if(value.length>256)return deny(400);headers.set(name,value);}}
   if(u.pathname==='/api/native/assets'){
    const digest=req.headers.get('x-rig-native-body-sha256');if(!/^[a-f0-9]{64}$/.test(digest||''))return deny(400);headers.set('x-rig-native-body-sha256',digest);
   }
  }else{
   for(const name of [...Object.values(SITE_HEADER_NAMES),...SIGNED_CONTENT_HEADERS,'origin']){const v=req.headers.get(name);if(v!==null)headers.set(name,v)}
   if(!/^[a-f0-9]{64}$/.test(headers.get(SITE_HEADER_NAMES.signature)||''))return deny(401);
  }
  if(length!==null)headers.set('content-length',length);
  const result=await env.CLOSED_VIDEO_SERVICE.fetch(new Request(req,{headers,redirect:'manual'}));
  if(!(result instanceof Response)||result.status>=300&&result.status<400)return deny(503);
  const out=new Headers();for(const name of ['content-type','content-length','content-disposition','content-range','accept-ranges','retry-after']){const v=result.headers.get(name);if(v!==null)out.set(name,v)}
  out.set('cache-control','private, no-store');out.set('x-content-type-options','nosniff');out.set('referrer-policy','no-referrer');
  if(req.method==='HEAD'&&result.body)void result.body.cancel().catch(()=>{});
  return new Response(req.method==='HEAD'?null:result.body,{status:result.status,headers:out});
 }catch{return deny(503)}
}};
