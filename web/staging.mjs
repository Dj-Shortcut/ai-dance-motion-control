// Worker-compatible staging composition. It does not authenticate browsers:
// a separately provisioned gateway must authenticate and HMAC-sign requests.
// Test ledger only; Mollie LIVE keys are refused by payment.mjs and gateway.
// Enabling fal staging can incur real charges: leave disabled until explicitly
// approved with a real spending cap enforced outside this process.
import {createStageGateway} from './gateway.mjs';
import {createRouter,d1Limit} from './router.mjs';
import {createAssets} from './assets.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {createResultStore} from './results.mjs';
import {privateResultFetch} from './upload.mjs';
import {getFalPricePreflight} from './price-preflight.mjs';
import {runTestMaintenance} from './maintenance.mjs';
import {createGenerationHandler} from './generation.mjs';
import {collectQueued} from './background-collector.mjs';
import {falConfigured,createOwnerTrialGuard} from './owner-fal-guard.mjs';

const fail=(status,msg)=>Response.json({error:msg},{status,headers:{'Cache-Control':'no-store'}});
// Fal is real-billed even in Mollie test mode. This candidate is default-off,
// owner-only, and fenced to one bounded attempt via createOwnerTrialGuard.
function assetServices(env,owner){return createAssets({mode:'test',origin:env.RIG_PUBLIC_ORIGIN,media:env.RIG_MEDIA,mediaSecret:env.RIG_MEDIA_SECRET,falKey:env.FAL_KEY,authenticate:async()=>({id:owner}),limit:async(id,scope)=>d1Limit({env,category:'asset',userId:id,method:scope==='asset-read'?'GET':'POST'})});}
async function generationServices(env,owner){return {...createD1GenerationStores(env.DB,{mode:'test'}),assets:assetServices(env,owner),results:createResultStore(env.BUCKET,privateResultFetch(env.FAL_KEY)),mode:'test',trustedOrigin:env.RIG_PUBLIC_ORIGIN,authenticate:async()=>({id:owner}),falKey:env.FAL_KEY,pricing:{standard:Number(env.RIG_PRICE_STANDARD),pro:Number(env.RIG_PRICE_PRO),version:env.RIG_PRICE_VERSION},trialGuard:createOwnerTrialGuard(env,owner)};}
function mediaConfigured(env,user,path){const enabled=path==='/api/media/test'?env.RIG_OWNER_MEDIA_TEST_ENABLED==='yes':path==='/api/assets'?env.RIG_OWNER_ASSETS_ENABLED==='yes':false;return env.RIG_MODE==='test'&&env.RIG_MOLLIE_MODE==='test'&&enabled&&user===env.RIG_STAGING_OWNER&&typeof env.RIG_MEDIA?.fetch==='function'&&typeof env.RIG_MEDIA_SECRET==='string'&&env.RIG_MEDIA_SECRET.length>=32&&/^(?:[1-9]|1[0-9]|2[0-2])$/.test(env.RIG_OWNER_MEDIA_DAILY_LIMIT??'');}
async function takeOwnerMediaAllowance(env,user,path,assetRole){
 // Keep the existing trial counter separate from the two assets needed to
 // generate one video. Both remain owner-only and individually bounded; no
 // existing counter is cleared or reused by a different endpoint.
 if(!['/api/media/test','/api/assets'].includes(path))return false;
 // Reference frames have an independent opt-in quota: four per set, with a
 // bounded retry. They cannot consume the image/video quota or reopen a
 // disabled test; all requests are still owner-only and bounded.
 const isReference=path==='/api/assets'&&['face','angle'].includes(assetRole);
 if(path==='/api/assets'&&!['image','video','face','angle'].includes(assetRole))return false;
 if(isReference&&!/^[1-8]$/.test(env.RIG_OWNER_REFERENCE_DAILY_LIMIT??''))return false;
 const configured=Number(isReference?env.RIG_OWNER_REFERENCE_DAILY_LIMIT:env.RIG_OWNER_MEDIA_DAILY_LIMIT);
 const limit=path==='/api/media/test'?Math.min(2,configured):configured,now=Math.floor(Date.now()/1000),bucket=`${isReference?'owner-generation-reference-assets':path==='/api/media/test'?'owner-media-test':'owner-generation-assets'}:${user}`;
 const row=await env.DB.prepare(`INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET requests=CASE WHEN rig_rate_limits.window_start<=? THEN 1 ELSE rig_rate_limits.requests+1 END,window_start=CASE WHEN rig_rate_limits.window_start<=? THEN excluded.window_start ELSE rig_rate_limits.window_start END RETURNING requests`).bind(bucket,now,now-86400,now-86400).first();
 return Number.isSafeInteger(row?.requests)&&row.requests<=limit;
}
// A durable shared exclusive lease bounds peak buffered media requests across
// all users/isolates. A stalled request may block staging until lease expiry;
// never bypass the lease to improve availability. This is not a substitute for
// deployment-wide byte quotas, spend limits or stress testing.
async function lease(db){
 const token=crypto.randomUUID(),now=Date.now();
 const row=await db.prepare(`INSERT INTO rig_staging_lease(id,token,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE rig_staging_lease.expires_at < ? RETURNING token`).bind(token,now+600000,now).first();
 return row?.token===token?token:null;
}
async function release(db,token){await db.prepare('DELETE FROM rig_staging_lease WHERE id=1 AND token=?').bind(token).run()}
async function route(req,env,user,context={}){
 const url=new URL(req.url),isWebhook=url.pathname==='/api/payments/webhook';
 if(!isWebhook && (!user||user!==env.RIG_STAGING_OWNER))return fail(403,'Deze testomgeving is alleen voor de eigenaar.');
 if(url.pathname==='/api/fal/preflight'){
  if(req.method!=='GET'||url.search||url.hash)return fail(404,'Niet gevonden.');
  if(env.RIG_FAL_PRICE_PREFLIGHT_ENABLED!=='yes'||typeof env.FAL_KEY!=='string'||!env.FAL_KEY)return fail(503,'Testomgeving is tijdelijk niet beschikbaar.');
  try{
   if(!await d1Limit({env,category:'payment',userId:`fal-preflight:${user}`,method:'POST'}))return fail(429,'Te veel aanvragen.');
   return Response.json(await getFalPricePreflight(env.FAL_KEY),{headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
  }catch{return fail(503,'Testomgeving is tijdelijk niet beschikbaar.')}
 }
 if(['/api/assets','/api/media/test'].includes(url.pathname)&&req.method==='POST'&&mediaConfigured(env,user,url.pathname)){try{if(!await takeOwnerMediaAllowance(env,user,url.pathname,req.headers.get('x-rig-asset-kind')))return fail(429,'Daglimiet voor de privétest bereikt.')}catch{return fail(503,'Media tijdelijk niet beschikbaar.')}}
 if(url.pathname==='/api/media/test'&&(req.method!=='POST'||url.search||url.hash))return fail(404,'Niet gevonden.');
 const mediaRoute=url.pathname==='/api/assets'||url.pathname==='/api/media/test'||url.pathname==='/api/generation-quotes';
 let token=null;
 if(mediaRoute&&!context.mediaLeaseHeld){try{token=await lease(env.DB);if(!token)return fail(429,'Media wordt al verwerkt. Probeer later opnieuw.')}catch{return fail(503,'Media tijdelijk niet beschikbaar.')}}
 try{
   const mediaAvailable=mediaConfigured(env,user,url.pathname);
   const generationAvailable=falConfigured(env,user);
   const makeAssets=async(_env,owner)=>assetServices(env,owner);
   if(url.pathname==='/api/media/test'){if(!mediaAvailable)return fail(503,'Mediatest niet beschikbaar.');const assets=createAssets({mode:'test',origin:env.RIG_PUBLIC_ORIGIN,media:env.RIG_MEDIA,mediaSecret:env.RIG_MEDIA_SECRET,ephemeral:true,authenticate:async()=>({id:user}),limit:async(id,scope)=>d1Limit({env,category:'asset',userId:id,method:scope==='asset-read'?'GET':'POST'})});return await assets.handle(req);}
   const router=createRouter({identity:async()=>user,limit:d1Limit,...(mediaAvailable?{makeAssets}:{}),...(generationAvailable?{makeGenerationServices:async(_env,owner)=>generationServices(env,owner)}:{})});
   return await router(req,env);
 }catch{return fail(503,'Testomgeving is tijdelijk niet beschikbaar.')}finally{if(token)try{await release(env.DB,token)}catch{/* expiry recovers; never manufacture success */}}
}
export default {
 fetch:createStageGateway({route,acquire:lease,release}),
 // Cloudflare invokes this handler through a Cron Trigger on this private
 // Worker. It is not reachable through a user-supplied request.
 scheduled(_event,env,ctx){
  ctx.waitUntil(runTestMaintenance(env));
  if(env.RIG_OWNER_BACKGROUND_COLLECTION==='yes'){
   ctx.waitUntil((async()=>{
    try{
     const owner=env.RIG_STAGING_OWNER;
     if(!falConfigured(env,owner))throw Error('Collector configuration unavailable');
     const dbMode=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
     if(dbMode?.mode!=='test')throw Error('Test database required');
     const handler=createGenerationHandler(await generationServices(env,owner));
     const summary=await collectQueued({enabled:true,db:env.DB,owner,origin:env.RIG_PUBLIC_ORIGIN,handler});
     // Counters only: no user IDs, prompts, media URLs, provider response or keys.
     console.info('RIG owner collector',summary);
     if(summary.failed||summary.needsReview)console.error('RIG owner collector requires review');
    }catch{
     // Keep the event failed for operator monitoring. Do not print provider errors.
     console.error('RIG owner collector unavailable');
     throw Error('Owner collector unavailable');
    }
   })());
  }
 }
};
export const stagingTesting={falConfigured,mediaConfigured,takeOwnerMediaAllowance,lease,release};
