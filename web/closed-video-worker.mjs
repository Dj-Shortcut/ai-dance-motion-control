import {videoDraftPath} from './video-drafts.mjs';
// Private, owner-gated test composition. Never expose a route or preview URL.
// Authentication is performed by the separately bound private identity Worker.
import {createClosedVideoService,closedVideoTesting} from './closed-video-service.mjs';
import {createDurableMediaLease} from './durable-media-lease.mjs';
import {estimatePrice} from './price-estimate.mjs';
import {getFalPricePreflight} from './price-preflight.mjs';
import {d1Limit} from './router.mjs';
import {createSponsoredInvitationStore} from './sponsored-invitation.mjs';
import {authenticateSitesBridge} from './sites-bridge-auth.mjs';
import {createChatgptApprovals} from './rig-chatgpt-approvals.mjs';
import {createInputVerification} from './rig-input-verification.mjs';
import {createAssets} from './assets.mjs';
import {handleProviderInput,mintProofProviderInput} from './rig-provider-inputs.mjs';
import {authorizeGatewayProof,createGatewayVerification,GATEWAY_PROOF_JOB} from './rig-gateway-verification.mjs';
import {createR2InputVerification,R2_INPUT_VERIFICATION_JOB} from './rig-r2-verification.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
import {collectProduction} from './production-collector.mjs';

const ownerId=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tokenPattern=/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const editEnabled=env=>env.RIG_EDIT_ENABLED==='yes'&&typeof env.RIG_PRICE_EDIT==='string'&&/^[1-9][0-9]*$/.test(env.RIG_PRICE_EDIT)&&Number.isSafeInteger(+env.RIG_PRICE_EDIT)&&+env.RIG_PRICE_EDIT<=250;
const reply=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const unavailable=()=>reply({error:'Videogeneratie is nog niet beschikbaar.'},503);
const recognized=path=>videoDraftPath(path,'GET')||videoDraftPath(path,'POST')||['/api/video-config','/api/estimate/fal','/api/assets','/api/generation-quotes','/api/generations','/api/generations/recent','/api/sponsor-invitations/status','/api/sponsor-invitations/redeem'].includes(path)||/^\/api\/generation-intents\/[A-Za-z0-9_-]{1,100}\/reconcile$/.test(path)||/^\/api\/generations\/[A-Za-z0-9_-]{1,100}(?:\/video)?$/.test(path);

