import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {startNativeSiteApp} from './frontend/multiuser/native-site-boot.mjs';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const payments=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const waitFor=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI did not settle');};
function page(){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id);
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 return {dom,w,d,el};
}
function fixture({quote:quoteOverride={},quality='pro',create,status,store=new Map(),verificationHandler}={}){
 const f=page(),{w,el}=f,calls=[],verifications=[];let uploads=0,cancelled=0;
 w.Blob=Blob;w.rigNativeSite=true;w.rigVideoFunding='owner-provider';w.rigVideoMode='live';w.rigVideoQualities=['standard','pro','edit-standard'];w.rigSessionActive=()=>true;
 w.rigScopedStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const media={image:{blob:new Blob(['image'],{type:'image/jpeg'})},video:{blob:new Blob(['video'],{type:'video/mp4'})},face:null,angles:[],quality,keepSound:true,steady:false,prompt:'Vervang alle honden in het orkest door mijn hond.'};
 w.rigPreparedMedia=()=>media;w.rigGenerationQuality=()=>quality;w.rigOpenVideo=async()=> 'blob:private-result';
 w.rigOwnerVerification={cancel(){cancelled++;},async prepare(operation,payload){verifications.push({operation,payload:JSON.parse(JSON.stringify(payload))});return verificationHandler?verificationHandler(operation,payload):{challengeId:'test-only-challenge-'+verifications.length,credential:{id:'test-only-assertion-'+verifications.length}};}};
 el('duration').value='5';
 const quote={id:'q1',funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:700000,durationSeconds:5,billedSeconds:5,quality,approvalToken:'t'.repeat(43),idempotencyKey:'rigchatgpt_q1',...(quality==='edit-standard'?{transferPolicy:'fal-temporary-links-v1'}:{}),...quoteOverride};
 const failed={id:'job1',state:'failed',funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:700000,finalizationConfirmed:true};
 w.rigRequest=async(path,init={})=>{
  calls.push([path,init]);
  if(path==='/api/generations/recent')return Response.json({job:null});
  if(path==='/api/assets')return Response.json({id:'asset'+(++uploads),status:'ready'});
  if(path==='/api/generation-quotes')return Response.json(quote);
  if(path==='/api/generations')return create?create(path,init):Response.json(failed);
  if(path.startsWith('/api/generations/'))return status?status(path,init):Response.json(failed);
  if(path.startsWith('/api/estimate/fal?'))return Response.json({funding:'owner-provider',quality,durationSeconds:5,billedSeconds:5,providerEstimate:{currency:'USD',usdMicros:700000,binding:false},customerProposal:{currency:'EUR',priceCents:9900,binding:false}});
  throw Error('Unexpected request '+path);
 };
 w.eval(generation);
 return {...f,calls,store,media,verifications,cancelled:()=>cancelled};
}
async function price(f){
 f.d.dispatchEvent(new f.w.Event('rig-prepared-ready'));
 await waitFor(()=>f.el('uploadDialog').open);
 f.el('confirmUpload').click();
 await waitFor(()=>!f.el('confirmUpload').disabled);
}

test('native owner boot enables direct Fal without replacing its account note with a gift or RIG budget',async()=>{
 const f=page(),loaded=[],user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const auth={currentSession:async()=>true,sessionSubject:async()=>user,watchSession:()=>()=>{},dispose(){},api:async path=>Response.json(path==='/api/session'?{userId:user}:{enabled:true,funding:'owner-provider',mode:'live',providerCurrency:'USD',qualities:['standard','pro','edit-standard']})};
 const app=await startNativeSiteApp({window:f.w,auth,loadScript:async name=>loaded.push(name)});
 try{
  assert.equal(f.w.rigVideoEnabled,true);assert.equal(f.w.rigVideoFunding,'owner-provider');assert.equal(f.w.rigVideoMode,'live');
  assert.deepEqual(loaded,['media.js','app.js','owner-security.js','generation-ui.js','payments.js','owner-administration.js','finance.js']);
  assert.match(f.el('videoAvailabilityNote').textContent,/eigen fal-account.*Fal-raming.*vóór je bevestigt/);
  assert.doesNotMatch(f.el('videoAvailabilityNote').textContent,/RIG-tegoed|uitnodiging|testtegoed|Mollie/);
 }finally{app.dispose();f.dom.window.close();}
});

