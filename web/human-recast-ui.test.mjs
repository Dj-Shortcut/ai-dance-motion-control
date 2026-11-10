import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Recast UI did not settle');};
function fixture({qualities=['standard','pro','human-recast'],verifiedDuration=5.94}={}){
 const dom=new JSDOM(html,{url:'https://rig.example.chatgpt.site/',runScripts:'outside-only'}),w=dom.window,d=w.document,el=id=>d.getElementById(id),calls=[],images=[],videos=[],storage=new Map(),verifications=[],created=[],revoked=[];
 w.Blob=Blob;w.rigNativeSite=true;w.rigVideoEnabled=true;w.rigVideoFunding='owner-provider';w.rigVideoQualities=qualities;w.rigSessionActive=()=>true;
 w.URL.createObjectURL=blob=>{const url=`blob:fixture-${created.length}`;created.push({url,blob});return url;};w.URL.revokeObjectURL=url=>revoked.push(url);w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 for(const dialog of d.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;};}
 for(const video of d.querySelectorAll('video')){for(const [key,value] of Object.entries({duration:60,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,key,{configurable:true,writable:true,value});video.pause=()=>{};video.play=async()=>{};}
 w.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720;}set src(value){this.onload?.();}};
 w.rigMedia={bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async(source,crop)=>{const image={blob:new Blob(['image-'+images.length],{type:'image/jpeg'}),width:1280,height:720};images.push({source,crop:{...crop},image});return image;},prepareImageFile:async file=>({blob:new Blob(['prepared '+file.name],{type:'image/jpeg'}),width:1280,height:720}),prepareVideo:async(...args)=>{videos.push(args);return {blob:new Blob(['prepared-video'],{type:'video/mp4'}),duration:args[3],width:1280,height:720};}};
 w.rigScopedStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 w.rigOwnerVerification={prepare:async(operation,payload)=>{verifications.push({operation,payload});return null;}};
 let assets=0,quotes=0;
 w.rigRequest=async(path,options={})=>{
  calls.push([path,options]);let value;
  if(path==='/api/generations/recent')value={job:null};
  else if(path==='/api/assets')value={id:'asset'+(++assets),status:'ready',kind:options.headers['X-Rig-Asset-Kind']};
  else if(path==='/api/generation-quotes'){
   const input=JSON.parse(options.body),duration=verifiedDuration??Number(el('duration').value),id='quote'+(++quotes);
   value={id,quality:input.quality,funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:987654,durationSeconds:duration,billedSeconds:Math.ceil(duration),transferPolicy:input.transferPolicy,approvalToken:'t'.repeat(43),idempotencyKey:'approval-'+id};
  }else if(path==='/api/generations')value={id:'job-recast',state:'failed',funding:'owner-provider',providerEstimateUsdMicros:987654,finalizationConfirmed:true};
  else if(path.startsWith('/api/estimate/fal?')){const p=new URL(path,w.location.origin).searchParams,duration=Number(p.get('duration'));value={quality:p.get('quality'),durationSeconds:duration,billedSeconds:Math.ceil(duration),funding:'owner-provider',providerEstimate:{currency:'USD',usdMicros:987654,binding:false}};}
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
  assert.match(f.el('quoteMessage').textContent,/0,988.*6 seconden/);assert.match(f.el('quoteMessage').textContent,/24 uur/);assert.equal(f.el('quoteTitle').textContent,'In de video');assert.equal(f.calls.some(([p])=>p==='/api/generations'),false);
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
