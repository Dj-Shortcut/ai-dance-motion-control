import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createOwnerVerification} from './frontend/multiuser/owner-security-client.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Security UI did not settle');};
const candidateId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const options=(number=1)=>({challengeId:'11111111-1111-4111-8111-'+String(number).padStart(12,'0'),expiresAt:Date.now()+60000,publicKey:{challenge:'test-only-challenge-'+number,userVerification:'required'},summary:'Daglimiet Fal: US$10 → US$15'});
function fixture({handler,supported=true,authenticate,register}={}){
 const dom=new JSDOM('<button id="authLogout">Afmelden</button><section id="security"></section>',{url:'https://rig.example.chatgpt.site/'}),win=dom.window,d=win.document,calls=[],authCalls=[],registerCalls=[],timers=new Map();
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;};
 let live=true,cancelled=0,timerSequence=0;
 win.rigNativeSite=true;win.rigSessionActive=()=>live;
 win.setTimeout=callback=>{const id=++timerSequence;timers.set(id,callback);return id;};win.clearTimeout=id=>timers.delete(id);
 win.rigRequest=async(path,init={})=>{
  const call={path,init,body:init.body?JSON.parse(init.body):undefined};calls.push(call);
  if(handler)return handler(call,calls);
  if(path==='/api/owner/security')return Response.json({configured:false,activeCredentialCount:0,credentials:[]});
  if(path.endsWith('/options'))return Response.json(options(calls.length));
  if(path.endsWith('/registration/verify'))return Response.json({candidateId,fingerprint:'test-only-public-fingerprint',status:'pending'});
  return Response.json({status:'pending'});
 };
 const client=createOwnerVerification({window:win,webauthn:{browserSupportsWebAuthn:()=>supported,startAuthentication:async value=>{authCalls.push(value);return authenticate?authenticate(value):{id:'test-only-assertion-'+authCalls.length};},startRegistration:async value=>{registerCalls.push(value);return register?register(value):{id:'test-only-registration'};},cancel:()=>{cancelled++;}}});
 return {dom,win,d,calls,authCalls,registerCalls,timers,client,mount(){client.mount(d.getElementById('security'));},stop(){live=false;},cancelled:()=>cancelled,async poll(){const next=timers.entries().next().value;if(next){timers.delete(next[0]);await next[1]();await new Promise(r=>setTimeout(r,5));}},close(){client.dispose();dom.window.close();}};
}
const approve=f=>f.d.querySelector('.owner-verification-dialog button').click();
const setup=f=>f.d.querySelector('#security button').click();
const refresh=f=>f.d.querySelectorAll('#security button')[1].click();

test('loading or reading the owner security panel never opens an authenticator',async()=>{
 const f=fixture();try{
  assert.equal(f.calls.length,0);f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Stel eerst'));
  assert.deepEqual(f.calls.map(call=>call.path),['/api/owner/security']);assert.equal(f.authCalls.length,0);assert.equal(f.registerCalls.length,0);assert.equal(f.d.querySelector('dialog'),null);
 }finally{f.close();}
});

test('explicit setup verifies the credential but remains pending until separate approval',async()=>{
 let active=false;const f=fixture({handler:call=>{
  if(call.path==='/api/owner/security')return Response.json({configured:active,activeCredentialCount:active?1:0,credentials:[]});
  if(call.path.endsWith('/registration/options'))return Response.json(options());
  if(call.path.endsWith('/registration/verify'))return Response.json({candidateId,fingerprint:'test-only-public-fingerprint',status:'pending'});
  return Response.json({status:active?'active':'pending'});
 }});try{
  f.mount();await waitFor(()=>f.calls.length===1);setup(f);await waitFor(()=>f.d.querySelector('.owner-security-pending').hidden===false);
  assert.equal(f.registerCalls.length,1);assert.equal(f.authCalls.length,0);assert.match(f.d.getElementById('security').textContent,/Wacht op aparte goedkeuring/);assert.match(f.d.getElementById('security').textContent,/test-only-public-fingerprint/);
  assert.deepEqual(f.calls.find(call=>call.path.endsWith('/registration/verify')).body,{challengeId:options().challengeId,credential:{id:'test-only-registration'}});
  await f.poll();assert.doesNotMatch(f.d.querySelector('.finance-status').textContent,/verificatie actief/);
  active=true;await f.poll();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('verificatie actief'));assert.equal(f.d.querySelector('.owner-security-pending').hidden,true);
 }finally{f.close();}
});

