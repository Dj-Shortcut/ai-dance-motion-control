import {createSupabaseIdentity} from './supabase-identity.mjs';
import {preAuthLimit} from './preauth-limit.mjs';
import {closedPaymentWithFetch} from './closed-test-payment.mjs';

// No entrypoint and no default network transport: the caller must supply two
// reviewed transports. The existing owner Worker is deliberately not modified.
// Test-only; private-only is an operator assertion, NOT proof of routing.
const fail=()=>Response.json({error:'Afgeschermde test niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store'}});
const reject=()=>Response.json({error:'Aanmelden vereist.'},{status:401,headers:{'cache-control':'no-store'}});
class PreDispatchFailure extends Error {}
function origin(url){try{const u=new URL(url);return u.protocol==='https:'&&u.origin===url&&!u.username&&!u.password?u.origin:null}catch{return null}}
function hook(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/api/payments/webhook'?u.href:null}catch{return null}}
async function identityConfigured(env){
 if(env?.RIG_CLOSED_TEST_ENABLED!=='yes'||env?.RIG_PRIVATE_SERVICE_ONLY!=='yes'||env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'
    ||(env?.MOLLIE_API_KEY&&!/^test_[A-Za-z0-9]+$/.test(env.MOLLIE_API_KEY))
    ||!/^[a-zA-Z0-9_-]{8,80}$/.test(env?.RIG_TEST_ENVIRONMENT_ID||'')||!origin(env?.RIG_PUBLIC_ORIGIN)
    ||typeof env?.SUPABASE_URL!=='string'||!/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(env?.SUPABASE_PUBLISHABLE_KEY||'')
    ||!env?.DB||env?.FAL_KEY||env?.RIG_MEDIA||env?.BUCKET||env?.RIG_STAGING_OWNER)return false;
 try{
  const row=await env.DB.prepare('SELECT * FROM rig_closed_test_tenant WHERE id=1').first();
  const mode=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  return row?.mode==='test'&&mode?.mode==='test'&&row.environment_id===env.RIG_TEST_ENVIRONMENT_ID
    &&row.public_origin===env.RIG_PUBLIC_ORIGIN&&row.identity_project===env.SUPABASE_URL;
 }catch{return false;}
}
async function paymentConfigured(env){
 if(!await identityConfigured(env)||!/^test_[A-Za-z0-9]+$/.test(env?.MOLLIE_API_KEY||'')||
    !/^pfl_[A-Za-z0-9]+$/.test(env?.RIG_MOLLIE_PROFILE_ID||'')||!hook(env?.RIG_WEBHOOK_URL))return false;
 try{const row=await env.DB.prepare('SELECT mollie_profile,webhook_url FROM rig_closed_test_tenant WHERE id=1').first();
  return row?.mollie_profile===env.RIG_MOLLIE_PROFILE_ID&&row?.webhook_url===env.RIG_WEBHOOK_URL;
 }catch{return false;}
}
async function limitedJson(res){
 const reader=res.body?.getReader();if(!reader)throw Error('No provider body');let size=0,parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144)throw Error('Provider body too large');parts.push(value);}}
 catch(e){void reader.cancel().catch(()=>{});throw e;}
 const all=new Uint8Array(size);let offset=0;for(const p of parts){all.set(p,offset);offset+=p.byteLength;}
 return {bytes:all,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all))};
}
function provider(env,transport){
 return async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method||'GET').toUpperCase(),headers=new Headers(init.headers);
  const basic=url.origin==='https://api.mollie.com'&&!url.username&&!url.password&&!url.hash;
  const payment=url.pathname==='/v2/payments'&&method==='POST'&&!url.search;
  const lookup=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}$/.test(url.pathname)&&method==='GET'&&!url.search;
  const reversals=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}\/(?:refunds|chargebacks)$/.test(url.pathname)&&method==='GET'&&url.search==='?limit=1';
  if(!basic||!(payment||lookup||reversals)||init.redirect!=='manual'||headers.get('authorization')!==`Bearer ${env.MOLLIE_API_KEY}`)throw Error('Unexpected provider request');
  // Verify the profile *before* every operation, including payment creation.
  try{
   const pre=await transport('https://api.mollie.com/v2/profiles/me',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${env.MOLLIE_API_KEY}`,accept:'application/json'}});
   if(!pre.ok)throw Error('Profile unavailable');const profile=await limitedJson(pre);if(profile.value?.id!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong profile');
  }catch{if(payment)throw new PreDispatchFailure('Profile check failed before dispatch');throw Error('Profile unavailable');}
  const res=await transport(url.href,{...init,redirect:'manual'});
  if(res.status>=300&&res.status<400)throw Error('Provider redirect refused');
  if(!res.ok||reversals)return res;
  const body=await limitedJson(res);
  if(body.value?.mode!=='test'||body.value?.profileId!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong payment profile or mode');
  return new Response(body.bytes,{status:res.status,statusText:res.statusText,headers:res.headers});
 };
}
export function createClosedTestService({identityTransport,mollieTransport}={}){
 if(typeof identityTransport!=='function'||typeof mollieTransport!=='function')throw Error('Explicit transports required');
 async function payment(req,env,user){return closedPaymentWithFetch(provider(env,mollieTransport),PreDispatchFailure)(req,env,user);}
 // One server-side verifier for identity; no request header supplies the
 // trusted RIG user. The result is internal and is never an HTTP response.
 async function verifyAuth(req,env){
  if(!await identityConfigured(env))return {response:fail()};
  let u;try{u=new URL(req.url)}catch{return {response:fail()}}
  if(u.origin!==env.RIG_PUBLIC_ORIGIN||!['GET','POST'].includes(req.method))return {response:new Response(null,{status:404})};
  if(req.method==='POST'&&req.headers.get('origin')!==env.RIG_PUBLIC_ORIGIN)return {response:new Response(null,{status:403})};
  const token=req.headers.get('authorization')||'';
  if(token.length>8200||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))return {response:reject()};
  try{if(!await preAuthLimit(env.DB))return {response:Response.json({error:'Te veel aanvragen.'},{status:429})}}catch{return {response:fail()}}
  let user;try{const verify=createSupabaseIdentity({projectUrl:env.SUPABASE_URL,publishableKey:env.SUPABASE_PUBLISHABLE_KEY,fetcher:identityTransport});user=await verify(req,env);}catch{return {response:fail()}}
  return user?{user}:{response:reject()};
 }
 return {
  verifyAuth,
  // User traffic: never exposes the Mollie callback endpoint.
  async user(req,env){
   const u=new URL(req.url);
   if(u.pathname==='/api/payments/webhook'||(u.pathname!=='/api/session'&&!u.pathname.startsWith('/api/payments/')))return new Response(null,{status:404});
   if(u.pathname==='/api/session'&&req.method!=='GET')return new Response(null,{status:405});
   // Reading the verified owner's ledger is independent of Mollie setup. It
   // does not create a payment, change a balance or trust an identity header.
   const readBalance=u.pathname==='/api/payments/balance'&&req.method==='GET';
   if(u.pathname.startsWith('/api/payments/')&&!readBalance&&!await paymentConfigured(env))return fail();
   const verified=await verifyAuth(req,env);if(verified.response)return verified.response;const user=verified.user;
   if(u.pathname==='/api/session')return Response.json({userId:user},{headers:{'cache-control':'no-store'}});
   if(readBalance){
    try{const row=await env.DB.prepare('SELECT COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0) AS balance, EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen').bind(user,user).first();
     if(!row||!Number.isSafeInteger(row.balance)||![0,1].includes(row.frozen))return fail();
     return Response.json({balance:row.balance,frozen:row.frozen},{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    }catch{return fail();}
   }
   const headers=new Headers(req.headers);for(const k of [...headers.keys()])if(k==='authorization'||k==='cookie'||k.startsWith('oai-authenticated-')||k.startsWith('x-rig-gateway-'))headers.delete(k);
   try{return await payment(new Request(req,{headers}),env,user)||new Response(null,{status:404});}catch{return fail();}
  },
  // PRIVATE SERVICE ONLY: no header or caller-supplied flag can prove this.
  // Deploying a separate protected callback ingress requires further review.
  async webhook(req,env){
   if(!await paymentConfigured(env))return fail();if(req.url!==env.RIG_WEBHOOK_URL||req.method!=='POST')return new Response(null,{status:404});
   try{return await payment(req,env,null)||new Response(null,{status:404});}catch{return fail();}
  },
 };
}
