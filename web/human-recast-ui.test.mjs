import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Recast UI did not settle');};
function fixture({qualities=['standard','pro','human-recast'],verifiedDuration=5.94,outputResolution='1080P',omitResolution=false,estimateLimit=false,estimateFailureCode='provider_limit_exceeded',storage:savedStorage=new Map(),jobState='failed',recentJob=null}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],images=[],videos=[],storage=savedStorage,verifications=[],created=[],revoked=[];
 w.Blob=Blob;el('rigStudio').hidden=false;el('authGate').hidden=true;w.rigNativeSite=true;w.rigVideoEnabled=true;w.rigVideoFunding='owner-provider';w.rigVideoQualities=qualities;w.rigSessionActive=()=>true;
 w.URL.createObjectURL=blob=>{const url=`blob:fixture-${created.length}`;created.push({url,blob});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};video.play=async()=>{};}
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(value){this.onload?.();}};
 w.rigMedia={bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async(source,crop)=>{const image={blob:new Blob(['image-'+images.length],{type:'image/jpeg'}),width:1280,height:720};images.push({source,crop:{...crop},image});return image;},prepareImageFile:async file=>({blob:new Blob(['prepared '+file.name],{type:'image/jpeg'}),width:1280,height:720}),prepareVideo:async(...args)=>{videos.push(args);return {blob:new Blob(['prepared-video'],{type:'video/mp4'}),duration:args[3],width:1280,height:720};}};
 w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 w.rigOpenVideo=async()=>`blob:fixture-result`;
 w.rigOwnerVerification={prepare:async(operation,payload)=>{verifications.push({operation,payload});return null;}};
 let assets=0,quotes=0;const uploadedDurations=new Map();
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);let value;
  if(path==='/api/generations/recent')value={job:recentJob};
  else if(path==='/api/assets'){const id='asset'+(++assets);if(options.headers['X-Rig-Asset-Kind']==='video')uploadedDurations.set(id,Number(options.headers['X-Rig-Duration-Seconds']));value={id,status:'ready',kind:options.headers['X-Rig-Asset-Kind']};}
  else if(path==='/api/generation-quotes'){
   const input=JSON.parse(options.body),duration=verifiedDuration??uploadedDurations.get(input.videoId),id='quote'+(++quotes);
   value={id,quality:input.quality,...(input.quality==='human-recast'&&!omitResolution?{outputResolution}:{}),funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:987654,durationSeconds:duration,billedSeconds:Math.ceil(duration),transferPolicy:input.transferPolicy,approvalToken:'t'.repeat(43),idempotencyKey:'approval-'+id};
  }else if(path==='/api/generations')value={id:'job-recast',state:jobState,funding:'owner-provider',providerEstimateUsdMicros:987654,finalizationConfirmed:true};
  else if(path==='/api/generations/job-recast')value={id:'job-recast',state:jobState==='failed'?'failed':'completed',videoPath:'/api/generations/job-recast/video',funding:'owner-provider',finalizationConfirmed:true};
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
 return {dom,w,d,el,calls,images,videos,storage,verifications,created,revoked,change,prompt,file,load,prepare};
}
test('human recast is chosen only from its capability while the dog-band preset remains explicitly O3-only',()=>{
 const f=fixture({qualities:['standard','pro','edit-standard','human-recast']});
 try{
  f.load();f.el('editModeButton').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('duration').value,'6');assert.equal(f.el('duration').min,'6');assert.equal(f.el('duration').max,'15');assert.match(f.el('personTip').textContent,/portretfoto van een persoon/);assert.match(f.el('tryShortVideo').textContent,/6 s/);
  f.el('idea-band').click();assert.equal(f.w.rigGenerationQuality(),'edit-standard');assert.equal(f.el('duration').value,'5');assert.match(f.el('editPrompt').value,/muzikant of zanger/);
  f.el('idea-film').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('editPrompt').value,f.el('idea-film').dataset.ideaPrompt);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
 const humanOnly=fixture();try{humanOnly.load();assert.equal(humanOnly.el('idea-band').hidden,true);assert.equal(humanOnly.el('idea-film').hidden,false);humanOnly.el('editModeButton').click();const before=humanOnly.el('editPrompt').value;humanOnly.el('idea-band').click();assert.equal(humanOnly.w.rigGenerationQuality(),'human-recast');assert.equal(humanOnly.el('editPrompt').value,before);}finally{humanOnly.dom.window.close();}
 const old=fixture({qualities:['standard','pro','edit-standard']});try{old.el('editModeButton').click();assert.equal(old.w.rigGenerationQuality(),'edit-standard');assert.equal(old.el('duration').value,'5');}finally{old.dom.window.close();}
});
test('recast retains selected files and unused references, uses one fixed portrait, and preserves the real price and device-confirmation flow',async()=>{
 const f=fixture();
 try{
  f.load();f.file('personInput','4k-reference.mp4','video/mp4');const source=f.el('personVideo');source.dispatchEvent(new f.w.Event('loadedmetadata'));source.dispatchEvent(new f.w.Event('loadeddata'));const portraitFile=f.el('personInput').files[0],motionFile=f.el('motionInput').files[0],motionURL=f.el('motionVideo').src;
  f.el('captureMain').click();await settle(()=>!f.el('mainReference').hidden);const main=f.images[0].image.blob;
  f.el('captureFace').click();await settle(()=>!f.el('faceReference').hidden);
  for(let i=0;i<3;i++){f.el('captureAngle').click();await settle(()=>!f.el('angleReference'+i).hidden);}
  f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));f.change('start',9.5);f.change('duration',5);f.prompt('Mijn bewaarde bewegingsbeschrijving.');
  f.el('editModeButton').click();assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('duration').value,'6');assert.equal(f.el('start').value,'9.5');assert.equal(f.el('sound').checked,true);assert.equal(f.el('sound').disabled,true);assert.equal(f.el('recastSoundNote').hidden,false);assert.equal(f.el('recastReferenceNote').hidden,false);assert.equal(f.el('referenceFiles').hidden,true);assert.equal(f.el('captureFace').hidden,true);assert.equal(f.el('captureAngle').hidden,true);assert.equal(f.el('faceReference').hidden,true);assert.equal(f.el('angleReference2').hidden,true);
  f.prompt('Vervang de persoon door mij.');f.el('prepare').click();f.el('tryShortVideo').click();await settle(()=>f.el('uploadDialog').open);
  const media=f.w.rigPreparedMedia();assert.equal(media.quality,'human-recast');assert.equal(media.image.blob,main);assert.equal(media.face,null);assert.equal(media.angles.length,0);assert.equal(media.steady,false);assert.equal(media.keepSound,true);assert.equal(media.prompt,'Vervang de persoon door mij.');assert.equal(f.videos.length,1);assert.equal(f.videos[0][2],9.5);assert.equal(f.videos[0][3],6);assert.equal(f.images.length,5);
  assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generations'),false);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);
  const uploads=f.calls.filter(([p])=>p==='/api/assets');assert.equal(uploads.length,2);assert.equal(uploads[0][1].body,main);assert.equal(uploads[1][1].headers['X-Rig-Duration-Seconds'],'6');const quote=JSON.parse(f.calls.find(([p])=>p==='/api/generation-quotes')[1].body);assert.equal(quote.quality,'human-recast');assert.equal(quote.faceId,null);assert.deepEqual(quote.angleIds,[]);assert.equal(quote.prompt,'Vervang de persoon door mij.');assert.equal(quote.transferPolicy,'fal-temporary-links-v1');assert.equal(Object.hasOwn(quote,'steadyCamera'),false);
  assert.match(f.el('quoteMessage').textContent,/0,988.*6 seconden/);assert.match(f.el('quoteMessage').textContent,/Kwaliteit: 1080p/);assert.match(f.el('quoteMessage').textContent,/24 uur/);assert.equal(f.el('quoteTitle').textContent,'In de video');assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  f.el('confirmGeneration').click();await settle(()=>f.verifications.length===1);await settle(()=>!f.el('confirmGeneration').disabled);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  f.w.rigOwnerVerification.prepare=async(operation,payload)=>{f.verifications.push({operation,payload});return {proof:'device-confirmed'};};f.el('confirmGeneration').click();await settle(()=>f.calls.some(([p])=>p==='/api/generations'));assert.equal(f.calls.filter(([p])=>p==='/api/generations').length,1);const submitted=JSON.parse(f.calls.find(([p])=>p==='/api/generations')[1].body);assert.equal(submitted.transferConsent,'fal-temporary-links-v1');assert.deepEqual(submitted.verification,{proof:'device-confirmed'});assert.equal(f.verifications[1].operation,'owner-generation');
  f.el('closeQuote').click();f.el('motionModeButton').click();assert.equal(f.el('personInput').files[0],portraitFile);assert.equal(f.el('motionInput').files[0],motionFile);assert.equal(f.el('motionVideo').src,motionURL);assert.equal(f.el('faceReference').hidden,false);assert.equal(f.el('angleReference2').hidden,false);assert.equal(f.el('captureFace').hidden,false);assert.equal(f.el('sound').checked,false);assert.equal(f.el('sound').disabled,false);assert.equal(f.el('editPrompt').value,'Mijn bewaarde bewegingsbeschrijving.');assert.equal(f.el('duration').value,'5');
 }finally{f.dom.window.close();}
});
test('a recast never reuses or pads a five-second selection or silently shifts a near-end start',async()=>{
 const f=fixture();
 try{
  f.load();f.el('motionVideo').duration=30;f.change('duration',5);f.change('start',25);f.el('editModeButton').click();assert.equal(f.el('duration').value,'6');assert.equal(f.el('start').value,'25');assert.equal(f.el('tryShortVideo').disabled,true);f.prepare();assert.equal(f.el('briefDialog').open,true);assert.match(f.el('briefError').textContent,/minstens 6 seconden/);assert.equal(f.videos.length,0);assert.equal(f.images.length,0);
  f.el('closeBrief').click();f.change('start',0);f.change('duration',5);f.prepare();assert.match(f.el('briefError').textContent,/6 tot 15 seconden/);assert.equal(f.videos.length,0);assert.equal(f.calls.some(([p])=>p==='/api/assets'),false);
  f.el('closeBrief').click();f.el('motionVideo').duration=5.9;f.change('duration',6);f.prepare();assert.match(f.el('briefError').textContent,/minstens 6 seconden/);assert.equal(f.el('tryShortVideo').disabled,true);assert.equal(f.videos.length,0);
 }finally{f.dom.window.close();}
});
test('a normalized recast below five seconds cannot expose generation confirmation',async()=>{
 const f=fixture({verifiedDuration:4.92});
 try{f.load();f.el('editModeButton').click();f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>f.el('quoteMessage').textContent.includes('gekozen videobewerking'));assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}
});
test('loss of the selected recast capability invalidates its quote without falling back to O3',async()=>{
 const f=fixture({qualities:['standard','pro','edit-standard','human-recast']});
 try{
  f.load();f.el('editModeButton').click();f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);
  const portraitURL=f.el('quotePortraitImage').src;assert.equal(f.el('quotePortraitPreview').hidden,false);f.w.rigVideoQualities=['standard','pro','edit-standard'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(f.el('quotePortraitPreview').hidden,true);assert.ok(f.revoked.includes(portraitURL));assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.w.rigPreparedMedia(),null);assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('confirmGeneration').hidden,true);f.el('confirmGeneration').click();assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  f.el('closeQuote').click();f.el('idea-band').click();assert.equal(f.w.rigGenerationQuality(),'edit-standard');assert.equal(f.el('prepare').disabled,false);f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);assert.equal(f.el('quotePortraitPreview').hidden,true);assert.equal(f.el('quotePortraitImage').hasAttribute('src'),false);
 }finally{f.dom.window.close();}
});

