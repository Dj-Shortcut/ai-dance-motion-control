import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {createHash,webcrypto} from 'node:crypto';
const media=readFileSync(new URL('./frontend/multiuser/media.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

function capability({recording=true,mp4=true,canvas=true,audio=true,throws=false}={}){
 let allocations=0,streams=0,recorders=0;
 class Canvas{}class Video{}
 if(canvas)Canvas.prototype.captureStream=()=>{streams++;throw Error('A support check must never create a stream');};
 if(audio)Video.prototype.captureStream=()=>{streams++;throw Error('A support check must never capture source audio');};
 class Recorder{constructor(){recorders++;}static isTypeSupported(){if(throws)throw Error('codec unsupported');return mp4;}}
 const context={window:{},HTMLCanvasElement:Canvas,HTMLVideoElement:Video,document:{createElement(){allocations++;throw Error('A support check must never allocate a canvas');}},...(recording?{MediaRecorder:Recorder}:{})};
 runInNewContext(media,context);
 return {check:context.window.rigMedia.preparationCapability,untouched:()=>({allocations,streams,recorders})};
}

test('pure capability check detects actual required APIs without reading media or creating capture resources',()=>{
 const available=capability();assert.equal(available.check({keepSound:true}).supported,true);assert.match(available.check({keepSound:false}).mime,/^video\/mp4/);
 assert.deepEqual(available.untouched(),{allocations:0,streams:0,recorders:0});
 for(const options of [{recording:false},{mp4:false},{canvas:false},{throws:true}]){const f=capability(options);assert.equal(f.check({keepSound:false}).supported,false);assert.equal(f.check({keepSound:false}).code,'mp4-recording');assert.deepEqual(f.untouched(),{allocations:0,streams:0,recorders:0});}
 const silentOnly=capability({audio:false});assert.equal(silentOnly.check({keepSound:true}).code,'source-audio');assert.equal(silentOnly.check({keepSound:false}).supported,true);
});

function fixture({audio=false,mp4=true}={}){
 const dom=new JSDOM(html,{url:'https://rig.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],images=[],videos=[],ready=[];
 w.Blob=Blob;w.File=File;w.rigVideoEnabled=true;w.rigVideoQualities=['standard','pro','human-recast'];w.rigSessionActive=()=>true;w.rigScopedStorage={getItem(){return null},setItem(){},removeItem(){}};
 w.rigRequest=async(path,options)=>{calls.push([path,options]);throw Error('No network or paid work from a browser support guard');};
 w.URL.createObjectURL=()=> 'blob:local';w.URL.revokeObjectURL=()=>{};w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 w.MediaRecorder=class{static isTypeSupported(){return mp4;}};
 w.HTMLCanvasElement.prototype.captureStream=()=>{throw Error('Not recording in capability UI test');};
 if(audio)w.HTMLMediaElement.prototype.captureStream=()=>{throw Error('Not recording source audio in capability UI test');};
 else delete w.HTMLMediaElement.prototype.captureStream;
 w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(_){this.onload?.();}};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){for(const [key,value]of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};}
 w.eval(media);
 // The real support helper above is retained. These spies prove no encoder or
 // preparation handoff starts while the genuine API requirements are absent.
 w.rigMedia.prepareImage=async(...args)=>{images.push(args);return {blob:new Blob(['jpeg'],{type:'image/jpeg'}),width:1280,height:720};};
 w.rigMedia.prepareVideo=async(...args)=>{videos.push(args);return {blob:new Blob(['mp4'],{type:'video/mp4'}),duration:args[3],width:1280,height:720};};
 w.eval(app);d.addEventListener('rig-prepared-ready',()=>ready.push(w.rigPreparedMedia()));
 function files(id,name,type){Object.defineProperty(el(id),'files',{configurable:true,value:[new File(['local'],name,{type})]});el(id).dispatchEvent(new w.Event('change'));}
 files('personInput','portrait.jpg','image/jpeg');files('motionInput','source.mp4','video/mp4');el('motionVideo').dispatchEvent(new w.Event('loadedmetadata'));
 el('editPrompt').value='Behoud mijn gekozen beschrijving.';el('editPrompt').dispatchEvent(new w.Event('input'));el('start').value='1';el('start').dispatchEvent(new w.Event('change'));el('duration').value='10';el('duration').dispatchEvent(new w.Event('change'));
 return {dom,w,el,calls,images,videos,ready};
}

test('unsupported audio disables preparation, price and trial before any preparation or cost; explicit Motion mute restores readiness',async()=>{
 const f=fixture();try{
  assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('confirmBrief').disabled,true);assert.equal(f.el('tryShortVideo').disabled,true);
  const note=f.el('preparationBrowserNote');assert.equal(note.hidden,false);assert.match(note.textContent,/originele geluid/);assert.match(note.textContent,/zelf.*geluid uitzetten/);
  f.el('videoAvailabilityNote').textContent='Server-owned funding text';assert.match(note.textContent,/andere browser/,'Native funding updates must not erase the local browser warning');
  f.el('prepare').click();f.el('confirmBrief').dispatchEvent(new f.w.Event('click'));f.el('tryShortVideo').dispatchEvent(new f.w.Event('click'));await tick();
  assert.equal(f.images.length,0);assert.equal(f.videos.length,0);assert.equal(f.ready.length,0);assert.equal(f.calls.length,0);
  const draft=[f.el('personName').textContent,f.el('motionName').textContent,f.el('start').value,f.el('duration').value,f.el('editPrompt').value,f.w.rigGenerationQuality()];
  f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));
  assert.equal(note.hidden,true);assert.equal(f.el('prepare').disabled,false);assert.equal(f.el('confirmBrief').disabled,false);assert.equal(f.el('tryShortVideo').disabled,false);
  assert.deepEqual([f.el('personName').textContent,f.el('motionName').textContent,f.el('start').value,f.el('duration').value,f.el('editPrompt').value,f.w.rigGenerationQuality()],draft);
  f.el('prepare').click();f.el('confirmBrief').click();await tick();assert.equal(f.images.length,1);assert.equal(f.videos.length,1);assert.equal(f.videos[0][4],false);assert.equal(f.ready.length,1);assert.equal(f.ready[0].quality,'pro');assert.equal(f.ready[0].keepSound,false);
 }finally{f.dom.window.close();}
});

