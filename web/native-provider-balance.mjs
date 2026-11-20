// Read-only owner wallet projection. This is the validated Fal credit balance,
// never RIG credit, spending headroom, a daily cap or an automatic refill amount.
import {validateProductionTenant} from './production-tenant.mjs';
import {readFundingCoverage} from './funding-coverage.mjs';
import {d1Limit} from './router.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_AGE=60000,MAX_USD_MICROS=1000000000000000;
const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const unavailable=()=>json({code:'provider_balance_unavailable',error:'Je Fal-saldo kan nu niet worden opgehaald. Probeer straks opnieuw.'},503);

// userId is supplied only after native bearer validation, never from the body.
export async function handleNativeProviderBalance(req,env,{userId,network=fetch,now=Date.now()}={}){
 // Gate before tenant/policy/cache lookup and before ANY provider request.
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return json({error:'Geen toegang.'},403);
 const url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==env.RIG_PRODUCTION_BRIDGE_ORIGIN||url.pathname!=='/api/native/provider-balance'||url.search||req.headers.has('origin'))return json({error:'Niet gevonden.'},404);
 if(!Number.isSafeInteger(now)||now<1)return unavailable();
 const mapped=await validateProductionTenant(env);if(!mapped)return unavailable();
 try{
  if(await d1Limit({env:mapped,category:'finance',userId,method:'GET'})!==true)return json({error:'Te veel aanvragen. Probeer straks opnieuw.'},429);
  // Reuses its existing short account/key/policy/network-bound cache and
  // concurrent-read deduplication. No new permissions, writes or sales toggle.
  const balance=await readFundingCoverage(mapped,{network,now});
  if(!['ready','insufficient'].includes(balance.status)||!Number.isSafeInteger(balance.availableUsdMicros)||balance.availableUsdMicros<0||balance.availableUsdMicros>MAX_USD_MICROS||!Number.isSafeInteger(balance.fetchedAt)||balance.fetchedAt>now||now-balance.fetchedAt>=MAX_AGE||!Number.isSafeInteger(balance.expiresAt))return unavailable();
  const expiresAt=Math.min(balance.expiresAt,balance.fetchedAt+MAX_AGE);
  if(expiresAt<=now)return unavailable();
  return json({availableUsdMicros:balance.availableUsdMicros,currency:'USD',fetchedAt:balance.fetchedAt,expiresAt});
 }catch{return unavailable();}
}