test('the recast quote previews the exact fixed main portrait and revokes that local URL on changes, closing, session end and page exit',async()=>{
 const f=fixture();
 try{
  f.load();f.el('captureMain').click();await settle(()=>!f.el('mainReference').hidden);const main=f.images[0].image.blob;
  f.el('editModeButton').click();f.el('personCropButton').click();f.el('cropX').value='10';f.el('cropW').value='90';f.el('applyCrop').click();
  const quote=async()=>{f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('quotePortraitPreview').hidden);return f.el('quotePortraitImage').src;};
  const first=await quote();const preview=f.created.find(x=>x.url===first);assert.equal(preview.blob.type,'image/jpeg');assert.deepEqual(new Uint8Array(await preview.blob.arrayBuffer()),new Uint8Array(await main.arrayBuffer()));assert.equal(f.w.rigPreparedMedia().image.blob,main);assert.match(f.el('quotePortraitPreview').textContent,/Gebruikt hoofdbeeld/);
  f.prompt('Een andere beschrijving.');assert.equal(f.el('quotePortraitPreview').hidden,true);assert.equal(f.el('quotePortraitImage').hasAttribute('src'),false);assert.ok(f.revoked.includes(first));
  f.el('closeQuote').click();const second=await quote();assert.notEqual(second,first);f.el('closeQuote').click();assert.equal(f.el('quotePortraitPreview').hidden,true);assert.ok(f.revoked.includes(second));
  const third=await quote();f.w.rigGenerationDispose();assert.equal(f.el('quotePortraitPreview').hidden,true);assert.equal(f.el('confirmGeneration').hidden,true);assert.ok(f.revoked.includes(third));f.el('confirmGeneration').click();assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  f.el('closeQuote').click();const fourth=await quote();f.w.dispatchEvent(new f.w.Event('pagehide'));assert.ok(f.revoked.includes(fourth));assert.equal(f.el('quotePortraitPreview').hidden,true);
 }finally{f.dom.window.close();}
});


