// Test fixture only. No live endpoints, keys, or public deployment.
import {createProductionPayment} from './production-payment.mjs';
let created=0;const payments=new Map();let replayKey='',scenario='';
const PROFILE='pfl_TESTPROFILE';
const fake=async(input,init)=>{
 const url=new URL(input),h=new Headers(init.headers);
 if(h.get('authorization')!=='Bearer live_fixture')throw Error('bad key');
 if(url.pathname==='/v2/profiles/me')return Response.json({id:PROFILE});
 if(url.pathname==='/v2/payments'&&init.method==='POST'){
  replayKey=h.get('Idempotency-Key');const body=JSON.parse(init.body);created++;
  const p={id:'tr_Pay'+String(created).padStart(5,'0'),mode:'live',profileId:PROFILE,amount:body.amount,metadata:body.metadata,status:'open',_links:{checkout:{href:'https://www.mollie.com/checkout/fixture'}}};payments.set(p.id,p);
  if(scenario==='lost')throw Error('lost response');
  if(scenario==='bad_amount')return Response.json({...p,amount:{currency:'EUR',value:'0.01'}},{status:201});
  if(scenario==='bad_metadata')return Response.json({...p,metadata:{order_id:'wrong-order-000001'}},{status:201});
  if(scenario==='bad_profile')return Response.json({...p,profileId:'pfl_WRONGPROFILE'},{status:201});
  if(scenario==='missing_checkout')return Response.json({...p,_links:{}},{status:201});
  if(scenario==='bad_checkout')return Response.json({...p,_links:{checkout:{href:'https://mollie.com.evil.invalid/checkout'}}},{status:201});
  return Response.json(p,{status:201});
 }
 const m=url.pathname.match(/^\/v2\/payments\/(tr_[A-Za-z0-9]+)(?:\/(refunds|chargebacks))?$/);
 if(!m||!payments.has(m[1]))return Response.json({error:'missing'},{status:404});
 if(m[2])return Response.json({_embedded:{[m[2]]:scenario==='refund'&&m[2]==='refunds'?[{id:'re_fixture'}]:[]}});
 return Response.json(payments.get(m[1]));
};
const payment=createProductionPayment({transport:fake});
export default {async fetch(req,env){
 const u=new URL(req.url);
 if(u.pathname==='/fixture/scenario'){scenario=u.searchParams.get('value')||'';return Response.json({ok:true})}
 if(u.pathname==='/fixture/paid'){payments.get('tr_Pay00001').status='paid';return Response.json({ok:true})}
 if(u.pathname==='/fixture/stats')return Response.json({created,replayKey});
 const e={...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:PROFILE,RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:'https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://rig-api.shortcut-computerguy.workers.dev',RIG_PRODUCTION_WEBHOOK_URL:'https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"unit","amountCents":500,"credits":500}]'};
 if(u.pathname==='/api/payments/webhook')return payment.webhook(req,e);
 return payment.user(req,e,req.headers.get('x-fixture-user')||'u-12345678-1234-4123-8123-123456789abc');
}};