test('owner account badge displays no invented balance and never asks for a Mollie purchase',async()=>{
 const f=page(),{w,el}=f,calls=[];
 try{
  w.rigNativeSite=true;w.rigVideoFunding='owner-provider';w.rigSessionActive=()=>true;w.rigScopedStorage={getItem:()=>null};
  w.rigRequest=async path=>{calls.push(path);return Response.json({balance:0,mode:'live',currency:'EUR',purchasesEnabled:true});};
  w.eval(payments);assert.equal(el('creditsButton').textContent,'Eigen fal-account');
  el('creditsButton').click();await waitFor(()=>el('creditsDialog').open);
  assert.equal(el('creditsTitle').textContent,'Eigen fal-account');
  assert.match(el('creditExplanation').textContent,/geen RIG-tegoed te kopen.*Fal-raming/);
  assert.match(el('creditsMessage').textContent,/Fal-saldo niet uitlezen.*fal\.ai/);
  assert.doesNotMatch(el('creditsButton').textContent+el('creditsMessage').textContent,/€|US\$|\$\d|testbudget|teruggezet/);
  assert.equal(el('packageList').children.length,0);assert.equal(el('refreshPayment').hidden,true);assert.equal(el('resumePayment').hidden,true);
  el('refreshPayment').click();el('resumePayment').click();f.d.dispatchEvent(new w.Event('rig-balance-changed'));
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(calls,[]);
 }finally{f.dom.window.close();}
});

test('owner sees USD estimate without a RIG balance check and explicitly consents before the first Fal edit',async()=>{
 const f=fixture({quality:'edit-standard'});
 try{
  await price(f);assert.equal(f.el('confirmGeneration').hidden,false);
  assert.match(f.el('quoteMessage').textContent,/eigen fal-account.*Fal-raming:.*0,70.*5 seconden/);
  assert.match(f.el('quoteMessage').textContent,/werkelijke Fal-kosten kunnen afwijken.*Pas na je bevestiging/);
  assert.match(f.el('quoteMessage').textContent,/tijdelijke links.*24 uur.*Iedereen met zo’n link/);
  assert.doesNotMatch(f.el('quoteMessage').textContent,/€|RIG-tegoed|fictief|testtegoed/);
  assert.equal(f.calls.some(([path])=>path.startsWith('/api/payments/')||path==='/api/generations'),false);
  f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('afgesloten'));
  const posts=f.calls.filter(([path])=>path==='/api/generations');assert.equal(posts.length,1);
  assert.deepEqual(f.verifications,[{operation:'owner-generation',payload:{quoteId:'q1',idempotencyKey:'rigchatgpt_q1',transferConsent:'fal-temporary-links-v1'}}]);
  assert.deepEqual(JSON.parse(posts[0][1].body),{quoteId:'q1',idempotencyKey:'rigchatgpt_q1',approvalToken:'t'.repeat(43),transferConsent:'fal-temporary-links-v1',verification:{challengeId:'test-only-challenge-1',credential:{id:'test-only-assertion-1'}}});
  assert.equal(f.store.has('rig-generation-pending'),false);assert.equal(f.store.has('rig-generation-job'),false);
  assert.doesNotMatch(f.el('quoteMessage').textContent,/teruggezet|terugbetaald|RIG-tegoed/);
 }finally{f.dom.window.close();}
});

test('owner quote requires the live USD funding proof and a native approval',async()=>{
 const invalid=[{funding:'credits'},{providerCurrency:'EUR'},{providerEstimateUsdMicros:0},{providerEstimateUsdMicros:-1},{providerEstimateUsdMicros:Number.MAX_SAFE_INTEGER+1},{durationSeconds:0,billedSeconds:0},{priceCents:100},{currency:'EUR'},{approvalToken:null},{transferPolicy:'different-policy'}];
 for(const quote of invalid){
  const f=fixture({quote,quality:'edit-standard'});
  try{await price(f);assert.equal(f.el('confirmGeneration').hidden,true,JSON.stringify(quote));f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);}
  finally{f.dom.window.close();}
 }
});

