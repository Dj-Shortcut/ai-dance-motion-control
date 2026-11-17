import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createCustomerVerification} from './frontend/multiuser/customer-security-client.mjs';
import {readFileSync} from 'node:fs';

const waitFor=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Customer passkey UI did not settle');};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const payload=()=>({quoteId:'quote-test-only',idempotencyKey:'idempotency-test-only'});
const options=(n=1)=>({required:true,challengeId:'11111111-1111-4111-8111-'+String(n).padStart(12,'0'),expiresAt:Date.now()+60000,publicKey:{challenge:'test-only-challenge',userVerification:'required',authenticatorSelection:{userVerification:'required'}},summary:'Video maken · €1,25 · 5 seconden · Pro · quote-test-only'});
function fixture({configured=true,supported=true,handler,authenticate,register}={}){
 const dom=new JSDOM('<button id="authLogout">Afmelden</button><dialog id="quoteDialog"><p id="quoteMessage"></p><button id="confirmGeneration">Bevestig video</button></dialog>',{url:'https://rig.example.chatgpt.site/'}),w=dom.window,d=w.document,calls=[],authCalls=[],registrationCalls=[];
 let active=true,cancelled=0,number=0,registered=configured;
 w.rigNativeSite=true;w.rigSessionActive=()=>active;w.rigScopedStorage={};
 w.rigRequest=async(path,init={})=>{const call={path,body:init.body?JSON.parse(init.body):undefined};calls.push(call);if(handler)return handler(call);
  if(path==='/api/security')return Response.json({configured:registered,activeCredentialCount:registered?1:0});
  if(path.endsWith('/options'))return Response.json(options(++number));
  if(path.endsWith('/registration/verify')){registered=true;return Response.json({configured:true,status:'active'},{status:201});}
  throw Error('Unexpected customer security request');
 };
 const client=createCustomerVerification({window:w,webauthn:{browserSupportsWebAuthn:()=>supported,startAuthentication:async value=>{authCalls.push(value);return authenticate?authenticate(value):{id:'test-only-assertion-'+authCalls.length};},startRegistration:async value=>{registrationCalls.push(value);return register?register(value):{id:'test-only-registration'};},cancel:()=>{cancelled++;}}});
 return {dom,w,d,client,calls,authCalls,registrationCalls,cancelled:()=>cancelled,stop(){active=false;},mount(){client.mount();},close(){client.dispose();w.close();}};
}

