import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
function fixture(){
 const dom=new JSDOM(html,{url:'https://rig.example/multiuser/',runScripts:'outside-only'}),win=dom.window,doc=win.document;
 const byId=id=>doc.getElementById(id),prepared=[];
 win.URL.createObjectURL=()=>`blob:fixture-${Math.random()}`;win.URL.revokeObjectURL=()=>{};
 win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};
 for(const dialog of doc.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false}}
 for(const video of doc.querySelectorAll('video')){
  for(const [name,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:640,videoHeight:480}))Object.defineProperty(video,name,{configurable:true,writable:true,value});
  video.pause=()=>{video.paused=true};video.play=async()=>{video.paused=false;video.dispatchEvent(new win.Event('play'))};
 }
 win.Image=class{constructor(){this.naturalWidth=640;this.naturalHeight=480}set src(value){this.onload()}};
 win.rigVideoEnabled=true;win.rigSessionActive=()=>true;
 win.rigMedia={bounds:crop=>crop,dimensions:()=>({width:640,height:480}),paint(){},prepareImage:async()=>({blob:new win.Blob(['image'],{type:'image/jpeg'})}),
  prepareVideo:async(video,crop,start,duration,keepSound,_progress,options)=>{const result={blob:new win.Blob(['video'],{type:'video/mp4'}),crop:{...crop},start,duration,keepSound,options};prepared.push(result);return result},
 };
 win.eval(app);
 const change=(id,value)=>{byId(id).value=value;byId(id).dispatchEvent(new win.Event('change',{bubbles:true}))};
 const loadMotion=duration=>{
  const input=byId('motionInput'),video=byId('motionVideo');
  Object.defineProperty(input,'files',{configurable:true,value:[new win.File(['motion'],'motion.mp4',{type:'video/mp4'})]});
  input.dispatchEvent(new win.Event('change',{bubbles:true}));video.duration=duration;video.currentTime=0;video.dispatchEvent(new win.Event('loadedmetadata'));
 };
 const loadPerson=()=>{
  const input=byId('personInput');Object.defineProperty(input,'files',{configurable:true,value:[new win.File(['person'],'person.jpg',{type:'image/jpeg'})]});
  input.dispatchEvent(new win.Event('change',{bubbles:true}));
 };
 const prepare=()=>{byId('prepare').click();if(byId('briefDialog').open)byId('confirmBrief').click();};
 return {dom,win,doc,byId,change,loadMotion,loadPerson,prepare,prepared,close:()=>win.close()};
}
const waitFor=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('Trim UI did not settle')};

test('HTML starts at 3 seconds; a new source defaults to its full integer duration up to 30 seconds',()=>{
 const f=fixture();try{
  assert.equal(f.byId('duration').value,'3');assert.equal(f.byId('duration').max,'30');assert.match(f.byId('trialDurationNote').textContent,/3–30 s/);
  for(const [source,expected] of [[3,3],[3.9,3],[9.8,9],[30,30],[45.25,30]]){
   f.loadMotion(source);
   assert.equal(f.byId('duration').value,String(expected));assert.equal(f.byId('duration').max,String(expected));
   assert.equal(f.byId('start').value,'0');assert.equal(f.byId('start').max,String(Math.floor((source-expected)*10+1e-7)/10));
   assert.equal(f.byId('motionSeek').max,String(source),'preview seek range covers the full source');
  }
 }finally{f.close()}
});

test('the chosen duration and start survive preview events and repeated metadata for the same source',()=>{
 const f=fixture();try{
  f.loadMotion(60);f.change('duration','12');f.change('start','20.5');
  const video=f.byId('motionVideo');video.currentTime=49;video.paused=false;
  for(const event of ['timeupdate','seeked','pause','loadeddata','loadedmetadata'])video.dispatchEvent(new f.win.Event(event));
  assert.equal(f.byId('duration').value,'12');assert.equal(f.byId('start').value,'20.5');
  assert.equal(video.currentTime,49);assert.equal(video.paused,false);assert.equal(f.byId('motionSeek').value,'49');
  f.loadMotion(8.8);assert.equal(f.byId('duration').value,'8');assert.equal(f.byId('start').value,'0');
 }finally{f.close()}
});

