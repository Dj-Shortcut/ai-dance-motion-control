import test from 'node:test';
import assert from 'node:assert/strict';
import {createRigSitesApp} from './rig-sites-app.mjs';

const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const user='u-11111111-1111-4111-8111-111111111111';
const env={RIG_SITES_PRODUCER_ORIGIN:origin,RIG_SITES_PROJECT_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',RIG_PRODUCTION_BRIDGE_ORIGIN:'https://rig-api.shortcut-computerguy.workers.dev',RIG_PRODUCTION_SITES_BRIDGE_KEY:'a'.repeat(64)};
const identity={'oai-authenticated-user-id':'native-platform-subject','x-rig-expected-user':user};
function fixture(){
 const forwarded=[];
 const app=createRigSitesApp({uiFiles:{},fetchImpl:async request=>{
  forwarded.push(new URL(request.url).pathname);
  assert.equal(new URL(request.url).pathname,'/api/session','a prepared store endpoint must never forward a purchase or payment');
  return Response.json({userId:user,currency:'EUR',mode:'live',balanceCents:500,purchasesEnabled:true});
 }});
 return {app,forwarded};
}

test('unconfigured Play cannot be activated by flags, client tokens or existing Mollie readiness',async()=>{
 const {app,forwarded}=fixture();
 const configuration=await app.fetch(new Request(origin+'/api/payments/google-play/config',{headers:identity}),{...env,RIG_GOOGLE_PLAY_ENABLED:'yes'});
 assert.equal(configuration.status,200);assert.deepEqual(await configuration.json(),{enabled:false});assert.equal(configuration.headers.get('cache-control'),'no-store');
 const confirmation=await app.fetch(new Request(origin+'/api/payments/google-play/confirm',{method:'POST',headers:{...identity,origin,'content-type':'application/json'},body:JSON.stringify({productId:'rig_credit_5',purchaseToken:'unverified-client-receipt',creditsCents:500})}),env);
 assert.equal(confirmation.status,503);assert.equal((await confirmation.json()).code,'google_play_not_configured');
 assert.deepEqual(forwarded,['/api/session','/api/session']);
});

test('prepared Play endpoints keep native account, CSRF and query guards',async()=>{
 const {app,forwarded}=fixture();
 assert.equal((await app.fetch(new Request(origin+'/api/payments/google-play/config'),env)).status,401);
 assert.equal(forwarded.length,0);
 assert.equal((await app.fetch(new Request(origin+'/api/payments/google-play/config',{headers:{...identity,'x-rig-expected-user':'u-22222222-2222-4222-8222-222222222222'}}),env)).status,403);
 for(const [path,method,headers]of [
  ['/api/payments/google-play/config?enable=yes','GET',identity],
  ['/api/payments/google-play/config','POST',{...identity,origin}],
  ['/api/payments/google-play/confirm','GET',identity],
  ['/api/payments/google-play/confirm?token=secret','POST',{...identity,origin}],
 ])assert.equal((await app.fetch(new Request(origin+path,{method,headers}),env)).status,404);
 assert.equal((await app.fetch(new Request(origin+'/api/payments/google-play/confirm',{method:'POST',headers:{...identity,origin:'https://attacker.invalid'}}),env)).status,403);
 assert.ok(forwarded.every(path=>path==='/api/session'));
});

test('Android manifest and certificate association are public fixed data, never identity-bearing',async()=>{
 const {app,forwarded}=fixture();
 const response=await app.fetch(new Request(origin+'/android/manifest.webmanifest'),env),manifest=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/manifest+json');
 assert.equal(manifest.start_url,'/android/');assert.equal(manifest.scope,'/android/');assert.equal(manifest.name,'RIG');
 assert.deepEqual(manifest.icons,[{src:'/favicon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]);
 const certificate=Array.from({length:32},(_,i)=>i.toString(16).padStart(2,'0')).join(':');
 const associated=await app.fetch(new Request(origin+'/.well-known/assetlinks.json'),{...env,RIG_ANDROID_APP_SIGNING_SHA256:certificate});
 assert.deepEqual(await associated.json(),[{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'dev.andyarijs.rig',sha256_cert_fingerprints:[certificate.toUpperCase()]}}]);
 for(const fingerprint of [undefined,'',certificate+'\n','-----BEGIN '+'PRIVATE KEY-----','AA:BB',{certificate}]){
  const result=await app.fetch(new Request(origin+'/.well-known/assetlinks.json'),{...env,RIG_ANDROID_APP_SIGNING_SHA256:fingerprint});assert.deepEqual(await result.json(),[]);
 }
 for(const path of ['/android/manifest.webmanifest','/.well-known/assetlinks.json']){
  assert.equal((await app.fetch(new Request(origin+path,{method:'HEAD'}),env)).body,null);
  assert.equal((await app.fetch(new Request(origin+path+'?user=private'),env)).status,404);
  assert.equal((await app.fetch(new Request(origin+path,{method:'POST'}),env)).status,404);
 }
 assert.equal(forwarded.length,0);
});
