import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createBrowserAuth} from './browser-auth.mjs';
import {captureSponsorInvitation,mountSponsorInvitation} from './frontend/multiuser/invitation.mjs';

const code='A'.repeat(43),storageKey='rig-sponsored-invitation:v1';
const alice='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const page=(suffix='',storage)=>{
 const dom=new JSDOM('<div id="rigStudio"><header>RIG</header><main>Studio</main></div>',{url:'https://rig.example/'+suffix});
 const browser={location:dom.window.location,history:dom.window.history,sessionStorage:storage||dom.window.sessionStorage};
 return {dom,browser,document:dom.window.document,close:()=>dom.window.close()};
};
const bind=(request,userId=alice)=>({userId,isActive:()=>true,request});
const waitFor=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('Invitation UI did not settle')};

test('fragment is scrubbed before Google sign-in and survives the same-tab OAuth return without entering OAuth URLs',async()=>{
 const first=page('studio?view=create#invite='+code),storage=first.browser.sessionStorage;
 try{
  const invitation=captureSponsorInvitation({browser:first.browser});
  assert.ok(invitation);assert.deepEqual(Object.keys(invitation),[]);
  assert.equal(first.browser.location.href,'https://rig.example/studio?view=create');
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)),{code,userId:null});
  let destination,options;
  const auth=createBrowserAuth({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixturekey12345',callbackUrl:'https://rig.example/auth/callback',
   browser:{...first.browser,location:{get href(){return first.browser.location.href},assign:value=>{destination=value}}},
   clientFactory:()=>({auth:{signInWithOAuth:async input=>{options=input;return {data:{url:'https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize?provider=google'}}}}}),
  });
  await auth.beginGoogleSignIn();
  assert.equal(options.options.redirectTo,'https://rig.example/auth/callback');
  assert.equal(destination.includes(code),false);
  const returned=page('auth/callback?code=oauth_fixture',storage);
  try{
   const pending=captureSponsorInvitation({browser:returned.browser});
   assert.ok(pending);assert.equal(returned.browser.location.hash,'');
   let calls=0;const ui=mountSponsorInvitation({invitation:pending,binding:bind(async()=>{calls++;return Response.json({state:'redeemed',amountCents:500})}),document:returned.document});
   assert.ok(ui);assert.equal(calls,0,'returning from OAuth never redeems automatically');
   assert.equal(ui.element.querySelector('button').textContent,'Activeer gratis €5 testtegoed');
  }finally{returned.close()}
 }finally{first.close()}
});

test('ordinary users and malformed fragments get no invitation action or request',()=>{
 for(const suffix of ['', '#invite=short', '#invite='+code+'&invite='+code, '#invite=%3Cimg%20src=x%3E']){
  const p=page(suffix);try{
   let calls=0;const invitation=captureSponsorInvitation({browser:p.browser});
   assert.equal(invitation,null);assert.equal(p.browser.location.hash,'');
   assert.equal(mountSponsorInvitation({invitation,binding:bind(()=>{calls++}),document:p.document}),null);
   assert.equal(p.document.querySelector('button'),null);assert.equal(calls,0);
  }finally{p.close()}
 }
});

test('successful explicit activation uses an authenticated JSON POST, clears the secret, and refreshes the UI',async()=>{
 const p=page('#invite='+code),calls=[];let refreshed=0,callbackCalls=0;
 try{
  const invitation=captureSponsorInvitation({browser:p.browser});
  p.document.addEventListener('rig-balance-changed',()=>refreshed++);
  const ui=mountSponsorInvitation({invitation,binding:bind(async(path,options)=>{calls.push({path,options});return Response.json({state:'redeemed',amountCents:500})}),document:p.document,
   onRedeemed:async()=>{callbackCalls++;assert.equal(p.browser.sessionStorage.getItem(storageKey),null);throw Error('video capability temporarily unavailable')},
  });
  assert.equal(ui.element.nextElementSibling,p.document.querySelector('main'));
  assert.equal(calls.length,0);const button=ui.element.querySelector('button');button.click();button.click();
  await waitFor(()=>callbackCalls===1);
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/sponsor-invitations/redeem');
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body),{code});
  assert.equal(p.browser.location.href.includes(code),false);assert.equal(ui.element.textContent.includes(code),false);
  assert.equal(p.browser.sessionStorage.getItem(storageKey),null);assert.equal(refreshed,1);
  assert.equal(button.hidden,true);assert.match(ui.element.textContent,/testtegoed is actief/);
 }finally{p.close()}
});

test('invalid, expired and already-used responses erase the invitation without showing server text',async()=>{
 for(const [status,state] of [[200,'unavailable'],[404,'invalid'],[410,'expired']]){
  const p=page('#invite='+code);try{
   const invitation=captureSponsorInvitation({browser:p.browser});
   const ui=mountSponsorInvitation({invitation,binding:bind(async()=>Response.json({state,error:'<img src=x onerror=alert(1)>'+code},{status})),document:p.document});
   ui.element.querySelector('button').click();
   await waitFor(()=>p.browser.sessionStorage.getItem(storageKey)===null);
   assert.match(ui.element.textContent,/niet meer beschikbaar/);assert.equal(ui.element.querySelector('button').hidden,true);
   assert.equal(ui.element.querySelector('img'),null);assert.equal(ui.element.textContent.includes(code),false);
  }finally{p.close()}
 }
});

