import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createHash,webcrypto} from 'node:crypto';

const source=name=>readFileSync(new URL(`./frontend/multiuser/${name}`,import.meta.url),'utf8');
const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Guided RIG flow did not settle');};
const privateDraftStore=()=>({assets:new Map(),drafts:new Map(),quotes:new Map(),jobs:new Map(),assetsCreated:0,quotesCreated:0,jobsCreated:0});
function draftDto(store,quoteId){
 const row=store.drafts.get(quoteId);if(!row)return {available:false,reason:'missing'};
 const descriptor=id=>{const asset=store.assets.get(id);if(!asset)throw Error('Fixture draft asset missing');return {...asset.meta,path:`/api/video-drafts/${quoteId}/assets/${id}`};};
 const request={imageId:row.imageId,videoId:row.fullVideoId,faceId:row.faceId,angleIds:row.angleIds,quality:row.quality,keepSound:row.keepSound,steadyCamera:row.steadyCamera??false,prompt:row.prompt,...(row.transferPolicy?{transferPolicy:row.transferPolicy}:{})};
 return {available:true,expiresAt:row.expiresAt,request,durationSeconds:store.assets.get(row.fullVideoId).meta.durationSeconds,selectedSeconds:row.selectedSeconds,originalStartSeconds:row.originalStartSeconds,cleanup:row.cleanup,assets:{image:descriptor(row.imageId),video:descriptor(row.fullVideoId),face:row.faceId?descriptor(row.faceId):null,angles:row.angleIds.map(descriptor)}};
}
function fixture({withGeneration=false,canShare=false,qualities=['standard','pro','edit-standard'],funding='credits',statusResponse,shareRead,recentJob=null,reconcileJob=null,storage:savedStorage=new Map(),draftStorage:savedDraftStorage=null,persistDrafts=false,serverStore=privateDraftStore(),savedDraftResponse,legacyDraftServer=false,saveDraftResponse,assetRead,restoredDurationOffset=0}={}){
 const dom=new JSDOM(source('index.html'),{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],prepared=[],shared=[],storage=savedStorage,restoredUrls=new Map();
 w.Blob=Blob;Object.defineProperty(w,'crypto',{configurable:true,value:webcrypto});w.rigNativeSite=true;w.rigVideoEnabled=true;w.rigVideoFunding=funding;w.rigVideoMode='live';w.rigVideoQualities=qualities;w.rigSessionActive=()=>true;
 w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 if(savedDraftStorage)w.rigDraftStorage={getItem:key=>savedDraftStorage.get(key)??null,setItem:(key,value)=>savedDraftStorage.set(key,value),removeItem:key=>savedDraftStorage.delete(key)};
 w.URL.createObjectURL=blob=>{const url=`blob:rig-local-${Math.random()}`;if(persistDrafts&&blob?.type==='video/mp4'&&serverStore.drafts.size){const row=[...serverStore.drafts.values()].at(-1);restoredUrls.set(url,serverStore.assets.get(row?.fullVideoId)?.meta.durationSeconds+restoredDurationOffset);}return url;};w.URL.revokeObjectURL=()=>{};w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};w.scrollTo=()=>{};w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
 el('authGate').hidden=true;el('rigStudio').hidden=false;
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){if(!this.open)return;this.open=false;this.dispatchEvent(new w.Event('close'));};}
 for(const video of d.querySelectorAll('video')){for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};video.play=async()=>{};const src=Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype,'src');Object.defineProperty(video,'src',{configurable:true,get(){return src.get.call(this);},set(value){src.set.call(this,value);if(restoredUrls.has(value))queueMicrotask(()=>{video.duration=restoredUrls.get(value);for(const event of ['loadedmetadata','loadeddata','seeked'])video.dispatchEvent(new w.Event(event));});}});}
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(value){this.onload?.();}};
 w.rigMedia={preparationCapability:()=>({supported:true}),bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async()=>({blob:new Blob(['prepared-image'],{type:'image/jpeg'}),width:1280,height:720}),prepareImageFile:async()=>({blob:new Blob(['prepared-image'],{type:'image/jpeg'}),width:1280,height:720}),prepareVideo:async(video,crop,start,duration,keepSound)=>{const output={blob:new Blob(['prepared-clip'],{type:'video/mp4'}),duration,width:1280,height:720};prepared.push({start,duration,keepSound,crop:{...crop},output});return output;}};
 w.rigOpenVideo=async path=>`blob:rig-private-${path.split('/').at(-2)}`;
 if(canShare){Object.defineProperty(w.navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(w.navigator,'share',{configurable:true,value:async value=>{shared.push(value);}});w.fetch=async url=>{assert.match(String(url),/^blob:/);return shareRead?shareRead(url):new Response(new Blob(['owned-private-video'],{type:'video/mp4'}));};}
 let assets=0,quotes=0,generations=0;const durations=new Map();
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);let data;
  if(path.startsWith('/api/generation-intents/')&&path.endsWith('/reconcile')&&reconcileJob)data=reconcileJob;
  else if(path==='/api/generations/recent')data={job:recentJob};
  else if(path==='/api/payments/balance')data={mode:'live',currency:'EUR',balance:5000};
  else if(path.startsWith('/api/estimate/fal?')){const query=new URL(path,w.location.origin).searchParams,seconds=Number(query.get('duration'));data={quality:query.get('quality'),durationSeconds:seconds,customerProposal:{currency:'EUR',priceCents:Math.ceil(seconds)*40,binding:false}};}
  else if(path==='/api/assets'){const id=persistDrafts?`a0000000-0000-4000-8000-${String(++serverStore.assetsCreated).padStart(12,'0')}`:`asset-${++assets}`,kind=options.headers['X-Rig-Asset-Kind'],bytes=Buffer.from(await options.body.arrayBuffer()),mime=kind==='video'?'video/mp4':'image/jpeg',duration=Number(options.headers['X-Rig-Duration-Seconds']);if(kind==='video')durations.set(id,duration);serverStore.assets.set(id,{bytes,meta:{id,mime,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,width:1280,height:720,...(kind==='video'?{durationSeconds:duration}:{})}});data={id,kind,status:'ready'};}
  else if(path==='/api/generation-quotes'){const input=JSON.parse(options.body),seconds=durations.get(input.videoId)??serverStore.assets.get(input.videoId)?.meta.durationSeconds,id=persistDrafts?`b0000000-0000-4000-8000-${String(++serverStore.quotesCreated).padStart(12,'0')}`:`quote-${++quotes}`;serverStore.quotes.set(id,input);data={id,quality:input.quality,priceCents:Math.ceil(seconds)*40,currency:'EUR',durationSeconds:seconds,billedSeconds:Math.ceil(seconds),approvalToken:'a'.repeat(43),idempotencyKey:`approval-${id}`,...(input.transferPolicy?{transferPolicy:input.transferPolicy}:{})};}
  else if(path==='/api/video-drafts'){const input=JSON.parse(options.body);serverStore.drafts.set(input.quoteId,{...input,expiresAt:Date.now()+86400000});data=saveDraftResponse??{saved:true,expiresAt:Date.now()+86400000};}
  else if(/^\/api\/generations\/[^/]+\/draft$/.test(path)){if(legacyDraftServer)return Response.json({error:'Not found'},{status:404});const id=path.split('/')[3];data=savedDraftResponse??(persistDrafts?draftDto(serverStore,serverStore.jobs.get(id)):{available:false,reason:'missing'});}
  else if(/^\/api\/video-drafts\/[^/]+\/assets\/[^/]+$/.test(path)){const id=path.split('/').at(-1),asset=serverStore.assets.get(id);if(assetRead)return assetRead(path,asset,options);return asset?new Response(new Uint8Array(asset.bytes),{headers:{'content-type':asset.meta.mime,'content-length':String(asset.bytes.length)}}):Response.json({error:'Bronbestand niet meer beschikbaar.'},{status:404});}
  else if(path==='/api/generations'){data={id:`job-${persistDrafts?++serverStore.jobsCreated:++generations}`,state:'queued'};serverStore.jobs.set(data.id,JSON.parse(options.body).quoteId);}
  else if(/^\/api\/generations\/job-\d+$/.test(path)){const id=path.split('/').at(-1);data=(await statusResponse?.(id))??{id,state:'completed',videoPath:`/api/generations/${id}/video`};}
  else throw Error('Unexpected guided-flow request: '+path);
  return {ok:true,json:async()=>data};
 };
 w.eval(source('app.js'));w.eval(source('flow.js'));if(withGeneration)w.eval(source('generation-ui.js'));w.rigVideoMode='live';
 const change=(id,value,event='change')=>{el(id).value=String(value);el(id).dispatchEvent(new w.Event(event,{bubbles:true}));};
 const file=(id,name,type)=>{const value=new w.File(['original-file'],name,{type});Object.defineProperty(el(id),'files',{configurable:true,value:[value]});el(id).dispatchEvent(new w.Event('change',{bubbles:true}));return value;};
 const load=()=>{const person=file('personInput','phone-photo.jpg','image/jpeg'),motion=file('motionInput','screen-recording.mp4','video/mp4');el('motionVideo').dispatchEvent(new w.Event('loadedmetadata'));return {person,motion};};
 const view=name=>[...d.querySelectorAll('[data-flow-screen]')].find(node=>node.dataset.flowScreen===name);
 const showing=name=>!!view(name)&&!view(name).hidden;
 const make=()=>{el('prepare').click();const files=load();el('prepare').click();el('prepare').click();return files;};
 return {dom,w,d,el,calls,prepared,shared,storage,serverStore,change,file,load,view,showing,make,close:()=>w.close()};
}
const writePaths=f=>f.calls.filter(([path])=>['/api/assets','/api/generation-quotes','/api/generations','/api/payments/create'].includes(path)).map(([path])=>path);
const cachedTransition=(f,type)=>f.w.dispatchEvent(new f.w.PageTransitionEvent(type,{persisted:true}));
const quoteReady=async f=>{try{await settle(()=>!f.el('confirmGeneration').hidden&&!f.el('confirmUpload').disabled);}catch(error){error.message+=`: ${f.el('quoteMessage').textContent}; calls=${writePaths(f).join(',')}; funding=${f.w.rigVideoFunding}/${f.w.rigVideoMode}`;throw error;}};
async function finishTrial(f){
 f.make();f.change('duration',18);f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await quoteReady(f);f.el('confirmGeneration').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());
}
async function confirmFullVideo(f){
 f.el('prepare').click();await settle(()=>f.el('briefDialog').open);f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1,'the second price does not itself start another generation');f.el('confirmGeneration').click();
}

