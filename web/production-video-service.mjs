// Private composition only. The caller must authenticate the signed production
// Sites subject once and pass its production-owned UUID and reconstructed request.
import {createProductionGenerationContext,isProductionGenerationContext,productionFundingKind} from './production-generation-context.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {createClosedVideoService,closedVideoTesting} from './closed-video-service.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import {getFalPricePreflight,recastPricePerSecond} from './price-preflight.mjs';
import {RECAST_QUALITY,RECAST_MIN_DURATION,RECAST_MAX_DURATION} from './recast-contract.mjs';
import {d1Limit} from './router.mjs';
import {loadProfitPolicy,retailPriceCents,createProfitSnapshot,profitable} from './profit-policy.mjs';
import {createPreparationBudget,consumePreparationReservation,preparationRequestBytes,preparationDeniedResponse} from './preparation-budget.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const unavailable=()=>reply({error:'Videogeneratie is tijdelijk niet beschikbaar.'},503);
const editEnabled=env=>env.RIG_EDIT_ENABLED==='yes'&&/^[1-9][0-9]*$/.test(env.RIG_PRICE_EDIT||'')&&Number.isSafeInteger(+env.RIG_PRICE_EDIT)&&+env.RIG_PRICE_EDIT<=250;
const recastEnabled=env=>env.RIG_OWNER_RECAST_VALIDATION_ENABLED==='yes'&&typeof env.RIG_PRICE_RECAST==='string'&&/^[1-9][0-9]*$/.test(env.RIG_PRICE_RECAST)&&Number.isSafeInteger(+env.RIG_PRICE_RECAST)&&+env.RIG_PRICE_RECAST<=250;

