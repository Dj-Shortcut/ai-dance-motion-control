import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('video frames are captured locally and passed to the actual generation handoff', async () => {
 const elements=new Map();let serial=0;
 const html=readFileSync(new URL('./frontend/index.html',import.meta.url),'utf8');
 const realIds=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
 const el=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,disabled:false,value:'',max:'10',textContent:'',style:{},files:[],duration:30,videoWidth:640,videoHeight:480,readyState:2,paused:true,currentTime:0,listeners:{},addEventListener(n,f){(this.listeners[n]??=[]).push(f)},dispatch(n,event={target:this}){return (this.listeners[n]||[]).map(f=>f(event))},click(){return this.dispatch('click')},showModal(){},close(){},pause(){this.paused=true},play(){this.paused=false;return Promise.resolve()},setCustomValidity(){},select(){},getBoundingClientRect(){return{width:640,height:480}},setPointerCapture(){},dispatchEvent(e){this.dispatch(e.type);return true}});return elements.get(id)};
 const events=[];const document={getElementById:id=>realIds.has(id)?el(id):null,querySelectorAll:()=>[],querySelector:q=>q.includes('textarea')?el('prompt'):{value:'pro'},dispatchEvent(e){events.push(e.type)},createElement:()=>el('new')};
 const rigMedia={bounds:c=>c,dimensions:()=>({width:640,height:480}),paint(){},async prepareImage(source,crop){return {blob:new Blob([`frame-${++serial}`],{type:'image/jpeg'}),width:640,height:480}},async prepareVideo(){return{blob:new Blob(['video'],{type:'video/mp4'})}}};
 const window={rigMedia,addEventListener(){}};const ctx={document,window,Blob,Image:class{},Event:class{constructor(type){this.type=type}},URL:{createObjectURL:()=>`blob:${++serial}`,revokeObjectURL(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},console};
 runInNewContext(readFileSync(new URL('./frontend/app.js',import.meta.url),'utf8'),ctx);
 el('personInput').files=[{name:'ref.mp4',type:'video/mp4'}];el('personInput').dispatch('change');el('personVideo').onloadedmetadata();el('personVideo').onloadeddata();
 assert.equal(el('referencePanel').hidden,false);assert.equal(el('referenceCapture').hidden,false);
 await Promise.all(el('captureMain').click());await Promise.all(el('captureFace').click());await Promise.all(el('captureAngle').click());await Promise.all(el('captureAngle').click());await Promise.all(el('captureAngle').click());await Promise.all(el('captureAngle').click());
 assert.equal(el('mainReference').hidden,false);assert.equal(el('faceReference').hidden,false);assert.equal(el('angleReference2').hidden,false);assert.equal(el('captureAngle').disabled,true);
 el('motionInput').files=[{name:'motion.mp4',type:'video/mp4'}];el('motionInput').dispatch('change');el('motionVideo').onloadedmetadata();
 await Promise.all(el('prepare').click());const prepared=window.rigPreparedMedia();assert.ok(prepared.image.blob instanceof Blob);assert.ok(prepared.face instanceof Blob);assert.equal(prepared.angles.length,3);assert.ok(prepared.angles.every(b=>b instanceof Blob));assert.ok(events.includes('rig-prepared-ready'));
 el('removeAngle1').click();assert.equal(el('angleReference2').hidden,true);assert.equal(window.rigPreparedMedia(),null);
 el('personInput').files=[{name:'other.mp4',type:'video/mp4'}];el('personInput').dispatch('change');assert.equal(el('faceReference').hidden,true);assert.equal(el('mainReference').hidden,true);assert.equal(el('angleReference0').hidden,true);
});