test('a reference video requires an explicit recast main frame before preparation and guides to the existing controls without losing the draft',async()=>{
 const f=fixture();
 try{
  f.load();f.el('editModeButton').click();const portraitFile=f.file('personInput','ik.mp4','video/mp4'),reference=f.el('personVideo'),motionFile=f.el('motionInput').files[0],motionURL=f.el('motionVideo').src;reference.duration=56.85;reference.dispatchEvent(new f.w.Event('loadedmetadata'));reference.dispatchEvent(new f.w.Event('loadeddata'));
  assert.equal(f.el('moreOptions').open,true);assert.equal(f.el('referenceCapture').hidden,false);assert.match(f.el('status').textContent,/Kies een beeld van jezelf.*hoofdbeeld/);
  f.el('personCropButton').click();f.el('cropX').value='10';f.el('cropW').value='90';f.el('applyCrop').click();f.change('start',9.5);f.prompt('Vervang de persoon door mij.');f.prepare();
  assert.equal(f.el('briefDialog').open,false);assert.equal(f.el('moreOptions').open,true);assert.equal(f.el('captureMain').disabled,false);assert.equal(f.d.activeElement,f.el('frameTime'));assert.match(f.el('status').textContent,/Kies een beeld van jezelf.*hoofdbeeld/);assert.equal(f.images.length,0);assert.equal(f.videos.length,0);assert.equal(f.calls.some(([p])=>['/api/assets','/api/generation-quotes','/api/generations'].includes(p)),false);
  assert.equal(f.el('personInput').files[0],portraitFile);assert.equal(f.el('motionInput').files[0],motionFile);assert.equal(f.el('motionVideo').src,motionURL);assert.equal(f.el('start').value,'9.5');assert.equal(f.el('duration').value,'6');assert.equal(f.el('editPrompt').value,'Vervang de persoon door mij.');
  f.el('frameTime').value='37.5';f.el('frameTime').dispatchEvent(new f.w.Event('input'));reference.dispatchEvent(new f.w.Event('seeked'));f.el('captureMain').click();await settle(()=>!f.el('mainReference').hidden);const main=f.images[0];assert.equal(main.source,reference);assert.equal(main.crop.x,10);assert.equal(main.crop.w,90);
  f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden);const uploads=f.calls.filter(([p])=>p==='/api/assets');assert.equal(uploads.length,2);assert.equal(uploads[0][1].body,main.image.blob);assert.equal(uploads[1][1].headers['X-Rig-Duration-Seconds'],'6');assert.equal(f.el('quotePortraitPreview').hidden,false);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});


