// PRIVATE candidate: its caller MUST verify Sites HMAC and per-user identity,
// and webhook calls MUST arrive through a distinct verified private binding.
// This module has no standalone network entrypoint.
import {closedPaymentWithFetch} from './closed-test-payment.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail=()=>Response.json({error:'Betalen is tijdelijk niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
class PreDispatchFailure extends Error {}
async function jsonBounded(res){
 if(!res.body)throw Error('Empty response');const r=res.body.getReader(),parts=[];let n=0;
 try{for(;;){const {done,value}=await r.read();if(done)break;n+=value.length;if(n>262144)throw Error('Large response');parts.push(value)}}finally{try{await r.cancel()}catch{}}
 const bytes=new Uint8Array(n);let p=0;for(const part of parts){bytes.set(part,p);p+=part.length}return {bytes,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}
function provider(env,transport){
 return async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method||'GET').toUpperCase(),headers=new Headers(init.headers);
  const post=url.pathname==='/v2/payments'&&method==='POST'&&!url.search;
  const read=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}$/.test(url.pathname)&&method==='GET'&&!url.search;
  const reversal=/^\/v2\/payments\/tr_[A-Za-z0-9]{6,80}\/(?:refunds|chargebacks)$/.test(url.pathname)&&method==='GET'&&url.search==='?limit=1';
  if(url.origin!=='https://api.mollie.com'||url.username||url.password||url.hash||!(post||read||reversal)||init.redirect!=='manual'||headers.get('authorization')!==`Bearer ${env.MOLLIE_API_KEY}`||post&&!/^[a-f0-9-]{36}$/.test(headers.get('Idempotency-Key')||''))throw Error('Invalid provider request');
  try{
   const profile=await transport('https://api.mollie.com/v2/profiles/me',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${env.MOLLIE_API_KEY}`,accept:'application/json'}});
   if(!profile.ok||profile.status>=300&&profile.status<400||(await jsonBounded(profile)).value?.id!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong profile');
  }catch{if(post)throw new PreDispatchFailure('Profile check failed before dispatch');throw Error('Profile unavailable')}
  const result=await transport(url.href,{...init,redirect:'manual'});
  if(result.status>=300&&result.status<400)throw Error('Redirect refused');
  if(!result.ok||reversal)return result;
  const body=await jsonBounded(result);
  if(body.value?.mode!=='live'||body.value?.profileId!==env.RIG_MOLLIE_PROFILE_ID)throw Error('Wrong payment profile or mode');
  return new Response(body.bytes,{status:result.status,statusText:result.statusText,headers:result.headers});
 };
}
export function createProductionPayment({transport}={}){
 if(typeof transport!=='function')throw Error('Explicit transport required');
 return {
  // trustedUserId must be from the authenticated Sites bridge, not from an HTTP header.
  async user(req,env,trustedUserId){
   const mapped=await validateProductionTenant(env);if(!mapped||!USER.test(trustedUserId||''))return fail();
   const url=new URL(req.url);if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||url.pathname==='/api/payments/webhook'||!url.pathname.startsWith('/api/payments/'))return new Response(null,{status:404});
   if(!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return new Response(null,{status:403});
   try{
    if(await d1Limit({env:mapped,category:'payment',userId:trustedUserId,method:req.method})!==true)return Response.json({error:'Te veel aanvragen.'},{status:429});
    return await closedPaymentWithFetch(provider(mapped,transport),PreDispatchFailure,{allowLive:true})(req,mapped,trustedUserId)||new Response(null,{status:404});
   }catch{return fail()}
  },
  async webhook(req,env){
   const mapped=await validateProductionTenant(env);if(!mapped)return fail();
   if(req.method!=='POST'||req.url!==mapped.RIG_WEBHOOK_URL)return new Response(null,{status:404});
   try{return await closedPaymentWithFetch(provider(mapped,transport),PreDispatchFailure,{allowLive:true})(req,mapped,null)||new Response(null,{status:404});}catch{return fail()}
  }
 };
}
export const productionPaymentTesting={provider,PreDispatchFailure};
