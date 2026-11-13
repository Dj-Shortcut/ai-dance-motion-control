import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8'),source=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Mobile generation did not settle');};
function fixture({owner=false,recast=false,submit,status,reconcile,draft,storage=new Map()}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],events=[];let active=true,visibility='visible',proofs=0,cancels=0;
 Object.defineProperty(d,'visibilityState',{configurable:true,get:()=>visibility});w.Blob=Blob;w.rigNativeSite=true;w.rigVideoMode='live';w.rigVideoFunding=owner?'owner-provider':'credits';w.rigVideoQualities=[recast?'human-recast':'pro'];w.rigSessionActive=()=>active;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};}
 for(const video of d.querySelectorAll('video'))video.pause=()=>{};
 w.URL.createObjectURL=()=> 'blob:owned-result';w.URL.revokeObjectURL=()=>{};w.rigOpenVideo=async()=> 'blob:owned-result';
 w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 const media={image:{blob:new Blob(['jpeg'],{type:'image/jpeg'})},video:{blob:new Blob(['mp4'],{type:'video/mp4'})},selectedSeconds:recast?6:5,face:null,angles:[],quality:recast?'human-recast':'pro',keepSound:true,steady:false,prompt:'Mijn eigen beweging.'};w.rigPreparedMedia=()=>media;w.rigGenerationQuality=()=>media.quality;
 w.rigOwnerVerification={prepare:async()=>{proofs++;return {proof:'explicit-device-proof'};},cancel:()=>{cancels++;}};
 for(const name of ['intent','accepted','tracking','completed','failed','not-started'])d.addEventListener('rig-generation-'+name,event=>events.push([name,event.detail]));
 let assets=0;
 // This request boundary models the separately tested native binding: an old
 // account/aborted response cannot be handed to the UI. No live service exists.
 const request=async(path,options={})=>{
  if(!active||w.rigRequest!==request)throw Error('De aanmelding is gewijzigd.');calls.push([path,options]);
  let task=(async()=>{
   if(path==='/api/generations/recent')return {job:null};
   if(path==='/api/assets')return {id:'asset'+(++assets),status:'ready'};
   if(path==='/api/generation-quotes')return {id:'quote-1',quality:media.quality,durationSeconds:media.selectedSeconds,billedSeconds:media.selectedSeconds,approvalToken:'a'.repeat(43),idempotencyKey:'intent-1',...(recast?{transferPolicy:'fal-temporary-links-v1',outputResolution:'1080P'}:{}),...(owner?{funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:840000}:{priceCents:100,currency:'EUR'})};
   if(path==='/api/payments/balance')return {mode:'live',currency:'EUR',balance:500};
   if(path==='/api/generations')return submit?submit():{id:'job-1',state:'queued'};
   if(path==='/api/generation-intents/intent-1/reconcile')return reconcile?reconcile():{id:'job-1',state:'queued'};
   if(path==='/api/generations/job-1')return status?status():{id:'job-1',state:'completed',videoPath:'/api/generations/job-1/video'};
   if(path==='/api/generations/job-1/draft')return draft?draft():{available:false,reason:'missing'};
   throw Error('Unexpected offline route '+path);
  })();
  let abort;const canceled=new Promise((_,reject)=>{abort=()=>reject(Error('Request aborted'));if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});});
  try{const value=await Promise.race([task,canceled]);if(!active||w.rigRequest!==request)throw Error('De aanmelding is gewijzigd.');return value instanceof Response?value:Response.json(value);}finally{options.signal?.removeEventListener('abort',abort);}
 };
 w.rigRequest=request;w.eval(source);
 const hide=()=>{visibility='hidden';w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:true}));d.dispatchEvent(new w.Event('visibilitychange'));};
 const show=()=>{visibility='visible';w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));d.dispatchEvent(new w.Event('visibilitychange'));};
 const quote=async()=>{d.dispatchEvent(new w.Event('rig-prepared-ready'));await settle(()=>el('uploadDialog').open);el('confirmUpload').click();await settle(()=>!el('confirmGeneration').hidden&&!el('confirmGeneration').disabled);};
 return {dom,w,d,el,calls,events,storage,media,hide,show,quote,posts:()=>calls.filter(([path])=>path==='/api/generations').length,changeAccount(){active=false;w.rigGenerationDispose();w.rigRequest=async()=>{throw Error('Different account');};},close(){w.rigGenerationDispose();dom.window.close();}};
}
test('an interrupted owner proof is never submitted late; only a new explicit confirmation can start one video',async()=>{
 const old=deferred(),f=fixture({owner:true});let proofs=0;f.w.rigOwnerVerification.prepare=()=>++proofs===1?old.promise:Promise.resolve({proof:'new-explicit-proof'});
 try{await f.quote();f.el('confirmGeneration').click();await settle(()=>proofs===1);f.hide();f.show();assert.match(f.el('quoteMessage').textContent,/niet gestart.*opnieuw/i);assert.equal(f.posts(),0);assert.equal(f.storage.size,0);assert.equal(f.el('confirmGeneration').hidden,false);assert.equal(f.el('confirmGeneration').disabled,false);
  f.el('confirmGeneration').click();await settle(()=>f.events.some(([name])=>name==='completed'));old.resolve({proof:'old-late-proof'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.posts(),1);assert.equal(proofs,2);assert.equal(f.events.filter(([name])=>name==='completed').length,1);
 }finally{f.close();}
});
test('returning while the first generation POST is pending waits for its receipt, then reads only that job',async()=>{
 const sent=deferred(),f=fixture({submit:()=>sent.promise});try{await f.quote();f.el('confirmGeneration').click();await settle(()=>f.posts()===1);f.hide();f.show();f.show();assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.el('checkGeneration').hidden,false);assert.ok(f.storage.has('rig-generation-pending'));assert.equal(f.calls.some(([path])=>path.includes('/reconcile')||path==='/api/generations/job-1'),false);
  sent.resolve({id:'job-1',state:'queued'});await settle(()=>f.events.some(([name])=>name==='completed'));assert.equal(f.posts(),1);assert.equal(f.calls.filter(([path])=>path==='/api/generations/job-1').length,1);assert.equal(f.calls.some(([path])=>path.includes('/reconcile')),false);assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.storage.has('rig-generation-job'),false);
 }finally{f.close();}
});
test('a queued poll canceled on hiding resumes the same job without paid submission or automatic cleanup advance',async()=>{
 const held=deferred();let reads=0,cleanupLoads=0;const f=fixture({status:()=>++reads===1?held.promise:{id:'job-1',state:'ready_to_advance',workflowVersion:'rig-workflow-v2'}});f.w.rigLoadCleanupModule=async()=>{cleanupLoads++;throw Error('No automatic paid advance');};
 try{await f.quote();f.el('confirmGeneration').click();await settle(()=>reads===1);f.hide();f.show();await settle(()=>reads===2&&!f.w.rigGenerationBusy());assert.equal(f.posts(),1);assert.equal(f.storage.get('rig-generation-job'),'job-1');assert.equal(cleanupLoads,0);assert.equal(f.calls.some(([path])=>path.includes('/advance')||path.includes('/client-processing')),false);assert.match(f.el('quoteMessage').textContent,/Controleer opdracht/);held.resolve({id:'job-1',state:'completed',videoPath:'/api/generations/job-1/video'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.events.some(([name])=>name==='completed'),false,'the abandoned poll cannot publish a late result');
 }finally{f.close();}
});
test('an account change after submission prevents resume and ignores the late old-account receipt',async()=>{
 const sent=deferred(),f=fixture({submit:()=>sent.promise});try{await f.quote();f.el('confirmGeneration').click();await settle(()=>f.posts()===1);const pending=f.storage.get('rig-generation-pending');f.hide();f.changeAccount();f.show();sent.resolve({id:'job-1',state:'queued'});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.posts(),1);assert.equal(f.storage.get('rig-generation-pending'),pending);assert.equal(f.calls.some(([path])=>path==='/api/generations/job-1'||path.includes('/reconcile')),false);assert.equal(f.events.some(([name])=>name==='accepted'||name==='completed'),false);
 }finally{f.close();}
});
test('same-binding script initialization during a pending POST keeps one instance and never reconciles or resubmits early',async()=>{
 const sent=deferred(),f=fixture({submit:()=>sent.promise});try{await f.quote();f.el('confirmGeneration').click();await settle(()=>f.posts()===1);const instance=f.w.rigGenerationInstance;f.w.eval(source);assert.equal(f.w.rigGenerationInstance,instance);f.hide();f.show();assert.equal(f.calls.some(([path])=>path.includes('/reconcile')),false);sent.resolve({id:'job-1',state:'queued'});await settle(()=>f.events.some(([name])=>name==='completed'));assert.equal(f.posts(),1);assert.equal(f.events.filter(([name])=>name==='completed').length,1);assert.equal(f.calls.filter(([path])=>path==='/api/generations/job-1').length,1);
 }finally{f.close();}
});

