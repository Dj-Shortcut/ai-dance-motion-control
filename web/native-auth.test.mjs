import test from 'node:test';
import assert from 'node:assert/strict';
import {handleNativeSiteLogin} from './native-sites-login.mjs';
import {nativeApiPath,nativePath} from './native-api.mjs';
import {nativePkceChallenge,NATIVE_CALLBACK} from './native-auth.mjs';
import {passkeyOrigin,nativeTransportEnvironment,configuredAndroidOrigin} from './native-passkey.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',state='s'.repeat(43),challenge=await nativePkceChallenge('v'.repeat(43)),query='?challenge='+challenge+'&state='+state;
const readBytes=async(stream,max)=>{const value=new Uint8Array(await new Response(stream).arrayBuffer());if(value.length>max)throw Error('size');return value;};
const env={RIG_SITES_PRODUCER_ORIGIN:SITE};
const req=(path,body,headers={})=>new Request(SITE+path,{method:body===undefined?'GET':'POST',headers:body===undefined?headers:{origin:SITE,'content-type':'application/x-www-form-urlencoded',...headers},...(body===undefined?{}:{body})});

test('native browser login preserves PKCE/state through platform login and requires explicit same-origin consent',async()=>{
 const anonymous=await handleNativeSiteLogin(req('/native/signin'+query),env,{context:async()=>null,readBytes}),html=await anonymous.text();assert.match(html,/Inloggen met ChatGPT/);assert.ok(html.includes(encodeURIComponent('/native/signin'+query)));assert.equal(anonymous.headers.get('cache-control'),'private, no-store');assert.match(anonymous.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const calls=[],context=async()=>({session:{mode:'live'},request:async(path,options)=>{calls.push({path,options});return Response.json({code:'c'.repeat(43),expiresAt:Date.now()+300000},{status:201});}});
 const consent=await handleNativeSiteLogin(req('/native/signin'+query),env,{context,readBytes});assert.match(await consent.text(),/Doorgaan op je telefoon/);assert.equal(calls.length,0);assert.equal(consent.headers.get('referrer-policy'),'same-origin');assert.match(consent.headers.get('content-security-policy'),/form-action 'self'/);
 const finish=await handleNativeSiteLogin(req('/native/authorize','challenge='+challenge+'&state='+state),env,{context,readBytes}),body=await finish.text();assert.equal(finish.headers.get('referrer-policy'),'no-referrer');assert.match(body,/Open RIG/);assert.ok(body.includes(NATIVE_CALLBACK+'?code='+'c'.repeat(43)+'&amp;state='+state));assert.doesNotMatch(body,/accessToken|refreshToken|rig_native_/);assert.equal(calls[0].path,'/api/internal/native-auth/authorize');assert.deepEqual(JSON.parse(calls[0].options.body),{challenge});
 assert.equal((await handleNativeSiteLogin(req('/native/authorize','challenge='+challenge+'&state='+state,{origin:'https://attacker.invalid'}),env,{context,readBytes})).status,400);assert.equal(calls.length,1);
 assert.equal((await handleNativeSiteLogin(req('/native/authorize','challenge='+challenge+'&state='+state,{origin:'null'}),env,{context,readBytes})).status,400);assert.equal(calls.length,1);
});

test('native login rejects redirect substitution, duplicate parameters, cross-site writes and malformed bodies',async()=>{
 let calls=0;const context=async()=>{calls++;return {session:{mode:'live'}};};
 for(const path of ['/native/signin'+query+'&redirect=https://attacker.invalid','/native/signin'+query+'&state=other','/native/signin?challenge=no&state='+state,'/native/signin?challenge='+challenge+'&state=short'])assert.equal((await handleNativeSiteLogin(req(path),env,{context,readBytes})).status,400);
 assert.equal((await handleNativeSiteLogin(req('/native/authorize','challenge='+challenge+'&state='+state,{'sec-fetch-site':'cross-site'}),env,{context,readBytes})).status,400);
 assert.equal((await handleNativeSiteLogin(req('/native/authorize','challenge='+challenge+'&state='+state+'&userId=victim'),env,{context,readBytes})).status,400);assert.equal(calls,0);
});

test('native path mapping has no financial administration, Mollie, callback or arbitrary query surface',()=>{
 assert.equal(nativePath('/api/native/auth/exchange','POST'),true);assert.equal(nativePath('/api/native/auth/logout','POST'),true);assert.equal(nativePath('/api/native/auth/exchange?redirect=bad','POST'),false);
 for(const path of ['/api/native/payments/create','/api/native/owner/finance','/api/native/owner/users','/api/native/internal/account-activity','/api/native/chatgpt/quote-approvals','/api/native/session?userId=other','/api/native/owner/security/registration/options','/api/native/../../owner/finance'])assert.equal(nativeApiPath(path,'POST'),null,path);
 assert.equal(nativeApiPath('/api/native/session','GET'),'/api/session');assert.equal(nativeApiPath('/api/native/owner/security','GET'),'/api/owner/security');assert.equal(nativeApiPath('/api/native/owner/security/verification/options','POST'),'/api/owner/security/verification/options');
 const intent='/api/native/generation-intents/rigchatgpt_12345678-1234-4123-8123-123456789abc/reconcile';assert.equal(nativeApiPath(intent,'POST'),intent.replace('/api/native/','/api/'));assert.equal(nativeApiPath(intent+'?userId=other','POST'),null);assert.equal(nativeApiPath(intent,'GET'),null);
});

test('only an internal native capability enables exactly the configured signing certificate',()=>{
 const fingerprint=Array(32).fill('BA').join(':'),config={RIG_NATIVE_ANDROID_SIGNING_SHA256:fingerprint};
 assert.equal(passkeyOrigin(config,SITE),SITE);assert.equal(passkeyOrigin({...config,nativeTransport:true,expectedOrigin:'https://attacker.invalid'},SITE),SITE);
 assert.equal(passkeyOrigin(nativeTransportEnvironment({}),SITE),null);const origin=configuredAndroidOrigin(config);assert.equal(origin,'android:apk-key-hash:'+Buffer.alloc(32,0xba).toString('base64url'));assert.equal(passkeyOrigin(nativeTransportEnvironment(config),SITE),origin);assert.equal(configuredAndroidOrigin({RIG_NATIVE_ANDROID_SIGNING_SHA256:'attacker'}),null);
});