test('an owner quote cannot be confirmed after the displayed funding changes',async()=>{
 const f=fixture();
 try{await price(f);assert.equal(f.el('confirmGeneration').hidden,false);f.w.rigVideoFunding='credits';f.el('confirmGeneration').click();assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);}finally{f.dom.window.close();}
});

test('owner preview shows provider estimate without a customer-price proposal',async()=>{
 const f=fixture();
 try{
  Object.defineProperty(f.el('motionInput'),'files',{value:[{}],configurable:true});Object.defineProperty(f.el('motionVideo'),'duration',{value:10,configurable:true});f.el('start').value='0';
  f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));
  await waitFor(()=>!f.el('providerEstimate').hidden);
  assert.match(f.el('providerEstimate').textContent,/Fal-raming:.*0,70.*eigen fal-account/);
  assert.doesNotMatch(f.el('providerEstimate').textContent,/klantprijs|€|RIG-tegoed/);
 }finally{f.dom.window.close();}
});

test('uncertain owner failure retains recovery even if an unrelated refund flag is present',async()=>{
 const job={id:'job1',state:'failed',funding:'owner-provider',refundConfirmed:true},f=fixture({create:()=>Response.json(job),status:()=>Response.json(job)});
 try{
  await price(f);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('nog gecontroleerd'));
  assert.equal(f.store.get('rig-generation-job'),'job1');assert.equal(f.el('checkGeneration').hidden,false);
  assert.doesNotMatch(f.el('quoteMessage').textContent,/tegoed|teruggezet|terugbetaald/i);
  f.d.dispatchEvent(new f.w.Event('rig-prepared-ready'));await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
 }finally{f.dom.window.close();}
});

test('owner recovery clears only a proven finalization, while historical credit jobs keep their refund semantics',async()=>{
 for(const [job,cleared,pattern] of [
  [{state:'failed',funding:'owner-provider',finalizationConfirmed:true,failureCode:'provider_input_unavailable'},true,/Fal kon je foto of video niet openen.*afgesloten.*fal\.ai/],
  [{state:'unknown',funding:'owner-provider'},false,/wordt gecontroleerd.*Start niet opnieuw/],
  [{state:'failed',funding:'credits',refundConfirmed:true},true,/Je tegoed is teruggezet/],
  [{state:'failed',funding:'credits',finalizationConfirmed:true},false,/tegoed wordt gecontroleerd/],
 ]){
  const store=new Map([['rig-generation-job','job1']]),f=fixture({store,status:()=>Response.json({id:'job1',...job})});
  try{
   f.el('checkGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.match(pattern));
   assert.equal(store.has('rig-generation-job'),!cleared);assert.equal(f.el('checkGeneration').hidden,cleared);
   if(job.funding==='owner-provider')assert.doesNotMatch(f.el('quoteMessage').textContent,/tegoed|teruggezet|terugbetaald/i);
   assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  }finally{f.dom.window.close();}
 }
});

test('owner verification finishes before a generation intent is persisted or submitted',async()=>{
 let finish;const f=fixture({quality:'edit-standard',verificationHandler:()=>new Promise(resolve=>{finish=resolve;})});try{
  await price(f);assert.equal(f.verifications.length,0);f.el('confirmGeneration').click();await waitFor(()=>typeof finish==='function');
  assert.equal(f.store.size,0);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.el('confirmGeneration').disabled,true);f.el('confirmGeneration').click();assert.equal(f.verifications.length,1);
  finish({challengeId:'test-only-bound-challenge',credential:{id:'test-only-bound-assertion'}});await waitFor(()=>f.calls.some(([path])=>path==='/api/generations'));
  const body=JSON.parse(f.calls.find(([path])=>path==='/api/generations')[1].body);assert.equal(body.verification.challengeId,'test-only-bound-challenge');assert.equal(body.approvalToken,'t'.repeat(43));assert.equal(body.transferConsent,'fal-temporary-links-v1');
  assert.equal([...f.store.values()].some(value=>String(value).includes('test-only-bound-assertion')),false);
 }finally{f.dom.window.close();}
});

