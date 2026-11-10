import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const media=readFileSync(new URL('./frontend/multiuser/media.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),created=[],revoked=[],images=[],paints=[];
 w.Blob=Blob;w.File=File;w.rigVideoEnabled=true;w.rigSessionActive=()=>true;w.rigVideoQualities=['standard','pro','edit-standard'];
 w.MediaRecorder=class{static isTypeSupported(){return true;}};w.HTMLCanvasElement.prototype.captureStream=()=>{};w.HTMLMediaElement.prototype.captureStream=()=>{};
 w.URL.createObjectURL=blob=>{const url='blob:local-'+created.length;created.push({blob,url});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);
 let automatic=true;
 w.Image=class{
  constructor(){this.naturalWidth=8064;this.naturalHeight=6048;images.push(this);}
  set src(value){this.url=value;if(value&&automatic)queueMicrotask(()=>this.onload?.());}
 };
 w.HTMLCanvasElement.prototype.getContext=function(){return {drawImage:(source,...args)=>paints.push({canvas:this,source,args})};};
 w.HTMLCanvasElement.prototype.toBlob=function(done,type,quality){done(new Blob([`${this.width}x${this.height}:${quality}`],{type}));};
 w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){
  for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:3840,videoHeight:2160}))Object.defineProperty(video,key,{configurable:true,writable:true,value});
  video.pause=()=>{};
 }
 w.eval(media);w.rigMedia.prepareVideo=async()=>({blob:new Blob(['prepared clip'],{type:'video/mp4'}),duration:5,width:1280,height:720});w.eval(app);
 const files=(id,...values)=>{Object.defineProperty(el(id),'files',{configurable:true,value:values});el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
 const file=(name,type,large=false)=>new File([large?new Uint8Array(20*1024*1024):'media'],name,{type});
 const load=async()=>{files('personInput',file('phone.jpg','image/jpeg'));await tick();files('motionInput',file('4k.mp4','video/mp4'));el('motionVideo').dispatchEvent(new w.Event('loadedmetadata'));};
 const prepare=async()=>{el('prepare').click();el('confirmBrief').click();await tick();};
 return {dom,w,el,created,revoked,images,paints,files,file,load,prepare,manual:()=>{automatic=false;}};
}
test('large phone photos in main, close-up and three angles become bounded JPEGs before the generation handoff',async()=>{
 const f=fixture();
 try{
  await f.load();
  const source=f.file('48mp-phone.png','image/png',true);assert.ok(source.size>16*1024*1024);
  f.files('personInput',source);await tick();assert.equal(f.el('personFrame').width,1280);assert.equal(f.el('personFrame').height,960);
  const face=f.file('large-face.png','image/png',true),angles=[f.file('left.webp','image/webp',true),f.file('right.jpg','image/jpeg',true),f.file('back.png','image/png',true)];
  f.files('faceInput',face);assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('confirmBrief').disabled,true);assert.equal(f.el('tryShortVideo').disabled,true);
  f.files('anglesInput',...angles);await tick();assert.equal(f.el('angleReference2').hidden,false);assert.equal(f.el('prepare').disabled,false);
  await f.prepare();const prepared=f.w.rigPreparedMedia();assert.ok(prepared);
  for(const blob of [prepared.image.blob,prepared.face,...prepared.angles]){assert.equal(blob.type,'image/jpeg');assert.ok(blob.size<16*1024*1024);assert.ok(![source,face,...angles].includes(blob));}
  assert.equal(prepared.angles.length,3);assert.equal(f.el('faceInput').value,'');
  // Decoder URLs are fixed raster MIME blobs, even for original Files over the
  // transfer bound; all temporary full-resolution decoders are released.
  for(const image of f.images.slice(-4))assert.equal(image.url,'');
  assert.equal(f.revoked.filter(url=>f.created.find(item=>item.url===url)?.blob.size>16*1024*1024).length,4);
  assert.equal(f.w.rigPreparedMedia().video.blob.type,'video/mp4');
 }finally{f.dom.window.close();}
});
test('replacing or removing a pending photo cannot publish a stale reference or unblock a newer import',async()=>{
 const f=fixture();
 try{
  await f.load();await f.prepare();assert.ok(f.w.rigPreparedMedia());f.manual();
  f.files('faceInput',f.file('old.jpg','image/jpeg'));const old=f.images.at(-1);assert.equal(f.w.rigPreparedMedia(),null);
  f.files('faceInput',f.file('new.png','image/png'));const current=f.images.at(-1);old.onload();await tick();
  assert.equal(f.el('faceReference').hidden,true);assert.equal(f.el('prepare').disabled,true);
  current.onload();await tick();const accepted=f.el('faceThumb').src;assert.equal(f.el('faceReference').hidden,false);assert.equal(f.el('prepare').disabled,false);
  f.files('faceInput',f.file('stale-error.jpg','image/jpeg'));const staleError=f.images.at(-1);f.files('faceInput',f.file('latest.jpg','image/jpeg'));const latest=f.images.at(-1),pendingStatus=f.el('referenceStatus').textContent;
  staleError.onerror();await tick();assert.equal(f.el('referenceStatus').textContent,pendingStatus);assert.equal(f.el('prepare').disabled,true);latest.onerror();await tick();assert.equal(f.el('faceThumb').src,accepted);
  f.files('faceInput',f.file('broken.jpg','image/jpeg'));const broken=f.images.at(-1);broken.onerror();await tick();
  assert.equal(f.el('faceThumb').src,accepted);assert.match(f.el('referenceStatus').textContent,/kan niet worden geopend/);assert.equal(f.el('prepare').disabled,false);
  f.files('faceInput',f.file('removed.jpg','image/jpeg'));const removed=f.images.at(-1);f.el('removeFace').click();removed.onload();await tick();
  assert.equal(f.el('faceReference').hidden,true);assert.equal(f.el('prepare').disabled,false);
  f.files('faceInput',f.file('previous-person.jpg','image/jpeg'));const previous=f.images.at(-1);
  f.files('personInput',f.file('new-person.jpg','image/jpeg'));const main=f.images.at(-1);main.onload();previous.onload();await tick();
  assert.equal(f.el('faceReference').hidden,true);assert.equal(f.el('prepare').disabled,false);
 }finally{f.dom.window.close();}
});
test('angle batches decode one full-size photo at a time and publish no partial batch after a decode failure',async()=>{
 const f=fixture();
 try{
  await f.load();f.manual();const before=f.images.length;
  f.files('anglesInput',f.file('left.jpg','image/jpeg'),f.file('bad.png','image/png'),f.file('back.webp','image/webp'));
  assert.equal(f.images.length,before+1);f.images.at(-1).onload();await tick();assert.equal(f.images.length,before+2);assert.equal(f.el('angleReference0').hidden,true);
  f.images.at(-1).onerror();await tick();assert.equal(f.images.length,before+2);assert.equal(f.el('angleReference0').hidden,true);assert.equal(f.el('prepare').disabled,false);
  assert.equal(f.images.at(-1).url,'');assert.match(f.el('referenceStatus').textContent,/kan niet worden geopend/);
 }finally{f.dom.window.close();}
});
test('the real photo decoder rejects active formats without a URL and fixes raster MIME independently of filenames',async()=>{
 const f=fixture();
 try{
  const initial=f.created.length;
  await assert.rejects(f.w.rigMedia.prepareImageFile(f.file('photo.jpg','image/svg+xml')),/JPG/);assert.equal(f.created.length,initial);
  const original=f.file('not-an-active-document.html','image/png',true),prepared=await f.w.rigMedia.prepareImageFile(original);
  const decoded=f.created[initial];assert.equal(decoded.blob.type,'image/png');assert.notEqual(decoded.blob,original);assert.ok(f.revoked.includes(decoded.url));
  assert.equal(prepared.width,1280);assert.equal(prepared.height,960);assert.equal(prepared.blob.type,'image/jpeg');assert.equal(f.images.at(-1).url,'');
 }finally{f.dom.window.close();}
});
test('a pending captured frame cannot overwrite a newer uploaded close-up',async()=>{
 const f=fixture();
 try{
  await f.load();await f.prepare();assert.ok(f.w.rigPreparedMedia());let finishCapture;
  f.w.rigMedia.prepareImage=()=>new Promise(resolve=>{finishCapture=()=>resolve({blob:new Blob(['old captured frame'],{type:'image/jpeg'}),width:1280,height:720});});
  f.el('captureFace').click();assert.equal(f.el('prepare').disabled,true);assert.equal(f.w.rigPreparedMedia(),null,'starting a reference capture invalidates the old prepared draft and quote immediately');
  f.files('faceInput',f.file('new-close-up.png','image/png'));await tick();const accepted=f.el('faceThumb').src;
  assert.equal(f.el('faceReference').hidden,false);assert.equal(f.el('prepare').disabled,false);
  finishCapture();await tick();assert.equal(f.el('faceThumb').src,accepted);assert.equal(f.el('referenceStatus').textContent,'Close-up toegevoegd');
 }finally{f.dom.window.close();}
});