test('recast quality is shown only after an exact 1080P quote and a missing or different resolution blocks confirmation',async()=>{
 for(const options of [{omitResolution:true},{outputResolution:'768P'},{outputResolution:'720P'},{outputResolution:'1080p'},{outputResolution:1080},{outputResolution:null}]){
  const f=fixture(options);try{f.load();f.el('editModeButton').click();f.prepare();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>f.el('quoteMessage').textContent.includes('1080p-kwaliteit'));assert.equal(f.el('confirmGeneration').hidden,true);assert.equal(f.el('quotePortraitPreview').hidden,true);assert.doesNotMatch(f.el('quoteMessage').textContent,/Kwaliteit: 1080p/);f.el('confirmGeneration').click();assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}
 }
});

test('Motion defaults to Pro, retains an explicit Standard choice and never silently changes quality when availability changes',()=>{
 const f=fixture();try{f.load();const standard=f.d.querySelector('input[name=quality][value=standard]'),pro=f.d.querySelector('input[name=quality][value=pro]');assert.equal(pro.checked,true);assert.equal(f.w.rigGenerationQuality(),'pro');
  f.w.rigVideoQualities=['standard'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(pro.checked,true);assert.equal(f.w.rigGenerationQuality(),'pro');assert.equal(f.el('prepare').disabled,true);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
  f.w.rigVideoQualities=['standard','pro','human-recast'];f.d.dispatchEvent(new f.w.Event('rig-video-availability'));assert.equal(f.w.rigGenerationQuality(),'pro');standard.checked=true;standard.dispatchEvent(new f.w.Event('change'));assert.equal(f.w.rigGenerationQuality(),'standard');f.el('editModeButton').click();f.el('motionModeButton').click();assert.equal(f.w.rigGenerationQuality(),'standard');assert.equal(standard.checked,true);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});


test('an owner Recast estimate shows the fixed Fal-limit rejection without changing duration, quality or starting preparation',async()=>{
 const f=fixture({estimateLimit:true});try{f.load();f.el('editModeButton').click();f.change('duration',14);await settle(()=>f.el('providerEstimate').textContent.includes('Fal-limiet'));assert.match(f.el('providerEstimate').textContent,/Kies een korter fragment/);assert.equal(f.el('duration').value,'14');assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.calls.some(([p])=>['/api/assets','/api/generation-quotes','/api/generations'].includes(p)),false);
  f.change('duration',13);await settle(()=>f.el('providerEstimate').textContent.includes('5,85'));assert.match(f.el('providerEstimate').textContent,/13 s/);assert.equal(f.el('duration').value,'13');assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});

test('unknown limit errors and non-owner funding do not display an owner provider-limit message',async()=>{
 for(const options of [{estimateFailureCode:'unknown_provider_error'},{funding:'credits'}]){const f=fixture({estimateLimit:true,...options});try{f.load();f.el('editModeButton').click();if(options.funding)f.w.rigVideoFunding=options.funding;f.change('duration',14);await settle(()=>f.el('providerEstimate').textContent.includes('tijdelijk niet beschikbaar'));assert.doesNotMatch(f.el('providerEstimate').textContent,/Fal-limiet/);assert.equal(f.el('duration').value,'14');assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);}finally{f.dom.window.close();}}
});

async function finishShortTrial(f){
 f.el('prepare').click();f.el('tryShortVideo').click();await settle(()=>f.el('uploadDialog').open).catch(error=>{error.message+=': '+f.el('status').textContent+' / '+f.el('briefError').textContent+' / prepare disabled='+f.el('prepare').disabled+' trial disabled='+f.el('tryShortVideo').disabled;throw error;});
 f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden&&!f.el('confirmUpload').disabled);
 assert.equal(f.calls.some(([path])=>path==='/api/generations'),false,'a price is not a paid generation');
 f.w.rigOwnerVerification.prepare=async()=>({proof:'explicit-device-confirmation'});
 f.el('confirmGeneration').click();await settle(()=>!f.el('makeFullVideo').hidden&&!f.el('makeFullVideo').disabled);
}
function crop(f,kind,x,w){f.el(kind+'CropButton').click();f.el('cropX').value=String(x);f.el('cropW').value=String(w);f.el('applyCrop').click();}

