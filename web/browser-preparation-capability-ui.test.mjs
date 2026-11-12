import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
const media=readFileSync(new URL('./frontend/multiuser/media.js',import.meta.url),'utf8');
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