test('an owner preview consumes no invitation and displays fixed sharing guidance',async()=>{
 const p=page('#invite='+code);let callbacks=0;
 try{
  const invitation=captureSponsorInvitation({browser:p.browser});
  const ui=mountSponsorInvitation({invitation,binding:bind(async()=>Response.json({state:'owner',message:'<img src=x>'+code})),document:p.document,onRedeemed:()=>callbacks++});
  ui.element.querySelector('button').click();await waitFor(()=>p.browser.sessionStorage.getItem(storageKey)===null);
  assert.match(ui.element.textContent,/voor je tester/);assert.equal(ui.element.querySelector('button').hidden,true);
  assert.equal(ui.element.querySelector('img'),null);assert.equal(ui.element.textContent.includes(code),false);assert.equal(callbacks,0);
 }finally{p.close()}
});

test('a lost response preserves the first verified account across reloads and reopening the invitation',async()=>{
 const first=page('#invite='+code),storage=first.browser.sessionStorage;let calls=0;
 try{
  const invitation=captureSponsorInvitation({browser:first.browser});
  const firstUi=mountSponsorInvitation({invitation,binding:bind(async()=>{calls++;throw Error('response lost')}),document:first.document});
  firstUi.element.querySelector('button').click();
  await waitFor(()=>firstUi.element.textContent.includes('ditzelfde account'));
  assert.deepEqual(JSON.parse(storage.getItem(storageKey)),{code,userId:alice});
  const switched=page('#invite='+code,storage);
  try{
   const reopened=captureSponsorInvitation({browser:switched.browser});
   const other=mountSponsorInvitation({invitation:reopened,binding:bind(async()=>{calls++;return Response.json({state:'redeemed',amountCents:500})},bob),document:switched.document});
   assert.equal(other.element.querySelector('button').hidden,true);
   other.element.querySelector('button').click();await new Promise(resolve=>setTimeout(resolve,1));
   assert.equal(calls,1);assert.equal(JSON.parse(storage.getItem(storageKey)).userId,alice);
  }finally{switched.close()}
  const retry=page('',storage);
  try{
   const pending=captureSponsorInvitation({browser:retry.browser});
   const ui=mountSponsorInvitation({invitation:pending,binding:bind(async()=>{calls++;return Response.json({state:'redeemed',amountCents:500})}),document:retry.document});
   ui.element.querySelector('button').click();await waitFor(()=>storage.getItem(storageKey)===null);
   assert.equal(calls,2);assert.match(ui.element.textContent,/testtegoed is actief/);
  }finally{retry.close()}
 }finally{first.close()}
});

test('session, rate-limit and service errors remain retryable only by the pinned account',async()=>{
 for(const status of [401,403,429,503]){
  const p=page('#invite='+code);try{
   const invitation=captureSponsorInvitation({browser:p.browser});
   const ui=mountSponsorInvitation({invitation,binding:bind(async()=>Response.json({state:'unavailable'},{status})),document:p.document});
   ui.element.querySelector('button').click();await waitFor(()=>ui.element.textContent.includes('ditzelfde account'));
   assert.deepEqual(JSON.parse(p.browser.sessionStorage.getItem(storageKey)),{code,userId:alice});
   assert.equal(ui.element.querySelector('button').disabled,false);
  }finally{p.close()}
 }
});

test('an unreadable or unrecognized success response keeps the pinned invitation for a safe retry',async()=>{
 for(const response of [new Response('not JSON'),Response.json({state:'redeemed',amountCents:50000}),Response.json({state:'unexpected'})]){
  const p=page('#invite='+code);try{
   const invitation=captureSponsorInvitation({browser:p.browser});
   const ui=mountSponsorInvitation({invitation,binding:bind(async()=>response),document:p.document});
   ui.element.querySelector('button').click();await waitFor(()=>ui.element.textContent.includes('ditzelfde account'));
   assert.deepEqual(JSON.parse(p.browser.sessionStorage.getItem(storageKey)),{code,userId:alice});
  }finally{p.close()}
 }
});

test('failed, inactive, changed and disposed bindings cannot send an activation request',async()=>{
 const p=page('#invite='+code);let calls=0,active=true;
 try{
  const invitation=captureSponsorInvitation({browser:p.browser});
  const request=async()=>{calls++;return Response.json({state:'redeemed',amountCents:500})};
  for(const binding of [null,bind(request,'unverified'),{...bind(request),isActive:()=>false}]){
   assert.equal(mountSponsorInvitation({invitation,binding,document:p.document}),null);
  }
  const binding={...bind(request),isActive:()=>active};
  const ui=mountSponsorInvitation({invitation,binding,document:p.document});
  const button=ui.element.querySelector('button');active=false;button.click();active=true;
  binding.userId=bob;button.click();binding.userId=alice;
  ui.dispose();button.click();await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(calls,0);assert.equal(JSON.parse(p.browser.sessionStorage.getItem(storageKey)).userId,null);
 }finally{p.close()}
});

test('unusable storage fails closed and disposal suppresses a late completion callback',async()=>{
 const p=page('#invite='+code);try{
  const unavailable={getItem:()=>null,setItem:()=>{throw Error('blocked')},removeItem:()=>{}};
  assert.equal(captureSponsorInvitation({browser:{...p.browser,sessionStorage:unavailable}}),null);
  assert.equal(p.browser.location.hash,'');
 }finally{p.close()}
 const late=page('#invite='+code);let resolve,callbacks=0,events=0;
 try{
  const invitation=captureSponsorInvitation({browser:late.browser});
  late.document.addEventListener('rig-balance-changed',()=>events++);
  const ui=mountSponsorInvitation({invitation,binding:bind(()=>new Promise(done=>{resolve=done})),document:late.document,onRedeemed:()=>callbacks++});
  ui.element.querySelector('button').click();ui.dispose();resolve(Response.json({state:'redeemed',amountCents:500}));
  await waitFor(()=>late.browser.sessionStorage.getItem(storageKey)===null);
  assert.equal(callbacks,0);assert.equal(events,0);assert.equal(late.document.querySelector('.sponsor-invitation'),null);
 }finally{late.close()}
});
