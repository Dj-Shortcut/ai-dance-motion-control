// Public RIG entrypoint; private data is verified in the bound private Worker.
// Test-mode only, default disabled. The Mollie callback uses a separate ingress.
import frontend from './closed-ui-bundle.mjs';
const deny=(status=403)=>Response.json({error:status===401?'Meld je aan om verder te gaan.':'RIG is tijdelijk niet beschikbaar.'},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function authConfig(env){
 try{
  const project=new URL(env.SUPABASE_URL),origin=new URL(env.RIG_PUBLIC_ORIGIN);
  if(env.RIG_AUTH_CONFIG_ENABLED!=='yes'||env.RIG_GOOGLE_AUTH_READY!=='yes'||project.protocol!=='https:'||project.origin!==env.SUPABASE_URL
      ||!/^(?:[a-z0-9]{20})\.supabase\.co$/.test(project.hostname)||project.username||project.password
      ||origin.protocol!=='https:'||origin.origin!==env.RIG_PUBLIC_ORIGIN||origin.username||origin.password
      ||!/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(env.SUPABASE_PUBLISHABLE_KEY||''))return null;
  return {enabled:true,projectUrl:project.origin,publishableKey:env.SUPABASE_PUBLISHABLE_KEY,callbackUrl:`${origin.origin}/auth/callback`};
 }catch{return null;}
}
function uiHeaders(config,path){
 const type=path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8';
 return {'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',
  'content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'${config?` ${config.projectUrl}`:''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`};
}
function videoPath(path){return ['/api/video-config','/api/estimate/fal','/api/assets','/api/generation-quotes','/api/generations','/api/generations/recent','/api/sponsor-invitations/redeem','/api/sponsor-invitations/status'].includes(path)||/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(path)||/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(path);}
export default {async fetch(req,env){
 if(env?.RIG_CLOSED_INGRESS_ENABLED!=='yes'||env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'
    ||typeof env?.CLOSED_PRIVATE_SERVICE?.fetch!=='function'
    ||env?.MOLLIE_API_KEY||env?.FAL_KEY||env?.DB||env?.BUCKET)return deny();
 let url;try{url=new URL(req.url);const origin=new URL(env.RIG_PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==env.RIG_PUBLIC_ORIGIN||origin.username||origin.password||url.origin!==origin.origin)return deny();}catch{return deny();}
 const site=req.headers.get('sec-fetch-site');
 const documentPath=url.pathname==='/auth/callback'||(url.pathname==='/'&&(!url.search||url.search==='?payment=return'));
 const documentNavigation=documentPath&&req.method==='GET'&&site==='cross-site'
   &&req.headers.get('sec-fetch-mode')==='navigate'&&req.headers.get('sec-fetch-dest')==='document';
 if(site&&!['same-origin','none'].includes(site)&&!documentNavigation)return deny();
 const config=authConfig(env);
 if(url.pathname==='/api/auth-config'){
  if(req.method!=='GET'||url.search||url.hash)return deny(404);
  if(!config)return deny(503);
  return Response.json(config,{headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 }
 const asset=(url.pathname==='/'||url.pathname==='/auth/callback')?'/multiuser/index.html':url.pathname;
 if(Object.hasOwn(frontend,asset)){
  if(!['GET','HEAD'].includes(req.method))return deny(405);
  return new Response(req.method==='HEAD'?null:frontend[asset],{headers:uiHeaders(config,asset)});
 }
 const video=videoPath(url.pathname);
 if(!['GET','POST'].includes(req.method)||!video&&!['/api/session','/api/payments/packages','/api/payments/balance','/api/payments/create','/api/payments/orders'].includes(url.pathname)&&!/^\/api\/payments\/orders\/[A-Za-z0-9_-]{12,80}(?:\/reconcile)?$/.test(url.pathname))return deny(404);
 if(req.method==='POST'&&req.headers.get('origin')!==env.RIG_PUBLIC_ORIGIN)return deny();
 // Bound unauthenticated attempts before reaching the private verifier/D1.
 // The Cloudflare-provided address is used only as a rate-limit key. The
 // per-location limiter is an additional guard, not a worldwide spending cap.
 const ip=req.headers.get('cf-connecting-ip');
 if(typeof env.RIG_PUBLIC_LIMITER?.limit!=='function'||!ip||ip.length>45||!/^[0-9a-fA-F:.]+$/.test(ip))return deny(503);
 try{if((await env.RIG_PUBLIC_LIMITER.limit({key:ip}))?.success!==true)return deny(429)}catch{return deny(503)}
 if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.headers.get('authorization')||'')||(req.headers.get('authorization')||'').length>8199)return deny(401);
 const headers=new Headers(req.headers);for(const name of [...headers.keys()])if(name==='cookie'||name.startsWith('x-rig-gateway-')||name.startsWith('oai-authenticated-'))headers.delete(name);
 // Separate private service independently verifies the session and owner. It
 // holds fal/media credentials; the public Worker never receives them.
 if(video){if(typeof env.CLOSED_VIDEO_SERVICE?.fetch!=='function')return deny(503);return env.CLOSED_VIDEO_SERVICE.fetch(new Request(req,{headers}));}
 return env.CLOSED_PRIVATE_SERVICE.fetch(new Request(req,{headers}));
}};
