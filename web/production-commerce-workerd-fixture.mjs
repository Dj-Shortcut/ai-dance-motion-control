// Test-only three-worker composition. Provider transport is a local fake;
// these exports must never be deployed or supplied production credentials.
import {createRigSitesApp} from './rig-sites-app.mjs';
import ingress from './production-ingress.mjs';
import {createProductionCommerceWorker} from './production-commerce-worker.mjs';
export const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
export const BRIDGE='https://rig-api.shortcut-computerguy.workers.dev';
const PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98',KEY='ac'.repeat(32),PROFILE='pfl_FIXTUREPROFILE';
let active=true,created=0,providerReads=0,videoCalls=0,dispatches=0,lastGeneration=null,lastPrivateHeaders=null;
const payments=new Map();
const production=env=>({...env,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:active?'yes':'no',RIG_PRODUCTION_VIDEO_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_localfixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'commerce-fixture-v1',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:JSON.stringify([{id:'small',amountCents:500,credits:500},{id:'medium',amountCents:1000,credits:1000}]),RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY});
async function provider(input,init={}){
 const url=new URL(input),headers=new Headers(init.headers);providerReads++;
 if(url.origin!=='https://api.mollie.com'||headers.get('authorization')!=='Bearer live_localfixture'||init.redirect!=='manual')throw Error('No real provider access permitted');
 if(url.pathname==='/v2/profiles/me')return Response.json({id:PROFILE});
 if(url.pathname==='/v2/payments'&&init.method==='POST'){
  const key=headers.get('Idempotency-Key');if(!/^[a-f0-9-]{36}$/.test(key||''))throw Error('Idempotency required');
  const existing=[...payments.values()].find(p=>p.metadata.order_id===key);if(existing)return Response.json(existing,{status:201});
  created++;const body=JSON.parse(init.body),id='tr_Fixture'+String(created).padStart(6,'0');
  const payment={id,mode:'live',profileId:PROFILE,amount:body.amount,metadata:body.metadata,status:'open',redirectUrl:body.redirectUrl,_links:{checkout:{href:'https://www.mollie.com/checkout/'+id}}};payments.set(id,payment);return Response.json(payment,{status:201});
 }
 const m=url.pathname.match(/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/);
 if(!m||!payments.has(m[1]))return Response.json({error:'not found'},{status:404});
 if(m[2])return Response.json({_embedded:{[m[2]]:[]}});
 return Response.json(payments.get(m[1]));
}
async function videoFactory(env,{trustedUserId}){
 return async req=>{
  videoCalls++;const path=new URL(req.url).pathname;
  if(path==='/api/video-config')return Response.json({enabled:true,funding:'credits',currency:'EUR',mode:'live'});
  if(path==='/api/generation-quotes'){
   const id=crypto.randomUUID(),now=Date.now();
   await env.PRODUCTION_DB.prepare("INSERT INTO rig_generation_quotes(id,user_id,model,input_json,price_cents,pricing_version,duration_seconds,expires_at,created_at) VALUES(?,?,?,'{}',100,'fixture',5,?,?)").bind(id,trustedUserId,'fixture-no-provider',now+60000,now).run();
   return Response.json({id,priceCents:100,currency:'EUR'},{status:201});
  }
  if(path==='/api/generations'){
   dispatches++;lastGeneration=await req.json();return Response.json({id:'fixture-video',state:'queued'});
  }
  return new Response(null,{status:404});
 };
}
const commerce=createProductionCommerceWorker({network:provider,videoFactory});
export const privateWorker={async fetch(req,env){
 const url=new URL(req.url);
 if(url.pathname==='/fixture/stats')return Response.json({active,created,providerReads,videoCalls,dispatches,lastGeneration,lastPrivateHeaders,payments:[...payments.values()]});
 if(url.pathname==='/fixture/active'){active=url.searchParams.get('value')!=='no';return Response.json({active})}
 if(url.pathname==='/fixture/paid'){const payment=payments.get(url.searchParams.get('id'));if(!payment)return new Response(null,{status:404});payment.status='paid';return Response.json({ok:true})}
 lastPrivateHeaders=Object.fromEntries(['authorization','cookie','oai-authenticated-user-id','x-rig-expected-user'].map(name=>[name,req.headers.get(name)]));
 return commerce.fetch(req,production(env));
}};
export const relayWorker={fetch(req,env){return ingress.fetch(req,{...env,RIG_PRODUCTION_RELAY_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})}})}};
export const siteWorker={fetch(req,env){
 const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<main>RIG credit checkout</main>'},fetchImpl:signed=>{const headers=new Headers(signed.headers);headers.set('cf-connecting-ip','192.0.2.9');return env.RIG_RELAY.fetch(new Request(signed,{headers}))}});
 return app.fetch(req,{RIG_SITES_PROJECT_ID:PROJECT,RIG_SITES_PRODUCER_ORIGIN:SITE,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_SITES_BRIDGE_KEY:KEY});
}};
export default privateWorker;
