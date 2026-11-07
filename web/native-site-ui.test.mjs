import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createNativeSiteAuth} from './frontend/multiuser/native-site-auth.mjs';
import {startNativeSiteApp} from './frontend/multiuser/native-site-boot.mjs';
import {prepareGuardedBinding} from './frontend/multiuser/guarded-binding.mjs';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const payments=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const alice='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI did not settle');};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
function page(url='https://rig.example.chatgpt.site/'){
 const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window;
 for(const dialog of w.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 return {dom,w,d:w.document};
}
test('native Site session supplies identity and binds API calls without a provider token',async()=>{
 const {dom,w}=page(),calls=[];
 const auth=createNativeSiteAuth({browser:w,fetchImpl:async(url,init)=>{calls.push([url,init]);return new URL(url).pathname==='/api/session'?Response.json({userId:alice}):Response.json({ok:true});}});
 try{
  assert.equal(await auth.currentSession(),true);assert.equal(await auth.sessionSubject(),alice);
  const response=await auth.api('/api/generation-quotes',{method:'POST',headers:{authorization:'Bearer forged','x-rig-expected-user':bob},body:'{}'},alice);
  assert.equal(response.status,200);
  const [,init]=calls.find(([url])=>url.endsWith('/api/generation-quotes'));
  assert.equal(init.headers.get('x-rig-expected-user'),alice);assert.equal(init.headers.get('authorization'),null);assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');
  const count=calls.length;
  for(const path of ['https://evil.test/api/session','/api/../private','/api/session#secret','/api/payments/webhook'])await assert.rejects(auth.api(path),/Ongeldige/);
  assert.equal(calls.length,count);assert.equal(calls.some(([url])=>/supabase|google|auth-config/.test(url)),false);
 }finally{auth.dispose();dom.window.close();}
});
test('native account changes abort the bound UI and cannot authorize a write as another user',async()=>{
 const {dom,w,d}=page(),gate=deferred(),reached=deferred();let user=alice,writes=0,ended=0;
 const auth=createNativeSiteAuth({browser:w,fetchImpl:async(url)=>{if(new URL(url).pathname==='/api/session')return Response.json({userId:user});writes++;reached.resolve();return gate.promise;}});
 const {binding,stop}=await prepareGuardedBinding({auth,browser:w,onChanged:()=>{ended++;}});
 try{
  const pending=binding.request('/api/generation-quotes',{method:'POST',body:'{}'}),rejected=assert.rejects(pending,/aanmelding/);
  await reached.promise;user=bob;gate.resolve(Response.json({id:'old-private-quote'}));await rejected;
  assert.equal(binding.isActive(),false);assert.equal(ended,1);assert.equal(d.getElementById('rigStudio').hidden,true);
  await assert.rejects(auth.api('/api/generations',{method:'POST',body:'{}'},alice),/aanmelding/);assert.equal(writes,1);
 }finally{stop();binding.dispose();auth.dispose();dom.window.close();}
});
test('native boot reuses the studio, keeps native sign-in anchors and mounts the gift invitation',async()=>{
 const code='x'.repeat(43),{dom,w,d}=page('https://rig.example.chatgpt.site/#invite='+code),loaded=[],calls=[];
 let listener,disposed=false;
 const auth={currentSession:async()=>true,sessionSubject:async()=>alice,watchSession:fn=>{listener=fn;return ()=>{};},dispose:()=>{disposed=true;},api:async(path)=>{calls.push(path);if(path==='/api/session')return Response.json({userId:alice});if(path==='/api/video-config')return Response.json({enabled:true,funding:'sponsored'});throw Error('unexpected request');}};
 const started=await startNativeSiteApp({window:w,auth,loadScript:async name=>{loaded.push(name);}});
 try{
  assert.deepEqual(loaded,['media.js','app.js','generation-ui.js','payments.js']);assert.equal(w.rigNativeSite,true);assert.equal(w.rigVideoFunding,'sponsored');assert.equal(d.getElementById('rigStudio').hidden,false);
  assert.equal(d.getElementById('authLogin').tagName,'A');assert.match(d.getElementById('authLogin').href,/\/signin-with-chatgpt\?return_to=%2F$/);assert.equal(d.getElementById('authLogin').target,'_top');assert.match(d.getElementById('authLogout').href,/\/signout-with-chatgpt$/);
  assert.equal(w.location.hash,'');assert.match(d.querySelector('.sponsor-invitation').textContent,/Activeer gratis €5/);assert.equal(calls.some(path=>path.includes('redeem')),false);
  listener(bob);assert.equal(d.getElementById('rigStudio').hidden,true);assert.equal(disposed,true);assert.equal(d.getElementById('authLogin').hidden,false);
 }finally{started.dispose();dom.window.close();}
});
test('native visitor can sign in without loading the studio or requiring Google',async()=>{
 const {dom,w,d}=page();let loaded=0;
 const app=await startNativeSiteApp({window:w,auth:{currentSession:async()=>false,dispose(){}},loadScript:async()=>{loaded++;}});
 try{assert.equal(loaded,0);assert.equal(d.getElementById('authLogin').hidden,false);assert.equal(d.getElementById('rigStudio').hidden,true);assert.match(d.getElementById('authLogin').textContent,/ChatGPT/);}finally{app.dispose();dom.window.close();}
});
async function quoteFixture({native=true,approval=true,price=100,remaining=500}={}){
 const state=page(),{w,d}=state,store=new Map(),calls=[];let uploads=0;
 w.Blob=Blob;w.rigNativeSite=native;w.rigVideoFunding='sponsored';w.rigSessionActive=()=>true;
 w.rigScopedStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const media={image:{blob:new Blob(['image'])},video:{blob:new Blob(['video'])},face:null,angles:[],quality:'pro',keepSound:true,steady:false,prompt:'Maak een dansvideo met dezelfde beweging.'};w.rigPreparedMedia=()=>media;
 w.rigRequest=async(path,init={})=>{calls.push([path,init]);let data;if(path==='/api/generations/recent')data={job:null};else if(path==='/api/assets')data={id:'asset'+(++uploads),status:'ready'};else if(path==='/api/sponsor-invitations/status')data={state:'eligible',remainingCents:remaining};else if(path==='/api/generation-quotes')data={id:'q1',priceCents:price,currency:'EUR',durationSeconds:3,billedSeconds:3,...(approval?{approvalToken:'t'.repeat(43),idempotencyKey:'rigchatgpt_q1'}:{})};else if(path==='/api/generations')data={id:'job1',state:'failed',refundConfirmed:true};else throw Error('unexpected '+path);return {ok:true,json:async()=>data};};
 w.eval(generation);d.dispatchEvent(new w.Event('rig-prepared-ready'));await waitFor(()=>d.getElementById('uploadDialog').open);d.getElementById('confirmUpload').click();await waitFor(()=>d.getElementById('quoteMessage').textContent.includes('1,00')||d.getElementById('quoteMessage').textContent.includes('6,00'));
 return {...state,store,calls};
}
test('native browser sends its hidden quote approval only after the user confirms',async()=>{
 const f=await quoteFixture(),{d,calls,store}=f;
 try{
  assert.equal(d.getElementById('confirmGeneration').hidden,false);assert.equal(calls.some(([p])=>p==='/api/generations'),false);assert.doesNotMatch(d.body.textContent,/tttttttt/);assert.equal([...store.values()].some(value=>value.includes('tttttttt')),false);
  d.getElementById('confirmGeneration').click();await waitFor(()=>calls.some(([p])=>p==='/api/generations'));
  const body=JSON.parse(calls.find(([p])=>p==='/api/generations')[1].body);assert.deepEqual(body,{quoteId:'q1',idempotencyKey:'rigchatgpt_q1',approvalToken:'t'.repeat(43)});
 }finally{f.dom.window.close();}
});
test('a native quote without approval or beyond the gift budget cannot be confirmed',async()=>{
 for(const options of [{approval:false},{approval:false,price:600}]){
  const f=await quoteFixture(options);
  try{assert.equal(f.d.getElementById('confirmGeneration').hidden,true);assert.match(f.d.getElementById('quoteMessage').textContent,options.price?/niet voldoende/:/prijsbevestiging.*niet beschikbaar/);f.d.getElementById('confirmGeneration').click();assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}
 }
 const f=await quoteFixture({native:false,approval:false});
 try{assert.equal(f.d.getElementById('confirmGeneration').hidden,false);f.d.getElementById('confirmGeneration').click();await waitFor(()=>f.calls.some(([p])=>p==='/api/generations'));const body=JSON.parse(f.calls.find(([p])=>p==='/api/generations')[1].body);assert.equal(Object.hasOwn(body,'approvalToken'),false);assert.match(body.idempotencyKey,/^[a-f0-9-]{36}$/);}finally{f.dom.window.close();}
});
test('native credit dialog distinguishes the RIG allowance from a separate Fal balance without provider calls',async()=>{
 for(const funding of ['sponsored','owner',undefined]){
 const {dom,w,d}=page('https://rig.example.chatgpt.site/?payment=return'),calls=[];
 try{
  w.rigNativeSite=true;w.rigVideoFunding=funding;w.rigScopedStorage={getItem:()=>null};w.rigRequest=async path=>{calls.push(path);return Response.json({balance:325,frozen:false});};
  w.eval(payments);await waitFor(()=>d.getElementById('creditsButton').textContent.includes('3,25'));d.getElementById('creditsButton').click();
  d.getElementById('refreshPayment').click();d.getElementById('resumePayment').click();await new Promise(resolve=>setTimeout(resolve,10));
  const label=funding==='sponsored'?'Gratis RIG-tegoed':funding==='owner'?'RIG-testbudget':'RIG-testtegoed';
  assert.equal(d.getElementById('creditsButton').textContent,`${label} € 3,25`);assert.equal(d.getElementById('creditsTitle').textContent,label);
  const explanation=d.getElementById('creditExplanation').textContent;
  if(funding==='sponsored'){assert.match(explanation,/betaalt niets.*maker betaalt/);assert.doesNotMatch(explanation,/je (echte )?fal-tegoed/i);}
  else if(funding==='owner')assert.match(explanation,/fictief RIG-testbudget.*Je echte fal-tegoed staat apart op fal\.ai/);
  else assert.match(explanation,/RIG-testtegoed.*geen saldo van fal\.ai/);
  assert.equal(d.getElementById('packageList').children.length,0);assert.equal(d.getElementById('refreshPayment').hidden,true);assert.equal(d.getElementById('resumePayment').hidden,true);assert.equal(calls.every(path=>path==='/api/payments/balance'),true);
 }finally{dom.window.close();}
 }
});