test('cancelling during registration options prevents a late native enrollment prompt',async()=>{
 const delayed=deferred(),f=fixture({handler:call=>call.path.endsWith('/registration/options')?delayed.promise:Response.json({configured:false,activeCredentialCount:0,credentials:[]})});try{
  f.mount();await waitFor(()=>f.calls.length===1);setup(f);await waitFor(()=>f.calls.length===2);f.client.cancel();delayed.resolve(Response.json(options()));await waitFor(()=>!f.d.querySelector('#security button').disabled);
  assert.equal(f.registerCalls.length,0);assert.equal(f.calls.some(call=>call.path.endsWith('/registration/verify')),false);assert.match(f.d.querySelector('.finance-status').textContent,/geannuleerd/);
 }finally{f.close();}
});

test('enrollment returned after logout cannot be verified or displayed',async()=>{
 const delayed=deferred(),f=fixture({register:()=>delayed.promise});try{
  f.mount();await waitFor(()=>f.calls.length===1);setup(f);await waitFor(()=>f.registerCalls.length===1);f.stop();f.d.getElementById('authLogout').click();delayed.resolve({id:'test-only-late-registration'});await new Promise(r=>setTimeout(r,10));
  assert.equal(f.calls.some(call=>call.path.endsWith('/registration/verify')),false);assert.equal(f.d.getElementById('security').textContent,'');assert.equal(f.timers.size,0);
 }finally{f.close();}
});

test('a fresh assertion requires the action summary and explicit confirmation for every write',async()=>{
 const f=fixture();try{
  const payload={expectedVersion:'v1',dailyProviderLimitUsdMicros:15000000};let pending=f.client.prepare('finance-policy',payload);await waitFor(()=>f.d.querySelector('dialog')?.open);
  assert.equal(f.authCalls.length,0);assert.match(f.d.querySelector('dialog').textContent,/US\$10 → US\$15/);assert.deepEqual(f.calls[0].body,{operation:'finance-policy',payload});approve(f);const first=await pending;assert.equal(first.credential.id,'test-only-assertion-1');
  pending=f.client.prepare('finance-policy',payload);await waitFor(()=>f.d.querySelector('dialog')?.open);assert.equal(f.authCalls.length,1);approve(f);const second=await pending;
  assert.notEqual(first.challengeId,second.challengeId);assert.equal(f.authCalls.length,2);assert.equal(f.calls.length,2);assert.equal(f.d.querySelector('dialog'),null);assert.equal(f.win.sessionStorage.length,0);assert.equal(f.win.localStorage.length,0);
 }finally{f.close();}
});

test('only an explicit server-classified safe change may proceed without an assertion',async()=>{
 const f=fixture({handler:()=>Response.json({required:false})});try{
  assert.equal(await f.client.prepare('finance-policy',{expectedVersion:'v1',dailyProviderLimitUsdMicros:5000000}),null);assert.equal(f.authCalls.length,0);assert.equal(f.d.querySelector('dialog'),null);
 }finally{f.close();}
 for(const operation of ['finance-expense','owner-generation']){
  const unexpected=fixture({handler:()=>Response.json({required:false})});try{await assert.rejects(unexpected.client.prepare(operation,{}),{code:'verification_expired'});assert.equal(unexpected.authCalls.length,0);}finally{unexpected.close();}
 }
 for(const invalid of [{},{required:false,challengeId:options().challengeId},{required:true,publicKey:{}}]){
  const malformed=fixture({handler:()=>Response.json(invalid)});try{await assert.rejects(malformed.client.prepare('finance-policy',{}),{code:'verification_expired'});assert.equal(malformed.authCalls.length,0);}finally{malformed.close();}
 }
});