test('Recast retains mandatory audio and chosen model while showing an early browser warning',async()=>{
 const f=fixture();try{
  f.el('editModeButton').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('sound').checked,true);assert.equal(f.el('sound').disabled,true);
  assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('confirmBrief').disabled,true);assert.equal(f.el('tryShortVideo').disabled,true);
  assert.match(f.el('preparationBrowserNote').textContent,/originele geluid verplicht/);assert.doesNotMatch(f.el('preparationBrowserNote').textContent,/zelf.*uitzetten/);
  f.el('confirmBrief').dispatchEvent(new f.w.Event('click'));await tick();assert.equal(f.images.length,0);assert.equal(f.videos.length,0);assert.equal(f.ready.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('personName').textContent,'portrait.jpg');assert.equal(f.el('motionName').textContent,'source.mp4');
 }finally{f.dom.window.close();}
});

test('missing MP4 support blocks even silent preparation while a fully capable browser keeps existing controls ready',()=>{
 for(const [options,supported]of [[{audio:true,mp4:false},false],[{audio:true,mp4:true},true]]){
  const f=fixture(options);try{assert.equal(f.el('prepare').disabled,!supported);assert.equal(f.el('preparationBrowserNote').hidden,supported);if(!supported){f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));assert.equal(f.el('prepare').disabled,true);assert.match(f.el('preparationBrowserNote').textContent,/MP4/);}assert.equal(f.calls.length,0);}finally{f.dom.window.close();}
 }
});


