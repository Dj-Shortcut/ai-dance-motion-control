// Disposable test fixture. All provider requests are intercepted locally.
import {createClosedPrivateWorker} from './closed-private-worker.mjs';
let scenario='',calls=[];
const fake=async(input,init={})=>{
 const url=new URL(input);calls.push({path:url.pathname+url.search,method:init.method});
 if(init.method!=='GET'||init.redirect!=='manual'||new Headers(init.headers).get('authorization')!=='Bearer live_fixture')throw Error('Unexpected provider request');
 if(scenario==='provider_error')return Response.json({secret:'never expose this provider error'}, {status:401});
 if(scenario==='redirect')return new Response(null,{status:302,headers:{location:'https://untrusted.invalid/'}});
 if(scenario==='large')return Response.json({padding:'x'.repeat(33000)});
 if(scenario==='bad_mime')return new Response('<html>private details</html>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/v2/profiles/me')return Response.json({id:scenario==='wrong_profile'?'pfl_OTHERPROFILE':'pfl_TESTPROFILE',status:scenario==='blocked'?'blocked':'verified',name:'Private name must not be returned',website:'https://private.example'});
 if(url.pathname==='/v2/methods'&&url.search==='?amount[value]=5.00&amount[currency]=EUR&locale=nl_BE'){
  if(scenario==='empty')return Response.json({count:0,_embedded:{methods:[]}});
  if(scenario==='missing')return Response.json({count:1,_embedded:{}});
  if(scenario==='bad_count')return Response.json({count:2,_embedded:{methods:[{id:'bancontact'}]}});
  if(scenario==='duplicate')return Response.json({count:2,_embedded:{methods:[{id:'bancontact'},{id:'bancontact'}]}});
  if(scenario==='array_id')return Response.json({count:1,_embedded:{methods:[{id:['ideal']}]}});
  if(scenario==='unsafe_id')return Response.json({count:1,_embedded:{methods:[{id:'https://untrusted.invalid'}]}});
  return Response.json({count:2,_embedded:{methods:[{id:'bancontact',description:'private extra ignored'},{id:'ideal'}]}});
 }
 throw Error('Unexpected destination');
};
const app=createClosedPrivateWorker({network:fake});
export default {async fetch(req,env){
 const url=new URL(req.url);
 if(url.pathname==='/fixture/scenario'){scenario=url.searchParams.get('value')||'';calls=[];return Response.json({ok:true})}
 if(url.pathname==='/fixture/calls')return Response.json(calls);
 return app.fetch(req,{...env,RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRIVATE_SERVICE_ONLY:'yes',MOLLIE_LIVE_API_KEY:'live_fixture',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_TESTPROFILE',RIG_PRODUCTION_ENVIRONMENT_ID:'prod-fixture',RIG_PRODUCTION_SITE_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_SITE_ORIGIN:'https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://rig-api.shortcut-computerguy.workers.dev',RIG_PRODUCTION_WEBHOOK_URL:'https://rig-api.shortcut-computerguy.workers.dev/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[{"id":"small","amountCents":500,"credits":500}]',RIG_PRODUCTION_SITES_BRIDGE_KEY:'ab'.repeat(32)});
}};