async function verifiedUser(req,env){
 const authorization=req.headers.get('authorization')||'';
 if(authorization.length>8199||!tokenPattern.test(authorization)||typeof env.CLOSED_IDENTITY_SERVICE?.fetch!=='function')return null;
 // Do not forward request identity headers, cookies, query, body or URL.
 const check=new Request(`${env.RIG_PUBLIC_ORIGIN}/api/session`,{headers:{authorization},signal:AbortSignal.timeout(10000)});
 const res=await env.CLOSED_IDENTITY_SERVICE.fetch(check);
 if(!res.ok||!res.body)return null;
 const length=res.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>2048))return null;
 const reader=res.body.getReader();let size=0,chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)return null;chunks.push(value)}}finally{try{await reader.cancel()}catch{}}
 const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length}
 const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 return typeof body?.userId==='string'&&ownerId.test(body.userId)?body.userId:null;
}
async function identityTenantMatches(env){
 if(env.RIG_MODE!=='test'||env.RIG_MOLLIE_MODE!=='test'||typeof env.DB?.prepare!=='function'||typeof env.DB?.batch!=='function'||env.RIG_VIDEO_PRIVATE_SERVICE_ONLY!=='yes'||env.MOLLIE_API_KEY||env.RIG_STAGING_OWNER||!ownerId.test(env.RIG_VIDEO_OWNER_USER_ID||'')||!/^[-_A-Za-z0-9]{8,80}$/.test(env.RIG_TEST_ENVIRONMENT_ID||''))return false;
 try{
  const project=new URL(env.SUPABASE_URL);
  if(project.origin!==env.SUPABASE_URL||project.protocol!=='https:'||!/^[a-z0-9]{20}\.supabase\.co$/.test(project.hostname))return false;
  const row=await env.DB.prepare('SELECT mode,environment_id,public_origin,identity_project FROM rig_closed_test_tenant WHERE id=1').first();
  const mode=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  const owner=await env.DB.prepare('SELECT 1 AS found FROM rig_external_identities WHERE issuer=? AND user_id=?').bind(`${project.origin}/auth/v1`,env.RIG_VIDEO_OWNER_USER_ID).first();
  return row?.mode==='test'&&mode?.mode==='test'&&row.environment_id===env.RIG_TEST_ENVIRONMENT_ID&&row.public_origin===env.RIG_PUBLIC_ORIGIN&&row.identity_project===project.origin&&owner?.found===1;
 }catch{return false}
}
async function tenantMatches(env){
 if(!closedVideoTesting.valid(env)||!await identityTenantMatches(env))return false;
 try{await env.DB.prepare('SELECT id FROM rig_media_work_lock LIMIT 1').first();return true}catch{return false}
}
async function hasSponsoredGrant(env,user){
 try{
  const row=await env.DB.prepare("SELECT 1 AS found FROM rig_sponsored_invitation s JOIN rig_ledger l ON l.event_id='sponsored-invitation:1' AND l.user_id=s.redeemed_by AND l.delta=500 AND l.order_id IS NULL WHERE s.id=1 AND s.redeemed_by=? AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='test')").bind(user).first();
  return row?.found===1;
 }catch{return false}
}
async function readInvitationCode(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||'')||!req.body)return null;
 const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>256))return null;
 const reader=req.body.getReader(),chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>256)return null;chunks.push(value)}
  const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  return data&&!Array.isArray(data)&&typeof data==='object'&&Object.keys(data).length===1&&/^[A-Za-z0-9_-]{43}$/.test(data.code||'')?data.code:null;
 }catch{return null}finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
async function readBridgeJSON(req,keys,optionalKeys=[]){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||'')||!req.body)return null;
 const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body.getReader(),chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),10000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>8192)return null;chunks.push(value)}
  const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  return data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).every(k=>keys.includes(k)||optionalKeys.includes(k))&&keys.every(k=>Object.hasOwn(data,k)&&typeof data[k]==='string')&&optionalKeys.every(k=>!Object.hasOwn(data,k)||typeof data[k]==='string')?data:null;
 }catch{return null}finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