// The real capability helper/app/generation handoff run against verified saved
// blobs. Network and media decoding are fixtures; no recorder or paid call runs.
async function savedPlaybackFixture({mp4=false,audio=false}={}){
 const dom=new JSDOM(html,{url:'https://rig.example/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],preparations=[],resources=[],ready=[],urls=new Map();
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',quote='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',imageId='11111111-1111-4111-8111-111111111111',videoId='22222222-2222-4222-8222-222222222222';
 const bytes={image:new Uint8Array([1,2,3]),video:new Uint8Array([4,5,6])};
 const descriptor=(assetId,kind)=>({id:assetId,mime:kind==='video'?'video/mp4':'image/jpeg',sha256:createHash('sha256').update(bytes[kind]).digest('hex'),size:bytes[kind].length,width:1280,height:720,path:`/api/video-drafts/${quote}/assets/${assetId}`,...(kind==='video'?{durationSeconds:17.94}:{})});
 const saved={available:true,expiresAt:Date.now()+86400000,request:{imageId,videoId,faceId:null,angleIds:[],quality:'pro',keepSound:true,steadyCamera:false,prompt:'Mijn oorspronkelijke volledige scène.'},durationSeconds:17.94,selectedSeconds:18,originalStartSeconds:2.5,cleanup:false,assets:{image:descriptor(imageId,'image'),video:descriptor(videoId,'video'),face:null,angles:[]}};
 w.Blob=Blob;w.File=File;Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});w.rigVideoEnabled=true;w.rigVideoQualities=['standard','pro','human-recast'];w.rigNativeSite=true;w.rigVideoFunding='credits';w.rigSessionActive=()=>true;
 const storage=new Map();w.rigScopedStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};w.rigDraftStorage={getItem:()=>null,setItem(){},removeItem(){}};
 w.MediaRecorder=class{constructor(){resources.push('recorder');throw Error('No encoder is permitted');}static isTypeSupported(){return mp4;}};
 w.HTMLCanvasElement.prototype.captureStream=()=>{resources.push('canvas-stream');throw Error('No stream is permitted');};
 if(audio)w.HTMLMediaElement.prototype.captureStream=()=>{resources.push('audio-stream');throw Error('No audio capture is permitted');};else delete w.HTMLMediaElement.prototype.captureStream;
 w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(_){this.onload?.();}};
 w.URL.createObjectURL=blob=>{const url='blob:saved-'+urls.size;urls.set(url,blob);return url;};w.URL.revokeObjectURL=()=>{};w.rigOpenVideo=async()=> 'blob:completed-result';
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){for(const [key,value]of Object.entries({duration:17.94,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};const src=Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype,'src');Object.defineProperty(video,'src',{configurable:true,get(){return src.get.call(this);},set(value){src.set.call(this,value);if(urls.get(value)?.type==='video/mp4')queueMicrotask(()=>{for(const event of ['loadedmetadata','loadeddata','seeked'])video.dispatchEvent(new w.Event(event));});}});}
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);
  if(path==='/api/generations/recent')return Response.json({job:{id,state:'completed'}});
  if(path===`/api/generations/${id}`)return Response.json({id,state:'completed',durationSeconds:5,videoPath:`/api/generations/${id}/video`,finalizationConfirmed:true});
  if(path===`/api/generations/${id}/draft`)return Response.json(saved);
  for(const kind of ['image','video'])if(path===saved.assets[kind].path)return new Response(bytes[kind],{headers:{'content-type':saved.assets[kind].mime,'content-length':String(bytes[kind].length)}});
  if(path==='/api/payments/balance')return Response.json({mode:'live',currency:'EUR',balance:2500,frozen:false});
  if(path.startsWith('/api/estimate/fal?'))return Response.json({customerProposal:{currency:'EUR',priceCents:450,binding:false}});
  if(path==='/api/generation-quotes'){const request=JSON.parse(options.body);return Response.json({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',quality:request.quality,durationSeconds:17.94,billedSeconds:18,priceCents:450,currency:'EUR',approvalToken:'q'.repeat(43),idempotencyKey:'fresh-owned-full'});}
  throw Error('Unexpected network or paid call: '+path);
 };
 w.eval(media);w.rigMedia.prepareImage=async(...args)=>{preparations.push(['image',args]);return {blob:new Blob(['new portrait'],{type:'image/jpeg'}),width:1280,height:720};};w.rigMedia.prepareImageFile=async()=>({blob:new Blob(['new reference'],{type:'image/jpeg'}),width:1280,height:720});w.rigMedia.prepareVideo=async()=>{preparations.push(['video']);throw Error('Saved media needs no encoding');};
 w.eval(app);w.eval(generation);w.rigVideoMode='live';d.addEventListener('rig-prepared-ready',()=>ready.push(w.rigPreparedMedia()));
 const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Saved playback fixture did not settle: '+el('status').textContent);};
 try{await settle(()=>!el('recentVideo').hidden);el('recentVideo').click();await settle(()=>!w.rigGenerationBusy()&&!el('resultVideo').hidden);el('prepare').click();await settle(()=>el('briefDialog').open);}
 catch(error){dom.window.close();throw error;}
 return {dom,w,d,el,calls,preparations,resources,ready,saved,settle};
}

for(const options of [{mp4:false,audio:false},{mp4:true,audio:false}])test(`verified saved full media obtains a fresh price on a playback-only browser (MP4 recording ${options.mp4})`,async()=>{
 const f=await savedPlaybackFixture(options);try{
  assert.equal(f.el('duration').value,'18');assert.equal(f.el('sound').checked,true);assert.equal(f.el('confirmBrief').disabled,false);assert.equal(f.el('preparationBrowserNote').hidden,true);assert.equal(f.el('tryShortVideo').disabled,true,'a new trial still requires an encoder');
  f.el('editPrompt').value='Mijn gewijzigde volledige beschrijving.';f.el('editPrompt').dispatchEvent(new f.w.Event('input'));f.el('confirmBrief').click();await f.settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await f.settle(()=>!f.el('confirmGeneration').hidden);
  const priced=f.calls.filter(([path])=>path==='/api/generation-quotes');assert.equal(priced.length,1);assert.deepEqual(JSON.parse(priced[0][1].body),{...f.saved.request,prompt:'Mijn gewijzigde volledige beschrijving.'});assert.match(f.el('quoteMessage').textContent,/17\.94 seconden/);assert.match(f.el('quoteMessage').textContent,/4,50/);
  assert.equal(f.ready.length,1);assert.equal(f.ready[0].selectedSeconds,18);assert.deepEqual(f.preparations,[]);assert.deepEqual(f.resources,[]);assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generations'||p.includes('/advance')||p.startsWith('/api/payments/create')),false);
 }finally{f.dom.window.close();}
});

for(const change of ['trial','video','crop','audio'])test(`saved-media playback bypass does not authorize new local preparation after ${change} changes`,async()=>{
 const f=await savedPlaybackFixture();try{
  if(change==='trial')await f.w.rigPrepareChoice(true);
  else{
   if(change==='video'){Object.defineProperty(f.el('motionInput'),'files',{configurable:true,value:[new File(['new source'],'different.mp4',{type:'video/mp4'})]});f.el('motionInput').dispatchEvent(new f.w.Event('change'));f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));}
   if(change==='crop'){f.el('motionCropButton').click();f.el('cropX').value='10';f.el('cropW').value='80';f.el('applyCrop').click();}
   if(change==='audio'){f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));}
   assert.equal(f.el('confirmBrief').disabled,true);await f.w.rigPrepareChoice(false);
  }
  assert.equal(f.el('uploadDialog').open,false);assert.equal(f.ready.length,0);assert.deepEqual(f.preparations,[]);assert.deepEqual(f.resources,[]);assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generation-quotes'||p==='/api/generations'||p.includes('/advance')||p.startsWith('/api/payments/create')),false);
 }finally{f.dom.window.close();}
});