test('an uncertain first POST is reconciled only after it settles, without another generation or automatic workflow advance',async()=>{
 const sent=deferred(),f=fixture({submit:()=>sent.promise,status:()=>({id:'job-1',state:'awaiting_client_processing',workflowVersion:'rig-workflow-v2'})});let cleanupLoads=0;f.w.rigLoadCleanupModule=async()=>{cleanupLoads++;throw Error('No automatic cleanup');};
 try{await f.quote();f.el('confirmGeneration').click();await settle(()=>f.posts()===1);f.hide();f.show();assert.equal(f.calls.some(([path])=>path.includes('/reconcile')),false);sent.reject(Error('The response was interrupted'));await settle(()=>f.storage.get('rig-generation-job')==='job-1'&&!f.w.rigGenerationBusy());assert.equal(f.calls.filter(([path])=>path.includes('/reconcile')).length,1);assert.equal(f.posts(),1);assert.equal(cleanupLoads,0);assert.equal(f.calls.some(([path])=>path.includes('/advance')),false);}
 finally{f.close();}
});

test('an unpaid Recast quote restores its exact portrait preview after suspension without requesting proof or submitting',async()=>{
 const f=fixture({owner:true,recast:true});let proofs=0;f.w.rigOwnerVerification.prepare=async()=>{proofs++;return {proof:'unexpected'};};
 try{await f.quote();assert.equal(f.el('quotePortraitPreview').hidden,false);f.hide();assert.equal(f.el('quotePortraitImage').getAttribute('src'),null);f.show();assert.equal(f.el('quotePortraitPreview').hidden,false);assert.match(f.el('quotePortraitImage').src,/^blob:/);assert.equal(f.el('confirmGeneration').hidden,false);assert.equal(proofs,0);assert.equal(f.posts(),0);}
 finally{f.close();}
});