test('cancelling owner verification leaves the quote reusable without a pending generation',async()=>{
 let attempts=0;const f=fixture({verificationHandler:()=>{if(++attempts===1)throw Object.assign(Error('Bevestiging geannuleerd. De video is niet gestart.'),{code:'verification_cancelled'});return {challengeId:'test-only-new-challenge',credential:{id:'test-only-new-assertion'}};}});try{
  await price(f);f.el('confirmGeneration').click();await waitFor(()=>!f.el('confirmGeneration').disabled);assert.equal(f.el('confirmGeneration').hidden,false);assert.equal(f.el('checkGeneration').hidden,true);assert.equal(f.store.size,0);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.match(f.el('quoteMessage').textContent,/geannuleerd/);
  f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(([path])=>path==='/api/generations'));assert.equal(f.verifications.length,2);assert.deepEqual(f.verifications[0].payload,f.verifications[1].payload);assert.equal(f.calls.filter(([path])=>path==='/api/generation-quotes').length,1);
 }finally{f.dom.window.close();}
});

test('missing, unconfigured or empty owner verification cannot create or persist a generation',async()=>{
 for(const type of ['missing','setup-required','empty']){
  const f=fixture({verificationHandler:()=>{if(type==='setup-required')throw Object.assign(Error('Stel eerst je apparaat in.'),{code:'owner_security_setup_required',status:428});return null;}});try{
   await price(f);if(type==='missing')delete f.w.rigOwnerVerification;f.el('confirmGeneration').click();await waitFor(()=>!f.el('confirmGeneration').disabled);
   assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.store.size,0);assert.equal(f.el('confirmGeneration').hidden,false);assert.equal(f.el('checkGeneration').hidden,true);
  }finally{f.dom.window.close();}
 }
});

test('changed media, quality or funding during owner verification cannot submit the approved old quote',async()=>{
 for(const change of ['media','quality','funding']){
  let finish;const f=fixture({verificationHandler:()=>new Promise(resolve=>{finish=resolve;})});try{
   await price(f);f.el('confirmGeneration').click();await waitFor(()=>typeof finish==='function');
   if(change==='media'){f.w.rigPreparedMedia=()=>({...f.media});f.d.dispatchEvent(new f.w.Event('rig-prepared-change'));assert.equal(f.cancelled(),1);}
   else if(change==='quality')f.w.rigGenerationQuality=()=> 'standard';else{f.w.rigVideoFunding='credits';f.d.dispatchEvent(new f.w.Event('rig-generation-mode-change'));assert.equal(f.cancelled(),1);}
   finish({challengeId:'test-only-stale-challenge',credential:{id:'test-only-stale-assertion'}});await waitFor(()=>!f.el('confirmGeneration').disabled);
   assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.store.size,0);assert.equal(f.el('confirmGeneration').hidden,true);assert.match(f.el('quoteMessage').textContent,/instellingen zijn gewijzigd/);
  }finally{f.dom.window.close();}
 }
});

test('ending or replacing the owner session during verification discards a late assertion',async()=>{
 for(const replace of [false,true]){
  let finish,newRequests=0;const f=fixture({verificationHandler:()=>new Promise(resolve=>{finish=resolve;})});try{
   await price(f);f.el('confirmGeneration').click();await waitFor(()=>typeof finish==='function');
   if(replace)f.w.rigRequest=async()=>{newRequests++;return Response.json({});};else f.w.rigSessionActive=()=>false;
   finish({challengeId:'test-only-other-session',credential:{id:'test-only-other-session-assertion'}});await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(newRequests,0);assert.equal(f.store.size,0);
  }finally{f.dom.window.close();}
 }
});