test('the guided studio begins with one start action and only the current screen, without example tiles',()=>{
 const f=fixture();try{
  assert.equal(f.showing('start'),true);for(const screen of ['files','where','result'])assert.equal(f.showing(screen),false);
  assert.equal(f.el('prepare').textContent,'Probeer met je eigen foto');assert.equal(f.el('prepare').disabled,false);assert.equal(f.d.querySelector('.ideas-panel,[data-idea-mode]'),null);assert.equal(f.el('makeFullVideo'),null);assert.equal(f.el('makeFullFromResult'),null);assert.deepEqual(writePaths(f),[]);
  assert.equal(f.el('newVideo').hidden,true,'the result-only secondary action stays out of the start screen');
  f.el('prepare').click();assert.equal(f.showing('files'),true);assert.equal(f.showing('start'),false);assert.equal(f.el('prepare').textContent,'Verder');assert.equal(f.el('prepare').disabled,true);assert.match(f.el('flowStep').textContent,/1\s*(?:van|\/)\s*3/);assert.equal(f.el('flowProgress').children.length,3);
 }finally{f.close();}
});

test('a cached page keeps the selected files and working guided navigation when it returns',()=>{
 const f=fixture();try{
  const files=f.make();f.el('closeBrief').click();const flow=f.w.rigFlow;
  cachedTransition(f,'pagehide');cachedTransition(f,'pageshow');
  assert.equal(f.w.rigFlow,flow,'a reusable document must not lose its event handlers');
  assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);
  f.el('flowBack').click();assert.equal(f.showing('files'),true);f.el('prepare').click();assert.equal(f.showing('where'),true);
  assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const event of ['rig-generation-intent','rig-generation-tracking'])test(`${event} keeps an existing submission in the status screen before a provider acknowledgement`,async()=>{
 const f=fixture();try{
  f.make();f.el('preparedDialog').showModal();
  f.storage.set('rig-generation-pending',JSON.stringify({quoteId:'existing-quote',idempotencyKey:'existing-intent'}));
  f.d.dispatchEvent(new f.w.CustomEvent(event,{detail:{pending:true}}));
  assert.equal(f.showing('result'),true);assert.equal(f.el('resultTitle').textContent,'Je video wordt gemaakt');
  for(const id of ['briefDialog','uploadDialog','preparedDialog'])assert.equal(f.el(id).open,false,id+' must not cover a submitted job');
  assert.equal(f.el('quoteDialog').open,true);assert.equal(f.el('newVideo').hidden,true);
  f.el('quoteDialog').close();await Promise.resolve();assert.equal(f.el('briefDialog').open,false,'closing status must not reopen preparation');
  cachedTransition(f,'pagehide');cachedTransition(f,'pageshow');
  assert.ok(f.w.rigFlow);assert.equal(f.showing('result'),true);assert.equal(f.el('quoteDialog').open,true);
  assert.deepEqual(writePaths(f),[],'restoring a known submission does not submit or prepare media');
 }finally{f.close();}
});

test('a definitively unstarted submission leaves processing without replaying preparation or losing the chosen files',()=>{
 const f=fixture();try{
  const files=f.make();f.storage.set('rig-generation-pending','owned pending handle');
  f.d.dispatchEvent(new f.w.CustomEvent('rig-generation-tracking',{detail:{pending:true}}));
  f.storage.delete('rig-generation-pending');f.d.dispatchEvent(new f.w.Event('rig-generation-not-started'));
  assert.equal(f.showing('result'),true);assert.equal(f.el('resultTitle').textContent,'Je video is niet gestart');assert.equal(f.el('newVideo').hidden,false);
  assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);
  assert.equal(f.el('briefDialog').open,false);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('forward and back navigation retain the actual files, video type and required description',()=>{
 const f=fixture();try{
  f.el('prepare').click();const files=f.load();assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();assert.equal(f.showing('where'),true);assert.equal(f.showing('files'),false);assert.match(f.el('flowStep').textContent,/2\s*(?:van|\/)\s*3/);
  f.el('editModeButton').click();f.change('editPrompt','Mijn gekozen scène.','input');f.el('flowBack').click();assert.equal(f.showing('files'),true);assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);
  f.el('prepare').click();assert.equal(f.w.rigGenerationQuality(),'edit-standard');f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('editPrompt').value,'Mijn gekozen scène.');assert.match(f.el('flowStep').textContent,/3\s*(?:van|\/)\s*3/);
  f.el('closeBrief').click();assert.equal(f.el('briefDialog').open,false);assert.equal(f.showing('where'),true);f.el('flowBack').click();assert.equal(f.showing('files'),true);f.el('flowBack').click();assert.equal(f.showing('start'),true);assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('editPrompt').value,'Mijn gekozen scène.');assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('the mode step shows the available photo workflow when public video editing is disabled',()=>{
 const f=fixture({qualities:['standard','pro']});try{
  f.el('prepare').click();f.load();assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();assert.equal(f.showing('where'),true);assert.equal(f.el('videoModePanel').hidden,false);assert.equal(f.el('motionModeButton').hidden,false);assert.equal(f.el('motionModeButton').getAttribute('aria-pressed'),'true');assert.equal(f.el('editModeButton').hidden,true);assert.equal(f.w.rigGenerationQuality(),'pro');
  f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('briefTitle').textContent,'Op je foto');assert.match(f.el('flowStep').textContent,/3\s*(?:van|\/)\s*3/);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('valid files can reach an explicitly selectable Recast-only mode without an unavailable motion card or an automatic model choice',()=>{
 const f=fixture({qualities:['human-recast'],funding:'owner-provider'});try{
  f.el('prepare').click();f.load();assert.equal(f.el('prepare').disabled,false,'valid files must reach the mode choice before a supported mode has been selected');f.el('prepare').click();assert.equal(f.showing('where'),true);assert.equal(f.el('videoModePanel').hidden,false);assert.equal(f.el('motionModeButton').hidden,true);assert.equal(f.el('editModeButton').hidden,false);assert.equal(f.el('editModeButton').disabled,false);assert.notEqual(f.w.rigGenerationQuality(),'human-recast');
  f.el('editModeButton').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('editModeButton').getAttribute('aria-pressed'),'true');assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('briefTitle').textContent,'In de video');assert.match(f.el('flowStep').textContent,/3\s*(?:van|\/)\s*3/);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('the clip handles alter the real start and integer duration within source and model bounds',()=>{
 const f=fixture();try{
  f.el('prepare').click();f.load();assert.equal(Number(f.el('flowClipStart').min),0);assert.equal(Number(f.el('flowClipStart').max),60);assert.equal(Number(f.el('flowClipEnd').min),0);assert.equal(Number(f.el('flowClipEnd').max),60);
  f.change('flowClipStart',12,'input');f.change('flowClipEnd',28,'input');assert.equal(Number(f.el('start').value),12);assert.equal(Number(f.el('duration').value),16);
  f.change('flowClipEnd',12,'input');const start=Number(f.el('start').value),seconds=Number(f.el('duration').value);assert.equal(Number.isInteger(seconds),true);assert.ok(start>=0&&seconds>=3&&seconds<=30&&start+seconds<=60);
  assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const recast of [false,true])test(`both clip handles share the full source scale and cannot cross a ${recast?6:3}-second minimum or exceed the model limit`,()=>{
 const f=fixture({qualities:recast?['standard','pro','human-recast']:['standard','pro'],funding:recast?'owner-provider':'credits'}),minimum=recast?6:3,maximum=recast?15:30;try{
  f.el('prepare').click();f.load();if(recast){f.el('prepare').click();f.el('editModeButton').click();f.el('flowBack').click();}f.change('start',12);f.change('duration',12);
  for(const id of ['flowClipStart','flowClipEnd']){assert.equal(Number(f.el(id).min),0);assert.equal(Number(f.el(id).max),60);}
  const assertBounds=()=>{const start=Number(f.el('start').value),duration=Number(f.el('duration').value),end=start+duration;assert.equal(Number.isInteger(duration),true);assert.ok(start>=0&&duration>=minimum&&duration<=maximum&&end<=60);assert.equal(Number(f.el('flowClipStart').value),start);assert.equal(Number(f.el('flowClipEnd').value),end);assert.ok(Number(f.el('flowClipStart').value)<Number(f.el('flowClipEnd').value));const track=f.el('flowClipStart').parentElement;assert.equal(parseFloat(track.style.getPropertyValue('--clip-start')),start/60*100);assert.equal(parseFloat(track.style.getPropertyValue('--clip-end')),end/60*100);return {start,duration,end};};
  assertBounds();f.change('flowClipStart',60,'input');assert.deepEqual(assertBounds(),{start:24-minimum,duration:minimum,end:24});f.change('flowClipEnd',0,'input');assert.equal(assertBounds().end,24);
  f.change('flowClipEnd',60,'input');const widest=assertBounds();assert.equal(widest.duration,maximum);f.change('flowClipStart',0,'input');assert.deepEqual(assertBounds(),widest,'dragging the start left retains the end while enforcing the maximum clip length');assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const recast of [false,true])test(`the end handle supports whole-second keyboard editing within the ${recast?'Recast':'Motion'} clip limits`,()=>{
 const f=fixture({qualities:recast?['standard','pro','human-recast']:['standard','pro'],funding:recast?'owner-provider':'credits'}),minimum=recast?6:3,maximum=recast?15:30;try{
  f.el('prepare').click();f.load();if(recast){f.el('prepare').click();f.el('editModeButton').click();f.el('flowBack').click();}f.change('start',12);f.change('duration',8);
  for(const [key,expected] of [['ArrowRight',9],['ArrowLeft',8],['PageUp',13],['PageDown',8],['Home',minimum],['End',maximum]]){const event=new f.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});f.el('flowClipEnd').dispatchEvent(event);assert.equal(event.defaultPrevented,true,key+' must replace the native fractional range step');assert.equal(Number(f.el('duration').value),expected,key);assert.equal(Number(f.el('start').value),12);assert.equal(Number(f.el('flowClipEnd').value),12+expected);}
  const untouched=new f.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});f.el('flowClipEnd').dispatchEvent(untouched);assert.equal(untouched.defaultPrevented,false);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const recast of [false,true])test(`the ${recast?'Recast':'Motion'} start handle supports keyboard edits while retaining the fractional selected end`,()=>{
 const f=fixture({qualities:recast?['standard','pro','human-recast']:['standard','pro'],funding:recast?'owner-provider':'credits'}),minimum=recast?6:3,maximum=recast?15:30;try{
  f.el('prepare').click();f.load();if(recast){f.el('prepare').click();f.el('editModeButton').click();f.el('flowBack').click();}f.change('start',12.7);f.change('duration',8);const end=Number(f.el('start').value)+8;
  for(const [key,expected] of [['ArrowLeft',9],['ArrowRight',8],['PageDown',13],['PageUp',8],['Home',Math.floor(Math.min(maximum,end))],['End',minimum],['ArrowRight',minimum]]){
   const event=new f.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});f.el('flowClipStart').dispatchEvent(event);assert.equal(event.defaultPrevented,true,key);assert.equal(Number(f.el('duration').value),expected,key);assert.ok(Math.abs(Number(f.el('start').value)-(end-expected))<1e-9,key+' retains the original fractional end');assert.ok(Math.abs(Number(f.el('flowClipEnd').value)-end)<1e-9);assert.ok(Number(f.el('flowClipStart').value)<Number(f.el('flowClipEnd').value));
  }
  const untouched=new f.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});f.el('flowClipStart').dispatchEvent(untouched);assert.equal(untouched.defaultPrevented,false);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('extending a clip left from the source end publishes both valid bounds before any change handler runs',()=>{
 const f=fixture({qualities:['standard','pro']});try{
  f.el('prepare').click();f.load();f.change('duration',5);f.change('start',55);const changes=[];
  f.d.addEventListener('change',event=>{if(event.target.id==='duration')changes.push({start:Number(f.el('start').value),duration:Number(f.el('duration').value)});},{capture:true});
  f.change('flowClipStart',40,'input');assert.deepEqual(changes,[{start:40,duration:20}],'downstream listeners must never see the old start with an extended duration past the source end');assert.equal(f.el('start').value,'40');assert.equal(f.el('duration').value,'20');assert.equal(Number(f.el('flowClipEnd').value),60);
  f.change('duration',5);f.change('start',55);changes.length=0;const left=new f.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true});f.el('flowClipStart').dispatchEvent(left);assert.equal(left.defaultPrevented,true);assert.deepEqual(changes,[{start:54,duration:6}]);assert.equal(Number(f.el('flowClipEnd').value),60);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('moving the start handle preserves the fractional original end while keeping an integer clip duration',()=>{
 const f=fixture({qualities:['standard','pro']});try{
  f.el('prepare').click();f.load();f.change('start',12.7);f.change('duration',12);const end=Number(f.el('start').value)+Number(f.el('duration').value);
  f.change('flowClipStart',16.2,'input');assert.equal(Number(f.el('duration').value),8);assert.ok(Math.abs(Number(f.el('start').value)-16.7)<1e-9);assert.ok(Math.abs(Number(f.el('flowClipEnd').value)-end)<1e-9);
  f.change('flowClipStart',60,'input');assert.equal(Number(f.el('duration').value),3);assert.ok(Math.abs(Number(f.el('start').value)-(end-3))<1e-9);assert.ok(Math.abs(Number(f.el('flowClipEnd').value)-end)<1e-9);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('a required portrait frame returns to visible file controls before focusing, then resumes the same guided draft',async()=>{
 const f=fixture({qualities:['standard','pro','human-recast'],funding:'owner-provider'});try{
  f.el('prepare').click();const person=f.file('personInput','my-phone-portrait.mp4','video/mp4');f.el('personVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.el('personVideo').dispatchEvent(new f.w.Event('loadeddata'));const motion=f.file('motionInput','my-motion.mp4','video/mp4');f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));
  f.el('prepare').click();f.el('editModeButton').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);f.el('chooseFullVideo').click();f.el('confirmBrief').click();
  assert.equal(f.el('briefDialog').open,false);assert.equal(f.showing('files'),true);assert.equal(f.el('flowAdvanced').open,true);assert.equal(f.el('moreOptions').open,true);assert.equal(f.el('frameControl').hidden,false);assert.equal(f.d.activeElement.id,'frameTime');assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
  f.el('captureMain').click();await settle(()=>!f.el('mainReference').hidden);f.el('prepare').click();f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('personInput').files[0],person);assert.equal(f.el('motionInput').files[0],motion);assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const choice of ['trial','full'])test(`${choice} selection is inert until the single preparation action confirms the chosen clip`,async()=>{
 const f=fixture();try{
  f.make();assert.equal(f.el('briefDialog').open,true);f.change('duration',18);f.change('start',7);f.change('editPrompt','Gebruik precies mijn gekozen beweging.','input');
  f.el('chooseFullVideo').click();assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').getAttribute('aria-pressed'),'false');
  f.el('tryShortVideo').click();assert.equal(f.el('tryShortVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'false');if(choice==='full')f.el('chooseFullVideo').click();
  assert.equal(f.prepared.length,0);assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('duration').value,'18');assert.deepEqual(writePaths(f),[]);
  f.change('editPrompt','','input');assert.equal(f.el('confirmBrief').disabled,true);f.el('confirmBrief').click();assert.equal(f.prepared.length,0);
  f.change('editPrompt','Gebruik precies mijn gekozen beweging.','input');f.el('confirmBrief').click();await settle(()=>f.w.rigPreparedMedia());const media=f.w.rigPreparedMedia();assert.equal(media.selectedSeconds,choice==='trial'?5:18);assert.equal(Boolean(media.trialToken),choice==='trial');assert.ok(f.prepared.every(video=>video.start===7));assert.deepEqual(f.prepared.map(video=>video.duration),choice==='trial'?[18,5]:[18]);assert.equal(f.el('duration').value,'18');assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('a priced offline trial reaches the result screen and continuing still needs a new full quote and explicit confirmation',async()=>{
 const f=fixture({withGeneration:true});try{
  f.make();f.change('duration',18);f.change('start',2);f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.calls.some(([path])=>path==='/api/assets'),false);
  f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);f.el('confirmGeneration').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());
  assert.equal(f.el('resultTitle').textContent,'Je proefje');assert.match(f.el('prepare').textContent,/volledige (?:video|versie)/i);assert.equal(f.el('quoteDialog').open,false);assert.equal(f.el('shareResult').hidden,true);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
  f.el('prepare').click();await settle(()=>f.el('briefDialog').open);assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').hidden,true);assert.equal(f.el('duration').value,'18');assert.equal(f.el('start').value,'2');assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.w.rigPreparedMedia().selectedSeconds,18);f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.calls.filter(([path])=>path==='/api/generation-quotes').length,2);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1,'a fresh full quote does not submit the full video');
 }finally{f.close();}
});

for(const mode of ['motion','edit'])test(`a reloaded ${mode} trial with missing close-up and angle bytes reveals the actual file and reference controls without charging`,async()=>{
 const first=fixture({withGeneration:true});let person,motion,saved;
 try{
  first.el('prepare').click();({person,motion}=first.load());first.el('flowAdvanced').open=true;first.el('moreOptions').open=true;
  if(mode==='motion'){person=first.file('personInput','original-portrait-video.mp4','video/mp4');first.el('personVideo').dispatchEvent(new first.w.Event('loadedmetadata'));first.el('personVideo').dispatchEvent(new first.w.Event('loadeddata'));first.el('captureMain').click();await settle(()=>!first.el('mainReference').hidden);}
  first.file('faceInput','original-closeup.jpg','image/jpeg');await settle(()=>!first.el('faceReference').hidden);first.file('anglesInput','original-angle.jpg','image/jpeg');await settle(()=>!first.el('angleReference0').hidden);
  first.el('prepare').click();if(mode==='edit')first.el('editModeButton').click();first.change('duration',12);first.change('start',3);first.change('editPrompt','Mijn volledige scène met mijn eerdere close-up en hoek.','input');first.el('prepare').click();first.el('tryShortVideo').click();first.el('confirmBrief').click();await settle(()=>first.el('uploadDialog').open);first.el('confirmUpload').click();await quoteReady(first);first.el('confirmGeneration').click();await settle(()=>first.showing('result')&&!first.w.rigGenerationBusy());saved=new Map(first.storage);
  const snapshot=JSON.parse(saved.get('rig-trial-continuation:v1'));assert.equal(snapshot.draft.faceRequired,true);assert.equal(snapshot.draft.angleCount,1);assert.equal(Object.hasOwn(snapshot.draft,'faceReferenceBlob'),false);assert.equal(Object.hasOwn(snapshot.draft,'angleReferenceBlobs'),false);
 }finally{first.close();}
 const f=fixture({withGeneration:true,storage:saved,legacyDraftServer:true,recentJob:{id:'job-1',state:'completed'}});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());f.el('prepare').click();await settle(()=>f.showing('files'));
  for(const [id,file] of [['personInput',person],['motionInput',motion]]){Object.defineProperty(f.el(id),'files',{configurable:true,value:[file]});f.el(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));}
  if(mode==='motion'){f.el('personVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.el('personVideo').dispatchEvent(new f.w.Event('loadeddata'));}f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.el('prepare').click();await settle(()=>f.el('status').textContent.includes('eerdere close-up en hoeken'));assert.equal(f.showing('where'),false,'recovering the matching full draft goes directly to missing references, without a repeated placement step');
  assert.equal(f.showing('files'),true,'missing reference uploads must be reachable rather than hidden behind the make screen');
  assert.equal(f.el('flowAdvanced').open,true,'the advanced controls must be expanded');assert.equal(f.el('moreOptions').open,true);assert.equal(f.el('referencePanel').hidden,false);assert.equal(f.el('referenceFiles').hidden,false,'the reference upload controls must be shown');assert.equal(f.el('faceReference').hidden,true);assert.equal(f.el('angleReference0').hidden,true);assert.equal(f.el('briefDialog').open,false,'reference recovery must not be covered by another review dialog');assert.equal(f.el('personInput').files[0],person);assert.equal(f.el('motionInput').files[0],motion);assert.equal(f.el('duration').value,'12');assert.equal(f.el('start').value,'3');assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('back and cancel from the full continuation return to the completed trial without another preparation or paid request',async()=>{
 const f=fixture({withGeneration:true});try{
  await finishTrial(f);const result=f.el('resultVideo').src,writes=writePaths(f).length,prepared=f.prepared.length;
  for(const action of ['back','cancel']){
   f.el('prepare').click();await settle(()=>f.el('briefDialog').open);assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').hidden,true);
   if(action==='back')f.el('closeBrief').click();else{const cancel=new f.w.Event('cancel',{cancelable:true});f.el('briefDialog').dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,false);f.el('briefDialog').close();}
   assert.equal(f.el('briefDialog').open,false);assert.equal(f.showing('result'),true);assert.equal(f.showing('where'),false);assert.equal(f.el('resultVideo').hidden,false);assert.equal(f.el('resultVideo').src,result);assert.equal(f.el('export').hidden,false);assert.match(f.el('prepare').textContent,/volledige (?:video|versie)/i);assert.equal(f.el('newVideo').hidden,false);assert.equal(f.prepared.length,prepared);assert.equal(writePaths(f).length,writes);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
  }
 }finally{f.close();}
});

for(const dialog of ['upload','quote'])test(`closing the unpaid ${dialog} popup returns to the same full-plan review without another POST`,async()=>{
 const f=fixture({withGeneration:true});try{
  const files=f.make();f.change('duration',18);f.change('start',4);f.change('editPrompt','Bewaar mijn volledige gekozen scène.','input');f.el('chooseFullVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open&&!f.w.rigGenerationBusy());const media=f.w.rigPreparedMedia();
  if(dialog==='quote'){f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.el('quoteDialog').open,true);assert.equal(f.el('briefDialog').open,false,'the normal upload-to-quote transition must not reopen the review');assert.equal(f.el('uploadDialog').open,false);}
  const writes=writePaths(f).length,localPreparations=f.prepared.length;f.el(dialog==='upload'?'closeUpload':'closeQuote').click();await settle(()=>f.el('briefDialog').open&&!f.el('uploadDialog').open&&!f.el('quoteDialog').open);
  assert.equal(f.d.body.dataset.flowView,'make');assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').getAttribute('aria-pressed'),'false');assert.equal(f.el('editPrompt').value,'Bewaar mijn volledige gekozen scène.');assert.equal(f.el('duration').value,'18');assert.equal(f.el('start').value,'4');assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);assert.equal(f.w.rigPreparedMedia(),media);assert.equal(f.prepared.length,localPreparations);assert.equal(writePaths(f).length,writes);assert.equal(f.calls.some(([path])=>path==='/api/generations'),false);assert.equal(f.storage.has('rig-generation-pending'),false);
 }finally{f.close();}
});

test('new video exits the result continuation without losing local files or creating a provider request',async()=>{
 const f=fixture({withGeneration:true});try{
  const files=f.make();f.change('duration',12);f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await quoteReady(f);f.el('confirmGeneration').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());const writes=writePaths(f).length;
  f.el('newVideo').click();assert.equal(f.showing('start'),true);assert.equal(f.el('prepare').textContent,'Probeer met je eigen foto');assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);assert.equal(writePaths(f).length,writes);assert.equal(f.storage.has('rig-trial-continuation:v1'),false);
 }finally{f.close();}
});

test('native sharing appears only for a supported owned result and waits for an explicit share click',async()=>{
 const f=fixture({withGeneration:true,canShare:true});try{
  assert.equal(f.el('shareResult').hidden,true);f.make();f.change('duration',12);f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await quoteReady(f);f.el('confirmGeneration').click();await settle(()=>f.showing('result')&&!f.el('shareResult').hidden&&!f.w.rigGenerationBusy());
  assert.equal(f.shared.length,0);const writes=writePaths(f).length;f.el('shareResult').click();await settle(()=>f.shared.length===1);assert.equal(f.shared[0].files.length,1);assert.equal(f.shared[0].files[0].name,'RIG-video.mp4');assert.equal(f.shared[0].files[0].type,'video/mp4');assert.ok(f.shared[0].files[0].size>0);assert.equal(writePaths(f).length,writes);
 }finally{f.close();}
});

test('a newly accepted queued video hides the old result and cannot start another draft before the new result is verified',async()=>{
 let release;const f=fixture({withGeneration:true,canShare:true,statusResponse:id=>id==='job-2'?new Promise(resolve=>{release=()=>resolve({id,state:'completed',videoPath:`/api/generations/${id}/video`});}):undefined});try{
  await finishTrial(f);await settle(()=>!f.el('shareResult').hidden);const oldResult=f.el('resultVideo').src;assert.equal(f.el('export').hidden,false);await confirmFullVideo(f);await settle(()=>release);
  assert.equal(f.showing('result'),true);assert.equal(f.el('resultTitle').textContent,'Je video wordt gemaakt');assert.equal(f.el('resultVideo').hidden,true);assert.equal(f.el('export').hidden,true);assert.equal(f.el('shareResult').hidden,true);assert.equal(f.el('newVideo').hidden,true);assert.equal(f.el('newVideo').disabled,true);assert.equal(f.storage.get('rig-generation-job'),'job-2');
  assert.equal(f.el('quoteDialog').classList.contains('flow-processing'),true);assert.equal(f.el('quoteDialog').classList.contains('flow-progress'),false,'a processing dialog must not inherit the three-column step-progress layout');
  const writes=writePaths(f).length;f.el('newVideo').dispatchEvent(new f.w.Event('click'));assert.equal(f.showing('result'),true);assert.equal(f.storage.get('rig-generation-job'),'job-2');assert.equal(writePaths(f).length,writes);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,2);
  release();await settle(()=>!f.w.rigGenerationBusy()&&!f.el('resultVideo').hidden&&!f.el('shareResult').hidden);assert.notEqual(f.el('resultVideo').src,oldResult);assert.equal(f.el('export').href,f.el('resultVideo').src);assert.equal(f.el('export').hidden,false);assert.equal(f.el('newVideo').hidden,false);assert.equal(f.el('newVideo').disabled,false);assert.equal(f.el('quoteDialog').classList.contains('flow-processing'),false);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,2);
 }finally{f.close();}
});

for(const refunded of [true,false])test(`a customer billing lock ${refunded?'shows only the proven RIG-credit refund':'retains recovery without claiming a refund'}`,async()=>{
 const storage=new Map([['rig-generation-job','job-17']]),f=fixture({withGeneration:true,storage,statusResponse:id=>({id,state:'failed',funding:'credits',failureCode:'provider_billing_locked',refundConfirmed:refunded,finalizationConfirmed:true})});try{
  f.el('checkGeneration').click();await settle(()=>!f.w.rigGenerationBusy()&&f.el('quoteMessage').textContent.includes('videodienst is tijdelijk niet beschikbaar'));
  assert.equal(f.el('quoteMessage').textContent,refunded?'De videodienst is tijdelijk niet beschikbaar. Je RIG-tegoed is teruggezet.':'De videodienst is tijdelijk niet beschikbaar. Je RIG-tegoed wordt nog gecontroleerd. Start de opdracht niet opnieuw.');assert.doesNotMatch(f.el('quoteMessage').textContent,/fal|onvoldoende tegoed|\$|provider/i);assert.equal(storage.has('rig-generation-job'),!refunded);assert.equal(f.el('checkGeneration').hidden,refunded);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const finalized of [true,false])test(`an owner billing lock ${finalized?'closes a finalized job':'keeps the unfinalized job recoverable'} without a customer refund claim`,async()=>{
 const storage=new Map([['rig-generation-job','job-17']]),f=fixture({withGeneration:true,funding:'owner-provider',storage,statusResponse:id=>({id,state:'failed',funding:'owner-provider',failureCode:'provider_billing_locked',finalizationConfirmed:finalized,refundConfirmed:true})});try{
  f.el('checkGeneration').click();await settle(()=>!f.w.rigGenerationBusy()&&f.el('quoteMessage').textContent.includes('Je Fal-account'));
  assert.match(f.el('quoteMessage').textContent,/Je Fal-account heeft onvoldoende tegoed\. Controleer je saldo op fal\.ai\./);assert.match(f.el('quoteMessage').textContent,finalized?/De opdracht is afgesloten\./:/De opdracht wordt nog gecontroleerd\. Start niet opnieuw\./);assert.doesNotMatch(f.el('quoteMessage').textContent,/RIG-tegoed|teruggezet|terugbetaald|€|refund/i);assert.equal(storage.has('rig-generation-job'),!finalized);assert.equal(f.el('checkGeneration').hidden,finalized);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('a delayed share preparation for the old result cannot reappear while the newly confirmed video is queued',async()=>{
 let releaseStatus,releaseOldShare,oldBodyRead=false;const f=fixture({withGeneration:true,canShare:true,shareRead:url=>String(url).endsWith('job-1')?new Promise(resolve=>{releaseOldShare=()=>resolve({blob:async()=>{oldBodyRead=true;return new Blob(['old-owned-video'],{type:'video/mp4'});}});}):Promise.resolve(new Response(new Blob(['new-owned-video'],{type:'video/mp4'}))),statusResponse:id=>id==='job-2'?new Promise(resolve=>{releaseStatus=()=>resolve({id,state:'completed',videoPath:`/api/generations/${id}/video`});}):undefined});try{
  await finishTrial(f);await settle(()=>releaseOldShare);await confirmFullVideo(f);await settle(()=>releaseStatus);assert.equal(f.el('shareResult').hidden,true);assert.equal(f.el('resultVideo').src,'blob:rig-private-job-1');releaseOldShare();await settle(()=>oldBodyRead);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.el('shareResult').hidden,true,'late old share data must not present the old video as a ready result');assert.equal(f.shared.length,0);assert.equal(f.el('resultVideo').hidden,true);assert.equal(f.el('export').hidden,true);assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,2);
  releaseStatus();await settle(()=>!f.w.rigGenerationBusy()&&!f.el('resultVideo').hidden&&!f.el('shareResult').hidden);assert.equal(f.el('resultVideo').src,'blob:rig-private-job-2');assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,2);
 }finally{f.close();}
});

test('choosing Recast after a longer phone clip keeps the full selection and exposes an explicit six-second trial',async()=>{
 const f=fixture({qualities:['standard','pro','human-recast'],funding:'owner-provider'});try{
  f.el('prepare').click();f.load();f.change('duration',18);f.change('start',2);f.el('prepare').click();f.el('editModeButton').click();assert.equal(f.el('duration').value,'15');assert.equal(f.el('start').value,'2');f.el('prepare').click();
  assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('tryShortVideo').hidden,false);assert.equal(f.el('flowFullDuration').textContent,'15 sec · zoals gekozen');assert.equal(f.el('flowTrialDuration').textContent,'6 sec · kort proefje');assert.deepEqual(writePaths(f),[]);
  f.change('editPrompt','Behoud de bronvideo en vervang alleen de hoofdpersoon.','input');f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.w.rigPreparedMedia());assert.equal(f.w.rigPreparedMedia().selectedSeconds,6);assert.ok(f.w.rigPreparedMedia().trialToken);assert.equal(f.el('duration').value,'15');assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('a result opened in a new tab without a saved trial offers contextual recovery to files, then requires a chosen full selection and fresh price',async()=>{
 const f=fixture({withGeneration:true,recentJob:{id:'job-1',state:'completed'}});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());
  assert.equal(f.el('resultTitle').textContent,'Je video');assert.equal(f.el('prepare').hidden,false);assert.equal(f.el('prepare').textContent,'Verder met deze video');assert.equal(f.el('prepare').disabled,false);assert.equal(f.storage.has('rig-trial-continuation:v1'),false);assert.deepEqual(writePaths(f),[]);
  f.el('prepare').click();assert.equal(f.showing('files'),true);assert.equal(f.showing('start'),false);assert.equal(f.el('briefDialog').open,false);assert.match(f.el('status').textContent,/oorspronkelijke foto en video/);assert.equal(f.el('personInput').files.length,0);assert.equal(f.el('motionInput').files.length,0);
  const files=f.load();f.change('duration',18);f.change('start',4);f.el('prepare').click();assert.equal(f.showing('where'),true);f.el('motionModeButton').click();f.el('prepare').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').hidden,true);assert.equal(f.el('duration').value,'18');assert.equal(f.el('start').value,'4');
  f.change('editPrompt','Mijn opnieuw gekozen volledige dans, zonder verzonnen oude instellingen.','input');f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.w.rigPreparedMedia().selectedSeconds,18);assert.equal(f.w.rigPreparedMedia().trialToken,undefined);assert.equal(f.el('personInput').files[0],files.person);assert.equal(f.el('motionInput').files[0],files.motion);assert.deepEqual(writePaths(f),[]);
  f.el('confirmUpload').click();await quoteReady(f);const quotes=f.calls.filter(([p])=>p==='/api/generation-quotes');assert.equal(quotes.length,1);assert.equal(JSON.parse(quotes[0][1].body).prompt,'Mijn opnieuw gekozen volledige dans, zonder verzonnen oude instellingen.');assert.equal(f.prepared[0].duration,18);assert.equal(f.calls.some(([p])=>p==='/api/generations'||p==='/api/payments/create'),false);
 }finally{f.close();}
});

test('a durable matching trial survives a new tab and one Continue restores the original full review before any new charge',async()=>{
 const drafts=new Map(),first=fixture({withGeneration:true,draftStorage:drafts});let files;
 try{
  first.make();files={person:first.el('personInput').files[0],motion:first.el('motionInput').files[0]};first.change('duration',18);first.change('start',3);first.change('editPrompt','Mijn bewaarde volledige dans.','input');first.el('tryShortVideo').click();first.el('confirmBrief').click();await settle(()=>first.el('uploadDialog').open);first.el('confirmUpload').click();await quoteReady(first);first.el('confirmGeneration').click();await settle(()=>first.showing('result')&&!first.w.rigGenerationBusy());
  assert.equal(first.storage.has('rig-trial-continuation:v1'),false);const metadata=JSON.parse(drafts.get('rig-trial-continuation:v1'));assert.equal(metadata.draft.seconds,18);assert.equal(metadata.draft.start,3);assert.doesNotMatch(JSON.stringify(metadata),/blob:|approvalToken|device-confirmed/);assert.deepEqual([...drafts.keys()],['rig-trial-continuation:v1']);
 }finally{first.close();}
 const f=fixture({withGeneration:true,draftStorage:drafts,legacyDraftServer:true,recentJob:{id:'job-1',state:'completed'}});try{
  assert.equal(f.storage.size,0,'new tab has no session recovery handles');await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());assert.equal(f.el('resultTitle').textContent,'Je proefje');assert.equal(f.el('prepare').textContent,'Volledige versie maken');assert.equal(f.el('prepare').hidden,false);assert.deepEqual(writePaths(f),[]);
  f.el('prepare').click();assert.equal(f.showing('files'),true);for(const [id,file] of [['personInput',files.person],['motionInput',files.motion]]){Object.defineProperty(f.el(id),'files',{configurable:true,value:[file]});f.el(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));}f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));
  f.el('prepare').click();await settle(()=>f.el('briefDialog').open);assert.equal(f.showing('where'),false);assert.equal(f.el('duration').value,'18');assert.equal(f.el('start').value,'3');assert.equal(f.el('editPrompt').value,'Mijn bewaarde volledige dans.');assert.equal(f.el('chooseFullVideo').getAttribute('aria-pressed'),'true');assert.equal(f.el('tryShortVideo').hidden,true);assert.deepEqual(writePaths(f),[]);
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.w.rigPreparedMedia().selectedSeconds,18);assert.equal(f.w.rigPreparedMedia().trialToken,undefined);assert.deepEqual(writePaths(f),[]);f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.calls.filter(([p])=>p==='/api/generation-quotes').length,1);assert.equal(f.calls.some(([p])=>p==='/api/generations'||p==='/api/payments/create'),false);assert.equal(f.prepared[0].duration,18);
 }finally{f.close();}
});

test('My videos reconciles a matching uncertain trial intent before opening its completed result and preserves its full draft',async()=>{
 const drafts=new Map(),first=fixture({withGeneration:true,draftStorage:drafts});try{await finishTrial(first);}finally{first.close();}
 const pending=JSON.parse(drafts.get('rig-trial-continuation:v1'));pending.state='pending';pending.jobId=null;drafts.set('rig-trial-continuation:v1',JSON.stringify(pending));const storage=new Map([['rig-generation-pending',JSON.stringify({quoteId:pending.quoteId,idempotencyKey:'known-trial-intent'})]]);
 const f=fixture({withGeneration:true,storage,draftStorage:drafts,recentJob:{id:'job-1',state:'completed'},reconcileJob:{id:'job-1',state:'completed'}});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());const reconciles=f.calls.filter(([p])=>p==='/api/generation-intents/known-trial-intent/reconcile');assert.equal(reconciles.length,1);assert.deepEqual(JSON.parse(reconciles[0][1].body),{quoteId:pending.quoteId});assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.el('resultTitle').textContent,'Je proefje');assert.equal(f.el('prepare').textContent,'Volledige versie maken');assert.equal(f.el('prepare').disabled,false);assert.equal(f.el('prepare').hidden,false);assert.equal(JSON.parse(drafts.get('rig-trial-continuation:v1')).jobId,'job-1');assert.equal(JSON.parse(drafts.get('rig-trial-continuation:v1')).draft.seconds,18);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('opening a pending trial from My videos cannot start cleanup or advance a ready workflow automatically',async()=>{
 const drafts=new Map(),first=fixture({withGeneration:true,draftStorage:drafts});try{await finishTrial(first);}finally{first.close();}
 const pending=JSON.parse(drafts.get('rig-trial-continuation:v1'));pending.state='pending';pending.jobId=null;drafts.set('rig-trial-continuation:v1',JSON.stringify(pending));const storage=new Map([['rig-generation-pending',JSON.stringify({quoteId:pending.quoteId,idempotencyKey:'pending-workflow-intent'})]]);
 const f=fixture({withGeneration:true,storage,draftStorage:drafts,recentJob:{id:'job-1',state:'ready_to_advance'},reconcileJob:{id:'job-1',state:'ready_to_advance'},statusResponse:async()=>({id:'job-1',state:'ready_to_advance',workflowVersion:'rig-workflow-v2'})});let cleanupLoads=0;
 try{
  f.w.rigLoadCleanupModule=async()=>{cleanupLoads++;return {cleanupSupported:()=>true,resumeClientProcessing:async()=>{throw Error('History must not advance a workflow');}};};
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>!f.w.rigGenerationBusy()&&f.el('quoteMessage').textContent.includes('lokale tussenstap'));
  assert.equal(cleanupLoads,0);assert.equal(f.el('checkGeneration').hidden,false);assert.equal(f.storage.get('rig-generation-job'),'job-1');assert.equal(f.storage.has('rig-generation-pending'),false);assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('resultVideo').hidden,true);assert.equal(f.calls.filter(([p])=>p==='/api/generation-intents/pending-workflow-intent/reconcile').length,1);assert.equal(f.calls.some(([p])=>p.includes('/advance')||p.includes('/client-processing')),false);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

test('a trial privately saves the chosen full crop and references before its paid confirmation, without uploading the phone original',async()=>{
 const f=fixture({withGeneration:true,persistDrafts:true});try{
  const files=f.make();f.change('duration',18);f.change('start',2.5);f.change('editPrompt','Mijn hele gekozen scène, met mijn eigen camera.','input');f.change('sound',false);f.el('sound').checked=false;f.el('steady').checked=true;
  f.el('motionCropButton').click();f.el('cropX').value='20';f.el('cropW').value='70';f.el('applyCrop').click();
  f.file('faceInput','closeup.jpg','image/jpeg');await settle(()=>!f.el('faceReference').hidden);f.file('anglesInput','angle.jpg','image/jpeg');await settle(()=>!f.el('angleReference0').hidden);
  f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);
  assert.deepEqual(f.prepared.map(v=>[v.start,v.duration,v.keepSound,v.crop.x,v.crop.w]),[[2.5,18,false,20,70],[2.5,5,false,20,70]]);
  const media=f.w.rigPreparedMedia();assert.equal(media.selectedSeconds,5);assert.equal(media.fullDraft.selectedSeconds,18);assert.equal(media.fullDraft.video,f.prepared[0].output);assert.deepEqual(writePaths(f),[]);
  f.el('confirmUpload').click();await quoteReady(f);
  const save=JSON.parse(f.calls.find(([path])=>path==='/api/video-drafts')[1].body),quote=JSON.parse(f.calls.find(([path])=>path==='/api/generation-quotes')[1].body);
  assert.notEqual(save.fullVideoId,quote.videoId);assert.equal(save.imageId,quote.imageId);assert.equal(save.faceId,quote.faceId);assert.deepEqual(save.angleIds,quote.angleIds);assert.equal(save.selectedSeconds,18);assert.equal(save.originalStartSeconds,2.5);assert.equal(save.prompt,'Mijn hele gekozen scène, met mijn eigen camera.');assert.equal(save.keepSound,false);assert.equal(save.steadyCamera,true);
  const uploads=f.calls.filter(([path])=>path==='/api/assets');assert.deepEqual(uploads.filter(([,o])=>o.headers['X-Rig-Asset-Kind']==='video').map(([,o])=>o.headers['X-Rig-Duration-Seconds']),['5','18']);assert.ok(uploads.every(([,o])=>o.body!==files.motion&&o.body!==files.person));
  assert.equal(f.calls.some(([path])=>path==='/api/generations'||path.includes('/advance')||path==='/api/payments/create'),false);
 }finally{f.close();}
});

test('a failed full-fragment save keeps trial generation hidden instead of selling a trial with no usable continuation',async()=>{
 const f=fixture({withGeneration:true,persistDrafts:true,saveDraftResponse:{saved:false}});try{
  f.make();f.change('duration',18);f.el('tryShortVideo').click();f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmUpload').disabled&&f.el('quoteMessage').textContent.includes('bewaard'));
  assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.filter(([path])=>path==='/api/video-drafts').length,1);assert.equal(f.calls.some(([path])=>path==='/api/generations'||path.includes('/advance')||path==='/api/payments/create'),false);
 }finally{f.close();}
});

test('a server-backed trial opened after reload restores the full prepared assets without original files or uploads and obtains a new price',async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});let saved;
 try{
  first.make();first.change('duration',18);first.change('start',3.5);first.change('editPrompt','Mijn volledige scène na een telefoonherstart.','input');first.el('steady').checked=true;first.el('sound').checked=false;
  first.file('faceInput','closeup.jpg','image/jpeg');await settle(()=>!first.el('faceReference').hidden);first.file('anglesInput','angle.jpg','image/jpeg');await settle(()=>!first.el('angleReference0').hidden);
  first.el('tryShortVideo').click();first.el('confirmBrief').click();await settle(()=>first.el('uploadDialog').open);first.el('confirmUpload').click();await quoteReady(first);first.el('confirmGeneration').click();await settle(()=>first.showing('result')&&!first.w.rigGenerationBusy());saved=draftDto(server,server.jobs.get('job-1'));
 }finally{first.close();}
 const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,recentJob:{id:'job-1',state:'completed'}});try{
  assert.equal(f.storage.size,0);await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());assert.equal(f.el('prepare').textContent,'Volledige versie maken');
  f.el('prepare').click();await settle(()=>f.el('briefDialog').open).catch(error=>{error.message+=`: ${f.el('status').textContent}; paths=${f.calls.map(([path])=>path).join(',')}`;throw error;});
  assert.equal(f.showing('files'),false);assert.equal(f.el('personInput').files.length,0);assert.equal(f.el('motionInput').files.length,0);assert.equal(f.prepared.length,0,'restoration does not encode another copy of the clip');assert.equal(f.el('editPrompt').value,saved.request.prompt);assert.equal(f.el('duration').value,'18');assert.equal(f.el('start').value,'0','the stored clip already contains the original 3.5-second offset');assert.equal(f.el('sound').checked,false);assert.equal(f.el('steady').checked,true);assert.equal(f.el('faceReference').hidden,false);assert.equal(f.el('angleReference0').hidden,false);assert.equal(f.el('tryShortVideo').hidden,true);
  const restored=f.w.rigPreparedMedia();assert.equal(restored.selectedSeconds,18);assert.equal(restored.trialToken,undefined);assert.deepEqual(JSON.parse(JSON.stringify(restored.assetRefs)),{imageId:saved.request.imageId,videoId:saved.request.videoId,faceId:saved.request.faceId,angleIds:saved.request.angleIds});assert.deepEqual(writePaths(f),[]);
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await quoteReady(f);
  assert.equal(f.calls.filter(([path])=>path==='/api/assets').length,0);const full=JSON.parse(f.calls.find(([path])=>path==='/api/generation-quotes')[1].body);assert.deepEqual(full,saved.request);assert.equal(f.calls.filter(([path])=>path==='/api/generation-quotes').length,1);assert.match(f.el('quoteMessage').textContent,/18\.00 seconden/);assert.equal(f.calls.some(([path])=>path==='/api/generations'||path.includes('/advance')||path==='/api/payments/create'),false);
  f.el('confirmGeneration').click();await settle(()=>f.calls.some(([path])=>path==='/api/generations')&&!f.w.rigGenerationBusy());assert.equal(f.calls.filter(([path])=>path==='/api/generations').length,1);
 }finally{f.close();}
});

