// Owner-only Cloudflare Access staging entrypoint. This Worker must be invoked
// directly by Access, with no Static Assets router. It serves only bundled UI
// files and never exposes a webhook. Defaults closed.
import { createSitesSigner } from './sites-signer.mjs';
import { d1Limit } from './router.mjs';
import frontend from './frontend-bundle.mjs';
import {handlePriceEstimate} from './price-estimate.mjs';
const deny=(status=403)=>Response.json({error:'Geen toegang tot de testomgeving.'},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
// Ingress and private backend share D1. Keep their buckets separate: otherwise
// every allowed request counts twice against the same downstream limit.
const signer=createSitesSigner({allowMedia:async({env,user,path})=>user===env.RIG_STAGING_OWNER&&((path==='/api/media/test'&&env.RIG_OWNER_MEDIA_TEST_ENABLED==='yes')||(path==='/api/assets'&&env.RIG_OWNER_ASSETS_ENABLED==='yes')),limit:({env,user,path,method})=>d1Limit({env,category:path.startsWith('/api/payments/')?'payment':'generation',userId:`ingress:${user}`,method})});
export default {
 async fetch(req,env,ctx){
  if(env.RIG_ACCESS_INGRESS_ENABLED!=='yes'||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||typeof env.RIG_ACCESS_AUD!=='string'||env.RIG_ACCESS_AUD.length<16||typeof env.RIG_ACCESS_OWNER_EMAIL!=='string'||!env.RIG_ACCESS_OWNER_EMAIL||!ctx?.access||ctx.access.aud!==env.RIG_ACCESS_AUD||typeof ctx.access.getIdentity!=='function')return deny();
  let identity;try{identity=await ctx.access.getIdentity()}catch{return deny()}
  if(typeof identity?.email!=='string'||identity.email.toLowerCase()!==env.RIG_ACCESS_OWNER_EMAIL.toLowerCase())return deny();
  let url;try{url=new URL(req.url);if(url.origin!==env.RIG_PUBLIC_ORIGIN)return deny()}catch{return deny()}
  if(url.pathname==='/api/fal/preflight'){
   // This checks provider prices only. It does not upload media or submit a
   // generation. No client may choose a provider URL, model, or secret.
   if(req.method!=='GET'||url.search||url.hash)return deny(404);
   const site=req.headers.get('sec-fetch-site');if(site&&!['same-origin','none'].includes(site))return deny();

  }
  // A non-binding provider estimate is available only after the direct Access
  // owner and origin checks above. It cannot reserve or deduct customer credit.
  if(url.pathname==='/api/estimate/fal'){
   try{
    if(await d1Limit({env,category:'generation',userId:`estimate:${env.RIG_STAGING_OWNER}`,method:req.method})!==true)return Response.json({error:'Te veel aanvragen. Probeer later opnieuw.'},{status:429,headers:{'cache-control':'no-store'}});
   }catch{return deny(503)}
   return handlePriceEstimate(req,env);
  }
  const asset=url.pathname==='/'?'/index.html':url.pathname;
  if(Object.hasOwn(frontend,asset)){
   if(!['GET','HEAD'].includes(req.method))return deny(405);
   const type=asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8';
   return new Response(req.method==='HEAD'?null:frontend[asset],{headers:{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}});
  }
  // Never use incoming identity headers. Assign the configured internal owner
  // only after direct Access context and owner identity have both been checked.
  const headers=new Headers(req.headers);headers.delete('oai-authenticated-user-id');headers.delete('oai-authenticated-user-email');headers.set('oai-authenticated-user-id',env.RIG_STAGING_OWNER||'');
  const clean=new Request(req,{headers});
  return signer(clean,{...env,RIG_SITES_VERIFIED_PRIVATE_INGRESS:'yes'});
 }
};
