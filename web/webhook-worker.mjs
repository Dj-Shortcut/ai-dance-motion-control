// Public Mollie TEST callback relay. This Worker holds no Mollie credential.
// Deploy only with a service binding to the private, non-routable backend.
import {gatewayTesting} from './gateway.mjs';
const fail=(status)=>new Response('Unavailable',{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const paymentId=id=>typeof id==='string'&&/^tr_[A-Za-z0-9]{6,80}$/.test(id);
export default {
 async fetch(req,env){
  let u,expected;try{u=new URL(req.url);expected=new URL(env.RIG_WEBHOOK_URL)}catch{return fail(503)}
  if(u.pathname!=='/api/payments/webhook'||u.search||u.hash)return fail(404);
  if(req.method!=='POST')return fail(405);
  if(env.RIG_WEBHOOK_TEST_ENABLED!=='yes'||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||typeof env.RIG_STAGING_SERVICE?.fetch!=='function'||expected.protocol!=='https:'||expected.username||expected.password||expected.search||expected.hash||expected.pathname!=='/api/payments/webhook'||u.href!==expected.href)return fail(503);
  if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return fail(400);
  const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>2048))return fail(413);
  let body;try{body=await gatewayTesting.bounded(req.body,2048,10000)}catch{return fail(413)}
  let input;try{input=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{return fail(400)}
  const ids=input.getAll('id');if(ids.length!==1||!paymentId(ids[0])||[...input.keys()].some(k=>k!=='id'))return fail(400);
  // Copy no caller-controlled headers, cookies or identities. The backend
  // independently queries Mollie and atomically updates its test-only ledger.
  const upstream=new Request(expected.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:ids[0]})});
  try{
   const response=await env.RIG_STAGING_SERVICE.fetch(upstream);
   if(!(response instanceof Response)||response.status>=300&&response.status<400)return fail(503);
   return new Response(response.body,{status:response.status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','content-type':'text/plain;charset=UTF-8'}});
  }catch{return fail(503)}
 }
};