for(const reason of ['missing','expired','source_unavailable'])test(`an unavailable saved full draft (${reason}) keeps the result and cannot invent a priced continuation`,async()=>{
 const f=fixture({withGeneration:true,recentJob:{id:'job-1',state:'completed'},savedDraftResponse:{available:false,reason}});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.el('resultVideo').hidden&&!f.w.rigGenerationBusy());
  assert.equal(f.el('resultTitle').textContent,'Je video');assert.doesNotMatch(f.el('prepare').textContent,/Volledige versie maken/);if(reason==='missing')f.el('prepare').click();assert.match(f.el('status').textContent,/niet meer|verlopen|niet bewaard|Kies je oorspronkelijke/);assert.equal(f.el('export').hidden,false);assert.equal(f.calls.some(([path])=>path.startsWith('/api/video-drafts/')),false);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const deniedStatus of [403,404])test(`a private full asset refused with ${deniedStatus} preserves the completed result and never falls back to a paid trial`,async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});try{await finishTrial(first);}finally{first.close();}
 const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,recentJob:{id:'job-1',state:'completed'},assetRead:()=>Response.json({error:'Bronbestand niet meer beschikbaar.'},{status:deniedStatus})});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());const result=f.el('resultVideo').src;f.el('prepare').click();await settle(()=>f.el('status').textContent.match(/niet meer|verlopen|niet bewaard|kon niet|opnieuw/i));
  assert.equal(f.el('resultVideo').src,result);assert.equal(f.el('resultVideo').hidden,false);assert.equal(f.el('export').hidden,false);assert.equal(f.el('briefDialog').open,false);assert.equal(f.w.rigPreparedMedia(),null);assert.deepEqual(writePaths(f),[]);assert.equal(f.prepared.length,0);
 }finally{f.close();}
});