test('changed media cannot restore the old unpaid Recast quote after suspension',async()=>{
 const f=fixture({owner:true,recast:true});try{await f.quote();f.hide();f.w.rigPreparedMedia=()=>({...f.media,prompt:'Nieuwe selectie.'});f.show();assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.el('quotePortraitPreview').hidden,true);assert.equal(f.posts(),0);assert.match(f.el('quoteMessage').textContent,/gewijzigd.*prijs opnieuw/);}finally{f.close();}
});

for(const outcome of ['canceled','subject_rejected'])test(`definitive ${outcome} leaves processing through the not-started event rather than inventing a failed paid job`,async()=>{
 const f=fixture(outcome==='canceled'?{storage:new Map([['rig-generation-pending',JSON.stringify({quoteId:'quote-1',idempotencyKey:'intent-1'})]]),reconcile:()=>({state:'canceled'})}:{submit:()=>Response.json({error:'Unsuitable source',code:'subject_rejected',generationStarted:false},{status:400})});
 try{if(outcome==='canceled'){f.hide();f.show();}else{await f.quote();f.el('confirmGeneration').click();}await settle(()=>f.events.some(([name])=>name==='not-started'));assert.equal(f.events.some(([name])=>name==='failed'),false);assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.posts(),outcome==='canceled'?0:1);}
 finally{f.close();}
});

test('suspending the last completed-draft read retains the exact job handle until a resumed completed event is published',async()=>{
 const held=deferred();let draftReads=0;const f=fixture({draft:()=>++draftReads===1?held.promise:{available:false,reason:'missing'}});
 try{await f.quote();f.el('confirmGeneration').click();await settle(()=>draftReads===1);assert.equal(f.storage.get('rig-generation-job'),'job-1','a downloaded result alone must not discard recovery before all reads finish');f.hide();f.show();await settle(()=>f.events.some(([name])=>name==='completed'));assert.equal(f.posts(),1);assert.equal(f.calls.filter(([path])=>path==='/api/generations/job-1').length,2);assert.equal(f.events.filter(([name])=>name==='completed').length,1);assert.equal(f.storage.has('rig-generation-job'),false);held.resolve({available:false,reason:'missing'});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.events.filter(([name])=>name==='completed').length,1);}
 finally{f.close();}
});
