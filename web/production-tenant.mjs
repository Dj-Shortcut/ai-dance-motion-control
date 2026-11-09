// PRIVATE PRODUCTION CANDIDATE — no entrypoint, disabled unless explicitly
// configured with a distinct production D1 and an independently verified site.
const SITE='appgprj_6aeec13b50448191b88da670dac8aa98';
const SITE_ORIGIN='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const BRIDGE_ORIGIN='https://rig-api.shortcut-computerguy.workers.dev';
function validWebhook(value){try{const u=new URL(value);return u.protocol==='https:'&&u.origin===BRIDGE_ORIGIN&&u.pathname==='/api/payments/webhook'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value}catch{return false}}
export function productionEnvironment(env){
 if(env?.RIG_PRODUCTION_PAYMENTS_ENABLED!=='yes'||env?.RIG_PRIVATE_SERVICE_ONLY!=='yes'||!env.PRODUCTION_DB||env.PRODUCTION_DB===env.DB||!/^live_[A-Za-z0-9]+$/.test(env.MOLLIE_LIVE_API_KEY||'')||!/^pfl_[A-Za-z0-9]+$/.test(env.RIG_PRODUCTION_MOLLIE_PROFILE||'')||!/^[-_A-Za-z0-9]{8,80}$/.test(env.RIG_PRODUCTION_ENVIRONMENT_ID||'')||env.RIG_PRODUCTION_SITE_ID!==SITE||env.RIG_PRODUCTION_SITE_ORIGIN!==SITE_ORIGIN||env.RIG_PRODUCTION_BRIDGE_ORIGIN!==BRIDGE_ORIGIN||!validWebhook(env.RIG_PRODUCTION_WEBHOOK_URL)||typeof env.RIG_PRODUCTION_PACKAGES!=='string')return null;
 return {...env,DB:env.PRODUCTION_DB,MOLLIE_API_KEY:env.MOLLIE_LIVE_API_KEY,RIG_MOLLIE_PROFILE_ID:env.RIG_PRODUCTION_MOLLIE_PROFILE,RIG_MODE:'live',RIG_MOLLIE_MODE:'live',RIG_PUBLIC_ORIGIN:SITE_ORIGIN,RIG_WEBHOOK_URL:env.RIG_PRODUCTION_WEBHOOK_URL,RIG_PACKAGES:env.RIG_PRODUCTION_PACKAGES,
  RIG_PRICE_STANDARD:env.RIG_PRODUCTION_PRICE_STANDARD??env.RIG_PRICE_STANDARD,
  RIG_PRICE_PRO:env.RIG_PRODUCTION_PRICE_PRO??env.RIG_PRICE_PRO,
  RIG_PRICE_EDIT:env.RIG_PRODUCTION_PRICE_EDIT??env.RIG_PRICE_EDIT,
  RIG_PRICE_VERSION:env.RIG_PRODUCTION_PRICE_VERSION??env.RIG_PRICE_VERSION,
  RIG_CLOSED_VIDEO_MAX_CENTS:env.RIG_PRODUCTION_VIDEO_MAX_CENTS??env.RIG_CLOSED_VIDEO_MAX_CENTS};
}
export async function validateProductionTenant(env){
 const mapped=productionEnvironment(env);if(!mapped)return null;
 try{
  const row=await mapped.DB.prepare('SELECT * FROM rig_production_tenant WHERE id=1').first();
  const mode=await mapped.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();
  if(row?.mode!=='live'||mode?.mode!=='live'||row.environment_id!==env.RIG_PRODUCTION_ENVIRONMENT_ID||row.site_id!==SITE||row.site_origin!==SITE_ORIGIN||row.bridge_origin!==BRIDGE_ORIGIN||row.mollie_profile!==mapped.RIG_MOLLIE_PROFILE_ID||row.webhook_url!==mapped.RIG_WEBHOOK_URL)return null;
  return mapped;
 }catch{return null}
}
export const productionTenantTesting={SITE,SITE_ORIGIN,BRIDGE_ORIGIN,validWebhook};
