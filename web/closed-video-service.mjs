// Closed, ledger-funded test composition. Not routed or deployed by this module.
// The caller must authenticate the subject and provide an actual shared media
// lease; client identity headers must never be passed as trustedUserId.
import {createAssets} from './assets.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {createResultStore} from './results.mjs';
import {privateResultFetch} from './upload.mjs';
import {createGenerationHandler} from './generation.mjs';
import {createRouter,d1Limit} from './router.mjs';
import {getFalPricePreflight} from './price-preflight.mjs';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';
import {r2InputsConfig} from './rig-r2-inputs.mjs';
const id=/^[A-Za-z0-9_-]{1,100}$/;
const version=/^[A-Za-z0-9_.-]{1,40}$/;
const integer=(s,max)=>typeof s==='string'&&/^[1-9][0-9]*$/.test(s)&&Number.isSafeInteger(+s)&&+s<=max;
const editEnabled=env=>env.RIG_EDIT_ENABLED==='yes'&&integer(env.RIG_PRICE_EDIT,250);
const unavailable=()=>Response.json({error:'Videogeneratie is nog niet beschikbaar.'},{status:503,headers:{'cache-control':'no-store'}});
function valid(env){
 try{return env.RIG_CLOSED_VIDEO_ENABLED==='yes'&&env.RIG_MODE==='test'&&env.RIG_MOLLIE_MODE==='test'&&new URL(env.RIG_PUBLIC_ORIGIN).origin===env.RIG_PUBLIC_ORIGIN&&env.RIG_PUBLIC_ORIGIN.startsWith('https://')&&typeof env.DB?.prepare==='function'&&typeof env.DB?.batch==='function'&&typeof env.RIG_MEDIA?.fetch==='function'&&typeof env.RIG_MEDIA_SECRET==='string'&&env.RIG_MEDIA_SECRET.length>=32&&typeof env.BUCKET?.get==='function'&&typeof env.BUCKET?.put==='function'&&typeof env.BUCKET?.head==='function'&&typeof env.FAL_KEY==='string'&&env.FAL_KEY.length>0&&env.FAL_KEY.length<1024&&!/[\r\n]/.test(env.FAL_KEY)&&integer(env.RIG_PRICE_STANDARD,250)&&integer(env.RIG_PRICE_PRO,250)&&version.test(env.RIG_PRICE_VERSION||'')&&integer(env.RIG_CLOSED_VIDEO_MAX_CENTS,800)&&integer(env.RIG_CLOSED_VIDEO_MAX_USD_MICROS,6000000)}catch{return false}
}
// Only provider hosts required by existing transfer/queue code. Redirects are
// never followed: particularly important for Authorization and signed URLs.
function providerTransport(fetcher){return async(input,init={})=>{const u=new URL(String(input));if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!['fal.ai','fal.run','fal.media'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d))||init.redirect!=='manual')throw Error('Untrusted provider endpoint');const r=await fetcher(input,init);if(r.status>=300&&r.status<400)throw Error('Provider redirect refused');return r;};}
function guard(env,priceFetch,{trustedUserId,accessMode}){return {
 limitMessage:accessMode==='sponsored'?'Je gratis testtegoed is hiervoor niet voldoende. Kies een kortere video of Standaard.':'Je beschikbare RIG-tegoed is hiervoor niet voldoende of je account wordt gecontroleerd.',
 async permits({durationSeconds,priceCents}){
  if(!Number.isFinite(durationSeconds)||durationSeconds<3||durationSeconds>30||!Number.isSafeInteger(priceCents)||priceCents<=0||priceCents>+env.RIG_CLOSED_VIDEO_MAX_CENTS)return false;
  if(accessMode!=='sponsored'){
   const row=await env.DB.prepare('SELECT COALESCE(SUM(delta),0) AS cents,NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS unfrozen FROM rig_ledger WHERE user_id=?').bind(trustedUserId,trustedUserId).first();
   return row?.unfrozen===1&&Number.isSafeInteger(row.cents)&&row.cents>=priceCents;
  }
  try{const state=await createSponsoredInvitationStore(env.DB).eligibility(trustedUserId);return state.state==='eligible'&&state.remainingCents>=priceCents}catch{return false}
 },
 async estimate(quality,durationSeconds){if(!(['standard','pro'].includes(quality)||(quality==='edit-standard'&&editEnabled(env)))||!Number.isFinite(durationSeconds)||durationSeconds<3||durationSeconds>(quality==='edit-standard'?15:30))throw Error('Invalid estimate');const p=await priceFetch(env.FAL_KEY),rate=p?.prices?.[quality];if(p?.currency!=='USD'||p?.unit!=='second'||!Number.isFinite(rate)||rate<=0)throw Error('Price unavailable');const n=Math.ceil(rate*1e6)*Math.ceil(durationSeconds);if(!Number.isSafeInteger(n)||n<=0||n>+env.RIG_CLOSED_VIDEO_MAX_USD_MICROS)throw Error('Test provider cap exceeded');return n;},
 async claimOnce({userId,jobId,quote}={}){
  if(userId!==trustedUserId||!quote||!Number.isSafeInteger(quote.priceCents)||quote.priceCents<=0)return false;
  if(accessMode==='sponsored'){
   if(env.RIG_SPONSORED_ENABLED!=='yes')return false;
   const reservation=await createSponsoredInvitationStore(env.DB).reserveForJob(userId,jobId);
   return reservation.state==='reserved'&&reservation.amountCents===quote.priceCents;
  }
  if(!id.test(jobId||'')||!id.test(quote.id||'')||quote.userId!==userId||typeof quote.model!=='string'||typeof quote.pricingVersion!=='string'||!Number.isFinite(quote.durationSeconds))return false;
  // Each explicitly confirmed owner request spends its existing ledger funds.
  // Historical global trial markers are deliberately irrelevant. This check
  // requires the exact reserved job; authorizeDispatch supplies the subsequent
  // atomic, one-time decision immediately before the provider queue request.
  const row=await env.DB.prepare(`SELECT 1 AS authorized FROM rig_generation_jobs j
   JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id
   WHERE j.id=? AND j.user_id=? AND q.id=? AND q.model=? AND q.price_cents=?
    AND q.price_cents=j.price_cents AND q.pricing_version=? AND q.duration_seconds=? AND q.expires_at>?
    AND j.state='submitting' AND j.fal_request_id IS NULL AND j.poll_token IS NULL
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=j.user_id)
    AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.order_id IS NULL AND l.delta=-j.price_cents)
    AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id IN ('release:'||j.id,'settle:'||j.id))
    AND COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=j.user_id),0)>=0
    AND NOT EXISTS(SELECT 1 FROM rig_generation_jobs active WHERE active.user_id=j.user_id AND active.id<>j.id AND active.state IN ('submitting','unknown','queued'))`)
   .bind(jobId,userId,quote.id,quote.model,quote.priceCents,quote.pricingVersion,quote.durationSeconds,Date.now()).first();
  return row?.authorized===1;
 }
};}
// lease.acquire/complete must be durable, shared and never expire automatically.
// No secrets or mock provider are created here; the host supplies dependencies.
export async function createClosedVideoService(env,{trustedUserId,lease,verifyTenant,providerFetch=fetch,gatewayFetch=fetch,priceFetch,accessMode='owner'}={}){
 if(!valid(env)||!id.test(trustedUserId||'')||!['owner','sponsored'].includes(accessMode)||(accessMode==='sponsored'&&env.RIG_SPONSORED_ENABLED!=='yes')||typeof lease?.acquire!=='function'||typeof lease?.complete!=='function'||typeof verifyTenant!=='function'||typeof providerFetch!=='function'||(priceFetch!==undefined&&typeof priceFetch!=='function'))return unavailable;
 try{const state=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();if(state?.mode!=='test')return unavailable;}catch{return unavailable;}
 const r2Inputs=env.RIG_R2_INPUTS_ENABLED==='yes'?r2InputsConfig(env):null;
 if(env.RIG_R2_INPUTS_ENABLED==='yes'&&!r2Inputs)return unavailable;
 const inlineO3Owner=env.RIG_O3_INLINE_INPUTS_ENABLED==='yes'&&accessMode==='owner'&&trustedUserId===env.RIG_VIDEO_OWNER_USER_ID?trustedUserId:undefined;
 const transport=providerTransport(providerFetch), currentPrice=priceFetch||((key)=>getFalPricePreflight(key,transport,{includeEdit:editEnabled(env)}));
 const makeAssets=()=>createAssets({mode:'test',origin:env.RIG_PUBLIC_ORIGIN,media:env.RIG_MEDIA,mediaSecret:env.RIG_MEDIA_SECRET,falKey:env.FAL_KEY,providerFetch:transport,gatewayOrigin:env.RIG_SITES_BRIDGE_ORIGIN,gatewayFetch,r2Inputs,inlineO3Owner,authenticate:async()=>({id:trustedUserId}),limit:async(user,scope)=>d1Limit({env,category:'asset',userId:user,method:scope==='asset-read'?'GET':'POST'})});
 const router=createRouter({identity:async()=>trustedUserId,limit:d1Limit,makeAssets:async()=>makeAssets(),makeGenerationServices:async()=>{
  const stores=createD1GenerationStores(env.DB,{mode:'test',dispatchMode:accessMode});
  if(accessMode==='sponsored'){
   const baseProvider=stores.jobs.markProviderFailed;
   const baseConfirm=stores.jobs.confirmInputFailureRefund;
   stores.jobs.confirmInputFailureRefund=async(user,job,falRequestId)=>{
    if(!await baseConfirm(user,job,falRequestId))return false;
    return (await createSponsoredInvitationStore(env.DB).releaseInputFailure(user,job,falRequestId)).state==='released';
   };
   stores.jobs.markProviderFailed=async(user,job,falRequestId,token,reason)=>{
    const result=await baseProvider(user,job,falRequestId,token,reason);
    if(['provider_input_unavailable','provider_subject_not_detected'].includes(reason)&&!await stores.jobs.confirmInputFailureRefund(user,job,falRequestId))throw Error('Sponsor refund requires review');
    return result;
   };
   const base=stores.jobs.markPreparationFailed;
   stores.jobs.markPreparationFailed=async(user,job)=>{
    const result=await base(user,job);
    const released=await createSponsoredInvitationStore(env.DB).releasePreparationFailure(user,job);
    if(released.state!=='released'){
     // Failure before claim has no sponsor reservation to release. If a row
     // exists but could not be safely released, require manual reconciliation.
     const row=await env.DB.prepare('SELECT 1 AS found FROM rig_sponsored_reservations WHERE job_id=? AND user_id=?').bind(job,user).first();
     if(row)throw Error('Sponsor refund requires review');
    }
    return result;
   };
  }
  return {...stores,inputGatewayOrigin:env.RIG_SITES_BRIDGE_ORIGIN,inputR2Config:r2Inputs,inlineO3Owner,assets:makeAssets(),results:createResultStore(env.BUCKET,privateResultFetch(env.FAL_KEY,transport)),falKey:env.FAL_KEY,pricing:{standard:+env.RIG_PRICE_STANDARD,pro:+env.RIG_PRICE_PRO,...(editEnabled(env)?{editStandard:+env.RIG_PRICE_EDIT}:{}),version:env.RIG_PRICE_VERSION},trialGuard:guard(env,currentPrice,{trustedUserId,accessMode})};
 },generationFactory:s=>createGenerationHandler(s,transport)});
 return async req=>{
  const p=new URL(req.url).pathname;
  if(!['/api/assets','/api/generation-quotes','/api/generations','/api/generations/recent'].includes(p)&&!/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(p)&&!/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(p))return new Response(null,{status:404});
  try{if(await verifyTenant(env)!==true)return unavailable();}catch{return unavailable()}
  // Only asset preparation starts a remote transform. Status, recovery, result
  // reads and generation use their own D1 idempotency/uncertainty state and
  // must remain available even when this transform lock needs review.
  if(p!=='/api/assets'||req.method!=='POST'){try{return await router(req,env)}catch{return unavailable()}}
  let claim;try{claim=await lease.acquire(trustedUserId)}catch{return unavailable()}
  if(claim?.state!=='acquired'||typeof claim.token!=='string')return unavailable();
  let response,outcome='uncertain';
  try{
   response=await router(req,env);if(!(response instanceof Response))throw Error('No result');
   const uncertain=response.headers.get('x-rig-media-uncertain')==='1';
   const settled=response.status<500||response.headers.get('x-rig-media-settled')==='1';
   if(!uncertain&&settled)outcome='settled';
  }catch{response=unavailable()}
  try{await lease.complete(claim.token,outcome)}catch{return unavailable()}
  const headers=new Headers(response.headers);headers.delete('x-rig-media-settled');headers.delete('x-rig-media-uncertain');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 };
}
export const closedVideoTesting={valid,providerTransport,guard};
