import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {enableVideoIfAvailable} from './frontend/multiuser/video-capability.mjs';
import {prepareBoundUi} from './frontend/multiuser/ui-auth.mjs';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const waitFor=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Edit UI did not settle');};
function fixture({qualities=['standard','pro','edit-standard'],withGeneration=false,price=100,polledFailure=false,refundConfirmed=true,failureCode,scopedStorage,videoEnabled=true,quotePolicy='echo'}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),prepared=[],imagePreparations=[],calls=[],storage=new Map(),removed=[];
 w.Blob=Blob;w.rigNativeSite=true;w.rigVideoEnabled=videoEnabled;w.rigVideoFunding='sponsored';w.rigVideoQualities=qualities;w.rigSessionActive=()=>true;
 w.URL.createObjectURL=()=>`blob:fixture-${Math.random()}`;w.URL.revokeObjectURL=()=>{};w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){
  for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});
  video.pause=()=>{video.paused=true;};video.play=async()=>{video.paused=false;};
 }
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(_value){this.onload();}};
 w.rigMedia={bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async(source,crop)=>{const image={blob:new Blob(['image'+(imagePreparations.length+1)],{type:'image/jpeg'}),width:1280,height:720};imagePreparations.push({source,sourceTime:Number.isFinite(source.currentTime)?source.currentTime:null,crop:{...crop},image});return image;},prepareVideo:async(...args)=>{prepared.push(args);return {blob:new Blob(['video'],{type:'video/mp4'}),duration:args[3],width:1280,height:720};}};
 w.rigScopedStorage=scopedStorage??{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>{removed.push(key);storage.delete(key);}};
 let uploads=0,quotes=0;
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);let value;
  if(path==='/api/generations/recent')value={job:null};
  else if(path==='/api/sponsor-invitations/status')value={state:'eligible',remainingCents:500};
  else if(path==='/api/assets')value={id:'asset'+(++uploads),status:'ready'};
  else if(path==='/api/generation-quotes'){const input=JSON.parse(options.body),seconds=Number(el('duration').value),id=++quotes===1?'quote-edit':'quote-edit-'+quotes;value={id,quality:input.quality,priceCents:price,currency:'EUR',durationSeconds:seconds,billedSeconds:seconds,...(quotePolicy==='echo'?(input.transferPolicy?{transferPolicy:input.transferPolicy}:{}):quotePolicy===null?{}:{transferPolicy:quotePolicy}),...(price<=500?{approvalToken:'t'.repeat(43),idempotencyKey:'rigchatgpt_'+id}:{})};}
  else if(path==='/api/generations')value=polledFailure?{id:'job-edit',state:'queued',priceCents:price,currency:'EUR'}:{id:'job-edit',state:'failed',...(refundConfirmed===undefined?{}:{refundConfirmed}),...(failureCode?{failureCode}:{})};
  else if(path==='/api/generations/job-edit')value={id:'job-edit',state:'failed',priceCents:price,currency:'EUR',...(refundConfirmed===undefined?{}:{refundConfirmed}),...(failureCode?{failureCode}:{})};
  else if(path.startsWith('/api/estimate/fal?')){const params=new URL(path,w.location.origin).searchParams;value={quality:params.get('quality'),durationSeconds:Number(params.get('duration')),billedSeconds:Math.ceil(Number(params.get('duration'))),customerProposal:{currency:'EUR',priceCents:100,binding:false}};}
  else throw Error('unexpected request '+path);
  return {ok:true,json:async()=>value};
 };
 w.eval(app);if(withGeneration)w.eval(generation);
 const change=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
 const prompt=text=>{el('editPrompt').value=text;el('editPrompt').dispatchEvent(new w.Event('input',{bubbles:true}));};
 const file=(id,name,type)=>{Object.defineProperty(el(id),'files',{configurable:true,value:[new w.File(['file'],name,{type})]});el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
 const load=()=>{file('personInput','dog.jpg','image/jpeg');file('motionInput','orchestra.mp4','video/mp4');el('motionVideo').dispatchEvent(new w.Event('loadedmetadata'));};
 const prepare=()=>{el('prepare').click();if(el('briefDialog').open)el('confirmBrief').click();};
 return {dom,w,d,el,prepared,imagePreparations,calls,storage,removed,change,prompt,file,load,prepare,setRefundConfirmed:value=>{refundConfirmed=value;}};
}
test('editing appears only when the server offers edit-standard and adds no footer controls',()=>{
 const unavailable=fixture({qualities:['standard','pro']});
 try{assert.equal(unavailable.el('videoModeTabs').hidden,true);unavailable.el('editModeButton').click();assert.equal(unavailable.w.rigVideoMode(),'motion');}finally{unavailable.dom.window.close();}
 const f=fixture();
 try{assert.equal(f.el('videoModePanel').hidden,false);assert.equal(f.el('motionModeButton').getAttribute('aria-pressed'),'true');assert.deepEqual([...f.d.querySelector('footer .actions').children].map(el=>el.id),['settingsToggle','prepare']);}finally{f.dom.window.close();}
});
test('a deliberate mode choice survives a real account-scoped page reload without storing private draft content',async()=>{
 const backing=new Map(),sessionStorage={getItem:key=>backing.get(key)??null,setItem:(key,value)=>backing.set(key,value),removeItem:key=>backing.delete(key)};
 const bound=async userId=>prepareBoundUi({browser:{sessionStorage},auth:{api:async()=>Response.json({userId})}});
 const alice=await bound('u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),bob=await bound('u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 let first,reloaded,other;
 try{
  first=fixture({scopedStorage:alice.scopedStorage});assert.equal(backing.size,0,'a default or capability update must not save a choice');
  first.el('editModeButton').click();first.load();first.prompt('Private hondomschrijving die alleen in dit tabblad hoort.');
  assert.deepEqual([...backing.values()],['edit']);assert.equal(alice.scopedStorage.getItem('rig-video-mode:v1'),'edit');first.dom.window.close();first=null;
  reloaded=fixture({scopedStorage:alice.scopedStorage,qualities:[],videoEnabled:false});assert.equal(reloaded.w.rigVideoMode(),'edit');assert.equal(reloaded.w.rigGenerationQuality(),'edit-standard');assert.equal(reloaded.el('editModeButton').getAttribute('aria-pressed'),'true');assert.equal(reloaded.el('duration').max,'15');assert.doesNotMatch(reloaded.el('editPrompt').value,/Private hond/);assert.match(reloaded.el('editPrompt').value,/^Vervang de hoofdpersoon in de video/);
  reloaded.load();assert.equal(reloaded.el('prepare').disabled,true);assert.match(reloaded.el('videoModeHint').textContent,/niet beschikbaar.*Kies zelf/);
  reloaded.w.rigVideoQualities=['standard','pro','edit-standard'];reloaded.w.rigVideoEnabled=true;reloaded.d.dispatchEvent(new reloaded.w.Event('rig-video-availability'));
  assert.equal(reloaded.w.rigVideoMode(),'edit');assert.equal(reloaded.w.rigGenerationQuality(),'edit-standard');assert.equal(reloaded.el('duration').value,'5');assert.equal(reloaded.el('prepare').disabled,false);
  other=fixture({scopedStorage:bob.scopedStorage});assert.equal(other.w.rigVideoMode(),'motion');assert.equal(bob.scopedStorage.getItem('rig-video-mode:v1'),null);assert.match(other.el('motionModeButton').textContent,/^Op je foto/);assert.match(other.el('videoModeHint').textContent,/lichaam/);
  other.el('motionModeButton').click();assert.equal(bob.scopedStorage.getItem('rig-video-mode:v1'),'motion');assert.equal(alice.scopedStorage.getItem('rig-video-mode:v1'),'edit');assert.deepEqual([...backing.values()].sort(),['edit','motion']);
 }finally{first?.dom.window.close();reloaded?.dom.window.close();other?.dom.window.close();alice.dispose();bob.dispose();}
});
test('temporarily missing editing capability disables the reviewed edit instead of silently changing the model',async()=>{
 const f=fixture({withGeneration:true});
 try{
  f.el('editModeButton').click();f.load();f.prompt('Vervang de zanger door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
  f.w.rigVideoQualities=['standard','pro'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));
  assert.equal(f.w.rigVideoMode(),'edit');assert.equal(f.w.rigGenerationQuality(),'edit-standard');assert.equal(f.el('editModeButton').getAttribute('aria-pressed'),'true');assert.equal(f.el('videoModePanel').hidden,false);assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('confirmBrief').disabled,true);assert.equal(f.el('confirmGeneration').hidden,true);assert.match(f.el('videoModeHint').textContent,/niet beschikbaar.*Kies zelf/);assert.equal(f.storage.get('rig-video-mode:v1'),'edit');
  f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  f.w.rigVideoQualities=['standard','pro','edit-standard'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(f.w.rigVideoMode(),'edit');assert.equal(f.w.rigGenerationQuality(),'edit-standard');assert.equal(f.w.rigPreparedMedia(),null,'a lost capability invalidates the old reviewed quote');
 }finally{f.dom.window.close();}
});
test('motion prefills its description in the pop-out and still blocks an empty one before any media preparation',async()=>{
 const f=fixture();
 try{
  f.load();assert.equal(f.d.querySelectorAll('main textarea').length,0);assert.equal(f.d.querySelectorAll('#settings textarea').length,0);assert.equal(f.d.querySelectorAll('#briefDialog textarea').length,1);
  assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('briefTitle').textContent,'Op je foto');assert.equal(f.el('promptLabel').textContent,'Wat wil je maken?');assert.equal(f.el('editPrompt').required,true);assert.match(f.el('editPrompt').value,/bewegingen uit de video natuurlijk nadoen/);assert.equal(f.el('confirmBrief').disabled,false);
  f.prompt('   ');assert.equal(f.el('confirmBrief').disabled,true);f.el('confirmBrief').click();assert.equal(f.prepared.length,0);assert.equal(f.calls.length,0);
  f.prompt('  Maak een dansvideo bij mij thuis.  ');assert.equal(f.el('confirmBrief').disabled,false);f.el('confirmBrief').click();await waitFor(()=>f.w.rigPreparedMedia()!==null);
  assert.equal(f.el('briefDialog').open,false);assert.equal(f.w.rigPreparedMedia().prompt,'Maak een dansvideo bij mij thuis.');assert.equal(f.w.rigPreparedMedia().quality,'pro');assert.equal(f.prepared.length,1);
 }finally{f.dom.window.close();}
});
test('the shared pop-out remembers each mode description without adding a second field',()=>{
 const f=fixture();
 try{
  f.load();f.el('prepare').click();f.prompt('Neem de dans over in mijn woonkamer.');f.el('closeBrief').click();
  f.el('editModeButton').click();f.el('prepare').click();assert.equal(f.el('briefTitle').textContent,'In de video');assert.equal(f.el('promptLabel').textContent,'Wat wil je veranderen?');assert.match(f.el('editPrompt').value,/^Vervang de hoofdpersoon in de video/);assert.equal(f.el('confirmBrief').disabled,false);f.prompt('Vervang de zanger door mijn hond.');f.el('closeBrief').click();
  f.el('motionModeButton').click();f.el('prepare').click();assert.equal(f.el('editPrompt').value,'Neem de dans over in mijn woonkamer.');f.el('closeBrief').click();
  f.el('editModeButton').click();f.el('prepare').click();assert.equal(f.el('editPrompt').value,'Vervang de zanger door mijn hond.');assert.equal(f.d.querySelectorAll('textarea').length,1);
 }finally{f.dom.window.close();}
});
test('editing has a visible description, five-second first fragment and clear source labels',()=>{
 const f=fixture();
 try{
  f.load();assert.equal(f.el('duration').value,'30');f.el('editModeButton').click();
  assert.equal(f.w.rigGenerationQuality(),'edit-standard');assert.equal(f.el('duration').value,'5');assert.equal(f.el('duration').max,'15');assert.equal(f.el('motionSeek').max,'60');
  assert.equal(f.el('editPromptPanel').hidden,false);assert.equal(f.el('editPrompt').required,true);assert.equal(f.el('prepare').disabled,false);assert.equal(f.el('confirmBrief').disabled,false);assert.equal(f.el('referencePanel').hidden,true);assert.equal(f.el('moreOptions').hidden,true);assert.equal(f.el('steadyOption').hidden,true);assert.equal(f.el('motionQualitySettings').hidden,true);
  assert.equal(f.el('personChooseText').textContent,'Kies een foto of video');assert.equal(f.el('personInput').accept,'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm');assert.equal(f.el('motionRole').textContent,'Video');assert.match(f.el('videoModeHint').textContent,/persoon of dier.*video blijft/);assert.equal(f.el('sound').checked,true);
  f.prompt('Vervang de zanger door mijn hond.');assert.equal(f.el('prepare').disabled,false);
  f.el('motionModeButton').click();assert.equal(f.el('duration').value,'30');assert.equal(f.el('duration').max,'30');assert.equal(f.el('motionQualitySettings').hidden,false);assert.equal(f.el('editPromptPanel').hidden,false);assert.equal(f.el('promptLabel').textContent,'Wat wil je maken?');
 }finally{f.dom.window.close();}
});
test('edit preparation enforces fifteen seconds and strips motion identity/camera controls',async()=>{
 const f=fixture();
 try{
  f.load();f.file('faceInput','closeup.jpg','image/jpeg');f.file('anglesInput','angle.jpg','image/jpeg');f.el('steady').checked=true;f.el('editModeButton').click();f.prompt('Vervang de zanger door de hond op mijn foto.');
  f.change('duration','16');f.prepare();await waitFor(()=>f.el('status').textContent.includes('3 tot 15'));assert.equal(f.prepared.length,0);
  f.change('duration','5');f.change('start','8.5');f.prepare();await waitFor(()=>f.w.rigPreparedMedia()!==null);
  const media=f.w.rigPreparedMedia(),args=f.prepared[0];assert.equal(media.quality,'edit-standard');assert.equal(media.face,null);assert.equal(media.angles.length,0);assert.equal(media.steady,false);assert.equal(media.keepSound,true);assert.equal(args[2],8.5);assert.equal(args[3],5);assert.equal(JSON.stringify(args[6]),JSON.stringify({minSide:720,maxDuration:15}));
  f.el('motionModeButton').click();assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('faceReference').hidden,false);assert.equal(f.el('angleReference0').hidden,false);
 }finally{f.dom.window.close();}
});
test('an edit uses the current reference crop while preserving an older motion snapshot',async()=>{
 const f=fixture();
 try{
  f.load();f.el('captureMain').click();await waitFor(()=>!f.el('mainReference').hidden);const original=f.imagePreparations[0].image.blob;
  f.el('editModeButton').click();f.el('personCropButton').click();f.el('cropX').value='10';f.el('cropW').value='90';f.el('applyCrop').click();f.prompt('Vervang de zanger door het personage op mijn foto.');
  f.prepare();await waitFor(()=>f.w.rigPreparedMedia()!==null);
  assert.equal(f.imagePreparations.length,2);assert.equal(f.imagePreparations[1].crop.x,10);assert.equal(f.imagePreparations[1].crop.w,90);assert.notEqual(f.w.rigPreparedMedia().image.blob,original);
  f.el('motionModeButton').click();assert.equal(f.el('mainReference').hidden,false);
 }finally{f.dom.window.close();}
});
test('editing extracts a chosen cropped JPEG from a long reference video without uploading that source or changing the motion clip',async()=>{
 const f=fixture({withGeneration:true});
 try{
  f.el('editModeButton').click();f.load();f.change('start','9.5');f.prompt('Vervang de zanger door mij op het gekozen referentiebeeld.');
  const motion=f.el('motionVideo'),motionSource=motion.src;
  f.file('personInput','my-reference-3min.mp4','video/mp4');
  const reference=f.el('personVideo'),referenceFile=f.el('personInput').files[0];reference.duration=180;reference.dispatchEvent(new f.w.Event('loadedmetadata'));reference.dispatchEvent(new f.w.Event('loadeddata'));
  assert.equal(f.el('frameControl').hidden,false);assert.equal(f.el('frameTime').max,'179.99');assert.equal(f.el('personCropButton').hidden,false);assert.equal(f.el('prepare').disabled,false);
  f.el('frameTime').value='47.25';f.el('frameTime').dispatchEvent(new f.w.Event('input'));reference.dispatchEvent(new f.w.Event('seeked'));
  f.el('personCropButton').click();f.el('cropX').value='10';f.el('cropY').value='5';f.el('cropW').value='80';f.el('cropH').value='90';f.el('applyCrop').click();
  f.prepare();await waitFor(()=>f.el('uploadDialog').open);
  const image=f.imagePreparations.at(-1),firstMedia=f.w.rigPreparedMedia();
  assert.equal(image.source,reference);assert.equal(image.sourceTime,47.25);assert.deepEqual(image.crop,{x:10,y:5,w:80,h:90});assert.equal(firstMedia.image.blob.type,'image/jpeg');assert.notEqual(firstMedia.image.blob,referenceFile);
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0][0],motion);assert.equal(f.prepared[0][2],9.5);assert.equal(f.prepared[0][3],5);assert.equal(motion.duration,60);assert.equal(motion.src,motionSource);assert.equal(f.el('duration').value,'5');assert.equal(f.el('start').value,'9.5');
  assert.equal(f.calls.some(([path])=>path==='/api/assets'||path==='/api/generations'),false,'choosing a frame and preparing it stays local until the upload confirmation');
  f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
  const uploads=f.calls.filter(([path])=>path==='/api/assets');assert.equal(uploads.length,2);
  const photoUpload=uploads.find(([,options])=>options.headers['X-Rig-Asset-Kind']==='image')[1];assert.equal(photoUpload.headers['Content-Type'],'image/jpeg');assert.equal(photoUpload.body,firstMedia.image.blob);
  const motionUpload=uploads.find(([,options])=>options.headers['X-Rig-Asset-Kind']==='video')[1];assert.equal(motionUpload.body,firstMedia.video.blob);assert.equal(motionUpload.headers['X-Rig-Duration-Seconds'],'5');
  assert.equal(uploads.some(([,options])=>options.body===referenceFile),false);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.match(f.el('quoteMessage').textContent,/1,00.*gratis testtegoed/);assert.match(f.el('quoteMessage').textContent,/tijdelijke links/);
  f.el('closeQuote').click();f.el('frameTime').value='80.5';f.el('frameTime').dispatchEvent(new f.w.Event('input'));reference.dispatchEvent(new f.w.Event('seeked'));
  assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  f.prepare();await waitFor(()=>f.el('uploadDialog').open);const secondMedia=f.w.rigPreparedMedia(),nextImage=f.imagePreparations.at(-1);assert.equal(nextImage.sourceTime,80.5);assert.deepEqual(nextImage.crop,{x:10,y:5,w:80,h:90});assert.notEqual(secondMedia.image.blob,firstMedia.image.blob);
  assert.equal(f.el('duration').value,'5');assert.equal(f.el('start').value,'9.5');assert.equal(motion.duration,60);assert.equal(motion.src,motionSource);
  f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);assert.equal(f.calls.filter(([path])=>path==='/api/generation-quotes').length,2);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(([path])=>path==='/api/generations'));const confirmations=f.calls.filter(([path])=>path==='/api/generations');assert.equal(confirmations.length,1);assert.equal(JSON.parse(confirmations[0][1].body).quoteId,'quote-edit-2');assert.equal(JSON.parse(confirmations[0][1].body).transferConsent,'fal-temporary-links-v1');
 }finally{f.dom.window.close();}
});
test('editing shows the EUR gift price before one explicit approved generation',async()=>{
 const f=fixture({withGeneration:true});
 try{
  f.el('editModeButton').click();f.load();f.prompt('Vervang de zanger door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);
  f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
  const body=JSON.parse(f.calls.find(([path])=>path==='/api/generation-quotes')[1].body);assert.equal(body.quality,'edit-standard');assert.equal(body.keepSound,true);assert.equal(body.transferPolicy,'fal-temporary-links-v1');for(const key of ['faceId','angleIds','steadyCamera'])assert.equal(Object.hasOwn(body,key),false);
  assert.match(f.el('quoteMessage').textContent,/1,00.*gratis testtegoed/);assert.doesNotMatch(f.el('quoteMessage').textContent,/Fal.*credits/i);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  assert.equal(f.el('quoteTitle').textContent,'In de video');assert.equal(f.el('confirmGeneration').textContent,'Bevestig videobewerking');
  assert.match(f.el('quoteMessage').textContent,/tijdelijke links.*foto, bronvideo en resultaat.*24 uur/);assert.match(f.el('quoteMessage').textContent,/Iedereen met zo’n link/);assert.match(f.el('quoteMessage').textContent,/Bevestig videobewerking.*akkoord/);
  f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(([path])=>path==='/api/generations'));
  const confirm=JSON.parse(f.calls.find(([path])=>path==='/api/generations')[1].body);assert.deepEqual(confirm,{quoteId:'quote-edit',idempotencyKey:'rigchatgpt_quote-edit',approvalToken:'t'.repeat(43),transferConsent:'fal-temporary-links-v1'});
  assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
 }finally{f.dom.window.close();}
});
test('editing cannot confirm an absent or substituted transfer policy',async()=>{
 for(const quotePolicy of [null,'unknown-policy']){
  const f=fixture({withGeneration:true,quotePolicy});
  try{
   f.el('editModeButton').click();f.load();f.prompt('Vervang de honden in alle shots.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);
   f.el('confirmUpload').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('bestandsoverdracht kon niet worden bevestigd'));
   assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.storage.has('rig-generation-pending'),false);
  }finally{f.dom.window.close();}
 }
});
test('the motion quote contains the reviewed description and loses approval when that description changes',async()=>{
 const f=fixture({withGeneration:true});
 try{
  f.load();f.change('duration','5');f.el('prepare').click();f.prompt('  Neem de dans over in mijn woonkamer.  ');f.el('confirmBrief').click();await waitFor(()=>f.el('uploadDialog').open);
  f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
  const input=JSON.parse(f.calls.find(([path])=>path==='/api/generation-quotes')[1].body);assert.equal(input.quality,'pro');assert.equal(input.prompt,'Neem de dans over in mijn woonkamer.');assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
  assert.equal(f.el('quoteTitle').textContent,'Op je foto');assert.equal(f.el('confirmGeneration').textContent,'Bevestig persoonsvideo');
  f.el('closeQuote').click();f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);f.prompt('Neem de dans over op een podium.');assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
 }finally{f.dom.window.close();}
});
test('a five-second trial invalidates a longer reviewed quote and requires a new price and explicit generation consent',async()=>{
 for(const mode of ['motion','edit']){
  const f=fixture({withGeneration:true});
  try{
   f.load();if(mode==='edit')f.el('editModeButton').click();f.change('duration','12');f.change('start','7.5');f.prompt('Vervang het personage en behoud de timing.');
   f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
   const previousMedia=f.w.rigPreparedMedia(),uploads=f.calls.filter(([path])=>path==='/api/assets').length;
   f.el('closeQuote').click();f.el('prepare').click();f.el('tryShortVideo').click();
   assert.equal(f.el('confirmGeneration').hidden,true,'the old approved price must stop being usable immediately');f.el('confirmGeneration').click();
   await waitFor(()=>f.el('uploadDialog').open&&f.w.rigPreparedMedia()!==previousMedia);
   assert.equal(f.calls.filter(([path])=>path==='/api/assets').length,uploads,'the trial does not automatically upload prepared media');
   assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.prepared.at(-1)[2],7.5);assert.equal(f.prepared.at(-1)[3],5);
   await waitFor(()=>f.calls.some(([path])=>path.startsWith('/api/estimate/fal?')&&new URL(path,f.w.location.origin).searchParams.get('duration')==='5'));
   f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
   assert.match(f.el('quoteMessage').textContent,/1,00.*gratis testtegoed/);assert.match(f.el('quoteMessage').textContent,/5\.00 seconden/);
   assert.equal(f.calls.filter(([path])=>path==='/api/generation-quotes').length,2);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
   const videoUploads=f.calls.filter(([path,options])=>path==='/api/assets'&&options.headers['X-Rig-Asset-Kind']==='video');assert.equal(videoUploads.at(-1)[1].headers['X-Rig-Duration-Seconds'],'5');
   if(mode==='edit'){assert.match(f.el('quoteMessage').textContent,/tijdelijke links/);assert.match(f.el('quoteMessage').textContent,/Bevestig videobewerking/);}
   f.el('confirmGeneration').click();await waitFor(()=>f.calls.some(([path])=>path==='/api/generations'));
   const confirmations=f.calls.filter(([path])=>path==='/api/generations');assert.equal(confirmations.length,1);
   const confirmation=JSON.parse(confirmations[0][1].body);assert.equal(confirmation.quoteId,'quote-edit-2');
   assert.equal(confirmation.transferConsent,mode==='edit'?'fal-temporary-links-v1':undefined);
  }finally{f.dom.window.close();}
 }
});
test('a proven subject rejection clears only that non-started pending request so a fresh explicit edit can proceed',async()=>{
 const f=fixture({withGeneration:true});let rejected=false;
 const original=f.w.rigRequest;f.w.rigRequest=async(path,options)=>{if(path==='/api/generations'&&!rejected){rejected=true;f.calls.push([path,options]);return {ok:false,status:409,json:async()=>({error:'Dit videotype past niet.',code:'subject_rejected',generationStarted:false})};}return original(path,options);};
 try{
  f.load();f.change('duration','5');f.prompt('Maak een video met dezelfde beweging.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('Deze video is niet gestart'));
  assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.el('checkGeneration').hidden,true);assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.w.rigVideoMode(),'motion','a rejection must not switch or re-submit automatically');assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
  f.el('closeQuote').click();f.el('editModeButton').click();f.prompt('Vervang de zanger door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);
  assert.equal(f.el('quoteTitle').textContent,'In de video');assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);f.el('confirmGeneration').click();await waitFor(()=>f.calls.filter(([path])=>path==='/api/generations').length===2);
  const submissions=f.calls.filter(([path])=>path==='/api/generations').map(([,options])=>JSON.parse(options.body));assert.notEqual(submissions[0].quoteId,submissions[1].quoteId);assert.equal(f.calls.some(([path])=>path.includes('/reconcile')),false);
 }finally{f.dom.window.close();}
});
test('ambiguous errors and unproved subject codes retain the existing pending recovery handle',async()=>{
 for(const [status,details] of [[409,{}],[409,{code:'subject_rejected',generationStarted:true}],[503,{code:'subject_rejected',generationStarted:false}]]){
  const f=fixture({withGeneration:true}),original=f.w.rigRequest;
  f.w.rigRequest=async(path,options)=>{if(path==='/api/generations'){f.calls.push([path,options]);return {ok:false,status,json:async()=>({error:'Nog onbekend.',...details})};}return original(path,options);};
  try{f.load();f.change('duration','5');f.prompt('Maak een dansvideo.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('Start niet opnieuw'));assert.equal(f.storage.has('rig-generation-pending'),true);assert.equal(f.el('checkGeneration').hidden,false);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);}finally{f.dom.window.close();}
 }
});
test('a terminal failure reports a proven refund and keeps uncertain refunds under review',async()=>{
 for(const confirmed of [true,false]){
  const f=fixture({withGeneration:true,polledFailure:true,refundConfirmed:confirmed});
  try{
   f.el('editModeButton').click();f.load();f.prompt('Vervang de zingende hond door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);
   f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();
   await waitFor(()=>f.el('quoteMessage').textContent.includes('De video kon niet worden gemaakt.'));
   assert.match(f.el('quoteMessage').textContent,confirmed?/tegoed is teruggezet/:/tegoed wordt gecontroleerd/);
   assert.equal(f.storage.has('rig-generation-job'),!confirmed);assert.equal(f.el('checkGeneration').hidden,confirmed);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
  }finally{f.dom.window.close();}
 }
});
test('generic failed-job recovery retains the exact handle until a strictly confirmed refund and never regenerates',async()=>{
 for(const failureCode of [undefined,'provider_failed','https://private.invalid/token?secret=never-show']){
  for(const initialConfirmation of [false,undefined,'true',1])for(const polledFailure of [true,false]){
   const f=fixture({withGeneration:true,polledFailure,refundConfirmed:initialConfirmation,failureCode});
   // An omitted refund field is deliberately different from a false field.
   if(initialConfirmation===undefined)f.setRefundConfirmed(undefined);
   try{
    f.el('editModeButton').click();f.load();f.prompt('Vervang de honden in alle shots.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);
    f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent==='De video kon niet worden gemaakt. Je tegoed wordt gecontroleerd.');
    assert.equal(f.storage.get('rig-generation-job'),'job-edit');assert.equal(f.el('checkGeneration').hidden,false);assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.removed.filter(key=>key==='rig-generation-job').length,0);
    assert.doesNotMatch(f.el('quoteMessage').textContent,/private|secret|token|Fal/);
    f.setRefundConfirmed(true);f.el('checkGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent==='De video kon niet worden gemaakt. Je tegoed is teruggezet.');
    assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.el('checkGeneration').hidden,true);assert.equal(f.removed.filter(key=>key==='rig-generation-job').length,1);
    assert.equal(f.calls.filter(([path])=>path==='/api/generations/job-edit').length,2);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);assert.equal(f.calls.some(([path])=>path.includes('/reconcile')),false);
   }finally{f.dom.window.close();}
  }
 }
});
test('known Fal input failures identify the cause without blaming preparation or retrying the generation',async()=>{
 for(const [failureCode,reason] of [['provider_input_unavailable','Fal kon je foto of video niet openen.'],['provider_subject_not_detected','Fal herkende geen duidelijk menselijk bovenlichaam op je foto.']]){
  for(const confirmed of [true,false,'true'])for(const polledFailure of [true,false]){
   const f=fixture({withGeneration:true,polledFailure,refundConfirmed:confirmed,failureCode});
   try{
    f.el('editModeButton').click();f.load();f.prompt('Vervang de zanger door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);
    f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.startsWith(reason));
    const refunded=confirmed===true;
    assert.equal(f.el('quoteMessage').textContent,reason+(refunded?' Je RIG-tegoed is teruggezet.':' Je RIG-tegoed wordt nog gecontroleerd. Start de opdracht niet opnieuw.'));
    assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.storage.get('rig-generation-job'),refunded?undefined:'job-edit');assert.equal(f.el('checkGeneration').hidden,refunded);assert.equal(f.el('confirmGeneration').hidden,true);
    assert.equal(f.w.rigVideoMode(),'edit');assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
    if(!refunded){
     f.setRefundConfirmed(true);f.el('checkGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent.endsWith('Je RIG-tegoed is teruggezet.'));
     assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.el('checkGeneration').hidden,true);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
    }
   }finally{f.dom.window.close();}
  }
 }
});
test('an unrecognised failure code cannot display raw provider details or a known Fal diagnosis',async()=>{
 const f=fixture({withGeneration:true,polledFailure:true,refundConfirmed:true,failureCode:'https://private.invalid/token?secret=never-show'});
 try{
  f.load();f.change('duration','5');f.prompt('Maak een dansvideo.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>!f.el('confirmGeneration').hidden);f.el('confirmGeneration').click();await waitFor(()=>f.el('quoteMessage').textContent==='De video kon niet worden gemaakt. Je tegoed is teruggezet.');
  assert.doesNotMatch(f.el('quoteMessage').textContent,/private|secret|token|Fal/);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
 }finally{f.dom.window.close();}
});
test('a five-second edit exceeding the gift cannot spend and draft changes hide old confirmation',async()=>{
 const f=fixture({withGeneration:true,price:600});
 try{
  f.el('editModeButton').click();f.load();f.prompt('Vervang de zanger door mijn hond.');f.prepare();await waitFor(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await waitFor(()=>f.el('quoteMessage').textContent.includes('niet voldoende'));
  assert.match(f.el('quoteMessage').textContent,/6,00.*5,00/);assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);
 }finally{f.dom.window.close();}
 const g=fixture({withGeneration:true});
 try{g.el('editModeButton').click();g.load();g.prompt('Vervang de zanger door mijn hond.');g.prepare();await waitFor(()=>g.el('uploadDialog').open);g.el('confirmUpload').click();await waitFor(()=>!g.el('confirmGeneration').hidden);g.prompt('Maak er een andere hond van.');assert.equal(g.el('confirmGeneration').hidden,true);g.el('confirmGeneration').click();assert.equal(g.calls.some(([path])=>path==='/api/generations'),false);}finally{g.dom.window.close();}
});
test('capabilities default to motion only and reject malformed or invented quality lists',async()=>{
 for(const qualities of [undefined,['standard','pro','edit-standard'],[],['edit-standard','edit-standard'],['future-model'],'edit-standard']){
  const dom=new JSDOM('<p id="videoAvailabilityNote"></p>'),w=dom.window;
  try{const valid=qualities===undefined||Array.isArray(qualities)&&qualities.length===3;const enabled=await enableVideoIfAvailable({binding:{isActive:()=>true,request:async()=>Response.json({enabled:true,qualities})},window:w,document:w.document,loadScript:async()=>{}});assert.equal(enabled,valid);if(enabled)assert.deepEqual(w.rigVideoQualities,qualities??['standard','pro']);}finally{dom.window.close();}
 }
});
test('idea tiles preset only the video type and description, and hide types the server does not offer',()=>{
 const f=fixture();
 try{
  const band=f.el('idea-band'),dance=f.el('idea-dans');
  assert.equal(band.hidden,false);assert.equal(band.getAttribute('aria-pressed'),'false');
  band.click();assert.equal(f.w.rigVideoMode(),'edit');assert.equal(f.el('editPrompt').value,band.dataset.ideaPrompt);assert.equal(band.getAttribute('aria-pressed'),'true');assert.equal(f.el('status').textContent,'Idee gekozen. Kies nu een foto.');assert.equal(f.calls.length,0);
  dance.click();assert.equal(f.w.rigVideoMode(),'motion');assert.equal(f.el('editPrompt').value,dance.dataset.ideaPrompt);assert.equal(dance.getAttribute('aria-pressed'),'true');assert.equal(band.getAttribute('aria-pressed'),'false');
  f.prompt('Mijn eigen idee.');assert.equal(dance.getAttribute('aria-pressed'),'false');
 }finally{f.dom.window.close();}
 const motionOnly=fixture({qualities:['standard','pro']});
 try{
  assert.equal(motionOnly.el('idea-band').hidden,true);assert.equal(motionOnly.el('idea-film').hidden,true);assert.equal(motionOnly.el('idea-dans').hidden,false);
  motionOnly.el('idea-band').click();assert.equal(motionOnly.w.rigVideoMode(),'motion');assert.doesNotMatch(motionOnly.el('editPrompt').value,/muzikant/);
 }finally{motionOnly.dom.window.close();}
});