export function createClosedVideoWorker({serviceFactory=createClosedVideoService,leaseFactory=createDurableMediaLease,pricePreflight=getFalPricePreflight,recoveryAssetsFactory=createAssets,gatewayVerificationFactory=createGatewayVerification}={}){
 const serve=async(req,env,sites=null)=>{
  let u;try{u=new URL(req.url)}catch{return unavailable()}
  if(!recognized(u.pathname))return reply({error:'Niet gevonden.'},404);
  if(!['GET','POST'].includes(req.method)||u.origin!==env.RIG_PUBLIC_ORIGIN||(req.method==='POST'&&req.headers.get('origin')!==env.RIG_PUBLIC_ORIGIN))return reply({error:'Aanvraag geweigerd.'},403);
  if(u.pathname==='/api/video-config'&&req.method!=='GET')return reply({error:'Methode niet toegestaan.'},405);
  let user;try{user=sites?.userId??await verifiedUser(req,env)}catch{return unavailable()}
  if(!user)return reply({error:'Aanmelden vereist.'},401);
  if(u.pathname.startsWith('/api/sponsor-invitations/')){
   if(env.RIG_SPONSORED_ENABLED!=='yes'||!await identityTenantMatches(env)||u.search)return unavailable();
   if((u.pathname.endsWith('/status')&&req.method!=='GET')||(u.pathname.endsWith('/redeem')&&req.method!=='POST'))return reply({error:'Methode niet toegestaan.'},405);
   try{
    if(await d1Limit({env,category:'generation',userId:user,method:req.method})!==true)return reply({error:'Te veel aanvragen.'},429);
    const sponsor=createSponsoredInvitationStore(env.DB);
    if(u.pathname.endsWith('/status'))return reply(await sponsor.eligibility(user));
    const code=await readInvitationCode(req);if(!code)return reply({state:'unavailable'});
    if(user===env.RIG_VIDEO_OWNER_USER_ID)return reply({state:'owner',message:'Deze uitnodiging is voor je tester. Deel de link met hem.'});
    return reply(await sponsor.redeem(user,code));
   }catch{return unavailable()}
  }
  let accessMode=user===env.RIG_VIDEO_OWNER_USER_ID?'owner':null,sponsorCanSpend=false;
  if(!accessMode&&env.RIG_SPONSORED_ENABLED==='yes'&&await hasSponsoredGrant(env,user)){
   accessMode='sponsored';
   try{const state=await createSponsoredInvitationStore(env.DB).eligibility(user);sponsorCanSpend=state.state==='eligible'&&state.remainingCents>0}catch{}
  }
  const ready=Boolean(accessMode)&&await tenantMatches(env);
  if(u.pathname==='/api/video-config')return reply(ready?{enabled:true,funding:accessMode,...(editEnabled(env)?{qualities:['standard','pro','edit-standard']}:{})}:{enabled:false});
  if(!ready)return unavailable();
  if(accessMode==='sponsored'&&!sponsorCanSpend&&(u.pathname==='/api/estimate/fal'||req.method==='POST'&&['/api/assets','/api/generation-quotes','/api/generations'].includes(u.pathname)))return reply({error:'Je testtegoed is op of wordt gecontroleerd.'},403);
  if(u.pathname==='/api/estimate/fal'){
   if(req.method!=='GET')return reply({error:'Methode niet toegestaan.'},405);
   const params=u.searchParams,quality=params.get('quality'),raw=params.get('duration');
   if([...params.keys()].some(k=>!['quality','duration'].includes(k))||params.getAll('quality').length!==1||params.getAll('duration').length!==1||!(['standard','pro'].includes(quality)||quality==='edit-standard'&&editEnabled(env))||!/^(?:[0-9]{1,2})(?:\.[0-9]{1,6})?$/.test(raw||''))return reply({error:'Kies een geldig fragment.'},400);
   const duration=Number(raw),billedSeconds=Math.ceil(duration);
   const proposed=quality==='edit-standard'?{quality,durationSeconds:duration,billedSeconds,customerProposal:/^[A-Za-z0-9_.-]{1,40}$/.test(env.RIG_PRICE_VERSION||'')?{currency:'EUR',priceCents:billedSeconds*Number(env.RIG_PRICE_EDIT),version:env.RIG_PRICE_VERSION,binding:false}:null}:estimatePrice(quality,duration,quality==='standard'?env.RIG_PRICE_STANDARD:env.RIG_PRICE_PRO,env.RIG_PRICE_VERSION);
   if(!Number.isFinite(duration)||duration<3||duration>(quality==='edit-standard'?15:30)||!proposed||!proposed.customerProposal||proposed.customerProposal.priceCents>Number(env.RIG_CLOSED_VIDEO_MAX_CENTS))return reply({error:'Kies een geldig fragment binnen de testlimiet.'},400);
   try{if(await d1Limit({env,category:'generation',userId:user,method:req.method})!==true)return reply({error:'Te veel aanvragen.'},429)}catch{return unavailable()}
   try{
    if(typeof pricePreflight!=='function')return unavailable();
    const current=await pricePreflight(env.FAL_KEY,closedVideoTesting.providerTransport(fetch),{includeEdit:editEnabled(env)});
    const rate=current?.prices?.[quality];
    if(current?.provider!=='fal'||current?.currency!=='USD'||current?.unit!=='second'||!Number.isFinite(rate)||rate<=0||rate>1000)return unavailable();
    const rateUsdMicrosPerSecond=Math.ceil(rate*1e6),usdMicros=rateUsdMicrosPerSecond*billedSeconds;
    if(!Number.isSafeInteger(rateUsdMicrosPerSecond)||!Number.isSafeInteger(usdMicros)||usdMicros<=0||usdMicros>Number(env.RIG_CLOSED_VIDEO_MAX_USD_MICROS))return unavailable();
    return reply({...proposed,customerProposal:{...proposed.customerProposal,testOnly:true},providerEstimate:{currency:'USD',usdMicros,rateUsdMicrosPerSecond,rateCheckedOn:new Date().toISOString().slice(0,10),binding:false}});
   }catch{return unavailable()}
  }
  try{
   const lease=sites?.lease??leaseFactory(env.DB);
   const service=await serviceFactory(env,{trustedUserId:user,lease,verifyTenant:tenantMatches,accessMode});
   return await service(req);
  }catch{return unavailable()}
 };
 return {async fetch(req,env){
  let sites=null;
  try{
   const u=new URL(req.url);
   if(u.pathname.startsWith('/provider-inputs/'))return await handleProviderInput(req,env,{verifyTenant:tenantMatches,authorizeProof:authorizeGatewayProof});
   if(u.origin===env.RIG_SITES_BRIDGE_ORIGIN){
    if(env.RIG_SITES_BRIDGE_ENABLED!=='yes'||!await identityTenantMatches(env))return unavailable();
    sites=await authenticateSitesBridge(req,env,{leaseFactory});
    if(!sites)return reply({error:'Aanmelden vereist.'},401);
    if(u.pathname==='/api/session'){
     const balance=await env.DB.prepare('SELECT COALESCE(SUM(delta),0) AS cents FROM rig_ledger WHERE user_id=?').bind(sites.userId).first();
     const frozen=await env.DB.prepare('SELECT 1 AS found FROM rig_frozen_accounts WHERE user_id=?').bind(sites.userId).first();
     if(!Number.isSafeInteger(balance?.cents))return unavailable();
     return reply({userId:sites.userId,balanceCents:balance.cents,frozen:frozen?.found===1});
    }
    if(u.pathname===`/api/generations/${GATEWAY_PROOF_JOB}/verify-gateway`){
     if(req.method!=='POST'||u.search)return reply({error:'Aanvraag geweigerd.'},400);
     if(sites.userId!==env.RIG_VIDEO_OWNER_USER_ID)return reply({error:'Deze controle is niet beschikbaar.'},403);
     const data=await readBridgeJSON(sites.request,[]);if(!data)return reply({error:'Controleer je aanvraag.'},400);
     const verify=gatewayVerificationFactory({env,verifyTenant:tenantMatches,mintProofInput:mintProofProviderInput});
     return await verify({userId:sites.userId,jobId:GATEWAY_PROOF_JOB});
    }
    const recovering=u.pathname.match(/^\/api\/generations\/([0-9a-f-]{36})\/verify-inputs$/);
    if(recovering){
     if(req.method!=='POST'||u.search)return reply({error:'Aanvraag geweigerd.'},400);
     if(sites.userId!==env.RIG_VIDEO_OWNER_USER_ID)return reply({error:'Deze controle is niet beschikbaar.'},403);
     const data=await readBridgeJSON(sites.request,[]);if(!data)return reply({error:'Controleer je aanvraag.'},400);
     const transport=closedVideoTesting.providerTransport(fetch);
     const noQueue=async(input,init)=>{const host=new URL(String(input)).hostname;if(host==='fal.run'||host.endsWith('.fal.run'))throw Error('Queue is unavailable during input verification');return transport(input,init)};
     const privateAssets={mode:'test',origin:env.RIG_PUBLIC_ORIGIN,media:env.RIG_MEDIA,mediaSecret:env.RIG_MEDIA_SECRET,falKey:env.FAL_KEY,authenticate:async()=>({id:sites.userId}),limit:async(user,scope)=>d1Limit({env,category:'asset',userId:user,method:scope==='asset-read'?'GET':'POST'})};
     const recovery=recovering[1]===R2_INPUT_VERIFICATION_JOB
      ?createR2InputVerification({env,verifyTenant:tenantMatches,makeAssets:({r2Inputs})=>recoveryAssetsFactory({...privateAssets,r2Inputs,gatewayFetch:fetch,providerFetch:async()=>{throw Error('Provider transport is unavailable during R2 verification')}})})
      :createInputVerification({db:env.DB,ownerUserId:env.RIG_VIDEO_OWNER_USER_ID,verifyTenant:()=>tenantMatches(env),makeAssets:()=>recoveryAssetsFactory({...privateAssets,providerFetch:noQueue})});
     return await recovery({userId:sites.userId,jobId:recovering[1]});
    }
    const issuing=u.pathname==='/api/chatgpt/quote-approvals',consuming=u.pathname==='/api/chatgpt/quote-approvals/consume';
    if(issuing||consuming){
     if(u.search||req.method!=='POST')return reply({error:'Aanvraag geweigerd.'},400);
     if(await d1Limit({env,category:'generation',userId:sites.userId,method:'POST'})!==true)return reply({error:'Te veel aanvragen.'},429);
     const data=await readBridgeJSON(sites.request,issuing?['quoteId']:['quoteId','approvalToken']);
     if(!data||!/^[A-Za-z0-9_-]{1,100}$/.test(data.quoteId)||consuming&&!/^[A-Za-z0-9_-]{32,128}$/.test(data.approvalToken))return reply({error:'Controleer je aanvraag.'},400);
     const approvals=createChatgptApprovals(env.DB),result=issuing?await approvals.issue(sites.userId,data):await approvals.consume(sites.userId,data);
     return result?reply(result,issuing?201:200):reply({error:'Deze prijsbevestiging is niet beschikbaar of verlopen.'},409);
    }
    if(u.pathname==='/api/generations'&&req.method==='POST'){
     const data=await readBridgeJSON(sites.request,['quoteId','idempotencyKey','approvalToken'],['transferConsent']);
     if(!data||!['quoteId','idempotencyKey'].every(k=>/^[A-Za-z0-9_-]{1,100}$/.test(data[k]))||!/^[A-Za-z0-9_-]{32,128}$/.test(data.approvalToken)||Object.hasOwn(data,'transferConsent')&&data.transferConsent!=='fal-temporary-links-v1')return reply({error:'Bevestig eerst de prijs in RIG.'},403);
     const approval=await createChatgptApprovals(env.DB).consume(sites.userId,{quoteId:data.quoteId,approvalToken:data.approvalToken});
     if(!approval||approval.idempotencyKey!==data.idempotencyKey)return reply({error:'Bevestig eerst de prijs in RIG.'},403);
     // The capability is checked here and never forwarded into generation
     // bookkeeping, provider inputs, logs or ordinary browser responses.
     sites.request=new Request(sites.request.url,{method:'POST',redirect:'manual',headers:sites.request.headers,body:JSON.stringify({quoteId:data.quoteId,idempotencyKey:data.idempotencyKey,...(Object.hasOwn(data,'transferConsent')?{transferConsent:data.transferConsent}:{})})});
    }
    return await serve(sites.request,env,sites);
   }
   return await serve(req,env);
  }catch{return unavailable()}
  finally{if(sites)try{await sites.releaseUnused()}catch{}}
 }};
}
export default {
 fetch(req,env){
  const u=new URL(req.url);
  if(u.origin===env.RIG_PRODUCTION_BRIDGE_ORIGIN)return createProductionCommerceWorker().fetch(req,env);
  return createClosedVideoWorker().fetch(req,env);
 },
 async scheduled(_event,env,ctx){
  const work=collectProduction(env);
  if(ctx?.waitUntil)ctx.waitUntil(work);
  else await work;
 }
};