for(const change of ['portrait','closeup','angle'])test(`a playback-only browser reuses its verified saved clip after changing ${change}`,async()=>{
 const f=await savedPlaybackFixture();try{
  const original=f.w.rigPreparedMedia(),file=(id,name)=>{Object.defineProperty(f.el(id),'files',{configurable:true,value:[new File(['new raster'],name,{type:'image/jpeg'})]});f.el(id).dispatchEvent(new f.w.Event('change'));};
  if(change==='portrait')file('personInput','new-phone-photo.jpg');
  if(change==='closeup')file('faceInput','new-closeup.jpg');
  if(change==='angle'){
   file('faceInput','new-closeup.jpg');await f.settle(()=>!f.el('faceReference').hidden);file('anglesInput','new-angle.jpg');
  }
  if(change!=='portrait')await f.settle(()=>!f.el(change==='angle'?'angleReference0':'faceReference').hidden);
  assert.equal(f.el('duration').value,'18','changing identity cannot drop the verified fractional clip duration');assert.equal(f.el('confirmBrief').disabled,false);f.el('confirmBrief').click();await f.settle(()=>f.el('uploadDialog').open);
  const prepared=f.w.rigPreparedMedia();assert.equal(prepared.selectedSeconds,18);assert.equal(prepared.video.blob,original.video.blob);assert.equal(prepared.assetRefs.videoId,f.saved.request.videoId);assert.equal(prepared.assetRefs.imageId,undefined);assert.equal(prepared.trialToken,undefined);
  assert.equal(f.preparations.filter(([kind])=>kind==='video').length,0);assert.deepEqual(f.resources,[]);assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generation-quotes'||p==='/api/generations'||p.includes('/advance')||p.startsWith('/api/payments/create')),false);
 }finally{f.dom.window.close();}
});