test('a completed trial restores the exact full draft only on request, then requires a fresh price and explicit paid confirmation',async()=>{
 const f=fixture({verifiedDuration:null,jobState:'queued'});
 try{
  f.load();const person=f.el('personInput').files[0],motion=f.el('motionInput').files[0];
  crop(f,'person',10,80);f.el('captureMain').click();await settle(()=>!f.el('mainReference').hidden);const portrait=f.images[0].image.blob;
  crop(f,'motion',20,70);f.el('editModeButton').click();f.change('duration',13);f.change('start',9.5);f.prompt('Mijn oorspronkelijke volledige scène.');
  await finishShortTrial(f);
  assert.equal(f.el('duration').value,'13');assert.equal(f.w.rigPreparedMedia().selectedSeconds,6);assert.equal(f.videos[0][3],6);
  assert.equal(f.calls.filter(([p])=>p==='/api/assets')[1][1].headers['X-Rig-Duration-Seconds'],'6');
  assert.match(f.el('quoteMessage').textContent,/apart afgerekend.*nieuwe prijs/);assert.equal(f.el('makeFullFromResult').hidden,false);
  const saved=JSON.parse(f.storage.get('rig-trial-continuation:v1'));assert.equal(saved.state,'completed');assert.equal(saved.draft.seconds,13);assert.equal(saved.draft.start,9.5);assert.equal(saved.draft.person.name,person.name);assert.equal(saved.draft.mainSelection.time,null);
  for(const key of ['personFile','motionFile','mainReferenceBlob','faceReferenceBlob','angleReferenceBlobs'])assert.equal(Object.hasOwn(saved.draft,key),false);
  assert.doesNotMatch(f.storage.get('rig-trial-continuation:v1'),/blob:|approvalToken|explicit-device/);
  f.el('makeFullFromResult').click();await settle(()=>f.el('briefDialog').open);
  assert.equal(f.el('duration').value,'13');assert.equal(f.el('start').value,'9.5');assert.equal(f.el('editPrompt').value,'Mijn oorspronkelijke volledige scène.');assert.equal(f.w.rigGenerationQuality(),'human-recast');assert.equal(f.el('sound').checked,true);
  assert.equal(f.el('personInput').files[0],person);assert.equal(f.el('motionInput').files[0],motion);assert.match(f.el('briefError').textContent,/13 seconden.*9\.5 s.*apart afgerekend.*nieuwe prijs/);
  assert.equal(f.calls.filter(([p])=>p==='/api/generations').length,1,'restoring does not submit a second generation');
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);
  const full=f.w.rigPreparedMedia();assert.equal(full.selectedSeconds,13);assert.equal(full.trialToken,undefined);assert.equal(full.image.blob,portrait);assert.deepEqual({...f.videos.at(-1)[1]},{x:20,y:0,w:70,h:100});assert.equal(f.videos.at(-1)[2],9.5);assert.equal(f.videos.at(-1)[3],13);assert.equal(f.el('makeFullFromResult').hidden,true,'an old completed result cannot add a second action to a new price review');
  f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden&&!f.el('confirmUpload').disabled);assert.equal(f.calls.filter(([p])=>p==='/api/generation-quotes').length,2);assert.match(f.el('quoteMessage').textContent,/13 seconden/);assert.equal(f.calls.filter(([p])=>p==='/api/generations').length,1);
  f.el('confirmGeneration').click();await settle(()=>f.calls.filter(([p])=>p==='/api/generations').length===2&&!f.w.rigGenerationBusy());
  assert.equal(f.el('makeFullVideo').hidden,true,'a known completed full video is not sold as another missing full video');assert.equal(f.el('makeFullFromResult').hidden,true);
 }finally{f.dom.window.close();}
});

test('completion leaves a newer selection intact; only the explicit full-video action restores the saved draft',async()=>{
 const f=fixture({verifiedDuration:null,jobState:'queued'});
 try{
  f.load();f.el('editModeButton').click();f.change('duration',12);f.change('start',7.5);f.prompt('Eerste scène.');
  let release;const original=f.w.rigRequest;f.w.rigRequest=async(path,options)=>path==='/api/generations/job-recast'?await new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({state:'completed',videoPath:'/api/generations/job-recast/video'})});}):original(path,options);
  f.el('prepare').click();f.el('tryShortVideo').click();await settle(()=>f.el('uploadDialog').open);f.el('confirmUpload').click();await settle(()=>!f.el('confirmGeneration').hidden&&!f.el('confirmUpload').disabled);f.w.rigOwnerVerification.prepare=async()=>({proof:'confirmed'});f.el('confirmGeneration').click();await settle(()=>release);
  const newFile=f.file('personInput','new-phone-photo.jpg','image/jpeg');f.prompt('Nieuw idee.');f.change('duration',10);f.change('start',2.5);crop(f,'person',30,50);
  release();await settle(()=>!f.el('makeFullVideo').hidden&&!f.el('makeFullVideo').disabled);
  assert.equal(f.el('personInput').files[0],newFile);assert.equal(f.el('editPrompt').value,'Nieuw idee.');assert.equal(f.el('duration').value,'10');assert.equal(f.el('start').value,'2.5');
  f.el('makeFullVideo').click();await settle(()=>f.el('briefDialog').open);assert.equal(f.el('personName').textContent,'my-portrait.jpg');assert.equal(f.el('editPrompt').value,'Eerste scène.');assert.equal(f.el('duration').value,'12');assert.equal(f.el('start').value,'7.5');assert.equal(f.calls.filter(([p])=>p==='/api/generations').length,1);
 }finally{f.dom.window.close();}
});