test('reading customer security offers separate setup and never opens an authenticator or starts a video',async()=>{
 const f=fixture({configured:false});try{f.mount();await waitFor(()=>!f.d.querySelector('.customer-security-panel button').hidden);assert.equal(f.d.querySelector('.customer-security-panel button').textContent,'Passkey instellen');assert.match(f.d.body.textContent,/eenmalig je passkey/);assert.deepEqual(f.calls.map(c=>c.path),['/api/security']);assert.equal(f.authCalls.length,0);assert.equal(f.registrationCalls.length,0);}finally{f.close();}
});
test('explicit setup activates a passkey but leaves video approval for a separate user action and fresh assertion',async()=>{
 const f=fixture({configured:false});try{
  await assert.rejects(f.client.prepare('customer-generation',payload()),{code:'security_setup_required'});assert.equal(f.registrationCalls.length,0);assert.equal(f.authCalls.length,0);
  f.d.querySelector('.customer-security-panel button').click();await waitFor(()=>f.d.querySelector('.customer-security-panel').textContent.includes('Passkey ingesteld'));
  assert.equal(f.registrationCalls.length,1);assert.equal(f.authCalls.length,0);assert.equal(f.calls.some(c=>c.path==='/api/generations'||c.path.endsWith('/verification/options')),false);assert.match(f.d.body.textContent,/Bevestig nu je video opnieuw/);
  const proof=await f.client.prepare('customer-generation',payload());assert.equal(f.authCalls.length,1);assert.equal(proof.credential.id,'test-only-assertion-1');assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);
 }finally{f.close();}
});
test('each explicit video confirmation displays the server operation and price before a fresh required-UV ceremony',async()=>{
 let f;f=fixture({authenticate:()=>{assert.match(f.d.querySelector('.customer-verification-summary').textContent,/€1,25.*5 seconden.*Pro.*quote-test-only/);assert.equal(f.d.querySelector('.customer-verification-summary').hidden,false);return {id:'test-only-'+f.authCalls.length};}});try{
  const first=await f.client.prepare('customer-generation',payload()),second=await f.client.prepare('customer-generation',payload());assert.notEqual(first.challengeId,second.challengeId);assert.equal(f.authCalls.length,2);for(const call of f.calls.filter(c=>c.path.endsWith('/verification/options')))assert.deepEqual(call.body,{operation:'customer-generation',payload:payload()});assert.equal(f.w.sessionStorage.length,0);assert.equal(f.w.localStorage.length,0);
 }finally{f.close();}
});
for(const stage of ['options','authentication'])test(`cancelling during customer ${stage} discards a late response without a reusable unlock`,async()=>{
 const held=deferred(),f=fixture({handler:stage==='options'?call=>call.path.endsWith('/verification/options')?held.promise:Response.json({configured:true,activeCredentialCount:1}):undefined,authenticate:stage==='authentication'?()=>held.promise:undefined});try{
  const result=f.client.prepare('customer-generation',payload()),rejected=assert.rejects(result,{code:'verification_cancelled'});await waitFor(()=>stage==='options'?f.calls.some(c=>c.path.endsWith('/verification/options')):f.authCalls.length===1);f.client.cancel();held.resolve(stage==='options'?Response.json(options()):{id:'test-only-late'});await rejected;assert.equal(stage==='options'?f.authCalls.length:0,0);assert.ok(f.cancelled()>0);
 }finally{f.close();}
});
for(const change of ['payload','binding','logout','pagehide'])test(`a ${change} change cannot return a late customer assertion`,async()=>{
 const held=deferred(),f=fixture({authenticate:()=>held.promise}),input=payload();try{
  const result=f.client.prepare('customer-generation',input),rejected=assert.rejects(result,error=>['operation_changed','session_changed','verification_cancelled'].includes(error.code));await waitFor(()=>f.authCalls.length===1);
  if(change==='payload')input.quoteId='other-quote';else if(change==='binding')f.w.rigRequest=async()=>Response.json({});else if(change==='logout'){f.stop();f.d.getElementById('authLogout').click();}else f.w.dispatchEvent(new f.w.PageTransitionEvent('pagehide',{persisted:true}));held.resolve({id:'test-only-late'});await rejected;assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);
 }finally{f.close();}
});
test('unsupported browsers fail closed with a usable browser instruction and no ceremony or registration',async()=>{
 const f=fixture({configured:false,supported:false});try{await assert.rejects(f.client.prepare('customer-generation',payload()),{code:'browser_unsupported'});assert.match(f.d.body.textContent,/Chrome.*Safari.*Face ID.*schermcode/);assert.equal(f.authCalls.length,0);assert.equal(f.registrationCalls.length,0);}finally{f.close();}
});
test('missing, optional-UV, expired or operation-free challenges cannot invoke a customer authenticator',async()=>{
 for(const changed of [null,{...options(),required:false},{...options(),publicKey:{userVerification:'preferred'}},{...options(),expiresAt:Date.now()-1},{...options(),summary:''}]){
  const f=fixture({handler:call=>Response.json(call.path.endsWith('/verification/options')?changed:{configured:true,activeCredentialCount:1})});try{await assert.rejects(f.client.prepare('customer-generation',payload()));assert.equal(f.authCalls.length,0);}finally{f.close();}
 }
});
test('cancelled native setup never verifies a late registration or submits a video',async()=>{
 const held=deferred(),f=fixture({configured:false,register:()=>held.promise});try{f.mount();await waitFor(()=>!f.d.querySelector('.customer-security-panel button').hidden);f.d.querySelector('.customer-security-panel button').click();await waitFor(()=>f.registrationCalls.length===1);f.client.cancel();held.resolve({id:'test-only-late-registration'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.calls.some(c=>c.path.endsWith('/registration/verify')||c.path==='/api/generations'),false);}finally{f.close();}
});

test('closing the quote during setup cancels enrollment and a new quote never shows the old price summary',async()=>{
 const held=deferred(),f=fixture({configured:false,register:()=>held.promise});try{
  f.mount();await waitFor(()=>!f.d.querySelector('.customer-security-panel button').hidden);f.d.querySelector('.customer-security-panel button').click();await waitFor(()=>f.registrationCalls.length===1);f.d.getElementById('quoteDialog').dispatchEvent(new f.w.Event('close'));held.resolve({id:'test-only-late-registration'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.calls.some(c=>c.path.endsWith('/registration/verify')),false);
 }finally{f.close();}
 const next=fixture();try{await next.client.prepare('customer-generation',payload());assert.equal(next.d.querySelector('.customer-verification-summary').hidden,false);next.client.cancel();next.mount();assert.equal(next.d.querySelector('.customer-verification-summary').hidden,true);assert.equal(next.d.querySelector('.customer-verification-summary').textContent,'');}finally{next.close();}
});

test('the actual customer summary receives two animation frames before the authenticator opens',async()=>{
 const frames=[],f=fixture();try{
  f.w.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};const result=f.client.prepare('customer-generation',payload());await waitFor(()=>frames.length===1);assert.equal(f.authCalls.length,0);assert.match(f.d.querySelector('.customer-verification-summary').textContent,/€1,25/);frames.shift()();assert.equal(f.authCalls.length,0);frames.shift()();await result;assert.equal(f.authCalls.length,1);
 }finally{f.close();}
});

const generationSource=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const generationHtml=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
async function generationFixture({configured=true,authenticate,withClient=true,create}={}){
 const dom=new JSDOM(generationHtml,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[],storage=new Map(),el=id=>d.getElementById(id);let assets=0,registered=configured,proofs=0;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};}
 w.Blob=Blob;w.rigNativeSite=true;w.rigVideoFunding='credits';w.rigVideoMode='live';w.rigVideoQualities=['standard','pro'];w.rigSessionActive=()=>true;w.rigScopedStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const media={image:{blob:new Blob(['image'])},video:{blob:new Blob(['video'])},face:null,angles:[],quality:'pro',selectedSeconds:5,keepSound:true,steady:false,prompt:'Mijn beweging.'};w.rigPreparedMedia=()=>media;w.rigGenerationQuality=()=>media.quality;
 w.rigRequest=async(path,init={})=>{const body=typeof init.body==='string'?JSON.parse(init.body):undefined;calls.push({path,body});
  if(path==='/api/generations/recent')return Response.json({job:null});
  if(path==='/api/assets')return Response.json({id:'asset-'+(++assets),status:'ready'});
  if(path==='/api/generation-quotes')return Response.json({id:'quote-test-only',quality:'pro',priceCents:125,currency:'EUR',durationSeconds:5,billedSeconds:5,approvalToken:'a'.repeat(43),idempotencyKey:'idempotency-test-only'});
  if(path==='/api/payments/balance')return Response.json({balance:500,mode:'live',currency:'EUR'});
  if(path==='/api/security')return Response.json({configured:registered,activeCredentialCount:registered?1:0});
  if(path.endsWith('/security/registration/options')||path.endsWith('/security/verification/options'))return Response.json(options(calls.length));
  if(path.endsWith('/security/registration/verify')){registered=true;return Response.json({configured:true,status:'active'});}
  if(path==='/api/generations')return create?create():Response.json({id:'job-1',state:'failed',refundConfirmed:true});
  throw Error('Unexpected fixture request '+path);
 };
 if(withClient)w.rigCustomerVerification=createCustomerVerification({window:w,webauthn:{browserSupportsWebAuthn:()=>true,startRegistration:async()=>({id:'test-only-registration'}),startAuthentication:async()=>{proofs++;return authenticate?authenticate():{id:'test-only-assertion-'+proofs};},cancel(){}}});
 w.eval(generationSource);d.dispatchEvent(new w.Event('rig-prepared-ready'));await waitFor(()=>el('uploadDialog').open);el('confirmUpload').click();await waitFor(()=>!el('confirmGeneration').hidden&&!el('confirmGeneration').disabled);
 return {dom,w,d,el,calls,storage,proofs:()=>proofs,close(){w.rigGenerationDispose();w.rigCustomerVerification?.dispose();w.close();}};
}