export async function createProductionVideoService(env,{trustedUserId,lease,providerFetch=fetch,gatewayFetch=fetch,priceFetch,productionContext,preparationReservation}={}){
 const context=productionContext??await createProductionGenerationContext(env);
 if(!USER.test(trustedUserId||'')||!isProductionGenerationContext(context,{db:env.PRODUCTION_DB})||context.env.PRODUCTION_DB!==env.PRODUCTION_DB)return unavailable;
 const funding=productionFundingKind(context,trustedUserId);
 // A private validation switch may enable Edit only for the existing pinned
 // production owner. The immutable production capability and direct-provider
 // funding must agree with the current server pin; request data cannot opt in.
 // This changes model availability only, never price/transfer/passkey consent.
 const ownerEditValidation=funding==='owner-provider'&&trustedUserId===env.RIG_PRODUCTION_OWNER_USER_ID&&env.RIG_OWNER_EDIT_VALIDATION_ENABLED==='yes'&&context.env.RIG_OWNER_EDIT_VALIDATION_ENABLED==='yes';
 const ownerRecastValidation=funding==='owner-provider'&&trustedUserId===env.RIG_PRODUCTION_OWNER_USER_ID&&env.RIG_OWNER_RECAST_VALIDATION_ENABLED==='yes'&&context.env.RIG_OWNER_RECAST_VALIDATION_ENABLED==='yes';
 const publicEditEnabled=env.RIG_EDIT_ENABLED==='yes'&&context.env.RIG_EDIT_ENABLED==='yes';
 const mapped={...context.env,RIG_EDIT_ENABLED:publicEditEnabled||ownerEditValidation?'yes':'no',RIG_OWNER_RECAST_VALIDATION_ENABLED:ownerRecastValidation?'yes':'no',RIG_SITES_BRIDGE_ORIGIN:env.RIG_PRODUCTION_BRIDGE_ORIGIN,RIG_R2_INPUTS_ENABLED:'no',RIG_O3_INLINE_INPUTS_ENABLED:'no'};
 const verifyTenant=async()=>{
  const current=await validateProductionTenant(env);
  return env.RIG_PRODUCTION_VIDEO_ENABLED==='yes'&&current?.DB===mapped.DB&&current.RIG_PUBLIC_ORIGIN===mapped.RIG_PUBLIC_ORIGIN;
 };
 if(!closedVideoTesting.valid(mapped,{productionContext:context}))return unavailable;
 const sharedLease=lease??createDurableMediaLease(mapped.DB,{mode:'live',productionContext:context});
 const currentPrice=priceFetch??((key,quality)=>getFalPricePreflight(key,closedVideoTesting.providerTransport(providerFetch),{includeEdit:editEnabled(mapped),includeRecast:recastEnabled(mapped),quality}));
 const service=await createClosedVideoService(mapped,{trustedUserId,lease:sharedLease,verifyTenant,providerFetch,gatewayFetch,priceFetch:currentPrice,accessMode:'paid',productionContext:context});
 return async req=>{
  const url=new URL(req.url);
  if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return reply({error:'Aanvraag geweigerd.'},403);
  try{
   if(!await verifyTenant())return unavailable();
   if(url.pathname==='/api/video-config'){
    if(req.method!=='GET'||url.search)return reply({error:'Aanvraag geweigerd.'},400);
    return reply({enabled:true,funding,mode:'live',...(funding==='owner-provider'?{providerCurrency:'USD'}:{currency:'EUR'}),qualities:['standard','pro',...(editEnabled(mapped)?['edit-standard']:[]),...(recastEnabled(mapped)?[RECAST_QUALITY]:[])]});
   }
   if(url.pathname==='/api/estimate/fal'){
    if(req.method!=='GET')return reply({error:'Methode niet toegestaan.'},405);
    const p=url.searchParams,quality=p.get('quality'),raw=p.get('duration');
    if([...p.keys()].some(k=>!['quality','duration'].includes(k))||p.getAll('quality').length!==1||p.getAll('duration').length!==1||!(['standard','pro'].includes(quality)||quality==='edit-standard'&&editEnabled(mapped)||quality===RECAST_QUALITY&&recastEnabled(mapped))||!/^(?:[0-9]{1,2})(?:\.[0-9]{1,6})?$/.test(raw||''))return reply({error:'Kies een geldig fragment.'},400);
    const recast=quality===RECAST_QUALITY,duration=Number(raw),billedSeconds=Math.ceil(duration),rate=Number(recast?mapped.RIG_PRICE_RECAST:quality==='edit-standard'?mapped.RIG_PRICE_EDIT:quality==='pro'?mapped.RIG_PRICE_PRO:mapped.RIG_PRICE_STANDARD);
    if(!Number.isFinite(duration)||duration<(recast?RECAST_MIN_DURATION:3)||duration>(recast?RECAST_MAX_DURATION:quality==='edit-standard'?15:30))return reply({error:'Kies een geldig fragment binnen de videolimiet.'},400);
    const policy=await loadProfitPolicy(mapped.DB);
    if(await d1Limit({env:mapped,category:'generation',userId:trustedUserId,method:'GET'})!==true)return reply({error:'Te veel aanvragen.'},429);
    const prices=await currentPrice(mapped.FAL_KEY,quality),providerRate=recast?recastPricePerSecond(prices):prices?.prices?.[quality];
    if(prices?.currency!=='USD'||prices?.unit!=='second'||!Number.isFinite(providerRate)||providerRate<=0||providerRate>1000)return unavailable();
    const rateUsdMicrosPerSecond=Math.ceil(providerRate*1e6),usdMicros=rateUsdMicrosPerSecond*billedSeconds;
    if(!Number.isSafeInteger(usdMicros)||usdMicros<=0||usdMicros>+mapped.RIG_CLOSED_VIDEO_MAX_USD_MICROS)return unavailable();
    const cents=retailPriceCents(policy,{quality,billedSeconds,rateCents:rate,providerEstimateUsdMicros:usdMicros,fundingKind:funding,maxPriceCents:+mapped.RIG_CLOSED_VIDEO_MAX_CENTS});
    if(!profitable(createProfitSnapshot({policy,fundingKind:funding,retailPriceCents:cents,providerEstimateUsdMicros:usdMicros})))return unavailable();
    // Provider costs are private business information. Customers receive only
    // their own EUR estimate; the trusted owner retains the direct-Fal view.
    return reply({quality,durationSeconds:duration,billedSeconds,...(funding==='owner-provider'?{funding,providerEstimate:{currency:'USD',usdMicros,rateUsdMicrosPerSecond,rateCheckedOn:new Date().toISOString().slice(0,10),binding:false}}:{customerProposal:{currency:'EUR',priceCents:cents,version:mapped.RIG_PRICE_VERSION,binding:false,testOnly:false}})});
   }
   if(url.pathname==='/api/assets'&&req.method==='POST'){
    const wallet=await mapped.DB.prepare('SELECT COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=?),0) AS balance,EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?) AS frozen').bind(trustedUserId,trustedUserId).first();
    if(wallet?.frozen===1)return reply({error:'Je tegoed wordt gecontroleerd.'},403);
    if(funding!=='owner-provider'&&(!Number.isSafeInteger(wallet?.balance)||wallet.balance<=0))return reply({error:'Koop eerst RIG-tegoed om bestanden voor te bereiden.'},402);
    const bytes=preparationRequestBytes(req);
    if(bytes===null)return reply({error:'Controleer de bestandsgrootte.'},400);
    // The signed ingress normally reserves before its lease and body read.
    // Private direct callers take the same quota here before transformation.
    const reserved=preparationReservation?{state:'reserved',reservation:preparationReservation}:await createPreparationBudget(mapped.DB,{productionContext:context}).reserve({userId:trustedUserId,bytes});
    if(reserved.state!=='reserved')return preparationDeniedResponse(reserved.state);
    if(!consumePreparationReservation(reserved.reservation,{db:mapped.DB,userId:trustedUserId,bytes:req.headers.has('content-length')?bytes:reserved.reservation.bytes}))return unavailable();
   }
   // Existing dispatched jobs may still be polled and stored after a freeze.
   // Their result cannot trigger a new reserve or another provider submission.
   return await service(req);
  }catch{return unavailable()}
 };
}