test('a legacy result guides to visible missing-file controls and an explicit longer duration, preserving the current selection',async()=>{
 const f=fixture({recentJob:{id:'legacy-completed',state:'completed'}});
 try{
  await settle(()=>!f.el('makeFullVideo').hidden);assert.equal(f.el('makeFullFromResult').hidden,true,'discovering an older result does not add an action to a new price popup');f.el('makeFullVideo').click();assert.equal(f.d.activeElement.id,'personName');assert.match(f.el('status').textContent,/bestanden opnieuw/);assert.equal(f.el('trim').hidden,true);assert.equal(f.el('briefDialog').open,false);
  f.file('personInput','current.jpg','image/jpeg');f.el('makeFullVideo').click();assert.equal(f.d.activeElement.id,'motionName');
  const motion=f.file('motionInput','current.mp4','video/mp4');f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.change('duration',6);f.el('resultVideo').duration=5.94;f.prompt('Mijn huidige keuze.');
  f.el('makeFullVideo').click();assert.equal(f.d.activeElement.id,'duration');assert.match(f.el('status').textContent,/niet bewaard.*langere duur/);assert.equal(f.el('briefDialog').open,false);
  f.change('duration',12);f.el('makeFullVideo').click();assert.equal(f.el('briefDialog').open,true);assert.equal(f.el('motionInput').files[0],motion);assert.equal(f.el('editPrompt').value,'Mijn huidige keuze.');assert.match(f.el('briefError').textContent,/12 seconden.*apart afgerekend.*nieuwe prijs/);assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});

test('an older completed result cannot restore a draft while a newer job, intent or status request remains active',async()=>{
 for(const key of ['rig-generation-job','rig-generation-pending']){
  const storage=new Map([[key,key.endsWith('job')?'new-job':JSON.stringify({quoteId:'new-quote',idempotencyKey:'new-intent'})]]),f=fixture({storage,recentJob:{id:'older-result',state:'completed'}});
  try{f.load();f.prompt('Blijf bij deze nieuwe keuze.');await settle(()=>!f.el('makeFullVideo').hidden);assert.equal(f.el('makeFullVideo').disabled,true);f.el('makeFullVideo').dispatchEvent(new f.w.Event('click'));assert.equal(f.el('editPrompt').value,'Blijf bij deze nieuwe keuze.');assert.equal(f.el('briefDialog').open,false);assert.equal(f.calls.some(([p])=>p==='/api/assets'),false);}finally{f.dom.window.close();}
 }
 const f=fixture({recentJob:{id:'older-result',state:'completed'}});
 try{f.load();await settle(()=>!f.el('makeFullVideo').hidden);let release;const original=f.w.rigRequest;f.w.rigRequest=async(path,options)=>path==='/api/generations/older-result'?await new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({state:'completed',videoPath:'/api/generations/older-result/video'})});}):original(path,options);f.el('recentVideo').click();await settle(()=>release);assert.equal(f.el('makeFullVideo').disabled,true);f.el('makeFullVideo').dispatchEvent(new f.w.Event('click'));assert.equal(f.el('briefDialog').open,false);release();await settle(()=>!f.el('makeFullVideo').disabled);assert.equal(f.w.rigGenerationBusy(),false,'recent-result polling releases the continuation controls');}finally{f.dom.window.close();}
});

