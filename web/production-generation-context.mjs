// Server-only capability. A plain object or a request flag cannot opt the
// shared test adapters into spending a production wallet.
import {validateProductionTenant} from './production-tenant.mjs';

const contexts=new WeakSet();
export async function createProductionGenerationContext(env){
 if(env?.RIG_PRODUCTION_VIDEO_ENABLED!=='yes')return null;
 const mapped=await validateProductionTenant(env);
 if(!mapped||mapped.RIG_MODE!=='live'||mapped.RIG_MOLLIE_MODE!=='live'||mapped.DB!==env.PRODUCTION_DB||mapped.DB===env.DB)return null;
 const context=Object.freeze({mode:'live',env:Object.freeze({...mapped})});
 contexts.add(context);
 return context;
}
export function isProductionGenerationContext(context,{db,origin}={}){
 return Boolean(context&&contexts.has(context)&&context.mode==='live'&&(!db||context.env.DB===db)&&(!origin||context.env.RIG_PUBLIC_ORIGIN===origin));
}
