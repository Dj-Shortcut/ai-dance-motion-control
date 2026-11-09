// Runs exclusively inside the existing private worker. Production and test
// identities, nonces and money remain in different physical D1 databases.
import {authenticateProductionSites} from './production-bridge-auth.mjs';
import {createProductionPayment} from './production-payment.mjs';
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createProductionVideoService} from './production-video-service.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import {createChatgptApprovals} from './rig-chatgpt-approvals.mjs';
import {handleProviderInput} from './rig-provider-inputs.mjs';
import {d1Limit} from './router.mjs';
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const unavailable=()=>json({error:'RIG-tegoed is tijdelijk niet beschikbaar.'},503);
async function readJSON(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0;const parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192)return null;parts.push(value)}const bytes=new Uint8Array(size);let i=0;for(const p of parts){bytes.set(p,i);i+=p.length}const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return data&&typeof data==='object'&&!Array.isArray(data)?data:null}catch{return null}finally{void reader.cancel().catch(()=>{})}
}
export function createProductionCommerceWorker({network=fetch,videoFactory=createProductionVideoService}={}){
 const payments=createProductionPayment({transport:network});
 return {async fetch(req,env){
  let authenticated;
  try{
   if(req.url===env.RIG_PRODUCTION_WEBHOOK_URL)return payments.webhook(req,env);
   const context=await createProductionGenerationContext(env);if(!context)return unavailable();
   const mapped={...context.env,RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN},u=new URL(req.url);
   if(u.pathname.startsWith('/provider-inputs/'))return handleProviderInput(req,mapped,{productionContext:context,verifyTenant:async()=>Boolean(await createProductionGenerationContext(env))});
   const leaseFactory=db=>createDurableMediaLease(db,{mode:'live',productionContext:context});
   authenticated=await authenticateProductionSites(req,env,{allowGeneration:true,leaseFactory});
   if(!authenticated)return json({error:'Meld je aan bij RIG.'},401);
   const {userId}=authenticated;
   if(u.pathname==='/api/session'||u.pathname.startsWith('/api/payments/'))return payments.user(authenticated.request,env,userId);
   const approvals=createChatgptApprovals(mapped.DB,{mode:'live',productionContext:context});
   const issue=u.pathname==='/api/chatgpt/quote-approvals',consume=u.pathname==='/api/chatgpt/quote-approvals/consume';
   if(issue||consume){
    if(req.method!=='POST'||u.search)return json({error:'Aanvraag geweigerd.'},400);
    if(await d1Limit({env:mapped,category:'generation',userId,method:'POST'})!==true)return json({error:'Te veel aanvragen.'},429);
    const data=await readJSON(authenticated.request),keys=issue?['quoteId']:['quoteId','approvalToken'];
    if(!data||Object.keys(data).length!==keys.length||keys.some(k=>typeof data[k]!=='string'))return json({error:'Controleer je aanvraag.'},400);
    const result=issue?await approvals.issue(userId,data):await approvals.consume(userId,data);
    return result?json(result,issue?201:200):json({error:'Deze prijsbevestiging is niet beschikbaar of verlopen.'},409);
   }
   if(u.pathname==='/api/generations'&&req.method==='POST'){
    const data=await readJSON(authenticated.request),required=['quoteId','idempotencyKey','approvalToken'];
    if(!data||required.some(k=>typeof data[k]!=='string')||Object.keys(data).some(k=>!required.includes(k)&&k!=='transferConsent')||Object.hasOwn(data,'transferConsent')&&data.transferConsent!=='fal-temporary-links-v1')return json({error:'Bevestig eerst de prijs.'},403);
    const approval=await approvals.consume(userId,data);if(!approval||approval.idempotencyKey!==data.idempotencyKey)return json({error:'Bevestig eerst de prijs.'},403);
    authenticated.request=new Request(authenticated.request.url,{method:'POST',headers:authenticated.request.headers,body:JSON.stringify({quoteId:data.quoteId,idempotencyKey:data.idempotencyKey,...(data.transferConsent?{transferConsent:data.transferConsent}:{})})});
   }
   const handler=await videoFactory(env,{trustedUserId:userId,productionContext:context,lease:authenticated.lease??leaseFactory(mapped.DB),providerFetch:network,gatewayFetch:network});
   return await handler(authenticated.request);
  }catch{return unavailable()}
  finally{try{await authenticated?.releaseUnused?.()}catch{}}
 }};
}