test('a reloaded completed trial retains settings but requires original files; asynchronous frame restoration cannot overwrite a new choice or session',async()=>{
 const first=fixture({verifiedDuration:null,jobState:'queued'});let saved,person,motion;
 try{
  first.load();person=first.file('personInput','original-4k.mp4','video/mp4');first.el('personVideo').dispatchEvent(new first.w.Event('loadedmetadata'));first.el('personVideo').dispatchEvent(new first.w.Event('loadeddata'));first.change('frameTime',12.5);first.el('frameTime').dispatchEvent(new first.w.Event('input'));first.el('captureMain').click();await settle(()=>!first.el('mainReference').hidden);motion=first.el('motionInput').files[0];first.el('editModeButton').click();first.change('duration',13);first.change('start',4.5);first.prompt('Oorspronkelijk portret en scène.');await finishShortTrial(first);saved=new Map(first.storage);
 }finally{first.dom.window.close();}
 for(const replacement of ['draft','session']){
  const f=fixture({storage:new Map(saved),recentJob:{id:'job-recast',state:'completed'}});
  try{
   await settle(()=>!f.el('makeFullVideo').hidden);f.el('makeFullVideo').click();assert.equal(f.d.activeElement.id,'personName');assert.equal(f.el('briefDialog').open,false);assert.match(f.el('status').textContent,/instellingen zijn bewaard/);
   const select=(id,file)=>{Object.defineProperty(f.el(id),'files',{configurable:true,value:[file]});f.el(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));};
   select('personInput',person);f.el('personVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.el('personVideo').dispatchEvent(new f.w.Event('loadeddata'));select('motionInput',motion);f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.prompt('Huidige, nieuw gekozen beschrijving.');
   let release;f.w.rigMedia.prepareImage=async()=>await new Promise(resolve=>{release=()=>resolve({blob:new Blob(['late-old-portrait'],{type:'image/jpeg'}),width:1280,height:720});});
   f.el('makeFullVideo').click();await settle(()=>release);
   if(replacement==='draft'){f.file('personInput','newest.jpg','image/jpeg');f.prompt('Nieuwste beschrijving.');}else{f.w.rigSessionActive=()=>false;f.w.rigGenerationDispose();}
   release();await settle(()=>f.el('makeFullVideo').hidden||!f.el('makeFullVideo').disabled);
   assert.equal(f.el('briefDialog').open,false);assert.equal(f.el('mainReference').hidden,true,'late old portrait bytes must not be committed');assert.notEqual(f.el('editPrompt').value,'Oorspronkelijk portret en scène.');assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generations'),false);
   if(replacement==='draft'){assert.equal(f.el('personName').textContent,'newest.jpg');assert.equal(f.el('editPrompt').value,'Nieuwste beschrijving.');}
  }finally{f.dom.window.close();}
 }
});

test('an explicitly captured main frame remembers its capture timestamp before asynchronous JPEG encoding',async()=>{
 const f=fixture({verifiedDuration:null,jobState:'queued'});
 try{
  f.load();f.file('personInput','phone-video.mp4','video/mp4');const source=f.el('personVideo');source.dispatchEvent(new f.w.Event('loadedmetadata'));source.dispatchEvent(new f.w.Event('loadeddata'));source.currentTime=12.5;
  let release;f.w.rigMedia.prepareImage=async()=>await new Promise(resolve=>{release=()=>resolve({blob:new Blob(['frame-at-12.5'],{type:'image/jpeg'}),width:1280,height:720});});f.el('captureMain').click();await settle(()=>release);source.currentTime=20;release();await settle(()=>!f.el('mainReference').hidden);
  f.el('editModeButton').click();f.change('duration',12);await finishShortTrial(f);const saved=JSON.parse(f.storage.get('rig-trial-continuation:v1'));assert.equal(saved.draft.mainSelection.time,12.5,'later preview seeks cannot relabel the frozen portrait');
  f.file('resultInput','different-local-result.mp4','video/mp4');assert.equal(f.el('makeFullVideo').hidden,true);assert.equal(f.el('makeFullFromResult').hidden,true);
 }finally{f.dom.window.close();}
});

test('explicitly reselected originals reconstruct a saved full draft after reload without saving original video or image bytes',async()=>{
 const first=fixture({verifiedDuration:null,jobState:'queued'});let saved,person,motion;
 try{
  first.load();person=first.file('personInput','reference-4k.mp4','video/mp4');first.el('personVideo').dispatchEvent(new first.w.Event('loadedmetadata'));first.el('personVideo').dispatchEvent(new first.w.Event('loadeddata'));first.el('frameTime').value='12.5';first.el('frameTime').dispatchEvent(new first.w.Event('input'));crop(first,'person',10,80);first.el('captureMain').click();await settle(()=>!first.el('mainReference').hidden);first.el('frameTime').value='18.5';first.el('frameTime').dispatchEvent(new first.w.Event('input'));motion=first.el('motionInput').files[0];first.el('editModeButton').click();first.change('duration',13);first.change('start',4.5);first.prompt('Deze scène blijft volledig bewaard.');await finishShortTrial(first);saved=new Map(first.storage);
 }finally{first.dom.window.close();}
 const f=fixture({storage:saved,recentJob:{id:'job-recast',state:'completed'},verifiedDuration:null});
 try{
  await settle(()=>!f.el('makeFullVideo').hidden);f.el('makeFullVideo').click();assert.equal(f.d.activeElement.id,'personName');
  for(const [id,file] of [['personInput',person],['motionInput',motion]]){Object.defineProperty(f.el(id),'files',{configurable:true,value:[file]});f.el(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));}
  f.el('personVideo').dispatchEvent(new f.w.Event('loadedmetadata'));f.el('personVideo').dispatchEvent(new f.w.Event('loadeddata'));f.el('motionVideo').dispatchEvent(new f.w.Event('loadedmetadata'));
  f.el('makeFullVideo').click();await settle(()=>f.el('briefDialog').open);
  assert.equal(f.el('duration').value,'13');assert.equal(f.el('start').value,'4.5');assert.equal(f.el('editPrompt').value,'Deze scène blijft volledig bewaard.');assert.equal(f.el('frameTime').value,'18.5');assert.equal(f.el('personVideo').currentTime,18.5);assert.equal(f.el('mainReference').hidden,false);assert.deepEqual(f.images[0].crop,{x:10,y:0,w:80,h:100});assert.equal(f.calls.some(([p])=>p==='/api/assets'||p==='/api/generations'),false);
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);assert.equal(f.w.rigPreparedMedia().selectedSeconds,13);assert.equal(f.w.rigPreparedMedia().image.blob,f.images[0].image.blob);assert.equal(f.videos[0][2],4.5);assert.equal(f.videos[0][3],13);
 }finally{f.dom.window.close();}
});

