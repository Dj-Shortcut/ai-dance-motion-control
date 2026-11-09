import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
function fixture(){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),created=[],revoked=[];
 w.rigVideoEnabled=true;w.rigSessionActive=()=>true;w.rigVideoQualities=['standard','pro','edit-standard'];
 w.URL.createObjectURL=blob=>{const url=`blob:https://rig.example.chatgpt.site/${created.length}`;created.push({blob,url});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);
 w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const video of d.querySelectorAll('video')){
  for(const [key,value] of Object.entries({duration:10,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});
  video.pause=()=>{};
 }
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(value){this.url=value;this.onload();}};
 w.rigMedia={paint(){}};
 w.eval(app);
 const files=(id,...values)=>{Object.defineProperty(el(id),'files',{configurable:true,value:values});el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
 const file=(name,type,bytes='media')=>new w.File([bytes],name,{type});
 const text=blob=>new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsText(blob);});
 return {dom,w,el,created,revoked,files,file,text};
}

test('every local media input rejects active documents and wrong media roles before creating a URL',()=>{
 const f=fixture();
 try{
  for(const id of ['personInput','motionInput','resultInput','faceInput','anglesInput']){
   for(const [name,type] of [['photo.jpg','text/html'],['video.mp4','image/svg+xml'],['unknown.mp4','']]){
    f.files(id,f.file(name,type,'<svg onload="alert(1)"></svg>'));
    assert.equal(f.created.length,0,`${id} must reject ${type||'an unknown MIME type'}`);
   }
  }
  for(const id of ['motionInput','resultInput'])f.files(id,f.file('not-a-video.jpg','image/jpeg'));
  for(const id of ['faceInput','anglesInput'])f.files(id,f.file('not-a-photo.mp4','video/mp4'));
  f.el('editModeButton').click();f.files('personInput',f.file('not-an-edit-reference.mp4','video/mp4'));
  assert.equal(f.created.length,0);assert.equal(f.el('resultVideo').hasAttribute('src'),false);assert.equal(f.el('export').hasAttribute('href'),false);
 }finally{f.dom.window.close();}
});

test('previews and downloads use new blobs with fixed non-active MIME types, never the selected File',async()=>{
 const f=fixture(),payload='<html><script>window.injected=true</script></html>';
 try{
  for(const type of ['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm']){
   // An OS-reported MIME type can be spoofed. The wrapper fixes interpretation
   // independently of the filename and bytes; media decoders reject bad data.
   const source=f.file('untrusted.html',type,payload);f.files('personInput',source);
   const {blob}=f.created.at(-1);assert.notEqual(blob,source);assert.equal(blob.type,type);assert.equal(await f.text(blob),payload);
   assert.equal(f.el('personName').textContent,'untrusted.html');assert.equal(f.w.injected,undefined);
  }
  f.files('motionInput',f.file('clip.mp4','video/mp4;codecs=avc1.42E01E'));
  assert.equal(f.created.at(-1).blob.type,'video/mp4');assert.equal(f.el('motionVideo').src,f.created.at(-1).url);
  const source=f.file('result.mp4','video/mp4',payload);f.files('resultInput',source);
  const {blob,url}=f.created.at(-1);assert.notEqual(blob,source);assert.equal(blob.type,'video/mp4');assert.equal(await f.text(blob),payload);
  assert.equal(f.el('resultVideo').src,url);assert.equal(f.el('export').href,url);assert.equal(f.el('export').download,'result.mp4');
 }finally{f.dom.window.close();}
});

test('reference uploads use safe raster blobs and reject a mixed batch without replacing the draft',()=>{
 const f=fixture();
 try{
  f.files('personInput',f.file('person.jpg','image/jpeg'));
  const face=f.file('face.png','image/png');f.files('faceInput',face);assert.equal(f.created.at(-1).blob.type,'image/png');assert.notEqual(f.created.at(-1).blob,face);const faceUrl=f.el('faceThumb').src;
  f.files('faceInput',f.file('attack.png','image/svg+xml'));assert.equal(f.el('faceThumb').src,faceUrl);
  const count=f.created.length;f.files('anglesInput',f.file('angle.webp','image/webp'),f.file('attack.jpg','text/html'));assert.equal(f.created.length,count);assert.equal(f.el('angleReference0').hidden,true);
  const angle=f.file('angle.webp','image/webp');f.files('anglesInput',angle);assert.equal(f.created.at(-1).blob.type,'image/webp');assert.notEqual(f.created.at(-1).blob,angle);assert.equal(f.el('angleReference0').hidden,false);
 }finally{f.dom.window.close();}
});

test('replacing local media revokes the old URL and page exit revokes current URLs',()=>{
 const f=fixture();
 try{
  f.files('resultInput',f.file('first.mp4','video/mp4'));const first=f.created.at(-1).url;
  f.files('resultInput',f.file('second.webm','video/webm'));const second=f.created.at(-1).url;
  assert.deepEqual(f.revoked,[first]);assert.equal(f.el('export').href,second);
  f.w.dispatchEvent(new f.w.Event('pagehide'));assert.ok(f.revoked.includes(second));
 }finally{f.dom.window.close();}
});
