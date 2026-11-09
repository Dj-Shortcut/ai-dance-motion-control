'use strict';
const $ = id => document.getElementById(id);
const urls = {};
let imageSource = null;
let personFile = null;
let motionFile = null;
let busy = false;
let prepared = null;
let cropTarget = null;
const modeStorageKey='rig-video-mode:v1';
function savedMode(){try{const value=window.rigScopedStorage?.getItem(modeStorageKey);return value==='motion'||value==='edit'?value:null;}catch{return null;}}
let videoMode=savedMode()??'motion',draftRevision=0;
const editUnavailableMessage='Videobewerking is nu niet beschikbaar. Kies zelf een ander videotype of probeer later opnieuw.';
const modeDurations={motion:null,edit:5};
const defaultPrompts={motion:"Laat de persoon of het dier op mijn foto de bewegingen uit de video natuurlijk nadoen. Behoud het uiterlijk van mijn foto.",edit:"Vervang de hoofdpersoon in de video door de persoon of het dier op mijn foto. Behoud de bewegingen, de timing, de achtergrond en de camera van de video."};
const modePrompts={...defaultPrompts};
const editing=()=>videoMode==='edit';
const availableQualities=()=>Array.isArray(window.rigVideoQualities)?window.rigVideoQualities:['standard','pro'];
const editAvailable=()=>availableQualities().includes('edit-standard');
const selectedQuality=()=>editing()?'edit-standard':document.querySelector('input[name="quality"]:checked')?.value;
const durationLimit=()=>editing()?15:30;
window.rigVideoMode=()=>videoMode;
window.rigGenerationQuality=selectedQuality;
// References are local snapshots until the user confirms a generation.
let mainReferenceBlob=null, faceReferenceBlob=null, angleReferenceBlobs=[], referenceRevision=0, referenceBusy=false;const thumbBlobs={};
function referenceThumb(id,blob){const angle=id.startsWith('angle'),item=$(angle?'angleReference'+id.slice(5):id+'Reference'),img=$(angle?'angleThumb'+id.slice(5):id+'Thumb');item.hidden=!blob;if(thumbBlobs[id]===blob)return;thumbBlobs[id]=blob;if(blob)img.src=setURL('ref-'+id,blob);else {if(typeof img.removeAttribute==='function')img.removeAttribute('src');else img.src='';if(urls['ref-'+id]){URL.revokeObjectURL(urls['ref-'+id]);delete urls['ref-'+id]}}}
function renderReferences(){$('referencePanel').hidden=editing()||!personFile;$('moreOptions').hidden=$('referencePanel').hidden;referenceThumb('main',mainReferenceBlob);referenceThumb('face',faceReferenceBlob);for(let i=0;i<3;i++)referenceThumb('angle'+i,angleReferenceBlobs[i]||null);$('captureAngle').disabled=busy||referenceBusy||editing()||!imageSource||!faceReferenceBlob||angleReferenceBlobs.length>=3;$('captureMain').disabled=busy||referenceBusy||editing()||!imageSource;$('captureFace').disabled=busy||referenceBusy||editing()||!imageSource;$('referenceHint').textContent=!personFile?.type.startsWith('video/')?'Voeg een close-up en andere hoeken toe.':!mainReferenceBlob?'Kies een beeld en zet het vast als hoofdbeeld.':!faceReferenceBlob?'Kies een close-up met de schuif.':angleReferenceBlobs.length<3?'Kies maximaal 3 hoeken met de schuif.':'Referenties klaar.'}
function clearReferences(){referenceRevision++;mainReferenceBlob=null;faceReferenceBlob=null;angleReferenceBlobs=[];$('faceInput').value='';$('anglesInput').value='';renderReferences();$('referenceStatus').textContent=''}
async function captureReference(kind){if(editing()||!imageSource||busy||referenceBusy||(kind==='angle'&&!faceReferenceBlob))return;referenceBusy=true;renderReferences();const revision=referenceRevision,source=imageSource,crop={...crops.person};try{const image=await window.rigMedia.prepareImage(source,crop);if(image.width<340||image.height<340||image.width/image.height<0.4||image.width/image.height>2.5)throw Error('Kies een duidelijk beeld van minstens 340 × 340 pixels.');if(revision!==referenceRevision)return;if(kind==='main')mainReferenceBlob=image.blob;else if(kind==='face')faceReferenceBlob=image.blob;else if(angleReferenceBlobs.length<3)angleReferenceBlobs.push(image.blob);invalidate();renderReferences();$('referenceStatus').textContent=kind==='main'?'Hoofdbeeld vastgezet':kind==='face'?'Close-up toegevoegd':'Hoek toegevoegd';}catch(error){$('referenceStatus').textContent=error.message||'Beeld vastleggen is mislukt.'}finally{referenceBusy=false;renderReferences()}}
for(const [id,kind] of [['captureMain','main'],['captureFace','face'],['captureAngle','angle']])$(id).addEventListener('click',()=>captureReference(kind));
$('removeMain').addEventListener('click',()=>{referenceRevision++;mainReferenceBlob=null;invalidate();renderReferences()});$('removeFace').addEventListener('click',()=>{referenceRevision++;faceReferenceBlob=null;$('faceInput').value='';invalidate();renderReferences()});
for(let i=0;i<3;i++)$('removeAngle'+i).addEventListener('click',()=>{referenceRevision++;angleReferenceBlobs.splice(i,1);$('anglesInput').value='';invalidate();renderReferences()});
const fullCrop = () => ({x:0,y:0,w:100,h:100});
const crops = { person: fullCrop(), motion: fullCrop() };
function mediaType(file){return typeof file?.type==='string'?file.type.split(';',1)[0].trim().toLowerCase():''}
function acceptsMedia(file,kind){const type=mediaType(file);return kind!=='video'&&['image/jpeg','image/png','image/webp'].includes(type)||kind!=='image'&&['video/mp4','video/quicktime','video/webm'].includes(type)}
function rejectMedia(input,file,kind,status='status'){if(acceptsMedia(file,kind))return false;input.value='';$(status).textContent=kind==='image'?'Kies een JPG-, PNG- of WebP-afbeelding.':kind==='video'?'Kies een MP4-, MOV- of WebM-video.':'Kies een JPG-, PNG-, WebP-, MP4-, MOV- of WebM-bestand.';return true}
function previewBlob(file){
 // A filename, accept filter or uploaded MIME label cannot make an active
 // document safe. Give preview/download URLs a literal, non-active media MIME;
 // even mislabeled HTML/SVG bytes can only fail media decoding, not run scripts.
 switch(mediaType(file)){
  case 'image/jpeg':return new Blob([file],{type:'image/jpeg'});
  case 'image/png':return new Blob([file],{type:'image/png'});
  case 'image/webp':return new Blob([file],{type:'image/webp'});
  case 'video/mp4':return new Blob([file],{type:'video/mp4'});
  case 'video/quicktime':return new Blob([file],{type:'video/quicktime'});
  case 'video/webm':return new Blob([file],{type:'video/webm'});
  default:throw Error('Dit bestandstype kan niet veilig worden geopend.');
 }
}
function setURL(key,file){const blob=previewBlob(file),url=URL.createObjectURL(blob);if(urls[key]) URL.revokeObjectURL(urls[key]);urls[key]=url;return url}
function showError(text){$('status').textContent=text}
function invalidate(){draftRevision++;document.dispatchEvent(new Event('rig-prepared-change'));prepared=null;$('previewPrepared').hidden=true;if(urls.prepared){URL.revokeObjectURL(urls.prepared);delete urls.prepared}refreshButton()}
// Server capability controls the interface; the server enforces authorization.
function refreshButton(){const enabled=window.rigVideoEnabled===true&&window.rigSessionActive?.()===true&&availableQualities().includes(selectedQuality());const promptReady=$('editPrompt').value.trim().length>0;$('prepare').disabled=!enabled||busy||!imageSource||!motionFile;$('prepare').textContent=enabled?(prepared?'Verder':'Maak video'):'Nog niet beschikbaar';$('confirmBrief').disabled=!enabled||busy||!promptReady;$('confirmBrief').textContent=prepared?'Verder':'Bekijk de prijs';$('motionModeButton').disabled=busy||!availableQualities().some(q=>q==='standard'||q==='pro');$('editModeButton').disabled=busy||!editAvailable();}
function updateModeUi(){
 const edit=editing(),showModes=edit||editAvailable();$('sourceCameraNote').hidden=!edit;$('videoModePanel').hidden=!showModes;$('videoModeTabs').hidden=!showModes;$('briefTitle').textContent=edit?'Video bewerken':'Persoon laten bewegen';$('motionModeButton').setAttribute('aria-pressed',String(!edit));$('editModeButton').setAttribute('aria-pressed',String(edit));
 $('videoModeHint').textContent=edit?(editAvailable()?'Je foto vervangt een persoon of dier in de video. De rest van de video blijft hetzelfde.':editUnavailableMessage):'Werkt het best met een duidelijk zichtbaar lichaam.';
 $('editPromptPanel').hidden=false;$('editPrompt').required=true;$('promptLabel').textContent=edit?'Wat wil je veranderen?':'Wat wil je maken?';$('editPrompt').placeholder=edit?'Vervang de zanger door het personage op mijn foto.':'Beschrijf het resultaat dat je wilt.';$('motionQualitySettings').hidden=edit;$('steadyOption').hidden=edit;$('backgroundOption').hidden=true;$('settingsNote').hidden=true;
 $('personChooseText').textContent=edit?'Kies een foto':'Kies een foto of video';$('personRole').textContent='Foto';$('motionChooseText').textContent='Kies een video';$('motionRole').textContent='Video';$('soundLabel').textContent=edit?'Geluid van de bronvideo behouden':'Geluid van de bewegingsvideo behouden';
 $('personInput').accept=edit?'image/jpeg,image/png,image/webp':'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm';$('trialDurationNote').textContent=edit?'(3–15 s · begin met 5 s)':'(3–30 s)';
 $('settingsNote').textContent=edit?'Gebruik een duidelijke referentiefoto. Beoordeel eerst een korte proef.':'Referenties worden pas na je bevestiging naar fal.ai gestuurd. Achtergrond vervangen is nog niet beschikbaar in de webversie.';
 if($('status').textContent===editUnavailableMessage&&(!edit||editAvailable()))showError('Kies een foto en een video.');
 renderReferences();refreshButton();renderIdeas();
}
function setMode(next){
 if(busy||!['motion','edit'].includes(next)||next==='edit'&&!editAvailable()||next==='motion'&&!availableQualities().some(q=>q==='standard'||q==='pro'))return;
 // Only a deliberate choice writes this preference, through the existing
 // account-bound storage. Files and descriptions remain in memory only.
 try{window.rigScopedStorage?.setItem(modeStorageKey,next);}catch{}
 if(next===videoMode)return;
 modeDurations[videoMode]=Number($('duration').value);modePrompts[videoMode]=$('editPrompt').value;videoMode=next;$('editPrompt').value=modePrompts[next];if(editing())$('sound').checked=true;
 const max=motionFile?Math.min(durationLimit(),Math.floor($('motionVideo').duration)):durationLimit();$('duration').max=String(max);$('duration').value=String(Math.max(3,Math.min(max,modeDurations[next]??max)));$('duration').setCustomValidity('');
 const startMax=updateStartMax();if(startMax!==null&&Number($('start').value)>startMax)applyStart(startMax);
 invalidate();updateModeUi();document.dispatchEvent(new Event('rig-generation-mode-change'));
}
function updateCapabilities(){
 for(const radio of document.querySelectorAll('input[name=quality]'))radio.disabled=!availableQualities().includes(radio.value);
 const selected=document.querySelector('input[name=quality]:checked');if(selected?.disabled){const first=[...document.querySelectorAll('input[name=quality]')].find(input=>!input.disabled);if(first)first.checked=true;}
 if(editing()&&!editAvailable()){invalidate();showError(editUnavailableMessage);}
 updateModeUi();
}
$('motionModeButton').addEventListener('click',()=>setMode('motion'));$('editModeButton').addEventListener('click',()=>setMode('edit'));
// Idea tiles only preset the video type and description; files stay the user's own choice.
function renderIdeas(){const prompt=$('editPrompt').value;let visible=0;for(const tile of document.querySelectorAll('[data-idea-mode]')){const mode=tile.dataset.ideaMode,available=mode==='edit'?editAvailable():availableQualities().some(q=>q==='standard'||q==='pro');tile.hidden=!available;tile.disabled=busy;if(available)visible++;tile.setAttribute('aria-pressed',String(available&&mode===videoMode&&tile.dataset.ideaPrompt===prompt));}const panel=document.querySelector('.ideas-panel');if(panel)panel.hidden=visible===0;}
function chooseIdea(tile){if(busy)return;const mode=tile.dataset.ideaMode;setMode(mode);if(videoMode!==mode)return;$('editPrompt').value=tile.dataset.ideaPrompt;modePrompts[videoMode]=tile.dataset.ideaPrompt;invalidate();renderIdeas();showError(!personFile?'Idee gekozen. Kies nu een foto.':!motionFile?'Idee gekozen. Kies nu een video.':'Idee gekozen. Druk op Maak video.');if(!personFile)$('personStepTitle').scrollIntoView?.({behavior:'smooth',block:'start'});}
for(const tile of document.querySelectorAll('[data-idea-mode]'))tile.addEventListener('click',()=>chooseIdea(tile));
const promptChanged=()=>{modePrompts[videoMode]=$('editPrompt').value;invalidate();renderIdeas();};
$('editPrompt').addEventListener('input',promptChanged);$('editPrompt').addEventListener('change',promptChanged);
document.addEventListener('rig-video-availability',updateCapabilities);
for(const [button,input] of [['personChoose','personInput'],['personName','personInput'],['motionChoose','motionInput'],['motionName','motionInput'],['resultName','resultInput']]) $(button).addEventListener('click',()=>$(input).click());
$('previewPrepared').addEventListener('click',()=>{if(!prepared||!urls.prepared)return;$('preparedVideo').src=urls.prepared;$('downloadPrepared').href=urls.prepared;$('preparedDialog').showModal()});
$('preparedDialog').addEventListener('close',()=>$('preparedVideo').pause());
$('settingsToggle').addEventListener('click',()=>{$('settings').showModal();$('settingsToggle').setAttribute('aria-expanded','true')});
$('settings').addEventListener('close',()=>$('settingsToggle').setAttribute('aria-expanded','false'));
function drawImage(source){const c=$('personFrame'); const w=source.videoWidth||source.naturalWidth; const h=source.videoHeight||source.naturalHeight;if(!w||!h)return;imageSource=source;window.rigMedia.paint(c,source,crops.person,1280,1280);c.hidden=false;$('personChoose').hidden=true;$('personCropButton').hidden=false;refreshButton();renderReferences()}
$('personInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,editing()?'image':'media'))return;personFile=file;imageSource=null;crops.person=fullCrop();clearReferences();invalidate();$('referencePanel').hidden=editing();$('referenceCapture').hidden=!file.type.startsWith('video/');const url=setURL('person',file);$('personName').textContent=file.name;$('personName').title=file.name;$('frameControl').hidden=true;$('personFrame').hidden=true;$('personCropButton').hidden=true;if(file.type.startsWith('video/')){const video=$('personVideo');video.src=url;video.onloadedmetadata=()=>{if(!Number.isFinite(video.duration)||video.duration<=0){showError('Deze video kon niet worden gelezen.');return}$('frameTime').max=Math.max(0,video.duration-0.01);$('frameTime').value=0;$('frameOutput').textContent='0.0 s';$('frameControl').hidden=false;video.currentTime=Math.min(0.01,video.duration)};video.onseeked=()=>drawImage(video);video.onloadeddata=()=>drawImage(video);video.onerror=()=>showError('Deze video kan niet worden geopend in je browser.')}else{let image=new Image();image.onload=()=>{if(personFile===file)drawImage(image)};image.onerror=()=>{if(personFile===file)showError('Deze afbeelding kan niet worden geopend.')};image.src=url}showError(motionFile?'Klaar? Druk op Maak video.':'Kies nu een video.')});
$('frameTime').addEventListener('input',event=>{const time=Number(event.target.value);$('frameOutput').textContent=`${time.toFixed(1)} s`;imageSource=null;invalidate();$('personVideo').currentTime=time;if(!$('personVideo').seeking)drawImage($('personVideo'))});
$('motionInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'video'))return;motionFile=null;crops.motion=fullCrop();invalidate();$('motionCropped').hidden=true;$('motionCropControls').hidden=true;const video=$('motionVideo');video.pause();video.src=setURL('motion',file);video.hidden=false;$('motionChoose').hidden=true;$('motionName').textContent=file.name;$('motionName').title=file.name;video.onloadedmetadata=()=>{if(motionFile===file)return;if(!Number.isFinite(video.duration)||video.duration<3){showError('Kies een video van minstens 3 seconden.');return}motionFile=file;$('trim').hidden=false;$('start').value=0;$('start').max=Math.max(0,Math.floor((video.duration-3)*10+1e-7)/10);$('duration').setCustomValidity('');modeDurations.motion=null;modeDurations.edit=5;$('duration').max=Math.min(durationLimit(),Math.floor(video.duration));$('duration').value=editing()?String(Math.min(5,Number($('duration').max))):$('duration').max;updateStartMax();$('motionSeek').max=video.duration;updateMotionPreview();$('motionCropButton').hidden=false;refreshButton()};video.onerror=()=>showError('Deze video kan niet worden geopend in je browser.');showError(personFile?'Klaar? Druk op Maak video.':'Kies nu een foto.')});
for(const id of ['start','duration'])$(id).addEventListener('focus',e=>e.target.select());function updateStartMax(){const v=$('motionVideo'),duration=Number($('duration').value);if(!Number.isFinite(v.duration)||!Number.isInteger(duration)||duration<3||duration>durationLimit())return null;const max=Math.max(0,Math.floor((v.duration-duration)*10+1e-7)/10);$('start').max=String(max);return max}function applyStart(value){const v=$('motionVideo'),max=updateStartMax();if(max===null||!Number.isFinite(value))return;const start=Math.min(max,Math.max(0,value));$('start').value=String(start);v.currentTime=start} $('start').addEventListener('change',()=>{if($('start').value!=='')applyStart(Number($('start').value));invalidate()});$('useCurrentStart').addEventListener('click',()=>{const v=$('motionVideo');if(!Number.isFinite(v.currentTime)||!Number.isFinite(v.duration))return;$('start').value=String(Math.floor(v.currentTime*10)/10);$('start').dispatchEvent(new Event('change',{bubbles:true}));});$('duration').addEventListener('change',()=>{const input=$('duration'),value=Number(input.value),max=Number(input.max);if(!Number.isInteger(value)||value<3||value>durationLimit()||value>max){const msg=`Kies voor deze privétest een duur van 3 tot ${Math.min(durationLimit(),max)} seconden.`;showError(msg);input.setCustomValidity(msg)}else{input.setCustomValidity('');const startMax=updateStartMax();if(startMax!==null&&Number($('start').value)>startMax)applyStart(startMax)}invalidate()});$('sound').addEventListener('change',invalidate);$('steady').addEventListener('change',invalidate);for(const r of document.querySelectorAll('input[name=quality]'))r.addEventListener('change',invalidate);
$('resultInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'video'))return;const url=setURL('result',file);$('resultVideo').src=url;$('resultVideo').hidden=false;$('resultEmpty').hidden=true;$('resultName').textContent=file.name;$('export').href=url;$('export').download=file.name;$('export').hidden=false});
$('backgroundInput').addEventListener('change',e=>{$('backgroundName').textContent=e.target.files[0]?.name||'Nog niet beschikbaar';invalidate()});
$('faceInput').addEventListener('change',e=>{const file=e.target.files[0];if(file&&rejectMedia(e.target,file,'image','referenceStatus'))return;referenceRevision++;faceReferenceBlob=file||null;invalidate();renderReferences();$('referenceStatus').textContent=faceReferenceBlob?'Close-up toegevoegd':''});
$('anglesInput').addEventListener('change',e=>{const files=[...e.target.files];if(files.some(file=>rejectMedia(e.target,file,'image','referenceStatus')))return;referenceRevision++;if(files.length+angleReferenceBlobs.length>3){e.target.value='';$('referenceStatus').textContent='Kies maximaal 3 hoeken';return}angleReferenceBlobs.push(...files);e.target.value='';invalidate();renderReferences();$('referenceStatus').textContent=files.length?'Hoeken toegevoegd':''});
function cropValues(){return {x:Number($('cropX').value),y:Number($('cropY').value),w:Number($('cropW').value),h:Number($('cropH').value)}}
function cropSource(){return cropTarget==='person'?imageSource:$('motionVideo')}
function previewCrop(){try{const canvas=$('cropPreview'),selection=$('cropSelection'),crop=window.rigMedia.bounds(cropValues());window.rigMedia.dimensions(cropSource(),crop,1280,1280);window.rigMedia.paint(canvas,cropSource(),fullCrop(),640,360);if(canvas.width>0&&canvas.height>0)$('cropStage').style.width=`min(100%, ${Math.floor(260*canvas.width/canvas.height)}px)`;Object.assign(selection.style,{left:`${crop.x}%`,top:`${crop.y}%`,width:`${crop.w}%`,height:`${crop.h}%`});$('cropError').textContent='';$('applyCrop').disabled=false}catch(e){$('cropError').textContent=e.message;$('applyCrop').disabled=true}}
for(const [id,target] of [['personCropButton','person'],['motionCropButton','motion']])$(id).addEventListener('click',()=>{cropTarget=target;for(const k of ['x','y','w','h'])$('crop'+k.toUpperCase()).value=crops[target][k];$('cropTitle').textContent=target==='person'?'Jouw beeld uitsnijden':'Beweging uitsnijden';$('cropDialog').showModal();previewCrop()});
for(const k of ['X','Y','W','H'])$('crop'+k).addEventListener('input',previewCrop);
// Crop coordinates are percentages of the visible full source, not the viewport.
// Pointer capture keeps mouse/touch drags stable outside the selection.
function adjustedCrop(initial,handle,dx,dy){
 const source=cropSource(),width=source.videoWidth||source.naturalWidth||source.width,height=source.videoHeight||source.naturalHeight||source.height;
 if(!width||!height)return initial;
 const minW=Math.min(100,Math.ceil(6400/width)),minH=Math.min(100,Math.ceil(6400/height));
 let left=initial.x,top=initial.y,right=initial.x+initial.w,bottom=initial.y+initial.h;
 const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
 dx=Math.round(dx);dy=Math.round(dy);
 if(handle==='move'){const x=clamp(left+dx,0,100-initial.w),y=clamp(top+dy,0,100-initial.h);return{x,y,w:initial.w,h:initial.h}}
 if(handle.includes('w'))left=clamp(left+dx,0,right-minW);
 if(handle.includes('e'))right=clamp(right+dx,left+minW,100);
 if(handle.includes('n'))top=clamp(top+dy,0,bottom-minH);
 if(handle.includes('s'))bottom=clamp(bottom+dy,top+minH,100);
 return{x:left,y:top,w:right-left,h:bottom-top};
}
function setCropFields(crop){for(const k of ['x','y','w','h'])$('crop'+k.toUpperCase()).value=crop[k];previewCrop()}
let cropDrag=null;
$('cropStage').addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-crop-handle]')?.dataset.cropHandle;if(!['move','nw','ne','sw','se'].includes(handle))return;const rect=$('cropStage').getBoundingClientRect();if(!rect.width||!rect.height)return;cropDrag={handle,initial:cropValues(),x:e.clientX,y:e.clientY,width:rect.width,height:rect.height,pointerId:e.pointerId};$('cropStage').setPointerCapture(e.pointerId);e.preventDefault()});
$('cropStage').addEventListener('pointermove',e=>{if(!cropDrag||cropDrag.pointerId!==e.pointerId)return;setCropFields(adjustedCrop(cropDrag.initial,cropDrag.handle,(e.clientX-cropDrag.x)*100/cropDrag.width,(e.clientY-cropDrag.y)*100/cropDrag.height));e.preventDefault()});
for(const type of ['pointerup','pointercancel','lostpointercapture'])$('cropStage').addEventListener(type,e=>{if(cropDrag?.pointerId===e.pointerId)cropDrag=null});
$('cropStage').addEventListener('keydown',e=>{const handle=e.target.closest('[data-crop-handle]')?.dataset.cropHandle;if(!['nw','ne','sw','se'].includes(handle))return;const step=e.shiftKey?5:1,delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];if(!delta)return;setCropFields(adjustedCrop(cropValues(),handle,...delta));e.preventDefault()});
$('resetCrop').addEventListener('click',()=>{for(const [k,v] of Object.entries(fullCrop()))$('crop'+k.toUpperCase()).value=v;previewCrop()});
function motionHasCrop(){const c=crops.motion;return c.x!==0||c.y!==0||c.w!==100||c.h!==100}
let motionAnimation=0;
function updateMotionPreview(){const v=$('motionVideo'),active=!!motionFile&&motionHasCrop();$('motionCropped').hidden=!active;$('motionCropControls').hidden=!active;v.hidden=active||!motionFile;if(active&&v.readyState>=2){try{window.rigMedia.paint($('motionCropped'),v,crops.motion,1280,1280)}catch{}}$('motionSeek').value=Number.isFinite(v.currentTime)?v.currentTime:0;$('motionTime').textContent=`${(v.currentTime||0).toFixed(1)} s`;$('motionPlay').textContent=v.paused?'▶ Afspelen':'❚❚ Pauzeren'}
function animateMotionPreview(){cancelAnimationFrame(motionAnimation);if(!$('motionVideo').paused&&motionHasCrop()){updateMotionPreview();motionAnimation=requestAnimationFrame(animateMotionPreview)}}
$('motionPlay').addEventListener('click',async()=>{const v=$('motionVideo');if(v.paused){try{await v.play()}catch{showError('De video kon niet worden afgespeeld.')}}else v.pause()});
$('motionSeek').addEventListener('input',e=>{$('motionVideo').currentTime=Number(e.target.value)});
for(const event of ['seeked','pause','loadeddata'])$('motionVideo').addEventListener(event,updateMotionPreview);
$('motionVideo').addEventListener('timeupdate',updateMotionPreview);
$('motionVideo').addEventListener('play',()=>{updateMotionPreview();animateMotionPreview()});
$('applyCrop').addEventListener('click',()=>{try{window.rigMedia.bounds(cropValues());crops[cropTarget]=cropValues();$('cropDialog').close();invalidate();if(cropTarget==='person'&&imageSource)drawImage(imageSource);else if(cropTarget==='motion')updateMotionPreview();showError(!editing()&&cropTarget==='person'&&mainReferenceBlob?'Uitsnede gekozen. Zet het hoofdbeeld opnieuw vast als je deze uitsnede wilt gebruiken.':'Uitsnede gekozen. Bereid de beelden opnieuw voor.')}catch(e){$('cropError').textContent=e.message}});
async function prepareWithPrompt(){
 if(window.rigVideoEnabled!==true||window.rigSessionActive?.()!==true||busy||!imageSource||!motionFile)return;
 const edit=editing(),quality=selectedQuality(),prompt=$('editPrompt').value.trim();
 if(!availableQualities().includes(quality)){showError('Deze videobewerking is momenteel niet beschikbaar.');return;}
 if(!prompt){showError(edit?'Beschrijf wat je in de video wilt veranderen.':'Beschrijf wat je wilt maken.');$('editPrompt').reportValidity?.();$('editPrompt').focus();return;}
 if(prompt.length>1900){showError('Houd je beschrijving korter dan 1900 tekens.');return;}
 modePrompts[videoMode]=$('editPrompt').value;
 if(prepared&&prepared.prompt===prompt&&prepared.quality===quality){$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));return;}
 $('briefDialog').close();busy=true;const disabledBefore=new Map();for(const el of document.querySelectorAll('button,input,textarea')){disabledBefore.set(el,el.disabled);el.disabled=true;}
 refreshButton();invalidate();const revision=draftRevision;
 try{
  const start=Number($('start').value),duration=Number($('duration').value),limit=edit?15:30;
  if(!edit&&personFile?.type.startsWith('video/')&&(faceReferenceBlob||angleReferenceBlobs.length)&&!mainReferenceBlob)throw Error('Zet eerst je hoofdbeeld vast.');
  if(!Number.isInteger(duration)||duration<3||duration>limit||duration>Number($('duration').max))throw Error(`Kies voor deze privétest een duur van 3 tot ${limit} seconden.`);
  showError('Beeld voorbereiden…');const image=!edit&&mainReferenceBlob?{blob:mainReferenceBlob}:await window.rigMedia.prepareImage(imageSource,crops.person);
  showError('Video voorbereiden…');
  const progress=p=>showError(`Video voorbereiden… ${Math.round(p*100)}%`);
  const video=edit?await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress,{minSide:720,maxDuration:15}):await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress);
  if(revision!==draftRevision||editing()!==edit||window.rigSessionActive?.()!==true)throw Error('Je instellingen zijn gewijzigd. Bereid je beelden opnieuw voor.');
  prepared={image,video,face:edit?null:faceReferenceBlob,angles:edit?[]:[...angleReferenceBlobs],quality,keepSound:$('sound').checked,steady:edit?false:$('steady').checked,prompt};
  setURL('prepared',video.blob);$('previewPrepared').hidden=false;showError('Beelden lokaal voorbereid.');document.dispatchEvent(new Event('rig-prepared-ready'));
 }catch(e){showError(e.message||'Voorbereiden is mislukt.');}
 finally{for(const [el,wasDisabled] of disabledBefore)el.disabled=wasDisabled;busy=false;updateCapabilities();}
}
$('prepare').addEventListener('click',()=>{if($('prepare').disabled||busy)return;refreshButton();$('briefDialog').showModal();$('editPrompt').focus();});
$('confirmBrief').addEventListener('click',prepareWithPrompt);
$('closeBrief').addEventListener('click',()=>$('briefDialog').close());
// Stable handoff for the future authenticated uploader; no automatic uploads.
window.rigPreparedMedia = () => prepared;
window.addEventListener('pagehide',()=>Object.values(urls).forEach(URL.revokeObjectURL));

$('editPrompt').value=modePrompts[videoMode];$('duration').max=String(durationLimit());if(editing())$('duration').value='5';
updateCapabilities();