for(const changed of ['draft','session'])test(`a delayed saved-asset download cannot publish over a changed ${changed}`,async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});try{await finishTrial(first);}finally{first.close();}
 let release;const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,recentJob:{id:'job-1',state:'completed'},assetRead:(_path,asset)=>new Promise(resolve=>{release=()=>resolve(new Response(new Uint8Array(asset.bytes),{headers:{'content-type':asset.meta.mime,'content-length':String(asset.bytes.length)}}));})});
 try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());f.el('prepare').click();await settle(()=>release);
  if(changed==='draft'){f.file('personInput','newest-choice.jpg','image/jpeg');f.change('editPrompt','Mijn nieuwste omschrijving.','input');}else{f.w.rigSessionActive=()=>false;f.w.rigGenerationDispose();}
  release();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.el('briefDialog').open,false);assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
  if(changed==='draft'){assert.equal(f.el('personName').textContent,'newest-choice.jpg');assert.equal(f.el('editPrompt').value,'Mijn nieuwste omschrijving.');}
 }finally{f.close();}
});

for(const choice of ['photo','video','settings'])test(`opening an older server-backed trial preserves a newer ${choice} choice before restoration begins`,async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});try{await finishTrial(first);}finally{first.close();}
 const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,recentJob:{id:'job-1',state:'completed'}});try{
  let selected;f.el('prepare').click();
  if(choice==='photo')selected=f.file('personInput','newest-photo.jpg','image/jpeg');
  else if(choice==='video'){selected=f.file('motionInput','newest-video.mp4','video/mp4');f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));}
  else {f.change('editPrompt','Mijn nieuwe omschrijving, niet die van het eerdere proefje.','input');f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));}
  const prompt=f.el('editPrompt').value,sound=f.el('sound').checked,view=f.d.body.dataset.flowView;
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.el('status').textContent.includes('nieuwe selectie')&&!f.w.rigGenerationBusy());
  assert.equal(f.d.body.dataset.flowView,view,'history returns directly to the current file selection screen');assert.equal(f.showing('files'),true);assert.equal(f.el('personChoose').closest('[data-flow-screen]').hidden,false);
  assert.match(f.el('status').textContent,/nieuwe selectie.*behouden/);assert.notEqual(f.el('prepare').textContent,'Volledige versie maken');
  f.el('prepare').dispatchEvent(new f.w.Event('click'));await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.el('editPrompt').value,prompt);assert.equal(f.el('sound').checked,sound);
  if(choice!=='settings')assert.equal(f.el(choice==='photo'?'personInput':'motionInput').files[0],selected);
  assert.equal(f.calls.some(([path])=>path.startsWith('/api/video-drafts/')),false,'history must not read replacement media over a newer selection');
  assert.deepEqual(writePaths(f),[]);assert.equal(f.prepared.length,0);assert.equal(f.el('briefDialog').open,false);
 }finally{f.close();}
});

