import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Recast UI did not settle');};
function fixture({qualities=['standard','pro','human-recast'],verifiedDuration=5.94,outputResolution='1080P',omitResolution=false,estimateLimit=false,estimateFailureCode='provider_limit_exceeded',storage:savedStorage=new Map(),jobState='failed',recentJob=null,cleanupFlag=true,webCodecs=true,omitWorkflow=false}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],images=[],videos=[],storage=savedStorage,verifications=[],created=[],revoked=[];
 w.Blob=Blob;el('rigStudio').hidden=false;el('authGate').hidden=true;w.rigNativeSite=true;w.rigVideoCleanup=cleanupFlag?{enabled:true,version:'owner-cleanup-v1',quality:'human-recast',maxDurationSeconds:15}:null;if(webCodecs){w.AudioEncoder=w.AudioDecoder=w.VideoEncoder=w.VideoDecoder=w.Worker=function(){};Object.defineProperty(w.crypto,'subtle',{value:{digest(){}},configurable:true});}w.rigVideoEnabled=true;w.rigVideoFunding='owner-provider';w.rigVideoQualities=qualities;w.rigSessionActive=()=>true;
 w.URL.createObjectURL=blob=>{const url=`blob:fixture-${created.length}`;created.push({url,blob});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};video.play=async()=>{};}
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(value){this.onload?.();}};
 w.rigMedia={bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async(source,crop)=>{const image={blob:new Blob(['image-'+images.length],{type:'image/jpeg'}),width:1280,height:720};images.push({source,crop:{...crop},image});return image;},prepareImageFile:async file=>({blob:new Blob(['prepared '+file.name],{type:'image/jpeg'}),width:1280,height:720}),prepareVideo:async(...args)=>{videos.push(args);return {blob:new Blob(['prepared-video'],{type:'video/mp4'}),duration:args[3],width:1280,height:720};}};
 w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 w.rigOpenVideo=async()=>`blob:fixture-result`;
 w.rigOwnerVerification={prepare:async(operation,payload)=>{verifications.push({operation,payload});return null;}};
 let assets=0,quotes=0,finishedWorkflow=false;const cleanupCalls=[],cleanupClients=[];let suspendMask=null,suspendResume=null;const maskBlob=new Blob(['mask'.repeat(30)],{type:'video/mp4'}),exactBlob=new Blob(['exact'.repeat(30)],{type:'video/mp4'}),cleanupMeta={version:'owner-cleanup-v1',sourceId:'source-verified',maskId:'mask-verified',reviewed:true};w.rigLoadCleanupModule=async()=>({cleanupAllowed:()=>true,cleanupSupported:()=>webCodecs,createCleanupClient:options=>{const c={disposed:false,async prepareSource(input){cleanupCalls.push(['source',input]);return {manifest:{id:'source-verified'},blob:exactBlob};},async sourceFrame(){return d.createElement('canvas');},mountEditor:options=>{c.editorOptions=options;return {getConfig:()=>({detectText:true,manualRegions:[],paddingPixels:3,temporalPaddingFrames:1}),dispose(){}};},async prepareMask(){cleanupCalls.push(['mask']);if(suspendMask)await suspendMask;return {blob:maskBlob};},async acceptMask(){cleanupCalls.push(['accept']);return cleanupMeta;},invalidateMask(){cleanupCalls.push(['invalidate-mask']);},dispose(){c.disposed=true;}};cleanupClients.push(c);return c;},async resumeClientProcessing(input){cleanupCalls.push(['resume',input]);if(suspendResume)await suspendResume;if(input.signal.aborted||!input.isCurrent())throw Error('canceled');finishedWorkflow=true;return {id:input.jobId,state:'queued',workflowVersion:'rig-workflow-v2'};}});const uploadedDurations=new Map();
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);let value;
  if(path==='/api/generations/recent')value={job:recentJob};
  else if(path==='/api/assets'){const id='asset'+(++assets);if(options.headers['X-Rig-Asset-Kind']==='video')uploadedDurations.set(id,Number(options.headers['X-Rig-Duration-Seconds']));value={id,status:'ready',kind:options.headers['X-Rig-Asset-Kind']};}
  else if(path==='/api/video-drafts')value={saved:true,expiresAt:Date.now()+86400000};
  else if(path==='/api/generation-quotes'){
   const input=JSON.parse(options.body),duration=verifiedDuration??(input.cleanupMaskId?6:uploadedDurations.get(input.videoId)),id='quote'+(++quotes);
   value={id,...(input.cleanupMaskId&&!omitWorkflow?{workflowVersion:'rig-workflow-v2'}:{}),quality:input.quality,...(input.quality==='human-recast'&&!omitResolution?{outputResolution}:{}),funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:987654,durationSeconds:duration,billedSeconds:Math.ceil(duration),transferPolicy:input.transferPolicy,approvalToken:'t'.repeat(43),idempotencyKey:'approval-'+id};
  }else if(path==='/api/generations')value={id:'job-recast',state:jobState,funding:'owner-provider',providerEstimateUsdMicros:987654,finalizationConfirmed:true};
  else if(path==='/api/generations/job-recast')value={id:'job-recast',...(['awaiting_client_processing','ready_to_advance'].includes(jobState)?{workflowVersion:'rig-workflow-v2'}:{}),state:['awaiting_client_processing','ready_to_advance'].includes(jobState)&&!finishedWorkflow?jobState:jobState==='failed'?'failed':'completed',videoPath:'/api/generations/job-recast/video',funding:'owner-provider',finalizationConfirmed:true};
  else if(path.startsWith('/api/estimate/fal?')){const p=new URL(path,w.location.origin).searchParams,duration=Number(p.get('duration')),micros=estimateLimit?Math.ceil(duration)*450000:987654;if(estimateLimit&&p.get('quality')==='human-recast'&&micros>6000000)return {ok:false,status:400,json:async()=>({error:'Dit fragment valt buiten de ingestelde Fal-limiet per video. Kies een korter fragment.',code:estimateFailureCode})};value={quality:p.get('quality'),durationSeconds:duration,billedSeconds:Math.ceil(duration),funding:'owner-provider',providerEstimate:{currency:'USD',usdMicros:micros,binding:false}};}
  else throw Error('unexpected '+path);
  return {ok:true,json:async()=>value};
 };
 w.eval(app);w.eval(generation);w.rigVideoMode='live';
 const change=(id,value)=>{el(id).value=String(value);el(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
 const prompt=text=>{el('editPrompt').value=text;el('editPrompt').dispatchEvent(new w.Event('input',{bubbles:true}));};
 const file=(id,name,type)=>{const source=new w.File(['source'],name,{type});Object.defineProperty(el(id),'files',{configurable:true,value:[source]});el(id).dispatchEvent(new w.Event('change',{bubbles:true}));return source;};
 const load=()=>{file('personInput','my-portrait.jpg','image/jpeg');file('motionInput','reference.mp4','video/mp4');el('motionVideo').dispatchEvent(new w.Event('loadedmetadata'));};
 const prepare=()=>{el('prepare').click();el('confirmBrief').click();};
 return {dom,w,d,el,calls,images,videos,storage,verifications,created,revoked,change,prompt,file,load,prepare,cleanupCalls,cleanupClients,exactBlob,maskBlob,suspendMask(p){suspendMask=p;},suspendResume(p){suspendResume=p;}};
}

test('cleanup appears only for the exact owner Recast capability and a supported local browser',()=>{
 for(const options of [{cleanupFlag:false},{webCodecs:false},{}]){const f=fixture(options);try{f.load();assert.equal(f.el('cleanupOption').hidden,true);f.el('editModeButton').click();assert.equal(f.el('cleanupOption').hidden,options.cleanupFlag===false||options.webCodecs===false);if(!f.el('cleanupOption').hidden){f.w.rigVideoCleanup={enabled:true,version:'unknown',quality:'human-recast',maxDurationSeconds:15};f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(f.el('cleanupOption').hidden,true);}assert.equal(f.cleanupCalls.length,0);}finally{f.dom.window.close();}}
});
async function openCleanup(f){f.load();f.el('editModeButton').click();f.el('cleanupEnabled').checked=true;f.el('cleanupEnabled').dispatchEvent(new f.w.Event('change'));f.prepare();await settle(()=>!f.el('cleanupReview').hidden&&!f.el('confirmBrief').disabled);}
test('cleanup reviews the actual source, then the mask, before one total quote and preserves prompt, source and full duration',async()=>{
 const f=fixture({verifiedDuration:6});try{f.load();f.el('editModeButton').click();f.change('duration',13);f.change('start',9.5);f.prompt('Mijn oorspronkelijke prompt.');const original=f.el('motionInput').files[0];f.el('cleanupEnabled').checked=true;f.el('cleanupEnabled').dispatchEvent(new f.w.Event('change'));f.el('prepare').click();f.el('tryShortVideo').click();await settle(()=>!f.el('cleanupReview').hidden&&!f.el('confirmBrief').disabled);
 assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('cleanupSourcePreview').src.startsWith('blob:'),true);assert.equal(f.el('cleanupMaskFigure').hidden,true);assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.cleanupCalls[0][1].selectedSeconds,6);assert.deepEqual(f.videos.map(video=>video[3]),[13,6]);assert.equal(f.el('duration').value,'13');assert.equal(f.calls.some(([p])=>p==='/api/generation-quotes'||p==='/api/generations'),false);
 f.el('confirmBrief').click();await settle(()=>!f.el('cleanupMaskFigure').hidden);assert.equal(f.el('briefDialog').open,true);assert.equal(f.w.rigPreparedMedia(),null);assert.match(f.el('confirmBrief').textContent,/Gebruik masker/);assert.equal(f.calls.some(([p])=>p==='/api/assets'),false);
 f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.w.rigPreparedMedia().cleanup.maskId,'mask-verified');assert.equal(f.w.rigPreparedMedia().video.blob,f.exactBlob);assert.equal(f.w.rigPreparedMedia().prompt,'Mijn oorspronkelijke prompt.');f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);
 const assets=f.calls.filter(([p])=>p==='/api/assets');assert.deepEqual(assets.map(([,options])=>options.headers['X-Rig-Asset-Kind']),['image','video']);assert.equal(assets[1][1].headers['X-Rig-Duration-Seconds'],'13');const saved=JSON.parse(f.calls.find(([p])=>p==='/api/video-drafts')[1].body);assert.equal(saved.selectedSeconds,13);assert.equal(saved.cleanup,true);assert.equal(Object.hasOwn(saved,'cleanupMaskId'),false,'the full draft remembers cleanup intent rather than reusing the six-second mask');const q=JSON.parse(f.calls.find(([p])=>p==='/api/generation-quotes')[1].body);assert.equal(q.videoId,'source-verified');assert.equal(q.cleanupMaskId,'mask-verified');assert.equal(q.quality,'human-recast');assert.equal(q.faceId,null);assert.deepEqual(q.angleIds,[]);assert.match(f.el('quoteMessage').textContent,/totale raming/);assert.match(f.el('quoteMessage').textContent,/1080p/);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);assert.equal(f.el('motionInput').files[0],original);assert.equal(f.el('start').value,'9.5');assert.equal(f.el('duration').value,'13');
 }finally{f.dom.window.close();}
});
test('changed manual marks revoke the reviewed mask and require a new mask before price',async()=>{
 const f=fixture();try{await openCleanup(f);f.el('confirmBrief').click();await settle(()=>!f.el('cleanupMaskFigure').hidden);const old=f.el('cleanupMaskPreview').src;f.cleanupClients[0].editorOptions.onChange();assert.equal(f.el('cleanupMaskFigure').hidden,true);assert.ok(f.revoked.includes(old));assert.equal(f.w.rigPreparedMedia(),null);assert.match(f.el('confirmBrief').textContent,/Zoek tekst/);assert.equal(f.calls.some(([p])=>p==='/api/generation-quotes'),false);}finally{f.dom.window.close();}
});
test('closing during mask processing cancels its intent and cannot publish a late mask or price',async()=>{
 const f=fixture();let release;try{await openCleanup(f);f.suspendMask(new Promise(r=>release=r));f.el('confirmBrief').click();await settle(()=>f.cleanupCalls.some(([s])=>s==='mask'));f.el('closeBrief').click();assert.equal(f.el('briefDialog').open,false);assert.equal(f.cleanupClients[0].disposed,true);release();await new Promise(r=>setTimeout(r,20));assert.equal(f.el('cleanupMaskFigure').hidden,true);assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.calls.some(([p])=>p==='/api/generation-quotes'||p==='/api/generations'),false);}finally{release?.();f.dom.window.close();}
});
test('source crop opens from the same prompt popup and returns without changing the user prompt',()=>{const f=fixture();try{f.load();f.el('prepare').click();f.prompt('Mijn behouden prompt');f.el('briefCrop').click();assert.equal(f.el('briefDialog').open,false);assert.equal(f.el('cropDialog').open,true);f.el('applyCrop').click();f.el('cropDialog').dispatchEvent(new f.w.Event('close'));assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('editPrompt').value,'Mijn behouden prompt');}finally{f.dom.window.close();}});
test('read-only discovery never composes; an explicit existing-job recovery resumes once without a new generation',async()=>{
 const storage=new Map([['rig-generation-job','job-recast']]),f=fixture({storage,jobState:'awaiting_client_processing',recentJob:{id:'job-recast',state:'awaiting_client_processing'}});try{await new Promise(r=>setTimeout(r,15));assert.equal(f.cleanupCalls.length,0);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);f.el('checkGeneration').click();await settle(()=>f.el('quoteMessage').textContent==='Je video is klaar.');assert.equal(f.cleanupCalls.filter(([s])=>s==='resume').length,1);assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}
});
for(const jobState of ['awaiting_client_processing','ready_to_advance'])test(`a fresh browser discovers ${jobState} and can explicitly resume it without a new generation`,async()=>{
 const f=fixture({jobState,recentJob:{id:'job-recast',state:jobState}});try{
  await settle(()=>!f.el('recentVideo').hidden);assert.equal(f.storage.get('rig-generation-job'),'job-recast');assert.equal(f.cleanupCalls.length,0);assert.equal(f.el('quoteDialog').open,false,'discovery does not open a confirmation or start processing');
  f.el('recentVideo').click();await settle(()=>!f.w.rigGenerationBusy()&&f.el('quoteMessage').textContent.includes('lokale tussenstap'));
  assert.equal(f.cleanupCalls.length,0,'viewing status does not automatically advance the accepted workflow');assert.equal(f.el('checkGeneration').hidden,false);
  f.el('checkGeneration').click();await settle(()=>f.el('quoteMessage').textContent==='Je video is klaar.');
  assert.equal(f.cleanupCalls.filter(([stage])=>stage==='resume').length,1);assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});
test('a discovered unfinished workflow never replaces a different stored job or pending intent',async()=>{
 for(const [key,value] of [['rig-generation-job','another-job'],['rig-generation-pending',JSON.stringify({quoteId:'another-quote',idempotencyKey:'another-intent'})]]){
  const f=fixture({storage:new Map([[key,value]]),jobState:'awaiting_client_processing',recentJob:{id:'job-recast',state:'awaiting_client_processing'}});try{
   await settle(()=>!f.el('recentVideo').hidden);f.el('recentVideo').click();await settle(()=>!f.w.rigGenerationBusy());
   assert.equal(f.storage.get(key),value);assert.equal(f.storage.size,1);assert.equal(f.el('checkGeneration').hidden,false);
   assert.equal(f.calls.some(([p])=>p==='/api/generations/job-recast'),false,'the current recovery must be resolved before switching to another unfinished workflow');
   assert.equal(f.cleanupCalls.length,0);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  }finally{f.dom.window.close();}
 }
});
test('late discovery cannot bind a previous session or overwrite a recovery created while its read was pending',async()=>{
 for(const replace of ['request','session','storage','pending']){
  const f=fixture({jobState:'awaiting_client_processing',recentJob:{id:'job-recast',state:'awaiting_client_processing'}});try{
   if(replace==='request')f.w.rigRequest=async()=>{throw Error('Different account request')};
   else if(replace==='session')f.w.rigSessionActive=()=>false;
   else if(replace==='storage')f.w.rigScopedStorage={getItem:()=>null,setItem:()=>{throw Error('Old discovery must not write new account storage')},removeItem:()=>{throw Error('Old discovery must not clear new account storage')}};
   else f.storage.set('rig-generation-pending',JSON.stringify({quoteId:'new-quote',idempotencyKey:'new-intent'}));
   await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.storage.has('rig-generation-job'),false);
   assert.equal(f.el('recentVideo').hidden,replace!=='pending');assert.equal(f.cleanupCalls.length,0);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  }finally{f.dom.window.close();}
 }
});
test('closing a discovered status view cancels its intent before a late workflow response can resume',async()=>{
 const f=fixture({jobState:'awaiting_client_processing',recentJob:{id:'job-recast',state:'awaiting_client_processing'}});let release;try{
  await settle(()=>!f.el('recentVideo').hidden);const original=f.w.rigRequest;
  f.w.rigRequest=(path,options)=>path==='/api/generations/job-recast'?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({id:'job-recast',state:'awaiting_client_processing',workflowVersion:'rig-workflow-v2'})});}):original(path,options);
  f.el('recentVideo').click();await settle(()=>!!release);assert.equal(f.w.rigGenerationBusy(),true);f.el('closeQuote').click();release();await settle(()=>!f.w.rigGenerationBusy());
  assert.equal(f.el('quoteDialog').open,false);assert.equal(f.el('recentVideo').disabled,false);assert.equal(f.el('checkGeneration').disabled,false);assert.equal(f.storage.get('rig-generation-job'),'job-recast');assert.equal(f.cleanupCalls.length,0);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{release?.();f.dom.window.close();}
});
test('a completed video fetched by an old session cannot appear after its binding changes',async()=>{
 const f=fixture({jobState:'completed',recentJob:{id:'job-recast',state:'completed'}});let release;try{
  await settle(()=>!f.el('recentVideo').hidden);let busyChanges=0;f.d.addEventListener('rig-generation-busy-change',()=>busyChanges++);f.w.rigOpenVideo=()=>new Promise(resolve=>{release=()=>resolve('blob:old-session-result')});
  f.el('recentVideo').click();await settle(()=>!!release);
  const beforeSwitch=busyChanges;
  f.w.rigScopedStorage={getItem:()=>null,setItem:()=>{throw Error('Old request must not write a new session')},removeItem:()=>{throw Error('Old request must not clear a new session')}};
  release();await settle(()=>!f.w.rigGenerationBusy());assert.equal(busyChanges,beforeSwitch,'old account must not dispatch UI-unlock events into the new binding');assert.equal(f.el('recentVideo').disabled,true);assert.equal(f.el('checkGeneration').disabled,true);assert.equal(f.el('resultVideo').hidden,true);assert.equal(f.el('export').hidden,true);assert.ok(f.revoked.includes('blob:old-session-result'));assert.equal(f.cleanupCalls.length,0);
 }finally{release?.();f.dom.window.close();}
});
test('a late finalized failure cannot remove a newer recovery handle',async()=>{
 const f=fixture({jobState:'failed',recentJob:{id:'job-recast',state:'failed'}});let release;try{
  await settle(()=>!f.el('recentVideo').hidden);const original=f.w.rigRequest;
  f.w.rigRequest=(path,options)=>path==='/api/generations/job-recast'?new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({id:'job-recast',state:'failed',funding:'owner-provider',finalizationConfirmed:true})});}):original(path,options);
  f.el('recentVideo').click();await settle(()=>!!release);f.storage.set('rig-generation-job','newer-job');release();await settle(()=>!f.w.rigGenerationBusy());
  assert.equal(f.storage.get('rig-generation-job'),'newer-job');assert.equal(f.el('checkGeneration').hidden,false);assert.equal(f.cleanupCalls.length,0);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{release?.();f.dom.window.close();}
});
test('closing a workflow recovery aborts local processing and keeps the existing job recoverable',async()=>{
 const storage=new Map([['rig-generation-job','job-recast']]),f=fixture({storage,jobState:'awaiting_client_processing'});let release;try{f.suspendResume(new Promise(r=>release=r));f.el('checkGeneration').click();await settle(()=>f.cleanupCalls.some(([s])=>s==='resume'));const intent=f.cleanupCalls.find(([s])=>s==='resume')[1];f.el('closeQuote').click();assert.equal(intent.signal.aborted,true);release();await settle(()=>!f.w.rigGenerationBusy());assert.equal(f.storage.get('rig-generation-job'),'job-recast');assert.equal(f.el('resultVideo').hidden,true);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{release?.();f.dom.window.close();}
});

test('a server that cannot confirm the complete workflow price cannot expose a paid cleanup confirmation',async()=>{const f=fixture({omitWorkflow:true});try{await openCleanup(f);f.el('confirmBrief').click();await settle(()=>!f.el('cleanupMaskFigure').hidden);f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>f.el('quoteMessage').textContent.includes('volledige verwerkingsprijs'));assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}});
test('session disposal clears prepared private cleanup IDs and preview URLs but keeps the selected originals for an explicit new review',async()=>{const f=fixture();try{await openCleanup(f);const original=f.el('motionInput').files[0];f.el('confirmBrief').click();await settle(()=>!f.el('cleanupMaskFigure').hidden);f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.ok(f.w.rigPreparedMedia().cleanup);const sourceURL=f.el('cleanupSourcePreview').src,maskURL=f.el('cleanupMaskPreview').src;f.w.rigGenerationDispose();assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('cleanupEnabled').checked,false);assert.ok(f.revoked.includes(sourceURL));assert.ok(f.revoked.includes(maskURL));assert.equal(f.el('motionInput').files[0],original);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}});

test('revoking cleanup capability invalidates its reviewed draft and price without silently switching to a normal generation',async()=>{const f=fixture();try{await openCleanup(f);f.el('confirmBrief').click();await settle(()=>!f.el('cleanupMaskFigure').hidden);f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);f.w.rigVideoCleanup=null;f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(f.el('cleanupOption').hidden,true);assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);assert.equal(f.w.rigGenerationQuality(),'human-recast');}finally{f.dom.window.close();}});

test('explicit recovery recognizes the real ready_to_advance status after a saved output and does not start a new generation',async()=>{const f=fixture({storage:new Map([['rig-generation-job','job-recast']]),jobState:'ready_to_advance'});try{f.el('checkGeneration').click();await settle(()=>f.el('quoteMessage').textContent==='Je video is klaar.');assert.equal(f.cleanupCalls.filter(([stage])=>stage==='resume').length,1);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}});