test('a real customer client finishes device verification before any pending intent, credit-generating POST or approval token submission',async()=>{
 const held=deferred(),f=await generationFixture({authenticate:()=>held.promise});try{
  f.el('confirmGeneration').click();await waitFor(()=>f.proofs()===1);assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);assert.deepEqual(f.calls.find(c=>c.path.endsWith('/verification/options')).body,{operation:'customer-generation',payload:payload()});
  held.resolve({id:'test-only-approved-assertion'});await waitFor(()=>f.calls.some(c=>c.path==='/api/generations'));const submitted=f.calls.find(c=>c.path==='/api/generations').body;assert.equal(submitted.approvalToken,'a'.repeat(43));assert.deepEqual(submitted.verification.credential,{id:'test-only-approved-assertion'});assert.equal(submitted.quoteId,payload().quoteId);
 }finally{f.close();}
});
test('a customer missing the verifier cannot create a pending intent or submit an approval',async()=>{
 const f=await generationFixture({withClient:false});try{f.el('confirmGeneration').click();await waitFor(()=>!f.w.rigGenerationBusy());assert.equal(f.storage.size,0);assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);assert.match(f.el('quoteMessage').textContent,/veilig met je passkey/);}finally{f.close();}
});
test('new customer setup is a separate explicit action and only the next video confirmation can submit',async()=>{
 const f=await generationFixture({configured:false});try{f.el('confirmGeneration').click();await waitFor(()=>!f.w.rigGenerationBusy());assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);assert.equal(f.storage.size,0);f.d.querySelector('.customer-security-panel button').click();await waitFor(()=>f.d.querySelector('.customer-security-panel').textContent.includes('Passkey ingesteld'));assert.equal(f.proofs(),0);assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(c=>c.path==='/api/generations'));assert.equal(f.proofs(),1);}finally{f.close();}
});
test('changing the prepared customer video while its authenticator is pending prevents a late assertion from starting anything',async()=>{
 const held=deferred(),f=await generationFixture({authenticate:()=>held.promise});try{f.el('confirmGeneration').click();await waitFor(()=>f.proofs()===1);f.d.dispatchEvent(new f.w.Event('rig-prepared-change'));held.resolve({id:'test-only-late-assertion'});await waitFor(()=>!f.w.rigGenerationBusy());assert.equal(f.storage.size,0);assert.equal(f.calls.some(c=>c.path==='/api/generations'),false);assert.equal(f.el('confirmGeneration').hidden,true);}finally{f.close();}
});
test('a typed server passkey rejection before debit restores safe explicit confirmation instead of retaining a false pending job',async()=>{
 const f=await generationFixture({create:()=>Response.json({code:'verification_expired',error:'untrusted server text'},{status:428})});try{f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(c=>c.path==='/api/generations')&&!f.w.rigGenerationBusy());assert.equal(f.storage.size,0);assert.equal(f.el('confirmGeneration').hidden,false);assert.match(f.el('quoteMessage').textContent,/opnieuw/);assert.doesNotMatch(f.el('quoteMessage').textContent,/untrusted/);}finally{f.close();}
});