test('structured setup-required responses keep the readable panel and do not start authentication',async()=>{
 const f=fixture({handler:call=>call.path.endsWith('/verification/options')?Response.json({error:'Stel eerst je apparaat in.',code:'owner_security_setup_required'},{status:428}):Response.json({configured:false,activeCredentialCount:0,credentials:[]})});try{
  f.mount();await waitFor(()=>f.calls.length===1);await assert.rejects(f.client.prepare('finance-expense',{amountCents:100}),{code:'owner_security_setup_required',status:428});assert.match(f.d.getElementById('security').textContent,/Extra beveiliging/);assert.equal(f.authCalls.length,0);
 }finally{f.close();}
});

test('cancel and Escape discard the operation before native verification',async()=>{
 for(const escape of [false,true]){const f=fixture();try{
  const pending=f.client.prepare('owner-generation',{quoteId:'quote-test-only',idempotencyKey:'idempotency-test-only'}),rejected=assert.rejects(pending,{code:'verification_cancelled'});await waitFor(()=>f.d.querySelector('dialog')?.open);
  if(escape)f.d.querySelector('dialog').dispatchEvent(new f.win.Event('cancel',{cancelable:true}));else f.d.querySelectorAll('.owner-verification-dialog button')[1].click();await rejected;assert.equal(f.authCalls.length,0);assert.equal(f.d.querySelector('dialog'),null);
 }finally{f.close();}}
});

test('changed action input fails closed both while options and while the authenticator are pending',async()=>{
 for(const stage of ['options','authentication']){
  const delayed=deferred(),payload={amountCents:100};const f=fixture({handler:stage==='options'?()=>delayed.promise:undefined,authenticate:stage==='authentication'?()=>delayed.promise:undefined});try{
   const pending=f.client.prepare('finance-expense',payload),rejected=assert.rejects(pending,{code:'operation_changed'});
   if(stage==='options'){await waitFor(()=>f.calls.length===1);payload.amountCents=200;delayed.resolve(Response.json(options()));}
   else{await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);await waitFor(()=>f.authCalls.length===1);payload.amountCents=200;delayed.resolve({id:'test-only-assertion'});}
   await rejected;assert.equal(f.d.querySelector('dialog'),null);assert.equal(f.calls.length,1);
  }finally{f.close();}
 }
});

test('changed input cannot use even a late safe-decrease response',async()=>{
 const delayed=deferred(),payload={dailyProviderLimitUsdMicros:5000000},f=fixture({handler:()=>delayed.promise});try{
  const pending=f.client.prepare('finance-policy',payload),rejected=assert.rejects(pending,{code:'operation_changed'});await waitFor(()=>f.calls.length===1);payload.dailyProviderLimitUsdMicros=500000000;delayed.resolve(Response.json({required:false}));await rejected;assert.equal(f.authCalls.length,0);
 }finally{f.close();}
});

test('logout or replacement of the session binding discards a late assertion',async()=>{
 for(const binding of [false,true]){const delayed=deferred(),f=fixture({authenticate:()=>delayed.promise});try{
  const pending=f.client.prepare('owner-generation',{quoteId:'test-only-quote'}),rejected=assert.rejects(pending,{code:'session_changed'});await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);await waitFor(()=>f.authCalls.length===1);
  if(binding)f.win.rigRequest=async()=>Response.json({});else{f.stop();f.d.getElementById('authLogout').click();}delayed.resolve({id:'test-only-late-assertion'});await rejected;assert.equal(f.d.querySelector('dialog'),null);assert.ok(f.cancelled()>0);
 }finally{f.close();}}
});

