import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
const script=readFileSync(new URL('./frontend/multiuser/media.js',import.meta.url),'utf8');
function setup({hidden=false,gap=false,blur=false,delayedPlay=false}={}){
 let ms=0,painted=0,paintedAtStart=-1,steps=0,focus=true,resolvePlay;const windowEvents={},docEvents={};
 const video={duration:20,currentTime:0,videoWidth:640,videoHeight:480,readyState:2,seeking:false,paused:true,ended:false,pause(){this.paused=true},async play(){this.paused=false;if(delayedPlay)await new Promise(resolve=>{resolvePlay=resolve})},addEventListener(){},removeEventListener(){}};
 class Canvas{getContext(){return {drawImage(){painted++}}}captureStream(){return {getTracks:()=>[{stop(){}}],addTrack(){}}}}
 class Recorder{constructor(){this.mimeType='video/mp4';this.state='inactive'}static isTypeSupported(){return true}start(){paintedAtStart=painted;this.state='recording'}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['synthetic'],{type:'video/mp4'})});this.onstop()}}
 const check={duration:9,events:{},addEventListener(n,f){this.events[n]=f},removeEventListener(n){delete this.events[n]},set src(_){queueMicrotask(()=>this.events.loadedmetadata?.())},removeAttribute(){},load(){}};
 const document={visibilityState:hidden?'hidden':'visible',hasFocus:()=>focus,addEventListener(n,f){docEvents[n]=f},removeEventListener(n){delete docEvents[n]},createElement:k=>k==='canvas'?new Canvas():check};
 const window={addEventListener(n,f){windowEvents[n]=f},removeEventListener(n){delete windowEvents[n]}};
 const ctx={window,document,HTMLCanvasElement:Canvas,MediaRecorder:Recorder,Blob,URL:{createObjectURL:()=> 'blob:fake',revokeObjectURL(){}},performance:{now:()=>ms},setTimeout,clearTimeout,queueMicrotask,requestAnimationFrame:f=>setImmediate(()=>{steps++;ms+=34;if(!video.paused)video.currentTime+=gap&&steps===3?5.5:0.034;if(delayedPlay&&steps===30)resolvePlay?.();if(blur&&steps===3){focus=false;windowEvents.blur?.()}f()}),cancelAnimationFrame:clearImmediate};
 runInNewContext(script,ctx);return {ctx,video,paintedAtStart:()=>paintedAtStart};
}
test('first frame is drawn before recorder begins on an intact recording',async()=>{const f=setup();const result=await f.ctx.window.rigMedia.prepareVideo(f.video,{x:0,y:0,w:100,h:100},0,9,false);assert.ok(result.blob.size);assert.ok(f.paintedAtStart()>=1)});
test('a long playback gap fails instead of accepting a partial video',async()=>{const f=setup({gap:true});await assert.rejects(f.ctx.window.rigMedia.prepareVideo(f.video,{x:0,y:0,w:100,h:100},0,9,false),/onderbroken/)});
test('painting continues while the play promise resolves late',async()=>{const f=setup({delayedPlay:true});const result=await f.ctx.window.rigMedia.prepareVideo(f.video,{x:0,y:0,w:100,h:100},0,9,false);assert.ok(result.blob.size)});
test('losing focus stops capture and hidden tabs never begin',async()=>{const f=setup({blur:true});await assert.rejects(f.ctx.window.rigMedia.prepareVideo(f.video,{x:0,y:0,w:100,h:100},0,9,false),/onderbroken/);const hidden=setup({hidden:true});await assert.rejects(hidden.ctx.window.rigMedia.prepareVideo(hidden.video,{x:0,y:0,w:100,h:100},0,9,false),/Houd RIG in beeld/);assert.equal(hidden.paintedAtStart(),-1)});
test('focus loss interrupts even while play has not resolved',async()=>{const f=setup({blur:true,delayedPlay:true});await assert.rejects(f.ctx.window.rigMedia.prepareVideo(f.video,{x:0,y:0,w:100,h:100},0,9,false),/onderbroken/)});