test('duration changes clamp only a start that would place the selected fragment beyond the source',()=>{
 const f=fixture();try{
  f.loadMotion(60);f.change('duration','8');f.change('start','45');
  f.change('duration','12');assert.equal(f.byId('start').value,'45');assert.equal(f.byId('start').max,'48');
  f.change('duration','30');assert.equal(f.byId('duration').value,'30');assert.equal(f.byId('start').value,'30');
  f.byId('motionVideo').currentTime=58.9;f.byId('useCurrentStart').click();
  assert.equal(f.byId('start').value,'30');assert.equal(f.byId('motionVideo').currentTime,30);
  f.change('duration','3');f.change('start','12');assert.equal(f.byId('start').value,'12');
  f.change('duration','31');assert.match(f.byId('duration').validationMessage,/3 tot 30/);assert.equal(f.byId('start').value,'12');
  f.change('duration','2');assert.match(f.byId('duration').validationMessage,/3 tot 30/);
  f.change('duration','3');assert.equal(f.byId('duration').validationMessage,'');
 }finally{f.close()}
});

test('cropped and uncropped previews continue through the whole source beyond the selected fragment',()=>{
 const f=fixture();try{
  f.loadMotion(60);f.change('duration','3');f.change('start','2');
  const video=f.byId('motionVideo');
  f.byId('motionCropButton').click();f.byId('cropX').value='10';f.byId('cropW').value='80';f.byId('applyCrop').click();
  assert.equal(f.byId('motionCropped').hidden,false);assert.equal(video.hidden,true);
  for(const time of [5.1,30,59.5]){video.currentTime=time;video.paused=false;video.dispatchEvent(new f.win.Event('timeupdate'));assert.equal(video.currentTime,time);assert.equal(video.paused,false)}
  assert.equal(f.byId('motionSeek').max,'60');assert.equal(f.byId('motionSeek').value,'59.5');
  f.byId('motionCropButton').click();f.byId('resetCrop').click();f.byId('applyCrop').click();
  assert.equal(f.byId('motionCropped').hidden,true);assert.equal(video.hidden,false);
  video.currentTime=59.8;video.paused=false;video.dispatchEvent(new f.win.Event('timeupdate'));
  assert.equal(video.currentTime,59.8);assert.equal(video.paused,false);assert.equal(f.byId('duration').value,'3');assert.equal(f.byId('start').value,'2');
 }finally{f.close()}
});

test('preparation accepts the selected 30 seconds and rejects values outside the source or 3–30 second range',async()=>{
 const f=fixture();try{
  f.loadPerson();f.loadMotion(60);f.byId('editPrompt').value='Maak een dansvideo.';f.byId('editPrompt').dispatchEvent(new f.win.Event('input'));
  for(const duration of ['2','31','3.5']){
   f.change('duration',duration);f.prepare();await waitFor(()=>f.byId('status').textContent.includes('3 tot 30'));
   assert.equal(f.prepared.length,0);
  }
  f.change('duration','30');f.change('start','9.5');f.prepare();await waitFor(()=>f.win.rigPreparedMedia()!==null);
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].duration,30);assert.equal(f.prepared[0].start,9.5);
  f.loadMotion(8.9);f.change('duration','9');f.prepare();await waitFor(()=>f.byId('status').textContent.includes('3 tot 8'));
  assert.equal(f.prepared.length,1,'a fragment longer than the source maximum is not prepared');
 }finally{f.close()}
});

test('a five-second trial preserves the chosen start, crops, description, quality and sound',async()=>{
 for(const mode of ['motion','edit']){
  const f=fixture();try{
   f.win.rigVideoQualities=['standard','pro','edit-standard'];f.doc.dispatchEvent(new f.win.Event('rig-video-availability'));
   f.loadPerson();f.loadMotion(12.8);if(mode==='edit')f.byId('editModeButton').click();
   f.change('duration','10');f.change('start','2.3');
   f.byId('personCropButton').click();f.byId('cropX').value='15';f.byId('cropW').value='80';f.byId('applyCrop').click();
   f.byId('motionCropButton').click();f.byId('cropX').value='10';f.byId('cropW').value='80';f.byId('applyCrop').click();
   f.byId('sound').checked=false;f.byId('sound').dispatchEvent(new f.win.Event('change'));
   const prompt='Behoud de gekozen scène en vervang de hoofdrolspeler.';
   f.byId('editPrompt').value=prompt;f.byId('editPrompt').dispatchEvent(new f.win.Event('input'));
   const imageCrops=[];f.win.rigMedia.prepareImage=async(_source,crop)=>{imageCrops.push({...crop});return {blob:new f.win.Blob(['image'],{type:'image/jpeg'})};};
   f.byId('prepare').click();assert.equal(f.byId('tryShortVideo').disabled,false);assert.equal(f.byId('shortTrialHint').hidden,true);
   f.byId('tryShortVideo').click();await waitFor(()=>f.win.rigPreparedMedia()!==null);
   assert.equal(f.prepared.length,2);assert.deepEqual(f.prepared.map(video=>video.duration),[10,5]);assert.ok(f.prepared.every(video=>video.start===2.3));
   for(const video of f.prepared){assert.deepEqual(video.crop,{x:10,y:0,w:80,h:100});assert.equal(video.keepSound,false);}assert.deepEqual(imageCrops,[{x:15,y:0,w:80,h:100}]);
   assert.equal(f.win.rigPreparedMedia().prompt,prompt);assert.equal(f.win.rigPreparedMedia().quality,mode==='edit'?'edit-standard':'pro');
   assert.equal(f.byId('duration').value,'10','the full selection remains intact');assert.equal(f.win.rigPreparedMedia().selectedSeconds,5);assert.equal(f.byId('start').value,'2.3');
   f.byId(mode==='edit'?'motionModeButton':'editModeButton').click();f.byId(mode==='edit'?'editModeButton':'motionModeButton').click();
   assert.equal(f.byId('duration').value,'10','the full duration is remembered for that mode');
  }finally{f.close()}
 }
});

