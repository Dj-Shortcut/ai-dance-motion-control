import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createRigSitesApp} from './rig-sites-app.mjs';
import {startNativeSiteApp} from './frontend/multiuser/native-site-boot.mjs';

const origin='https://rig.example.chatgpt.site',user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const marker='<meta name="rig-app-channel" content="google-play">';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');

test('only the explicit Android entry receives its server-built channel marker',async()=>{
 const web='<head></head><h1>RIG website</h1>',android='<head>'+marker+'</head><h1>RIG Android</h1>';
 const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':web,'/android/index.html':android},fetchImpl:()=>{throw Error('HTML does not contact private services');}}),env={RIG_SITES_PRODUCER_ORIGIN:origin};
 for(const path of ['/','/multiuser/','/?fbclid=shared']){
  const response=await app.fetch(new Request(origin+path),env);assert.equal(response.status,200);assert.equal(await response.text(),web);assert.doesNotMatch(response.headers.get('permissions-policy'),/payment=/);
 }
 for(const path of ['/android/','/android/?utm_source=play']){
  const response=await app.fetch(new Request(origin+path),env);assert.equal(response.status,200);assert.equal(await response.text(),android);assert.match(response.headers.get('permissions-policy'),/^payment=\(self\)/);
 }
 for(const path of ['/android/index.html','/android/?payment=return','/android/?channel=mollie','/?channel=google-play'])assert.equal((await app.fetch(new Request(origin+path),env)).status,404,path);
});

async function boot({path='/android/',marked=true,signedIn=true}={}){
 const dom=new JSDOM(marked?html.replace('<head>','<head>'+marker):html,{url:origin+path}),w=dom.window,loaded=[],calls=[];
 for(const dialog of w.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 const auth={currentSession:async()=>signedIn,sessionSubject:async()=>user,watchSession:()=>()=>{},dispose(){},api:async(path)=>{calls.push(path);return Response.json(path==='/api/session'?{userId:user}:{enabled:false});}};
 const app=await startNativeSiteApp({window:w,auth,loadScript:async name=>{loaded.push(name);}});
 return {dom,w,d:w.document,loaded,calls,app,close(){app.dispose();dom.window.close();}};
}

test('Android boot keeps native sign-in/logout in Android and never loads the Mollie script',async()=>{
 const f=await boot();
 try{
  assert.equal(f.w.rigPaymentChannel,'google-play');assert.equal(f.loaded.includes('google-play-payments.js'),true);assert.equal(f.loaded.includes('payments.js'),false);
  assert.equal(f.d.getElementById('authLogin').getAttribute('href'),'/signin-with-chatgpt?return_to=%2Fandroid%2F');assert.equal(f.d.getElementById('authLogout').getAttribute('href'),'/signout-with-chatgpt?return_to=%2Fandroid%2F');
  await assert.rejects(f.w.rigCheckout('https://www.mollie.com/checkout/test'),/Google Play/);
  for(const path of ['/api/payments/create','/api/payments/packages','/api/payments/orders/old/reconcile'])await assert.rejects(async()=>f.w.rigRequest(path,{method:'POST'}),/Google Play/);
  assert.equal(f.calls.some(path=>path==='/api/payments/create'),false);
  await f.w.rigRequest('/api/payments/google-play/config');assert.equal(f.calls.at(-1),'/api/payments/google-play/config');
 }finally{f.close();}
});

test('a missing Android marker fails closed rather than loading Mollie',async()=>{
 const f=await boot({marked:false});
 try{assert.equal(f.loaded.length,0);assert.equal(f.d.getElementById('rigStudio').hidden,true);assert.match(f.d.getElementById('authStatus').textContent,/Android-versie.*niet beschikbaar/);}finally{f.close();}
});

test('an Android visitor can sign in without loading purchase or studio code',async()=>{
 const f=await boot({signedIn:false});
 try{assert.equal(f.loaded.length,0);assert.equal(f.d.getElementById('authLogin').hidden,false);assert.equal(f.d.getElementById('authLogin').getAttribute('href'),'/signin-with-chatgpt?return_to=%2Fandroid%2F');}finally{f.close();}
});

test('the ordinary website ignores misplaced markers and retains its existing Mollie flow',async()=>{
 const f=await boot({path:'/',marked:true});
 try{assert.equal(f.w.rigPaymentChannel,'mollie');assert.equal(f.loaded.includes('payments.js'),true);assert.equal(f.loaded.includes('google-play-payments.js'),false);assert.equal(f.d.getElementById('authLogin').getAttribute('href'),'/signin-with-chatgpt?return_to=%2F');assert.equal(f.d.getElementById('authLogout').getAttribute('href'),'/signout-with-chatgpt');}finally{f.close();}
});
