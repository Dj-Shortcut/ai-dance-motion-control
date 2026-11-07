import {createClosedTestService} from './closed-test-service.mjs';
import {createProductionPayment} from './production-payment.mjs';
import {authenticateProductionSites} from './production-bridge-auth.mjs';

// Test payments + Supabase only. No Worker routes/hostname, no fal. Both
// provider transports reject redirects and every unexpected destination.
export function createClosedPrivateWorker({network=fetch}={}){
 return {async fetch(req,env){
  if(typeof network!=='function')return new Response(null,{status:503});
  const pathname=new URL(req.url).pathname;
  const identityTransport=async(input,init={})=>{
   const target=new URL(input instanceof Request?input.url:String(input));
   if(target.origin!==env.SUPABASE_URL||target.pathname!=='/auth/v1/user'||target.search||target.hash||(init.method||'GET').toUpperCase()!=='GET')throw Error('Unexpected identity destination');
   const response=await network(target.href,{...init,redirect:'manual'});
   if(response.status>=300&&response.status<400)throw Error('Redirect refused');return response;
  };
  const mollieTransport=async(input,init={})=>{
   const target=new URL(input instanceof Request?input.url:String(input));
   if(target.origin!=='https://api.mollie.com'||target.username||target.password||target.hash||!target.pathname.startsWith('/v2/'))throw Error('Unexpected payment destination');
   const response=await network(target.href,{...init,redirect:'manual'});
   if(response.status>=300&&response.status<400)throw Error('Redirect refused');return response;
  };
  // Separate branch: only exact production relay origin is eligible for live
  // credentials and D1; the legacy test branch remains unchanged.
  const u=new URL(req.url);
  if(u.origin===env.RIG_PRODUCTION_BRIDGE_ORIGIN || req.url===env.RIG_PRODUCTION_WEBHOOK_URL){
   const production=createProductionPayment({transport:mollieTransport});
   if(req.url===env.RIG_PRODUCTION_WEBHOOK_URL)return production.webhook(req,env);
   const authenticated=await authenticateProductionSites(req,env);
   if(!authenticated)return Response.json({error:'Aanmelden vereist.'},{status:401,headers:{'cache-control':'no-store'}});
   return production.user(authenticated.request,env,authenticated.userId);
  }
  const service=createClosedTestService({identityTransport,mollieTransport});
  // This Worker must have no public route. The webhook path is reached only
  // through the separately rate-limited relay's private service binding.
  return pathname==='/api/payments/webhook'?service.webhook(req,env):service.user(req,env);
 }};
}
export default {fetch(req,env){return createClosedPrivateWorker().fetch(req,env)}};