test('expired challenge and expired native assertion cannot be returned',async t=>{
 const f=fixture({handler:()=>Response.json({...options(),expiresAt:Date.now()-1})});try{await assert.rejects(f.client.prepare('finance-policy',{}),{code:'verification_expired'});assert.equal(f.authCalls.length,0);}finally{f.close();}
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 const delayed=deferred(),late=fixture({authenticate:()=>delayed.promise});try{
  const pending=late.client.prepare('finance-expense',{}),rejected=assert.rejects(pending,{code:'verification_expired'});await waitFor(()=>late.d.querySelector('dialog')?.open);approve(late);await waitFor(()=>late.authCalls.length===1);now+=61000;delayed.resolve({id:'test-only-expired-assertion'});await rejected;
 }finally{late.close();}
});

test('unsupported browsers stay readable and offer only a same-origin separate window',async()=>{
 const f=fixture({supported:false});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Stel eerst'));const link=f.d.querySelector('#security a');assert.equal(link.href,'https://rig.example.chatgpt.site/');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(f.d.querySelector('#security button').disabled,true);
  await assert.rejects(f.client.prepare('finance-policy',{}),{code:'browser_unsupported'});assert.equal(f.authCalls.length,0);assert.match(f.d.getElementById('security').textContent,/Extra beveiliging/);
 }finally{f.close();}
});

test('wrapped browser cancellation is readable and frame denial offers a top-level browser hint',async()=>{
 for(const name of ['NotAllowedError','SecurityError']){const f=fixture({authenticate:()=>{throw Object.assign(Error('browser detail'),{cause:{name},code:'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY'});}});try{
  f.mount();await waitFor(()=>f.calls.length===1);const pending=f.client.prepare('finance-policy',{}),rejected=assert.rejects(pending,{code:name==='NotAllowedError'?'verification_cancelled':'browser_unsupported'});await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);await rejected;if(name==='SecurityError')assert.equal(f.d.querySelector('.owner-security-browser-hint a').origin,f.win.location.origin);
 }finally{f.close();}}
});

test('summary and enrollment fingerprint are text and never injected markup',async()=>{
 const injection='<img src=x onerror=alert(1)>',f=fixture({handler:call=>{
  if(call.path==='/api/owner/security')return Response.json({configured:false,activeCredentialCount:0,credentials:[]});
  if(call.path.endsWith('/registration/verify'))return Response.json({candidateId,fingerprint:injection,status:'pending'});
  return Response.json({...options(),summary:injection});
 }});try{
  f.mount();await waitFor(()=>f.calls.length===1);setup(f);await waitFor(()=>f.d.querySelector('.owner-security-pending').hidden===false);assert.match(f.d.getElementById('security').textContent,/<img/);assert.equal(f.d.querySelectorAll('img,script').length,0);
  const pending=f.client.prepare('finance-policy',{}),rejected=assert.rejects(pending,{code:'verification_cancelled'});await waitFor(()=>f.d.querySelector('dialog')?.open);assert.match(f.d.querySelector('dialog').textContent,/<img/);assert.equal(f.d.querySelectorAll('img,script').length,0);f.client.cancel();await rejected;
 }finally{f.close();}
});

test('a non-JSON access denial clears private security state and prevents further requests',async()=>{
 let denied=false;const f=fixture({handler:()=>denied?new Response('<h1>Denied</h1>',{status:403}):Response.json({configured:false,activeCredentialCount:0,credentials:[]})});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Stel eerst'));denied=true;refresh(f);await waitFor(()=>f.d.getElementById('security').textContent==='');await assert.rejects(f.client.prepare('finance-policy',{}),{code:'session_changed'});assert.equal(f.authCalls.length,0);
 }finally{f.close();}
});

test('only one verification may run and malformed operation bodies do not request challenges',async()=>{
 const f=fixture();try{
  for(const [operation,payload]of [['other',{}],['finance-policy',[]],['finance-expense',{verification:{}}]])await assert.rejects(f.client.prepare(operation,payload),{code:'invalid_operation'});assert.equal(f.calls.length,0);
  const pending=f.client.prepare('finance-policy',{}),rejected=assert.rejects(pending,{code:'verification_cancelled'});await waitFor(()=>f.d.querySelector('dialog')?.open);await assert.rejects(f.client.prepare('finance-expense',{}),{code:'verification_busy'});f.client.cancel();await rejected;assert.equal(f.calls.length,1);
 }finally{f.close();}
});

