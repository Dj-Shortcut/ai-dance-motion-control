// Public relay only: no credentials, DB, R2 or caller-supplied trusted identity.
import {SITE_HEADER_NAMES,SIGNED_CONTENT_HEADERS,SITES_BODY_MAX,sitesOrigin,sitesPath} from './sites-bridge-protocol.mjs';
const deny=(status)=>Response.json({error:'RIG-aanvraag niet beschikbaar.'},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INPUT_PATH=new RegExp('^/provider-inputs/[A-Za-z0-9_-]{32,1536}\\.[a-f0-9]{64}/'+UUID+'\\.(?:jpg|mp4)$');
const INPUT_HEADERS=['content-type','content-length','content-range','accept-ranges','cache-control','x-content-type-options','retry-after'];
function providerPath(url,raw){return !url.search&&!raw.includes('?')&&!raw.includes('#')&&INPUT_PATH.test(url.pathname)}
function validRange(value){
 if(typeof value!=='string'||value.length>40)return false;
 const part=value.match(/^bytes=(\d{1,12})-(\d{0,12})$/);
 if(part)return !part[2]||Number(part[2])>=Number(part[1]);
 const suffix=value.match(/^bytes=-(\d{1,12})$/);return Boolean(suffix&&Number(suffix[1])>0);
}
export default {async fetch(req,env){
 try{
  if(env.RIG_SITES_RELAY_ENABLED!=='yes'||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||!sitesOrigin(env.RIG_SITES_BRIDGE_ORIGIN)||!sitesOrigin(env.RIG_SITES_PRODUCER_ORIGIN)||typeof env.CLOSED_VIDEO_SERVICE?.fetch!=='function'||env.FAL_KEY||env.RIG_MEDIA_SECRET||env.RIG_SITES_BRIDGE_KEY||env.MOLLIE_API_KEY||env.DB||env.BUCKET)return deny(503);
  const u=new URL(req.url),provider=providerPath(u,req.url);
  if(u.origin!==env.RIG_SITES_BRIDGE_ORIGIN||u.username||u.password||u.hash||!provider&&!sitesPath(u.pathname+u.search,req.method))return deny(404);
  if(provider&&!['GET','HEAD'].includes(req.method))return deny(405);
  if(!provider&&req.method==='POST'&&req.headers.get('origin')!==env.RIG_SITES_PRODUCER_ORIGIN)return deny(403);
  const ip=req.headers.get('cf-connecting-ip');if(!ip||ip.length>45||!/^[a-fA-F0-9:.]+$/.test(ip)||typeof env.RIG_PUBLIC_LIMITER?.limit!=='function')return deny(503);
  if((await env.RIG_PUBLIC_LIMITER.limit({key:ip}))?.success!==true)return deny(429);
  if(provider){
   // The URL itself is a narrow, expiring capability. Only the private service
   // validates its HMAC and owned immutable asset before any private I/O.
   // Browser sessions, Site identities and provider credentials never cross.
   const declared=req.headers.get('content-length');
   if(req.body||declared!==null&&declared!=='0')return deny(400);
   const range=req.headers.get('range'),headers=new Headers();
   if(range!==null){if(!validRange(range))return deny(416);headers.set('range',range)}
   const response=await env.CLOSED_VIDEO_SERVICE.fetch(new Request(req.url,{method:req.method,headers,redirect:'manual',signal:req.signal}));
   if(!(response instanceof Response)||response.status>=300&&response.status<400)return deny(503);
   const out=new Headers();for(const name of INPUT_HEADERS){const value=response.headers.get(name);if(value!==null)out.set(name,value)}
   out.set('cache-control','private, no-store');out.set('x-content-type-options','nosniff');
   if(req.method==='HEAD'&&response.body)void response.body.cancel().catch(()=>{});
   return new Response(req.method==='HEAD'?null:response.body,{status:response.status,headers:out});
  }
  const size=req.headers.get('content-length'),max=u.pathname==='/api/assets'?SITES_BODY_MAX:8192;if(size!==null&&(!/^\d+$/.test(size)||Number(size)>max))return deny(413);
  const headers=new Headers();for(const name of [...Object.values(SITE_HEADER_NAMES),...SIGNED_CONTENT_HEADERS,'origin','content-length']){const value=req.headers.get(name);if(value!==null)headers.set(name,value)}
  if(!/^[a-f0-9]{64}$/.test(headers.get(SITE_HEADER_NAMES.signature)||''))return deny(401);
  const response=await env.CLOSED_VIDEO_SERVICE.fetch(new Request(req,{headers,redirect:'manual'}));
  if(!(response instanceof Response)||response.status>=300&&response.status<400)return deny(503);
  const out=new Headers(response.headers);for(const name of ['access-control-allow-origin','access-control-allow-credentials','set-cookie'])out.delete(name);out.set('cache-control','no-store');out.set('x-content-type-options','nosniff');
  return new Response(response.body,{status:response.status,headers:out});
 }catch{return deny(503)}
}};
export const sitesRelayTesting={providerPath,validRange};
