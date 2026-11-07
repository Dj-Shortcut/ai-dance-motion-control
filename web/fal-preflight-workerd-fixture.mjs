import ingress from './access-ingress.mjs';
import stage from './staging.mjs';
const aud='audience-0123456789', email='owner@example.com', origin='https://owner.example';
const DB={prepare(){return {bind(){return {async first(){return {requests:1}},async run(){return {meta:{changes:1}}}}}}}};
const shared={DB,RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:origin,RIG_STAGING_OWNER:'owner01',RIG_GATEWAY_KEY:'ab'.repeat(32)};
const backend={...shared,RIG_GATEWAY_CONFIGURED:'yes',MOLLIE_API_KEY:'test_abc',RIG_FAL_PRICE_PREFLIGHT_ENABLED:'yes',FAL_KEY:'fake-key'};
const env={...shared,RIG_ACCESS_INGRESS_ENABLED:'yes',RIG_ACCESS_AUD:aud,RIG_ACCESS_OWNER_EMAIL:email,RIG_STAGING_SERVICE:{fetch:req=>stage.fetch(req,backend)}};
const ctx={access:{aud,getIdentity:async()=>({email})}};
export default {async fetch(req){
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  const wire=new Request(url,options);
  if(wire.redirect!=='manual'||wire.method!=='GET'||new URL(url).origin!=='https://api.fal.ai')throw Error('unsafe');
  const endpoint=new URL(url).searchParams.get('endpoint_id');
  return Response.json({prices:[{endpoint_id:endpoint,unit_price:.126,unit:'seconds',currency:'USD'}]});
 };
 try{return await ingress.fetch(req,env,ctx)}finally{globalThis.fetch=original}
}};
