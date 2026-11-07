// Test-only webhook ingress building block. No default Worker entrypoint or
// route. The host must supply a private service binding and an edge limiter.
import {gatewayTesting} from './gateway.mjs';
const fail=status=>new Response('Unavailable',{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','content-type':'text/plain;charset=UTF-8'}});
const payId=id=>typeof id==='string'&&/^tr_[A-Za-z0-9]{6,80}$/.test(id);
async function deadline(promise,ms=10000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),ms)})])}finally{clearTimeout(timer)}}
export async function receiveTestWebhook(req,env){
 let url,expected;try{url=new URL(req.url);expected=new URL(env.RIG_WEBHOOK_URL)}catch{return fail(503)}
 if(url.pathname!=='/api/payments/webhook'||url.search||url.hash)return fail(404);
 if(req.method!=='POST')return fail(405);
 if(env.RIG_WEBHOOK_TEST_ENABLED!=='yes'||env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||
    env.MOLLIE_API_KEY||env.FAL_KEY||env.DB||typeof env.RIG_STAGING_SERVICE?.fetch!=='function'||
    typeof env.RIG_WEBHOOK_LIMITER?.limit!=='function'||expected.protocol!=='https:'||expected.username||expected.password||expected.search||expected.hash||expected.pathname!=='/api/payments/webhook'||url.href!==expected.href)return fail(503);
 if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return fail(400);
 const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>2048))return fail(413);
 // Deliberately global: do not trust a caller's user/IP headers. This alone is
 // not adequate DDoS protection; a trusted edge limiter is still required.
 try{const r=await deadline(env.RIG_WEBHOOK_LIMITER.limit({key:'rig-mollie-test-webhook'}));if(r?.success!==true)return fail(429)}catch{return fail(503)}
 let body,input;try{body=await gatewayTesting.bounded(req.body,2048,10000)}catch{return fail(413)}
 try{input=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{return fail(400)}
 const ids=input.getAll('id');if(ids.length!==1||!payId(ids[0])||[...input.keys()].some(k=>k!=='id'))return fail(400);
 // Construct a new request: no cookies, forwarded identity, marker or other
 // attacker-controlled headers are forwarded through the private binding.
 const upstream=new Request(expected.href,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:ids[0]}),signal:AbortSignal.timeout(10000)});
 try{
  const response=await deadline(env.RIG_STAGING_SERVICE.fetch(upstream));
  if(!(response instanceof Response))return fail(503);
  // Never reflect provider/private response bodies or headers to the caller.
  try{void response.body?.cancel().catch(()=>{})}catch{}
  if(response.status===200)return new Response('OK',{status:200,headers:{'cache-control':'no-store','content-type':'text/plain;charset=UTF-8','x-content-type-options':'nosniff'}});
  return fail(response.status===400?400:503);
 }catch{return fail(503)}
}