test('Motion continuation restores explicit Standard, audio, camera, crops and every retained identity reference without changing provider',async()=>{
 const f=fixture({verifiedDuration:null,jobState:'queued'});
 try{
  f.load();const standard=f.d.querySelector('input[name=quality][value=standard]');standard.checked=true;standard.dispatchEvent(new f.w.Event('change'));f.el('sound').checked=false;f.el('sound').dispatchEvent(new f.w.Event('change'));f.el('steady').checked=true;f.el('steady').dispatchEvent(new f.w.Event('change'));crop(f,'person',15,70);
  for(const id of ['captureMain','captureFace','captureAngle','captureAngle']){f.el(id).click();await settle(()=>!f.el(id).disabled);}
  const blobs=f.images.map(x=>x.image.blob);f.change('duration',20);f.change('start',2.5);f.prompt('De volledige dans in dezelfde stijl.');await finishShortTrial(f);assert.equal(f.videos[0][3],5);assert.equal(f.el('duration').value,'20');
  f.el('editModeButton').click();f.prompt('Een ander idee.');f.el('makeFullVideo').click();await settle(()=>f.el('briefDialog').open);
  assert.equal(f.w.rigGenerationQuality(),'standard');assert.equal(standard.checked,true);assert.equal(f.el('sound').checked,false);assert.equal(f.el('steady').checked,true);assert.equal(f.el('duration').value,'20');assert.equal(f.el('start').value,'2.5');assert.equal(f.el('editPrompt').value,'De volledige dans in dezelfde stijl.');
  f.el('confirmBrief').click();await settle(()=>f.el('uploadDialog').open);const media=f.w.rigPreparedMedia();assert.equal(media.quality,'standard');assert.equal(media.keepSound,false);assert.equal(media.steady,true);assert.equal(media.image.blob,blobs[0]);assert.equal(media.face,blobs[1]);assert.deepEqual([...media.angles],blobs.slice(2));assert.equal(f.videos.at(-1)[3],20);assert.equal(f.calls.filter(([p])=>p==='/api/generations').length,1);
 }finally{f.dom.window.close();}
});

test('status control visibly locks while one check runs, then disappears after completion without submitting a new generation',async()=>{
 const saved=new Map([['rig-generation-job','job-recast']]),f=fixture({storage:saved,jobState:'completed'});let release,checks=0;
 try{
  const original=f.w.rigRequest;f.w.rigRequest=(path,options)=>{if(path==='/api/generations/job-recast'){checks++;return new Promise(resolve=>release=()=>resolve(original(path,options)));}return original(path,options);};
  assert.equal(f.el('checkGeneration').hidden,false);f.el('checkGeneration').click();await settle(()=>checks===1);
  assert.equal(f.el('checkGeneration').disabled,true);assert.match(f.el('checkGeneration').textContent,/wordt gecontroleerd/);f.el('checkGeneration').click();assert.equal(checks,1);
  release();await settle(()=>f.el('checkGeneration').hidden&&!f.w.rigGenerationBusy());assert.equal(f.el('checkGeneration').disabled,false);assert.equal(f.storage.has('rig-generation-job'),false);assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
 }finally{f.dom.window.close();}
});

test('angle chooser requires a close-up and removing it preserves angles while blocking preparation until it is restored',async()=>{
 const f=fixture();try{
  f.load();assert.equal(f.el('anglesInput').disabled,true);assert.match(f.el('anglesChooseLabel').textContent,/eerst een close-up/);
  f.file('faceInput','face.jpg','image/jpeg');await settle(()=>!f.el('faceReference').hidden);assert.equal(f.el('anglesInput').disabled,false);
  f.file('anglesInput','angle.jpg','image/jpeg');await settle(()=>!f.el('angleReference0').hidden);f.el('removeFace').click();assert.equal(f.el('angleReference0').hidden,false);assert.equal(f.el('anglesInput').disabled,true);assert.equal(f.el('prepare').disabled,true);assert.equal(f.el('tryShortVideo').disabled,true);
  f.file('faceInput','new-face.jpg','image/jpeg');await settle(()=>!f.el('faceReference').hidden);assert.equal(f.el('angleReference0').hidden,false);assert.equal(f.el('prepare').disabled,false);
 }finally{f.dom.window.close();}
});
