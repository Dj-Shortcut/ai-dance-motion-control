import test from 'node:test';
import assert from 'node:assert/strict';
import {sitesGooglePlayPath,sitesPath,signSitesBridgeRequest,SITE_HEADER_NAMES} from './sites-bridge-protocol.mjs';
import relay from './production-ingress.mjs';
const origin='https://rig-api.shortcut-computerguy.workers.dev',site='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',id='12345678-1234-4123-8123-123456789abc';
test('Google customer paths are signed exact operations; tokens, amount queries and RTDN cannot enter the browser bridge',async()=>{
 for(const [path,method]of [['/api/payments/google-play/config','GET'],['/api/payments/google-play/status','GET'],['/api/payments/google-play/status?intentId='+id,'GET'],['/api/payments/google-play/intents','POST'],['/api/payments/google-play/confirm','POST']]){
  assert.equal(sitesGooglePlayPath(path,method),true);assert.equal(sitesPath(path,method),true);
  const req=await signSitesBridgeRequest({env:{RIG_SITES_PROJECT_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_SITES_PRODUCER_ORIGIN:site,RIG_SITES_BRIDGE_ORIGIN:origin,RIG_SITES_BRIDGE_KEY:'a'.repeat(64)},subject:'platform-user',path,method});assert.match(req.headers.get(SITE_HEADER_NAMES.signature),/^[a-f0-9]{64}$/);
 }
 for(const path of ['/api/payments/google-play/rtdn','/api/payments/google-play/confirm?token=private','/api/payments/google-play/status?intentId='+id+'&owner=yes','/api/payments/google-play/status?intentId=wrong','/api/payments/google-play/status?intentId='+id.toUpperCase(),'/api/payments/google-play/config?enable=yes'])for(const method of ['GET','POST'])assert.equal(sitesPath(path,method),false,path);
});
test('only the exact Google webhook forwards its bounded OIDC authorization, never cookies or forged customer identity',async()=>{
 const calls=[],env={RIG_PRODUCTION_RELAY_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:origin,RIG_PUBLIC_LIMITER:{limit:async()=>({success:true})},CLOSED_VIDEO_SERVICE:{fetch:async req=>{calls.push(req);return Response.json({received:true})}}};
 const request=(path,headers={},method='POST')=>new Request(origin+path,{method,headers:{'cf-connecting-ip':'192.0.2.1','content-type':'application/json',authorization:'Bearer signed.jwt.token',cookie:'private-cookie','oai-authenticated-user-id':'forged',[SITE_HEADER_NAMES.signature]:'b'.repeat(64),...headers},...(method==='POST'?{body:'{}'}:{})});
 assert.equal((await relay.fetch(request('/api/payments/google-play/rtdn'),env)).status,200);assert.equal(calls.length,1);assert.deepEqual([...calls[0].headers.entries()],[['authorization','Bearer signed.jwt.token'],['content-type','application/json']]);
 for(const [path,headers,method]of [['/api/payments/google-play/rtdn?token=private',{},'POST'],['/api/payments/google-play/rtdn',{},'GET'],['/api/payments/google-play/rtdn',{authorization:''},'POST'],['/api/payments/google-play/rtdn',{'content-length':'49153'},'POST'],['/api/payments/google-play/rtdn',{'content-type':'text/html'},'POST']])assert.ok([400,401,404,413].includes((await relay.fetch(request(path,headers,method),env)).status));
 assert.equal(calls.length,1);
 assert.equal((await relay.fetch(request('/api/payments/google-play/confirm',{origin:site}),env)).status,200);assert.equal(calls[1].headers.get('authorization'),null);assert.equal(calls[1].headers.get('cookie'),null);
});