for(const choice of ['references','photo'])test(`editing ${choice} after restoring a verified 17.94-second clip preserves its original 18-second selection`,async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});let saved;
 try{await finishTrial(first);saved=draftDto(server,server.jobs.get('job-1'));server.assets.get(saved.request.videoId).meta.durationSeconds=17.94;}finally{first.close();}
 const browserOffset=choice==='photo'?0.004:0;const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,recentJob:{id:'job-1',state:'completed'},restoredDurationOffset:browserOffset});try{
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());f.el('prepare').click();await settle(()=>f.el('briefDialog').open);
  assert.equal(f.el('motionVideo').duration,17.94+browserOffset);assert.equal(f.el('duration').value,'18');
  if(choice==='references'){f.file('faceInput','new-closeup.jpg','image/jpeg');await settle(()=>!f.el('faceReference').hidden);f.file('anglesInput','new-angle.jpg','image/jpeg');await settle(()=>!f.el('angleReference0').hidden);}
  else f.file('personInput','replacement-portrait.jpg','image/jpeg');
  assert.equal(f.el('duration').value,'18');f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);
  const media=f.w.rigPreparedMedia();assert.equal(media.selectedSeconds,18);assert.equal(f.el('duration').value,'18');
  assert.equal(f.prepared.length,0,'new identity images do not re-encode or shorten the unchanged verified video');assert.equal(media.assetRefs.videoId,saved.request.videoId);
  if(choice==='references'){assert.ok(media.face);assert.equal(media.angles.length,1);}
  f.el('confirmUpload').click();await quoteReady(f);assert.equal(f.calls.some(([path,options])=>path==='/api/assets'&&options.headers['X-Rig-Asset-Kind']==='video'),false,'reuse the owned video ID while uploading only the new identity images');const quote=JSON.parse(f.calls.find(([path])=>path==='/api/generation-quotes')[1].body);assert.equal(quote.videoId,saved.request.videoId);assert.match(f.el('quoteMessage').textContent,/17\.94 seconden/);
  assert.equal(f.calls.some(([path])=>path==='/api/generations'||path.includes('/advance')||path==='/api/payments/create'),false);
 }finally{f.close();}
});