test('manual status check visibly loads and confirms its time without opening an authenticator',async()=>{
 const delayed=deferred();let reads=0;const f=fixture({handler:()=>++reads===1?Response.json({configured:true,activeCredentialCount:1}):delayed.promise});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Extra verificatie actief'));
  refresh(f);const button=f.d.querySelectorAll('#security button')[1];
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Controleren…');assert.match(f.d.querySelector('.finance-status').textContent,/wordt gecontroleerd/);assert.equal(f.d.getElementById('security').getAttribute('aria-busy'),'true');
  button.click();assert.equal(reads,2);
  delayed.resolve(Response.json({configured:true,activeCredentialCount:1}));await waitFor(()=>!button.disabled);
  assert.match(f.d.querySelector('.finance-status').textContent,/Extra verificatie actief/);assert.match(f.d.querySelector('.finance-status').textContent,/Laatst gecontroleerd om \d{2}:\d{2}:\d{2}/);
  assert.equal(button.textContent,'Status controleren');assert.equal(f.d.getElementById('security').getAttribute('aria-busy'),'false');assert.equal(f.authCalls.length,0);assert.equal(f.registerCalls.length,0);
 }finally{f.close();}
});

test('failed status check shows failure and allows a new successful check',async()=>{
 let reads=0;const f=fixture({handler:()=>++reads===2?Promise.reject(Error('Verbinding verbroken.')):Response.json({configured:true,activeCredentialCount:1})});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Extra verificatie actief'));refresh(f);
  await waitFor(()=>f.d.querySelector('.finance-status').dataset.error==='true');assert.match(f.d.querySelector('.finance-status').textContent,/Status controleren is niet gelukt/);assert.doesNotMatch(f.d.querySelector('.finance-status').textContent,/Laatst gecontroleerd/);
  assert.equal(f.d.querySelectorAll('#security button')[1].disabled,false);refresh(f);await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Laatst gecontroleerd'));assert.equal(f.d.querySelector('.finance-status').dataset.error,'false');assert.equal(f.authCalls.length,0);
 }finally{f.close();}
});

test('a status response after logout cannot recreate private security state',async()=>{
 const delayed=deferred();let reads=0;const f=fixture({handler:()=>++reads===1?Response.json({configured:true,activeCredentialCount:1}):delayed.promise});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Extra verificatie actief'));refresh(f);f.stop();f.d.getElementById('authLogout').click();delayed.resolve(Response.json({configured:true,activeCredentialCount:1}));await new Promise(r=>setTimeout(r,10));
  assert.equal(f.d.getElementById('security').textContent,'');assert.equal(f.authCalls.length,0);
 }finally{f.close();}
});

test('a late status read cannot overwrite the status from a newly mounted panel',async()=>{
 const old=deferred();let reads=0;const f=fixture({handler:()=>++reads===1?old.promise:Response.json({configured:true,activeCredentialCount:1})});try{
  f.mount();const next=f.d.createElement('section');f.d.body.append(next);f.client.mount(next);
  await waitFor(()=>next.textContent.includes('Extra verificatie actief'));old.resolve(Response.json({configured:false,activeCredentialCount:0}));await new Promise(r=>setTimeout(r,10));
  assert.match(next.textContent,/Extra verificatie actief/);assert.equal(next.querySelector('button').hidden,true);assert.equal(next.getAttribute('aria-busy'),'false');
 }finally{f.close();}
});