test('a trial never silently moves a near-end start and leaves three- or four-second sources usable normally',async()=>{
 for(const [source,start] of [[3,0],[4.99,0],[12,8]]){
  const f=fixture();try{
   f.loadPerson();f.loadMotion(source);f.change('duration','3');f.change('start',String(start));f.byId('prepare').click();
   assert.equal(f.byId('tryShortVideo').disabled,true);assert.equal(f.byId('shortTrialHint').hidden,false);assert.match(f.byId('shortTrialHint').textContent,/5/);
   f.byId('tryShortVideo').dispatchEvent(new f.win.Event('click'));await new Promise(resolve=>setImmediate(resolve));
   assert.equal(f.prepared.length,0);assert.equal(f.byId('start').value,String(start));assert.equal(f.byId('duration').value,'3');
   f.byId('confirmBrief').click();await waitFor(()=>f.win.rigPreparedMedia()!==null);assert.equal(f.prepared[0].duration,3);assert.equal(f.prepared[0].start,start);
  }finally{f.close()}
 }
 for(const [source,start] of [[10,5],[9.2,4.2]]){
  const f=fixture();try{
   f.loadPerson();f.loadMotion(source);f.change('duration','3');f.change('start',String(start));f.byId('prepare').click();
   assert.equal(f.byId('tryShortVideo').disabled,false);f.byId('tryShortVideo').click();await waitFor(()=>f.win.rigPreparedMedia()!==null);
   assert.equal(f.prepared[0].start,start);assert.equal(f.prepared[0].duration,5);assert.equal(f.byId('start').value,String(start));
  }finally{f.close()}
 }
});

test('trial preparation rejects an empty prompt, inactive session or capability and ignores a busy double click',async()=>{
 const f=fixture();let release;
 try{
  f.loadPerson();f.loadMotion(12);f.byId('prepare').click();
  f.byId('editPrompt').value=' ';f.byId('editPrompt').dispatchEvent(new f.win.Event('input'));
  assert.equal(f.byId('tryShortVideo').disabled,true);f.byId('tryShortVideo').dispatchEvent(new f.win.Event('click'));assert.equal(f.prepared.length,0);assert.equal(f.byId('duration').value,'12');
  f.byId('editPrompt').value='Neem de beweging over.';f.byId('editPrompt').dispatchEvent(new f.win.Event('input'));
  f.win.rigSessionActive=()=>false;f.doc.dispatchEvent(new f.win.Event('rig-video-availability'));
  assert.equal(f.byId('tryShortVideo').disabled,true);f.byId('tryShortVideo').dispatchEvent(new f.win.Event('click'));assert.equal(f.prepared.length,0);assert.equal(f.byId('duration').value,'12');
  f.win.rigSessionActive=()=>true;f.win.rigVideoEnabled=false;f.doc.dispatchEvent(new f.win.Event('rig-video-availability'));
  assert.equal(f.byId('tryShortVideo').disabled,true);f.byId('tryShortVideo').dispatchEvent(new f.win.Event('click'));assert.equal(f.prepared.length,0);
  f.win.rigVideoEnabled=true;f.doc.dispatchEvent(new f.win.Event('rig-video-availability'));
  let images=0;f.win.rigMedia.prepareImage=()=>{images++;return new Promise(resolve=>{release=()=>resolve({blob:new f.win.Blob(['image'],{type:'image/jpeg'})});});};
  f.byId('tryShortVideo').click();assert.equal(f.byId('tryShortVideo').disabled,true);f.byId('tryShortVideo').dispatchEvent(new f.win.Event('click'));
  assert.equal(images,1);assert.equal(f.prepared.length,0);release();await waitFor(()=>f.win.rigPreparedMedia()!==null);assert.deepEqual(f.prepared.map(video=>video.duration),[12,5]);
 }finally{release?.();f.close()}
});