test('an unverified 17.94-second phone source cannot claim an 18-second selection',()=>{
 const f=fixture();try{f.make();f.el('motionVideo').duration=17.94;f.change('duration',18);f.el('chooseFullVideo').click();f.el('confirmBrief').click();assert.match(f.el('briefError').textContent,/tot 17 seconden/);assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);}finally{f.close();}
});

test('automatic availability changes in an empty restored edit-mode browser do not suppress its saved full trial',async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});try{await finishTrial(first);}finally{first.close();}
 const storage=new Map([['rig-video-mode:v1','edit']]),f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,storage,qualities:['standard','pro'],recentJob:{id:'job-1',state:'completed'}});try{
  assert.equal(f.w.rigMotionSelected(),false);f.w.rigVideoQualities=['standard','pro','edit-standard'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>f.showing('result')&&!f.w.rigGenerationBusy());
  assert.equal(f.el('prepare').textContent,'Volledige versie maken');assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();await settle(()=>f.el('briefDialog').open);
  assert.equal(f.el('duration').value,'18');assert.equal(f.w.rigGenerationQuality(),'pro');assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});

for(const edited of [false,true])test(`automatic startup checks ${edited?'preserve a real changed selection for':'do not dirty'} a matching locally remembered server trial`,async()=>{
 const server=privateDraftStore(),first=fixture({withGeneration:true,persistDrafts:true,serverStore:server});let storage;
 try{await finishTrial(first);storage=new Map(first.storage);}finally{first.close();}
 assert.ok(storage.has('rig-trial-continuation:v1'));storage.set('rig-video-mode:v1','edit');
 const f=fixture({withGeneration:true,persistDrafts:true,serverStore:server,storage,qualities:['standard','pro'],recentJob:{id:'job-1',state:'completed'}});try{
  if(edited){f.el('prepare').click();f.change('editPrompt','Mijn echte nieuwe keuze blijft behouden.','input');f.d.dispatchEvent(new f.w.Event('rig-video-availability'));}
  f.w.rigVideoQualities=['standard','pro','edit-standard'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));
  await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>!f.w.rigGenerationBusy()&&f.el('status').textContent.includes('proefje is klaar'));
  if(edited){assert.match(f.el('status').textContent,/nieuwe selectie.*behouden/);assert.notEqual(f.el('prepare').textContent,'Volledige versie maken');assert.equal(f.showing('files'),true);assert.equal(f.el('editPrompt').value,'Mijn echte nieuwe keuze blijft behouden.');assert.equal(f.calls.some(([path])=>path.startsWith('/api/video-drafts/')),false);}
  else {assert.equal(f.showing('result'),true);assert.equal(f.el('prepare').textContent,'Volledige versie maken');assert.equal(f.el('prepare').disabled,false);f.el('prepare').click();await settle(()=>f.el('briefDialog').open);assert.equal(f.el('duration').value,'18');assert.equal(f.w.rigGenerationQuality(),'pro');}
  assert.equal(f.prepared.length,0);assert.deepEqual(writePaths(f),[]);
 }finally{f.close();}
});