test('a failed old enrollment poll cannot overwrite a newer active status check',async()=>{
 const delayed=deferred();let active=false;const f=fixture({handler:call=>{
  if(call.path==='/api/owner/security')return Response.json({configured:active,activeCredentialCount:active?1:0});
  if(call.path.endsWith('/registration/options'))return Response.json(options());
  if(call.path.endsWith('/registration/verify'))return Response.json({candidateId,fingerprint:'test-only-public-fingerprint',status:'pending'});
  return delayed.promise;
 }});try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Stel eerst'));setup(f);await waitFor(()=>f.d.querySelector('.owner-security-pending').hidden===false);
  await f.poll();active=true;refresh(f);await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Laatst gecontroleerd'));
  delayed.resolve(Response.json({error:'Oude aanvraag is niet beschikbaar.'},{status:503}));await new Promise(r=>setTimeout(r,10));
  assert.match(f.d.querySelector('.finance-status').textContent,/Extra verificatie actief/);assert.equal(f.d.querySelector('.finance-status').dataset.error,'false');assert.equal(f.d.querySelector('.owner-security-pending').hidden,true);
 }finally{f.close();}
});

test('cached page hide cancels confirmation but preserves the panel for a new explicit device check',async()=>{
 const f=fixture();try{
  f.mount();await waitFor(()=>f.d.querySelector('.finance-status').textContent.includes('Stel eerst'));
  const first=f.client.prepare('owner-generation',{quoteId:'cached-original'}),rejected=assert.rejects(first,{code:'verification_cancelled'});await waitFor(()=>f.d.querySelector('dialog')?.open);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));await rejected;
  assert.equal(f.d.querySelector('dialog'),null);assert.match(f.d.getElementById('security').textContent,/Extra beveiliging/);assert.equal(f.timers.size,0);assert.equal(f.authCalls.length,0);
  const calls=f.calls.length;f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));await new Promise(r=>setTimeout(r,5));assert.equal(f.calls.length,calls,'restore never requests an automatic challenge');
  const next=f.client.prepare('owner-generation',{quoteId:'cached-original'});await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);assert.equal((await next).credential.id,'test-only-assertion-1');
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:false}));assert.equal(f.d.getElementById('security').textContent,'');await assert.rejects(f.client.prepare('owner-generation',{}),{code:'session_changed'});
 }finally{f.close();}
});

test('a late cancelled authenticator cannot release a newer verification or return its old proof',async()=>{
 const old=deferred(),next=deferred(),f=fixture({authenticate:()=>f.authCalls.length===1?old.promise:next.promise});try{
  const first=f.client.prepare('owner-generation',{quoteId:'old'}),rejected=assert.rejects(first,{code:'operation_changed'});await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);await waitFor(()=>f.authCalls.length===1);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));
  const second=f.client.prepare('owner-generation',{quoteId:'new'});await waitFor(()=>f.d.querySelector('dialog')?.open);approve(f);await waitFor(()=>f.authCalls.length===2);
  old.resolve({id:'old-unusable-proof'});await rejected;await assert.rejects(f.client.prepare('finance-expense',{}),{code:'verification_busy'});
  next.resolve({id:'new-explicit-proof'});assert.equal((await second).credential.id,'new-explicit-proof');assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.path.endsWith('/verification/options')));
 }finally{old.resolve({});next.resolve({});f.close();}
});

test('cached enrollment suspension ignores a late verify response and never restarts polling by itself',async()=>{
 const late=deferred(),f=fixture({handler:call=>call.path==='/api/owner/security'?Response.json({configured:false,activeCredentialCount:0}):call.path.endsWith('/registration/verify')?late.promise:Response.json(options())});try{
  f.mount();await waitFor(()=>f.calls.length===1);setup(f);await waitFor(()=>f.calls.some(c=>c.path.endsWith('/registration/verify')));
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide',{persisted:true}));assert.equal(f.d.querySelector('#security button').disabled,false);
  late.resolve(Response.json({candidateId,fingerprint:'late-unused-candidate',status:'pending'}));await new Promise(r=>setTimeout(r,10));assert.equal(f.d.querySelector('.owner-security-pending').hidden,true);assert.equal(f.timers.size,0);
  const count=f.calls.length;f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow',{persisted:true}));await new Promise(r=>setTimeout(r,5));assert.equal(f.calls.length,count);assert.doesNotMatch(f.d.getElementById('security').textContent,/late-unused-candidate/);
 }finally{late.resolve(Response.json({}));f.close();}
});
