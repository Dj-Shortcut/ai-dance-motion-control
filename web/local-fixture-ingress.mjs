// Local workerd fixture only; no route or deploy configuration is provided.
const fail=()=>Response.json({error:'Proefomgeving niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store'}});
export default {async fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes'||env.RIG_PUBLIC_ORIGIN!=='https://rig.local'||typeof env.PRIVATE_ROUTER?.fetch!=='function'
    ||env.FAL_KEY||env.MOLLIE_API_KEY||env.BUCKET||env.RIG_STAGING_OWNER)return fail();
 const u=new URL(req.url);if(u.origin!=='https://rig.local'||!['GET','POST'].includes(req.method))return new Response(null,{status:404});
 if(!['/api/session','/api/payments/balance','/api/assets','/api/generation-quotes','/api/generations','/api/generations/recent'].includes(u.pathname)&&!/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(u.pathname))return new Response(null,{status:404});
 const h=new Headers(req.headers);for(const k of [...h.keys()])if(k==='cookie'||k.startsWith('oai-authenticated-')||k.startsWith('x-rig-gateway-'))h.delete(k);
 return env.PRIVATE_ROUTER.fetch(new Request(req,{headers:h}));
}};
