import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8'),app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const proposal={x:34.583333333333336,y:24.666666666666668,w:25.833333333333332,h:73.66666666666667};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(suggest){
 const dom=new JSDOM(html,{url:'https://rig.example/',runScripts:'outside-only'}),win=dom.window,doc=win.document,el=id=>doc.getElementById(id),paints=[],requests=[];
 win.URL.createObjectURL=()=> 'blob:local';win.URL.revokeObjectURL=()=>{};win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};
 win.rigVideoEnabled=true;win.rigSessionActive=()=>true;win.rigScopedStorage={getItem(){return null},setItem(){},removeItem(){}};win.rigRequest=()=>{requests.push('unexpected');throw Error('No upload or pricing from crop');};
 win.rigSuggestScreenCrop=suggest;win.rigMedia={bounds:c=>c,dimensions:()=>({width:744,height:1326}),paint:(canvas,source,crop)=>paints.push({id:canvas.id,crop:{...crop}})};
 win.Image=class{constructor(){this.naturalWidth=1000;this.naturalHeight=1400}set src(value){this.onload?.()}};
 for(const dialog of doc.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'))};}
 for(const video of doc.querySelectorAll('video')){for(const [k,v]of Object.entries({duration:38.244,currentTime:9.5,paused:true,readyState:2,videoWidth:2880,videoHeight:1800}))Object.defineProperty(video,k,{configurable:true,writable:true,value:v});video.pause=()=>{video.paused=true};}
 win.eval(app);
 function loadMotion(name='screen.mov'){const input=el('motionInput'),file=new win.File(['fixture'],name,{type:'video/quicktime'});Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new win.Event('change'));el('motionVideo').dispatchEvent(new win.Event('loadedmetadata'));return file;}
 function person(){const input=el('personInput');Object.defineProperty(input,'files',{configurable:true,value:[new win.File(['image'],'portrait.jpg',{type:'image/jpeg'})]});input.dispatchEvent(new win.Event('change'));}
 return {win,el,paints,requests,loadMotion,person,close:()=>win.close()};
}
test('screen recording gets a local popout proposal; only Apply changes the real motion crop and the portrait stays intact',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {proposal,confidence:.94}});try{
  f.person();f.loadMotion();const time=f.el('motionVideo').currentTime;f.el('motionCropButton').click();await tick();
  assert.equal(calls,1);assert.equal(f.el('cropDialog').open,true);assert.match(f.el('autoCropStatus').textContent,/voorgesteld/);assert.equal(+f.el('cropX').value,proposal.x);assert.equal(f.el('motionCropped').hidden,true);assert.equal(f.el('motionVideo').currentTime,time);assert.equal(f.requests.length,0);
  f.el('applyCrop').click();assert.equal(f.el('motionCropped').hidden,false);assert.deepEqual(f.paints.filter(p=>p.id==='motionCropped').at(-1).crop,proposal);
  f.el('motionCropButton').click();await tick();assert.equal(calls,1,'an existing reviewed crop is never overwritten automatically');f.el('cropDialog').close();f.el('personCropButton').click();await tick();assert.equal(f.el('autoCrop').hidden,true);assert.equal(+f.el('cropW').value,100);assert.equal(calls,1);
 }finally{f.close()}
});
test('dragging or typing aborts local analysis and a late proposal cannot overwrite manual framing',async()=>{
 let finish,signal;const f=fixture((_file,options)=>{signal=options.signal;return new Promise(r=>finish=r)});try{
  f.loadMotion();f.el('motionCropButton').click();await tick();f.el('cropX').value='12';f.el('cropX').dispatchEvent(new f.win.Event('input'));assert.equal(signal.aborted,true);finish({proposal,confidence:.99});await tick();assert.equal(f.el('cropX').value,'12');assert.equal(f.el('autoCropStatus').hidden,true);
 }finally{f.close()}
});
test('keyboard corner changes abort analysis and clear its progress before late completion',async()=>{
 let finish,signal;const f=fixture((_file,o)=>{signal=o.signal;return new Promise(resolve=>finish=resolve)});try{
  f.loadMotion();f.el('motionCropButton').click();await tick();
  const handle=f.el('cropSelection').querySelector('[data-crop-handle="nw"]');handle.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(signal.aborted,true);assert.equal(f.el('autoCropStatus').hidden,true);assert.equal(f.el('cropX').value,'1');
  finish({proposal,confidence:.99});await tick();assert.equal(f.el('cropX').value,'1');assert.equal(f.el('autoCropStatus').hidden,true);assert.equal(f.requests.length,0);
 }finally{f.close()}
});
test('closing, choosing another file or changing account prevents stale crop selection',async()=>{
 for(const reason of ['close','file','account']){
  let finish,signal;const f=fixture((_file,o)=>{signal=o.signal;return new Promise(r=>finish=r)});try{f.loadMotion();f.el('motionCropButton').click();await tick();if(reason==='close')f.el('cropDialog').close();else if(reason==='file')f.loadMotion('another.mov');else f.win.rigSessionActive=()=>true;finish({proposal,confidence:.99});await tick();assert.equal(f.el('cropX').value,'0');if(reason!=='account')assert.equal(signal.aborted,true);assert.equal(f.requests.length,0);}finally{f.close()}
 }
});
test('uncertain detection preserves full framing and manual crop controls stay usable',async()=>{
 for(const value of [{proposal:null,confidence:0},{proposal,confidence:.45}]){const f=fixture(async()=>value);try{f.loadMotion();f.el('motionCropButton').click();await tick();assert.equal(f.el('cropX').value,'0');assert.equal(f.el('cropW').value,'100');assert.match(f.el('autoCropStatus').textContent,/Geen duidelijk videovlak/);assert.equal(f.el('applyCrop').disabled,false);assert.equal(f.el('autoCrop').disabled,false);f.el('resetCrop').click();assert.equal(f.el('autoCropStatus').hidden,true);}finally{f.close()}}
});

test('crop popup blocks an undersized prepared image before saving and accepts fractional percentages as valid input',()=>{
 const f=fixture(async()=>({proposal:null,confidence:0}));try{f.person();f.win.rigMedia.dimensions=()=>({width:220,height:600});f.el('personCropButton').click();assert.equal(f.el('applyCrop').disabled,true);assert.match(f.el('cropError').textContent,/340/);for(const id of ['cropX','cropY','cropW','cropH']){f.el(id).value='12.345';assert.equal(f.el(id).validity.stepMismatch,false);}}finally{f.close()}
});
