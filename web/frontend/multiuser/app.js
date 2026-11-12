'use strict';
const $ = id => document.getElementById(id);
const urls = {};
let imageSource = null;
let personFile = null;
let motionFile = null, motionLoadingFile = null;
let busy = false;
let prepared = null;
let cropTarget = null;
let cleanupReview=null,cleanupEpoch=0,cleanupWork=false,returnBriefFromCrop=false;
let cleanupModulePromise=null;
const cleanupBinding=()=>({request:window.rigRequest,active:window.rigSessionActive,storage:window.rigScopedStorage});
const loadCleanup=()=>cleanupModulePromise??=(typeof window.rigLoadCleanupModule==='function'?window.rigLoadCleanupModule():import('/multiuser/cleanup-client.js')).catch(error=>{cleanupModulePromise=null;throw error;});
function cleanupAvailable(){const c=window.rigVideoCleanup;return recasting()&&window.rigVideoFunding==='owner-provider'&&window.rigVideoMode==='live'&&c?.enabled===true&&c.version==='owner-cleanup-v1'&&c.quality==='human-recast'&&c.maxDurationSeconds===15&&['VideoEncoder','VideoDecoder','AudioEncoder','AudioDecoder','Worker'].every(k=>typeof window[k]==='function')&&typeof window.crypto?.subtle?.digest==='function';}
function disposeCleanup(){cleanupEpoch++;cleanupReview?.client?.dispose();cleanupReview?.editor?.dispose();if(cleanupReview?.canvas)cleanupReview.canvas.width=cleanupReview.canvas.height=1;cleanupReview=null;for(const name of ['cleanupSource','cleanupMask'])if(urls[name]){URL.revokeObjectURL(urls[name]);delete urls[name];}for(const name of ['cleanupSourcePreview','cleanupMaskPreview']){const v=$(name);v?.pause();v?.removeAttribute('src');}if($('cleanupReview'))$('cleanupReview').hidden=true;if($('cleanupMaskFigure'))$('cleanupMaskFigure').hidden=true;}
window.rigCleanupDispose=()=>{disposeCleanup();if(prepared?.cleanup){prepared=null;$('previewPrepared').hidden=true;if(urls.prepared){URL.revokeObjectURL(urls.prepared);delete urls.prepared;}document.dispatchEvent(new Event('rig-prepared-change'));}$('cleanupEnabled').checked=false;};

const modeStorageKey='rig-video-mode:v1';
function savedMode(){try{const value=window.rigScopedStorage?.getItem(modeStorageKey);return value==='motion'||value==='edit'?value:null;}catch{return null;}}
let videoMode=savedMode()??'motion',draftRevision=0;
const qualityUnavailableMessage='Je gekozen kwaliteit is nu niet beschikbaar. Kies zelf een kwaliteit in Instellingen.';
const editUnavailableMessage='Videobewerking is nu niet beschikbaar. Kies zelf een ander videotype of probeer later opnieuw.';
const modeDurations={motion:null,edit:5,'human-recast':6};
const modeSound={motion:true,edit:true,'human-recast':true};
let selectedEditQuality=null;
const defaultPrompts={motion:"Laat de persoon op mijn foto de bewegingen uit de video natuurlijk nadoen. Behoud het uiterlijk van mijn foto.",edit:"Vervang de hoofdpersoon in de video door de persoon of het dier op mijn foto. Behoud de bewegingen, de timing, de achtergrond en de camera van de video."};
const modePrompts={...defaultPrompts,'human-recast':'Vervang de persoon in de video door de persoon op mijn foto.'};
const editing=()=>videoMode==='edit';
const availableQualities=()=>Array.isArray(window.rigVideoQualities)?window.rigVideoQualities:['standard','pro'];
const editAvailable=()=>availableQualities().some(q=>q==='edit-standard'||q==='human-recast');
const preferredEditQuality=()=>availableQualities().includes('human-recast')?'human-recast':'edit-standard';
const selectedQuality=()=>editing()?(selectedEditQuality??'edit-standard'):document.querySelector('input[name="quality"]:checked')?.value;
const recasting=()=>editing()&&selectedQuality()==='human-recast';
const modeKey=()=>recasting()?'human-recast':videoMode;
const durationLimit=()=>editing()?15:30;
const durationMinimum=()=>recasting()?6:3;
const trialSeconds=()=>recasting()?6:5;
const recastFrameHint='Kies een beeld van jezelf en zet het vast als hoofdbeeld.';
const needsRecastFrame=()=>recasting()&&personFile?.type.startsWith('video/')&&!mainReferenceBlob;
const angleLimit=()=>editing()?2:3;
window.rigVideoMode=()=>videoMode;
window.rigGenerationQuality=selectedQuality;
// References are local snapshots until the user confirms a generation.
let mainReferenceSelection=null;
let mainReferenceBlob=null, faceReferenceBlob=null, angleReferenceBlobs=[], referenceRevision=0;const referenceWork={capture:null,face:null,angles:null},thumbBlobs={};
const referencesBusy=()=>Object.values(referenceWork).some(Boolean);
const missingAngleCloseup=()=>!recasting()&&angleReferenceBlobs.length>0&&!faceReferenceBlob;
function referenceThumb(id,blob){const angle=id.startsWith('angle'),item=$(angle?'angleReference'+id.slice(5):id+'Reference'),img=$(angle?'angleThumb'+id.slice(5):id+'Thumb');item.hidden=!blob;if(thumbBlobs[id]===blob)return;thumbBlobs[id]=blob;if(blob)img.src=setURL('ref-'+id,blob);else {if(typeof img.removeAttribute==='function')img.removeAttribute('src');else img.src='';if(urls['ref-'+id]){URL.revokeObjectURL(urls['ref-'+id]);delete urls['ref-'+id]}}}
function renderReferences(){
 const recast=recasting(),limit=angleLimit();$('referencePanel').hidden=!personFile;$('moreOptions').hidden=$('referencePanel').hidden;
 $('referenceOptionsTitle').textContent=recast?'Hoofdbeeld kiezen':'Meer opties: close-up en hoeken';$('referenceFiles').hidden=recast;$('recastReferenceNote').hidden=!recast;
 referenceThumb('main',mainReferenceBlob);referenceThumb('face',faceReferenceBlob);for(let i=0;i<3;i++)referenceThumb('angle'+i,angleReferenceBlobs[i]||null);
 if(recast){$('faceReference').hidden=true;for(let i=0;i<3;i++)$('angleReference'+i).hidden=true;}
 $('captureFace').hidden=recast;$('captureAngle').hidden=recast;
 $('captureAngle').disabled=recast||busy||referencesBusy()||!imageSource||!faceReferenceBlob||angleReferenceBlobs.length>=limit;
 $('anglesInput').disabled=recast||busy||referencesBusy()||!faceReferenceBlob||angleReferenceBlobs.length>=limit;$('anglesChooseLabel').setAttribute?.('aria-disabled',String($('anglesInput').disabled));$('anglesChooseLabel').textContent=faceReferenceBlob?'Kies hoeken':'Voeg eerst een close-up toe';$('anglesChooseLabel').style.opacity=$('anglesInput').disabled?'.55':'1';
 $('captureMain').disabled=busy||referencesBusy()||!imageSource;$('captureFace').disabled=recast||busy||referencesBusy()||!imageSource;
 $('referenceHint').textContent=recast?'Alleen je hoofdbeeld wordt gebruikt.':!personFile?.type.startsWith('video/')?'Voeg een close-up en andere hoeken toe.':!mainReferenceBlob?'Kies een beeld en zet het vast als hoofdbeeld.':!faceReferenceBlob?(angleReferenceBlobs.length?'Voeg opnieuw een close-up toe; je hoeken blijven bewaard.':'Kies een close-up met de schuif.'):angleReferenceBlobs.length>limit?`Kies maximaal ${limit} hoeken voor deze bewerking.`:angleReferenceBlobs.length<limit?`Kies maximaal ${limit} hoeken met de schuif.`:'Referenties klaar.';
}
function clearReferences(){referenceRevision++;for(const key of Object.keys(referenceWork))referenceWork[key]=null;mainReferenceBlob=null;mainReferenceSelection=null;faceReferenceBlob=null;angleReferenceBlobs=[];$('faceInput').value='';$('anglesInput').value='';renderReferences();$('referenceStatus').textContent=''}
async function captureReference(kind){
 if(!imageSource||busy||referencesBusy()||recasting()&&kind!=='main'||kind==='angle'&&(!faceReferenceBlob||angleReferenceBlobs.length>=angleLimit()))return;
 const token={};referenceWork.capture=token;invalidate();renderReferences();
 const revision=referenceRevision,source=imageSource,crop={...crops.person},selectionTime=personFile?.type.startsWith('video/')?source.currentTime:null;
 try{
  const image=await window.rigMedia.prepareImage(source,crop);
  if(image.width<340||image.height<340||image.width/image.height<0.4||image.width/image.height>2.5)throw Error('Kies een duidelijk beeld van minstens 340 × 340 pixels.');
  if(revision!==referenceRevision||referenceWork.capture!==token)return;
  if(kind==='main'){mainReferenceBlob=image.blob;mainReferenceSelection={time:selectionTime,crop:{...crop}};}else if(kind==='face')faceReferenceBlob=image.blob;else if(angleReferenceBlobs.length<angleLimit())angleReferenceBlobs.push(image.blob);
  invalidate();renderReferences();$('referenceStatus').textContent=kind==='main'?'Hoofdbeeld vastgezet':kind==='face'?'Close-up toegevoegd':'Hoek toegevoegd';if(recasting()&&kind==='main')showError(motionFile?'Hoofdbeeld vastgezet. Druk op Maak video.':'Hoofdbeeld vastgezet. Kies nu een video.');
 }catch(error){if(referenceWork.capture===token)$('referenceStatus').textContent=error.message||'Beeld vastleggen is mislukt.';}
 finally{if(referenceWork.capture===token)referenceWork.capture=null;renderReferences();refreshButton();}
}
async function importReferences(kind,files){
 if(busy||recasting()||!files.length)return;
 const input=$(kind==='face'?'faceInput':'anglesInput');
 if(files.some(file=>rejectMedia(input,file,'image','referenceStatus')))return;
 if(kind==='angles'&&files.length+angleReferenceBlobs.length>angleLimit()){input.value='';$('referenceStatus').textContent=`Kies maximaal ${angleLimit()} hoeken`;return;}
 const token={},source=personFile;referenceRevision++;referenceWork.capture=null;referenceWork[kind]=token;invalidate();renderReferences();
 $('referenceStatus').textContent=files.length>1?'Foto’s voorbereiden…':'Foto voorbereiden…';
 try{
  const images=[];
  // Sequential decoding avoids keeping multiple full-resolution phone photos
  // in memory. Commit a batch only when every selected image is ready.
  for(const file of files){
   if(referenceWork[kind]!==token||personFile!==source)return;
   const image=await window.rigMedia.prepareImageFile(file);images.push(image.blob);
  }
  if(referenceWork[kind]!==token||personFile!==source)return;
  if(kind==='face')faceReferenceBlob=images[0];else angleReferenceBlobs.push(...images);
  input.value='';invalidate();renderReferences();$('referenceStatus').textContent=kind==='face'?'Close-up toegevoegd':'Hoeken toegevoegd';
 }catch(error){if(referenceWork[kind]===token)$('referenceStatus').textContent=error.message||'Foto voorbereiden is mislukt.';}
 finally{if(referenceWork[kind]===token)referenceWork[kind]=null;renderReferences();refreshButton();}
}
for(const [id,kind] of [['captureMain','main'],['captureFace','face'],['captureAngle','angle']])$(id).addEventListener('click',()=>captureReference(kind));
$('removeMain').addEventListener('click',()=>{referenceRevision++;mainReferenceBlob=null;mainReferenceSelection=null;invalidate();renderReferences()});$('removeFace').addEventListener('click',()=>{referenceRevision++;referenceWork.face=null;faceReferenceBlob=null;$('faceInput').value='';invalidate();renderReferences()});
for(let i=0;i<3;i++)$('removeAngle'+i).addEventListener('click',()=>{referenceRevision++;referenceWork.angles=null;angleReferenceBlobs.splice(i,1);$('anglesInput').value='';invalidate();renderReferences()});
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
function invalidate(options){
 cancelAutoCrop();disposeCleanup();const retainingOriginals=options?.reselecting===true&&reselectingOriginals();
 if(!busy&&continuationAvailable()&&!retainingOriginals)continuationOffer=false;
 if(!busy&&retainingOriginals&&trialContinuation?.revision===draftRevision)trialContinuation.revision++;
 draftRevision++;document.dispatchEvent(new Event('rig-prepared-change'));prepared=null;$('previewPrepared').hidden=true;if(urls.prepared){URL.revokeObjectURL(urls.prepared);delete urls.prepared}refreshButton();
}
// Server capability controls the interface; the server enforces authorization.
function localPreparationCapability(){
 if(typeof window.rigMedia?.preparationCapability!=='function')return {supported:true};
 let result;try{result=window.rigMedia.preparationCapability({keepSound:recasting()||$('sound').checked});}catch{}
 if(result?.supported===true)return result;
 let message=typeof result?.message==='string'&&result.message.length<=400?result.message:'Deze browser kan deze video niet lokaal voorbereiden. Kies een andere browser die MP4-opname ondersteunt.';
 if(result?.code==='source-audio')message+=recasting()?' Deze bewerking houdt het originele geluid verplicht aan.':' Je kunt ook zelf in Instellingen het geluid uitzetten.';
 return {supported:false,message};
}
function refreshButton(){
 const capability=localPreparationCapability(),enabled=window.rigVideoEnabled===true&&window.rigSessionActive?.()===true&&availableQualities().includes(selectedQuality()),ready=enabled&&capability.supported;
 let note=$('preparationBrowserNote');if(!note){note=document.createElement('small');note.id='preparationBrowserNote';note.setAttribute('role','status');$('videoAvailabilityNote').after(note);}note.hidden=capability.supported||window.rigSessionActive?.()!==true;note.textContent=capability.supported?'':capability.message;
 const promptReady=$('editPrompt').value.trim().length>0,continuing=continuationAvailable();
 $('prepare').disabled=continuing?continuationBlocked():!ready||continuationBlocked()||missingAngleCloseup()||!imageSource||!motionFile;
 $('prepare').textContent=continuing?'Maak volledige video':enabled?(prepared?'Verder':'Maak video'):'Nog niet beschikbaar';
 $('confirmBrief').disabled=!ready||busy||cleanupWork||referencesBusy()||missingAngleCloseup()||!promptReady;
 $('confirmBrief').textContent=cleanupReview?(cleanupReview.mask?'Gebruik masker en bekijk prijs':'Zoek tekst en toon masker'):cleanupAvailable()&&$('cleanupEnabled').checked?'Controleer tekst en overlays':prepared?'Verder':'Bekijk de prijs';
 $('cleanupOption').hidden=!cleanupAvailable();$('cleanupEnabled').disabled=busy||cleanupWork||!cleanupAvailable();$('briefCrop').disabled=busy||cleanupWork||!motionFile;
 const start=Number($('start').value),remaining=$('motionVideo').duration-start,hasTrial=!!motionFile&&Number.isFinite(start)&&start>=0&&Number.isFinite(remaining)&&remaining>=trialSeconds()-1e-7;
 $('tryShortVideo').hidden=reviewingFull;$('tryShortVideo').disabled=!ready||busy||cleanupWork||!!cleanupReview||referencesBusy()||missingAngleCloseup()||!imageSource||!promptReady||!hasTrial;$('shortTrialHint').hidden=reviewingFull||!motionFile||hasTrial;$('recastTrialNote').hidden=reviewingFull||!recasting();
 $('motionModeButton').disabled=busy||!availableQualities().some(q=>q==='standard'||q==='pro');$('editModeButton').disabled=busy||!editAvailable();
}
function updateModeUi(){
 const edit=editing(),showModes=edit||editAvailable();$('sourceCameraNote').hidden=!edit;$('videoModePanel').hidden=!showModes;$('videoModeTabs').hidden=!showModes;$('briefTitle').textContent=edit?'In de video':'Op je foto';$('motionModeButton').setAttribute('aria-pressed',String(!edit));$('editModeButton').setAttribute('aria-pressed',String(edit));
 $('videoModeHint').textContent=edit?(availableQualities().includes(selectedQuality())?(recasting()?'Vervang een persoon met één portret. Begin met een korte proef.':'Vervang een persoon of dier met je foto. Controleer het resultaat met een korte proef.'):editUnavailableMessage):'Werkt het best met een duidelijk zichtbaar lichaam.';
 $('editPromptPanel').hidden=false;$('editPrompt').required=true;$('promptLabel').textContent=edit?'Wat wil je veranderen?':'Wat wil je maken?';$('editPrompt').placeholder=edit?'Vervang de zanger door het personage op mijn foto.':'Beschrijf het resultaat dat je wilt.';$('motionQualitySettings').hidden=edit;$('steadyOption').hidden=edit;$('backgroundOption').hidden=true;$('settingsNote').hidden=true;
 $('personChooseText').textContent='Kies een foto of video';$('personRole').textContent='Foto';$('motionChooseText').textContent='Kies een video';$('motionRole').textContent='Video';$('soundLabel').textContent=edit?'Geluid van de bronvideo behouden':'Geluid van de bewegingsvideo behouden';
 $('personInput').accept='image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm';$('duration').min=String(durationMinimum());$('trialDurationNote').textContent=recasting()?'(6–15 s · proefje: 6 s)':edit?'(3–15 s · begin met 5 s)':'(3–30 s)';
 $('tryShortVideo').textContent=`Eerst een proefje · ${trialSeconds()} s`;$('shortTrialHint').textContent=`Kies een start met nog minstens ${trialSeconds()} seconden video.`;$('recastTrialNote').hidden=!recasting();$('personTip').textContent=recasting()?'Kies één duidelijke portretfoto van een persoon.':'Tip: een duidelijke foto, liefst met het hele lichaam.';$('sourceCameraNote').textContent=recasting()?'Gebruikt je video en één portret.':'Camera: uit de bronvideo';
 $('sound').disabled=busy||recasting();$('recastSoundNote').hidden=!recasting();if(recasting()){$('sound').checked=true;$('soundLabel').textContent='Origineel geluid blijft behouden';}
 $('settingsNote').textContent=edit?'Gebruik een duidelijke referentiefoto. Beoordeel eerst een korte proef.':'Referenties worden pas na je bevestiging naar fal.ai gestuurd. Achtergrond vervangen is nog niet beschikbaar in de webversie.';
 if($('status').textContent===editUnavailableMessage&&(!edit||editAvailable()))showError('Kies een foto en een video.');
 renderReferences();refreshButton();
}
function setMode(next,{quality}={}){
 const nextQuality=next==='edit'?(quality??preferredEditQuality()):selectedEditQuality;
 if(busy||!['motion','edit'].includes(next)||next==='edit'&&!availableQualities().includes(nextQuality)||next==='motion'&&!availableQualities().some(q=>q==='standard'||q==='pro'))return;
 try{window.rigScopedStorage?.setItem(modeStorageKey,next);}catch{}
 if(next===videoMode&&(next!=='edit'||nextQuality===selectedEditQuality))return;
 modeDurations[modeKey()]=Number($('duration').value);modePrompts[modeKey()]=$('editPrompt').value;modeSound[modeKey()]=$('sound').checked;
 videoMode=next;if(editing())selectedEditQuality=nextQuality;$('editPrompt').value=modePrompts[modeKey()];$('sound').checked=recasting()?true:modeSound[modeKey()];
 const max=motionFile?Math.min(durationLimit(),Math.floor($('motionVideo').duration)):durationLimit();$('duration').max=String(max);$('duration').value=String(Math.max(durationMinimum(),Math.min(max,modeDurations[modeKey()]??max)));$('duration').setCustomValidity('');
 const startMax=updateStartMax();if(!recasting()&&startMax!==null&&Number($('start').value)>startMax)applyStart(startMax);
 invalidate();updateModeUi();if(needsRecastFrame()){$('moreOptions').open=true;showError(recastFrameHint);}document.dispatchEvent(new Event('rig-generation-mode-change'));
}
function updateCapabilities(){
 if((cleanupReview||prepared?.cleanup)&&!cleanupAvailable())invalidate();
 if(selectedEditQuality===null&&editAvailable()){selectedEditQuality=preferredEditQuality();if(recasting()){$('duration').value='6';$('editPrompt').value=modePrompts['human-recast'];}}
 for(const radio of document.querySelectorAll('input[name=quality]'))radio.disabled=!availableQualities().includes(radio.value);
 const selected=document.querySelector('input[name=quality]:checked');
 // Keep an explicit quality choice through availability changes. A missing
 // default Pro capability must not silently downgrade a new draft.
 if(!editing()&&selected?.disabled&&availableQualities().some(q=>q==='standard'||q==='pro'))showError(qualityUnavailableMessage);else if($('status').textContent===qualityUnavailableMessage)showError(personFile&&motionFile?'Klaar? Druk op Maak video.':'Kies een foto en een video.');
 if(editing()&&!availableQualities().includes(selectedQuality())){invalidate();showError(editUnavailableMessage);}
 updateModeUi();
}
$('motionModeButton').addEventListener('click',()=>setMode('motion'));$('editModeButton').addEventListener('click',()=>setMode('edit'));
const promptChanged=()=>{clearBriefFeedback();modePrompts[modeKey()]=$('editPrompt').value;invalidate();};
$('editPrompt').addEventListener('input',promptChanged);$('editPrompt').addEventListener('change',promptChanged);
document.addEventListener('rig-video-availability',updateCapabilities);
for(const [button,input] of [['personChoose','personInput'],['personName','personInput'],['motionChoose','motionInput'],['motionName','motionInput'],['resultName','resultInput']]) $(button).addEventListener('click',()=>$(input).click());
$('previewPrepared').addEventListener('click',()=>{if(!prepared||!urls.prepared)return;$('preparedVideo').src=urls.prepared;$('downloadPrepared').href=urls.prepared;$('preparedDialog').showModal()});
$('preparedDialog').addEventListener('close',()=>$('preparedVideo').pause());
$('settingsToggle').addEventListener('click',()=>{$('settings').showModal();$('settingsToggle').setAttribute('aria-expanded','true')});
$('settings').addEventListener('close',()=>$('settingsToggle').setAttribute('aria-expanded','false'));
function drawImage(source){const c=$('personFrame'); const w=source.videoWidth||source.naturalWidth; const h=source.videoHeight||source.naturalHeight;if(!w||!h)return;imageSource=source;window.rigMedia.paint(c,source,crops.person,1280,1280);c.hidden=false;$('personChoose').hidden=true;$('personCropButton').hidden=false;refreshButton();renderReferences()}
function usePersonFile(file,isCurrent=()=>true){personFile=file;imageSource=null;crops.person=fullCrop();clearReferences();invalidate({reselecting:true});$('referencePanel').hidden=false;$('referenceCapture').hidden=!file.type.startsWith('video/');const url=setURL('person',file);$('personName').textContent=file.name;$('personName').title=file.name;$('frameControl').hidden=true;$('personFrame').hidden=true;$('personCropButton').hidden=true;if(file.type.startsWith('video/')){const video=$('personVideo');video.src=url;video.onloadedmetadata=()=>{if(personFile!==file||!isCurrent())return;if(!Number.isFinite(video.duration)||video.duration<=0){showError('Deze video kon niet worden gelezen.');return}$('frameTime').max=Math.max(0,video.duration-0.01);$('frameTime').value=0;$('frameOutput').textContent='0.0 s';$('frameControl').hidden=false;video.currentTime=Math.min(0.01,video.duration)};video.onseeked=()=>{if(personFile===file&&isCurrent())drawImage(video)};video.onloadeddata=()=>{if(personFile===file&&isCurrent())drawImage(video)};video.onerror=()=>{if(personFile===file&&isCurrent())showError('Deze video kan niet worden geopend in je browser.')}}else{let image=new Image();image.onload=()=>{if(personFile===file&&isCurrent())drawImage(image)};image.onerror=()=>{if(personFile===file&&isCurrent())showError('Deze afbeelding kan niet worden geopend.')};image.src=url}if(needsRecastFrame()){$('moreOptions').open=true;showError(recastFrameHint);}else showError(motionFile?'Klaar? Druk op Maak video.':'Kies nu een video.')}
$('personInput').addEventListener('change',event=>{const file=event.target.files[0];if(file&&!rejectMedia(event.target,file,'media'))usePersonFile(file);});
$('frameTime').addEventListener('input',event=>{const time=Number(event.target.value);$('frameOutput').textContent=`${time.toFixed(1)} s`;imageSource=null;invalidate();$('personVideo').currentTime=time;if(!$('personVideo').seeking)drawImage($('personVideo'))});
function useMotionFile(file,isCurrent=()=>true){motionLoadingFile=file;motionFile=null;crops.motion=fullCrop();invalidate({reselecting:true});$('motionCropped').hidden=true;$('motionCropControls').hidden=true;const video=$('motionVideo');video.pause();video.src=setURL('motion',file);video.hidden=false;$('motionChoose').hidden=true;$('motionName').textContent=file.name;$('motionName').title=file.name;video.onloadedmetadata=()=>{if(motionLoadingFile!==file||motionFile===file||!isCurrent())return;if(!Number.isFinite(video.duration)||video.duration<3){showError('Kies een video van minstens 3 seconden.');return}motionFile=file;$('trim').hidden=false;$('start').value=0;$('start').max=Math.max(0,Math.floor((video.duration-3)*10+1e-7)/10);$('duration').setCustomValidity('');modeDurations.motion=null;modeDurations.edit=5;modeDurations['human-recast']=6;$('duration').max=Math.min(durationLimit(),Math.floor(video.duration));$('duration').value=editing()?String(Math.max(durationMinimum(),Math.min(trialSeconds(),Number($('duration').max)))):$('duration').max;updateStartMax();$('motionSeek').max=video.duration;updateMotionPreview();$('motionCropButton').hidden=false;refreshButton()};video.onerror=()=>{if(motionLoadingFile===file&&isCurrent())showError('Deze video kan niet worden geopend in je browser.')};showError(personFile?'Klaar? Druk op Maak video.':'Kies nu een foto.')}
$('motionInput').addEventListener('change',event=>{const file=event.target.files[0];if(file&&!rejectMedia(event.target,file,'video'))useMotionFile(file);});
for(const id of ['start','duration'])$(id).addEventListener('focus',e=>e.target.select());function updateStartMax(){const v=$('motionVideo'),duration=Number($('duration').value);if(!Number.isFinite(v.duration)||!Number.isInteger(duration)||duration<durationMinimum()||duration>durationLimit())return null;const max=Math.max(0,Math.floor((v.duration-duration)*10+1e-7)/10);$('start').max=String(max);return max}function applyStart(value){const v=$('motionVideo'),max=updateStartMax();if(max===null||!Number.isFinite(value))return;const start=Math.min(max,Math.max(0,value));$('start').value=String(start);v.currentTime=start} $('start').addEventListener('change',()=>{if($('start').value!=='')applyStart(Number($('start').value));invalidate()});$('useCurrentStart').addEventListener('click',()=>{const v=$('motionVideo');if(!Number.isFinite(v.currentTime)||!Number.isFinite(v.duration))return;$('start').value=String(Math.floor(v.currentTime*10)/10);$('start').dispatchEvent(new Event('change',{bubbles:true}));});$('duration').addEventListener('change',()=>{const input=$('duration'),value=Number(input.value),max=Number(input.max);if(!Number.isInteger(value)||value<durationMinimum()||value>durationLimit()||value>max){const msg=`Kies een duur van ${durationMinimum()} tot ${Math.min(durationLimit(),max)} seconden.`;showError(msg);input.setCustomValidity(msg)}else{input.setCustomValidity('');const startMax=updateStartMax();if(startMax!==null&&Number($('start').value)>startMax)applyStart(startMax)}invalidate()});$('sound').addEventListener('change',()=>{modeSound[modeKey()]=$('sound').checked;invalidate();});$('steady').addEventListener('change',invalidate);for(const r of document.querySelectorAll('input[name=quality]'))r.addEventListener('change',invalidate);
$('resultInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'video'))return;const url=setURL('result',file);$('resultVideo').src=url;$('resultVideo').hidden=false;$('resultEmpty').hidden=true;$('resultName').textContent=file.name;$('export').href=url;$('export').download=file.name;$('export').hidden=false});
$('backgroundInput').addEventListener('change',e=>{$('backgroundName').textContent=e.target.files[0]?.name||'Nog niet beschikbaar';invalidate()});
$('faceInput').addEventListener('change',e=>importReferences('face',[...e.target.files]));
$('anglesInput').addEventListener('change',e=>importReferences('angles',[...e.target.files]));
function cropValues(){return {x:Number($('cropX').value),y:Number($('cropY').value),w:Number($('cropW').value),h:Number($('cropH').value)}}
function cropSource(){return cropTarget==='person'?imageSource:$('motionVideo')}
function previewCrop(){try{const canvas=$('cropPreview'),selection=$('cropSelection'),crop=window.rigMedia.bounds(cropValues());const size=window.rigMedia.dimensions(cropSource(),crop,1280,1280);if(size.width<340||size.height<340)throw Error('Kies een uitsnede van minstens 340 × 340 pixels.');if(cropTarget==='person'&&(size.width/size.height<.4||size.width/size.height>2.5))throw Error('Kies een uitsnede met passende verhoudingen.');if(cropTarget==='motion'&&editing()&&typeof window.rigMedia.videoDimensions==='function')window.rigMedia.videoDimensions(cropSource(),crop,{minSide:720});window.rigMedia.paint(canvas,cropSource(),fullCrop(),640,360);if(canvas.width>0&&canvas.height>0)$('cropStage').style.width=`min(100%, ${Math.floor(260*canvas.width/canvas.height)}px)`;Object.assign(selection.style,{left:`${crop.x}%`,top:`${crop.y}%`,width:`${crop.w}%`,height:`${crop.h}%`});$('cropError').textContent='';$('applyCrop').disabled=false}catch(e){$('cropError').textContent=e.message;$('applyCrop').disabled=true}}
// Screen-recording analysis uses a separate local video decoder. It only
// proposes the frame in this popout; the normal Apply action commits it.
let autoCropOperation=null;
function cancelAutoCrop(){if(autoCropOperation)autoCropOperation.abort.abort();autoCropOperation=null;$('autoCrop').disabled=false;}
async function suggestMotionCrop(){
 if(cropTarget!=='motion'||!motionFile||!$('cropDialog').open||busy)return;
 cancelAutoCrop();const operation={abort:new AbortController(),file:motionFile,revision:draftRevision,fields:JSON.stringify(cropValues()),request:window.rigRequest,active:window.rigSessionActive,storage:window.rigScopedStorage};autoCropOperation=operation;
 const current=()=>autoCropOperation===operation&&!operation.abort.signal.aborted&&cropTarget==='motion'&&$('cropDialog').open&&motionFile===operation.file&&draftRevision===operation.revision&&JSON.stringify(cropValues())===operation.fields&&window.rigRequest===operation.request&&window.rigSessionActive===operation.active&&window.rigScopedStorage===operation.storage&&operation.active?.()===true;
 $('autoCrop').disabled=true;$('autoCropStatus').hidden=false;$('autoCropStatus').textContent='Videovlak zoeken…';
 try{
  const suggest=window.rigSuggestScreenCrop??(await import('/multiuser/screen-recording-crop.mjs')).suggestScreenRecordingCrop;
  if(!current())return;
  const result=await suggest(operation.file,{signal:operation.abort.signal});if(!current())return;
  if(!result?.proposal||result.confidence<.9){$('autoCropStatus').textContent='Geen duidelijk videovlak gevonden. Sleep het kader zelf.';return;}
  const crop=window.rigMedia.bounds(result.proposal);window.rigMedia.dimensions(cropSource(),crop,1280,1280);
  setCropFields(crop);$('autoCropStatus').textContent='Uitsnede voorgesteld. Controleer het kader en bewaar.';
 }catch(error){if(current())$('autoCropStatus').textContent=error?.code==='canceled'?'Zoeken gestopt.': 'Geen voorstel beschikbaar. Je kunt de hoeken zelf slepen.';}
 finally{if(autoCropOperation===operation){autoCropOperation=null;$('autoCrop').disabled=false;}}
}
for(const [id,target] of [['personCropButton','person'],['motionCropButton','motion']])$(id).addEventListener('click',()=>{cancelAutoCrop();cropTarget=target;for(const k of ['x','y','w','h'])$('crop'+k.toUpperCase()).value=crops[target][k];$('cropTitle').textContent=target==='person'?'Jouw beeld uitsnijden':'Bronvideo bijsnijden';$('autoCrop').hidden=target!=='motion';$('autoCropStatus').hidden=true;$('cropDialog').showModal();previewCrop();if(target==='motion'&&!motionHasCrop())suggestMotionCrop();});
$('autoCrop').addEventListener('click',suggestMotionCrop);
$('cropDialog').addEventListener('close',cancelAutoCrop);
$('cropDialog').addEventListener('cancel',cancelAutoCrop);
window.addEventListener('pagehide',cancelAutoCrop);
for(const k of ['X','Y','W','H'])$('crop'+k).addEventListener('input',()=>{cancelAutoCrop();$('autoCropStatus').hidden=true;previewCrop();});
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
$('cropStage').addEventListener('pointerdown',e=>{const handle=e.target.closest('[data-crop-handle]')?.dataset.cropHandle;if(!['move','nw','ne','sw','se'].includes(handle))return;cancelAutoCrop();$('autoCropStatus').hidden=true;const rect=$('cropStage').getBoundingClientRect();if(!rect.width||!rect.height)return;cropDrag={handle,initial:cropValues(),x:e.clientX,y:e.clientY,width:rect.width,height:rect.height,pointerId:e.pointerId};$('cropStage').setPointerCapture(e.pointerId);e.preventDefault()});
$('cropStage').addEventListener('pointermove',e=>{if(!cropDrag||cropDrag.pointerId!==e.pointerId)return;setCropFields(adjustedCrop(cropDrag.initial,cropDrag.handle,(e.clientX-cropDrag.x)*100/cropDrag.width,(e.clientY-cropDrag.y)*100/cropDrag.height));e.preventDefault()});
for(const type of ['pointerup','pointercancel','lostpointercapture'])$('cropStage').addEventListener(type,e=>{if(cropDrag?.pointerId===e.pointerId)cropDrag=null});
$('cropStage').addEventListener('keydown',e=>{const handle=e.target.closest('[data-crop-handle]')?.dataset.cropHandle;if(!['nw','ne','sw','se'].includes(handle))return;const step=e.shiftKey?5:1,delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[e.key];if(!delta)return;cancelAutoCrop();$('autoCropStatus').hidden=true;setCropFields(adjustedCrop(cropValues(),handle,...delta));e.preventDefault()});
$('resetCrop').addEventListener('click',()=>{cancelAutoCrop();$('autoCropStatus').hidden=true;for(const [k,v] of Object.entries(fullCrop()))$('crop'+k.toUpperCase()).value=v;previewCrop()});
function motionHasCrop(){const c=crops.motion;return c.x!==0||c.y!==0||c.w!==100||c.h!==100}
let motionAnimation=0;
function updateMotionPreview(){const v=$('motionVideo'),active=!!motionFile&&motionHasCrop();$('motionCropped').hidden=!active;$('motionCropControls').hidden=!active;v.hidden=active||!motionFile;if(active&&v.readyState>=2){try{window.rigMedia.paint($('motionCropped'),v,crops.motion,1280,1280)}catch{}}$('motionSeek').value=Number.isFinite(v.currentTime)?v.currentTime:0;$('motionTime').textContent=`${(v.currentTime||0).toFixed(1)} s`;$('motionPlay').textContent=v.paused?'▶ Afspelen':'❚❚ Pauzeren'}
function animateMotionPreview(){cancelAnimationFrame(motionAnimation);if(!$('motionVideo').paused&&motionHasCrop()){updateMotionPreview();motionAnimation=requestAnimationFrame(animateMotionPreview)}}
$('motionPlay').addEventListener('click',async()=>{const v=$('motionVideo');if(v.paused){try{await v.play()}catch{showError('De video kon niet worden afgespeeld.')}}else v.pause()});
$('motionSeek').addEventListener('input',e=>{$('motionVideo').currentTime=Number(e.target.value)});
for(const event of ['seeked','pause','loadeddata'])$('motionVideo').addEventListener(event,updateMotionPreview);
$('motionVideo').addEventListener('timeupdate',updateMotionPreview);
$('motionVideo').addEventListener('play',()=>{updateMotionPreview();animateMotionPreview()});
$('applyCrop').addEventListener('click',()=>{cancelAutoCrop();try{window.rigMedia.bounds(cropValues());crops[cropTarget]=cropValues();$('cropDialog').close();invalidate();if(cropTarget==='person'&&imageSource)drawImage(imageSource);else if(cropTarget==='motion')updateMotionPreview();showError(cropTarget==='person'&&mainReferenceBlob?'Uitsnede gekozen. Zet het hoofdbeeld opnieuw vast als je deze uitsnede wilt gebruiken.':'Uitsnede gekozen. Bereid de beelden opnieuw voor.')}catch(e){$('cropError').textContent=e.message}});
function clearBriefFeedback(){
 $('briefError').textContent='';$('briefError').hidden=true;$('correctBriefDuration').hidden=true;
}
function briefFeedback(message){if($('briefError').textContent!==message)$('briefError').textContent=message;$('briefError').hidden=false;showError(message);}
function availableBriefDuration(){
 const start=Number($('start').value),sourceDuration=$('motionVideo').duration;
 return Number.isFinite(start)&&start>=0&&Number.isFinite(sourceDuration)?Math.min(durationLimit(),Math.floor(sourceDuration-start+1e-7)):0;
}
function cleanupProgress(progress){const stage=progress.stage,done=progress.completedFrames,total=progress.totalFrames;const text=stage==='detect-text'?'Tekst zoeken op dit apparaat':stage==='encode-mask'?'Masker maken':stage==='prepare-cfr-source'?'Fragment precies voorbereiden':stage==='private-source'?'Privéfragment controleren':'Fragment controleren';$('cleanupStatus').textContent=text+(Number.isFinite(progress.fraction)?`… ${Math.round(progress.fraction*100)}%`:Number.isFinite(done)&&total?`… ${done}/${total}`:'…');}
async function beginCleanupReview(base,revision,start){
 const epoch=cleanupEpoch,sourceToken=crypto.randomUUID(),portraitToken=crypto.randomUUID();
 const readSelection=()=>({revision:draftRevision,sourceToken,portraitToken,startSeconds:Number($('start').value),selectedSeconds:base.selectedSeconds,crop:{...crops.motion},quality:selectedQuality(),keepSound:$('sound').checked,prompt:$('editPrompt').value.trim()});
 const current=()=>epoch===cleanupEpoch&&revision===draftRevision&&window.rigSessionActive?.()===true&&cleanupAvailable()&&$('cleanupEnabled').checked;
 let client,editor;
 try{
  const module=await loadCleanup();if(!current())throw Error('Je selectie of aanmelding is gewijzigd.');
  client=module.createCleanupClient({getBinding:cleanupBinding,readSelection,onProgress:cleanupProgress});cleanupReview={client,editor:null,base,mask:null,current};$('closeBrief').disabled=false;$('cleanupReview').hidden=false;$('cleanupStatus').textContent='Fragment precies voorbereiden…';
  const owned=await client.prepareSource({workingBlob:base.video.blob,selectedSeconds:base.selectedSeconds});if(!current())throw Error('Je selectie of aanmelding is gewijzigd.');
  const canvas=await client.sourceFrame();if(!current()){canvas.width=canvas.height=1;throw Error('Je selectie of aanmelding is gewijzigd.');}
  const review=cleanupReview;review.owned=owned;review.canvas=canvas;review.base={...base,video:{...base.video,blob:owned.blob}};$('cleanupSourcePreview').src=setURL('cleanupSource',owned.blob);$('cleanupMaskFigure').hidden=true;
  editor=client.mountEditor({container:$('cleanupEditor'),sourceCanvas:canvas,sourceKey:owned.manifest.id,isBusy:()=>cleanupWork,onChange:()=>{if(cleanupReview!==review)return;review.mask=null;client.invalidateMask();prepared=null;$('previewPrepared').hidden=true;$('cleanupMaskFigure').hidden=true;if(urls.cleanupMask){URL.revokeObjectURL(urls.cleanupMask);delete urls.cleanupMask;}$('cleanupMaskPreview').removeAttribute('src');document.dispatchEvent(new Event('rig-prepared-change'));refreshButton();}});review.editor=editor;
  $('cleanupStatus').textContent='Bekijk het fragment. Markeer zo nodig extra tekst of iconen en laat daarna het masker maken.';briefFeedback('Er is nog geen video gestart en er is nog geen Fal-tegoed gebruikt.');
 }catch(error){client?.dispose();editor?.dispose();if(current()){disposeCleanup();throw error;}}
}
async function advanceCleanupReview(){
 const review=cleanupReview;if(!review||cleanupWork||busy)return;cleanupWork=true;refreshButton();
 try{
  if(!review.current())throw Error('Je selectie is gewijzigd. Bereid opnieuw voor.');
  if(!review.mask){const mask=await review.client.prepareMask({readOptions:()=>review.editor.getConfig()});if(cleanupReview!==review||!review.current())return;review.mask=mask;$('cleanupMaskPreview').src=setURL('cleanupMask',mask.blob);$('cleanupMaskFigure').hidden=false;$('cleanupStatus').textContent='Speel het masker af. Alleen witte vakken worden bijgewerkt. Controleer ook gezichten en bewegingen.';briefFeedback('Klopt het masker? Gebruik het dan om de totale prijs te bekijken.');}
  else{const cleanup=await review.client.acceptMask();if(cleanupReview!==review||!review.current())return;prepared={...review.base,cleanup};setURL('prepared',prepared.video.blob);$('previewPrepared').hidden=false;clearBriefFeedback();$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));}
 }catch(error){if(cleanupReview===review)briefFeedback(error.message||'Het masker kon niet worden voorbereid.');}
 finally{cleanupWork=false;refreshButton();}
}
async function prepareWithPrompt({trial=false}={}){
 if(window.rigVideoEnabled!==true||window.rigSessionActive?.()!==true||busy||referencesBusy()||!imageSource||!motionFile)return;
 clearBriefFeedback();
 const capability=localPreparationCapability();if(!capability.supported){refreshButton();briefFeedback(capability.message);return;}
 const edit=editing(),quality=selectedQuality(),prompt=$('editPrompt').value.trim(),start=Number($('start').value),duration=cleanupReview?cleanupReview.base.selectedSeconds:trial?trialSeconds():Number($('duration').value),limit=edit?15:30,max=availableBriefDuration();
 if(!availableQualities().includes(quality)){briefFeedback('Deze videobewerking is momenteel niet beschikbaar.');return;}
 if(recasting()&&!$('sound').checked){briefFeedback('Deze bewerking behoudt het originele geluid. Kies de bewerking opnieuw.');return;}
 if(!prompt){briefFeedback(edit?'Beschrijf wat je in de video wilt veranderen.':'Beschrijf wat je wilt maken.');$('editPrompt').reportValidity?.();$('editPrompt').focus();return;}
 if(prompt.length>1900){briefFeedback('Houd je beschrijving korter dan 1900 tekens.');return;}
 if(needsRecastFrame()){$('briefDialog').close();$('moreOptions').open=true;showError(recastFrameHint);$('frameControl').scrollIntoView?.({behavior:'smooth',block:'center'});$('frameTime').focus();return;}
 if(!Number.isFinite(start)||start<0||max<durationMinimum()){briefFeedback(`Kies een startpunt met nog minstens ${durationMinimum()} seconden video.`);return;}
 if(!Number.isInteger(duration)||duration<durationMinimum()||duration>max){
  briefFeedback(`Kies vanaf dit startpunt een duur van ${durationMinimum()} tot ${max} seconden.`);
  $('correctBriefDuration').textContent=`Gebruik ${max} seconden`;$('correctBriefDuration').hidden=false;return;
 }
 if(editing()&&!recasting()&&angleReferenceBlobs.length>angleLimit()){briefFeedback('Kies maximaal twee extra hoeken voor deze videobewerking.');return;}
 if(!recasting()&&personFile?.type.startsWith('video/')&&(faceReferenceBlob||angleReferenceBlobs.length)&&!mainReferenceBlob){briefFeedback('Zet eerst je hoofdbeeld vast.');return;}
 modePrompts[modeKey()]=$('editPrompt').value;
 if(cleanupReview){await advanceCleanupReview();return;}
 const useCleanup=cleanupAvailable()&&$('cleanupEnabled').checked;
 if(prepared&&prepared.prompt===prompt&&prepared.quality===quality&&prepared.selectedSeconds===duration&&Boolean(prepared.trialToken)===trial&&Boolean(prepared.cleanup)===useCleanup){$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));return;}
 const trialToken=trial?startTrialContinuation():null;
 busy=true;$('briefDialog').setAttribute('aria-busy','true');const disabledBefore=new Map();for(const el of document.querySelectorAll('button,input,textarea')){disabledBefore.set(el,el.disabled);el.disabled=true;}
 refreshButton();invalidate();const revision=draftRevision;if(trialToken&&trialContinuation?.token===trialToken)trialContinuation.revision=revision;let complete=false;
 try{
  briefFeedback('Beeld voorbereiden…');const image=mainReferenceBlob?{blob:mainReferenceBlob}:await window.rigMedia.prepareImage(imageSource,crops.person);
  briefFeedback('Video voorbereiden… Houd RIG in beeld.');
  const progress=p=>briefFeedback(`Video voorbereiden… ${Math.round(p*100)}% · Houd RIG in beeld.`);
  const video=edit?await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress,{minSide:720,maxDuration:15}):await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress);
  if(revision!==draftRevision||editing()!==edit||window.rigSessionActive?.()!==true)throw Error('Je instellingen zijn gewijzigd. Bereid je beelden opnieuw voor.');
  prepared={image,video,selectedSeconds:duration,...(trialToken?{trialToken}:{}),face:recasting()?null:faceReferenceBlob,angles:recasting()?[]:[...angleReferenceBlobs],quality,keepSound:$('sound').checked,steady:edit?false:$('steady').checked,prompt};
  if(useCleanup){const base=prepared;prepared=null;await beginCleanupReview(base,revision,start);}
  else{setURL('prepared',video.blob);$('previewPrepared').hidden=false;showError('Beelden lokaal voorbereid.');complete=true;}
 }catch(e){briefFeedback(e.message||'Voorbereiden is mislukt.');}
 finally{for(const [el,wasDisabled] of disabledBefore)el.disabled=wasDisabled;busy=false;$('briefDialog').setAttribute('aria-busy','false');updateCapabilities();}
 if(complete){clearBriefFeedback();$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));}
}
$('prepare').addEventListener('click',()=>{if($('prepare').disabled||busy)return;if(continuationAvailable()){void continueFullVideo();return;}reviewingFull=false;clearBriefFeedback();refreshButton();$('briefDialog').showModal();$('editPrompt').focus();});
$('correctBriefDuration').addEventListener('click',()=>{
 if(busy||$('correctBriefDuration').hidden)return;
 const duration=availableBriefDuration();if(duration<durationMinimum())return;
 $('duration').value=String(duration);$('duration').setCustomValidity('');modeDurations[modeKey()]=duration;$('duration').dispatchEvent(new Event('change',{bubbles:true}));
 clearBriefFeedback();briefFeedback(`Duur ingesteld op ${duration} seconden. Bekijk de prijs om verder te gaan.`);
});
$('confirmBrief').addEventListener('click',prepareWithPrompt);
$('tryShortVideo').addEventListener('click',()=>{
 if($('tryShortVideo').disabled||busy)return;
 const start=Number($('start').value),remaining=$('motionVideo').duration-start;
 if(!Number.isFinite(start)||start<0||!Number.isFinite(remaining)||remaining<trialSeconds()-1e-7){refreshButton();return;}
 try{if(window.rigScopedStorage?.getItem('rig-generation-pending')||window.rigScopedStorage?.getItem('rig-generation-job')){$('briefDialog').close();$('quoteDialog').showModal();$('quoteMessage').textContent='Controleer eerst je bestaande opdracht voordat je een nieuw proefje start.';$('checkGeneration').hidden=false;return;}}catch{return;}
 // A trial gets its own working clip. Keep the original full selection intact.
 prepareWithPrompt({trial:true});
});

$('closeBrief').addEventListener('click',()=>{if(!busy||cleanupReview){disposeCleanup();$('briefDialog').close();refreshButton();}});
$('briefDialog').addEventListener('cancel',event=>{if(busy&&!cleanupReview)event.preventDefault();else{disposeCleanup();refreshButton();}});
$('cleanupEnabled').addEventListener('change',()=>{if(busy||cleanupWork)return;invalidate();clearBriefFeedback();});
$('briefCrop').addEventListener('click',()=>{if(busy||cleanupWork||!motionFile)return;returnBriefFromCrop=true;$('briefDialog').close();$('motionCropButton').click();});
$('cropDialog').addEventListener('close',()=>{if(returnBriefFromCrop){returnBriefFromCrop=false;if(window.rigSessionActive?.()===true){$('briefDialog').showModal();refreshButton();}}});
window.addEventListener('pagehide',disposeCleanup);

// Trial continuation metadata is account-scoped and bounded. Source files,
// image bytes and private URLs stay in memory and are never persisted here.
const trialStorageKey='rig-trial-continuation:v1';
let trialContinuation=null,lastCompletedResult=null,restoreOperation=null,continuationOffer=false,reviewingFull=false;
const nonTrialJobs=new Set();
const continuationPriceNote='Je proefje is apart afgerekend. Je ziet en bevestigt eerst de nieuwe prijs.';
const copyMainSelection=value=>value?{time:value.time,crop:{...value.crop}}:null;

const draftFile=file=>file?{name:file.name,type:file.type,size:file.size,lastModified:file.lastModified}:null;
const sameFile=(file,meta)=>!!file&&!!meta&&file.name===meta.name&&file.type===meta.type&&file.size===meta.size&&file.lastModified===meta.lastModified;
function continuationSnapshot(){return {personFile,motionFile,person:draftFile(personFile),motion:draftFile(motionFile),mode:videoMode,editQuality:selectedEditQuality,quality:selectedQuality(),start:Number($('start').value),seconds:Number($('duration').value),prompt:$('editPrompt').value,sound:$('sound').checked,steady:$('steady').checked,cleanup:$('cleanupEnabled').checked,frameTime:Number($('frameTime').value),crops:{person:{...crops.person},motion:{...crops.motion}},mainReferenceBlob,mainSelection:mainReferenceSelection?copyMainSelection(mainReferenceSelection):null,faceReferenceBlob,angleReferenceBlobs:[...angleReferenceBlobs],faceRequired:!!faceReferenceBlob,angleCount:angleReferenceBlobs.length};}
function persistTrialContinuation(){
 try{if(!trialContinuation?.quoteId){window.rigScopedStorage?.removeItem(trialStorageKey);return;}const {personFile,motionFile,mainReferenceBlob,faceReferenceBlob,angleReferenceBlobs,...draft}=trialContinuation.draft;window.rigScopedStorage?.setItem(trialStorageKey,JSON.stringify({version:1,token:trialContinuation.token,createdAt:trialContinuation.createdAt,state:trialContinuation.state,quoteId:trialContinuation.quoteId,jobId:trialContinuation.jobId??null,draft}));}catch{}
}
function readTrialContinuation(){
 try{const raw=window.rigScopedStorage?.getItem(trialStorageKey);if(!raw||raw.length>8192)return;const value=JSON.parse(raw),d=value?.draft,validCrop=c=>c&&['x','y','w','h'].every(k=>Number.isFinite(c[k]))&&c.x>=0&&c.y>=0&&c.w>0&&c.h>0&&c.x+c.w<=100&&c.y+c.h<=100,validFile=f=>f&&typeof f.name==='string'&&f.name.length<=256&&typeof f.type==='string'&&f.type.length<=100&&Number.isSafeInteger(f.size)&&f.size>0&&Number.isFinite(f.lastModified),id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
 if(value.version!==1||!id(value.token)||!id(value.quoteId)||value.jobId!==null&&!id(value.jobId)||!['pending','accepted','completed'].includes(value.state)||!Number.isFinite(value.createdAt)||Date.now()-value.createdAt>86400000||value.createdAt>Date.now()+60000||!d||!validFile(d.person)||!validFile(d.motion)||!['motion','edit'].includes(d.mode)||!['standard','pro','edit-standard','human-recast'].includes(d.quality)||d.editQuality!==null&&!['edit-standard','human-recast'].includes(d.editQuality)||d.mode==='motion'&&!['standard','pro'].includes(d.quality)||d.mode==='edit'&&!['edit-standard','human-recast'].includes(d.quality)||!Number.isFinite(d.start)||d.start<0||d.start>604800||!Number.isInteger(d.seconds)||d.seconds<1||d.seconds>604800||typeof d.prompt!=='string'||d.prompt.length>1900||typeof d.sound!=='boolean'||typeof d.steady!=='boolean'||!Number.isFinite(d.frameTime)||d.frameTime<0||d.frameTime>604800||!validCrop(d.crops?.person)||!validCrop(d.crops?.motion)||typeof d.faceRequired!=='boolean'||!Number.isInteger(d.angleCount)||d.angleCount<0||d.angleCount>3||d.mainSelection!==null&&(!validCrop(d.mainSelection?.crop)||d.mainSelection.time!==null&&(!Number.isFinite(d.mainSelection.time)||d.mainSelection.time<0||d.mainSelection.time>604800)))return;
 trialContinuation={...value,revision:draftRevision,draft:{...d,personFile:null,motionFile:null,mainReferenceBlob:null,faceReferenceBlob:null,angleReferenceBlobs:[]}};
 }catch{}
}
function continuationBlocked(){try{return busy||referencesBusy()||window.rigSessionActive?.()!==true||window.rigGenerationBusy?.()===true||!!window.rigScopedStorage?.getItem('rig-generation-pending')||!!window.rigScopedStorage?.getItem('rig-generation-job');}catch{return true;}}
function continuationAvailable(){return continuationOffer&&!!lastCompletedResult&&trialContinuation?.jobId===lastCompletedResult&&trialContinuation.state==='completed'&&!nonTrialJobs.has(lastCompletedResult);}
function reselectingOriginals(){const d=trialContinuation?.draft;return !!d&&!d.personFile&&!d.motionFile&&(!personFile||sameFile(personFile,d.person))&&(!motionLoadingFile||sameFile(motionLoadingFile,d.motion))&&(!motionFile||sameFile(motionFile,d.motion));}
function renderContinuation(){refreshButton();$('resultTitle').textContent=lastCompletedResult&&trialContinuation?.jobId===lastCompletedResult?'Je proefje':'Je video';}
function startTrialContinuation(){continuationOffer=false;trialContinuation={token:crypto.randomUUID(),createdAt:Date.now(),state:'prepared',draft:continuationSnapshot()};return trialContinuation.token;}
const delayForDraft=()=>new Promise(resolve=>setTimeout(resolve,50));
async function waitForSources(d,assertCurrent){for(let i=0;i<600;i++){assertCurrent();if(personFile===d.personFile&&motionFile===d.motionFile&&imageSource&&$('motionVideo').readyState>=2)return;await delayForDraft();}throw Error('Je oorspronkelijke bestanden konden niet worden geopend. Kies ze opnieuw.');}
async function seekPortrait(time,assertCurrent){const video=$('personVideo');assertCurrent();if(!Number.isFinite(time)||time<0||time>video.duration)throw Error('Het gekozen hoofdbeeld valt buiten deze video.');video.currentTime=time;for(let i=0;i<200;i++){assertCurrent();if(!video.seeking&&video.readyState>=2)return;await delayForDraft();}throw Error('Het gekozen hoofdbeeld kon niet worden teruggezet.');}
function putInputFile(id,file){try{if(typeof DataTransfer==='function'){const transfer=new DataTransfer();transfer.items.add(file);$(id).files=transfer.files;}}catch{}}
function guideToFiles(message,{person=false,motion=false}={}){showError(message);$('quoteDialog').close();const target=person?'personName':motion?'motionName':null;if(target){$(person?'personStepTitle':'motionStepTitle').scrollIntoView?.({behavior:'smooth',block:'start'});$(target).focus();}}
function guideToDuration(message){showError(message);$('duration').scrollIntoView?.({behavior:'smooth',block:'center'});$('duration').focus();}
async function restoreFullDraft(d){
 if(!availableQualities().includes(d.quality))throw Error('Het eerder gekozen videotype of de kwaliteit is nu niet beschikbaar. Er wordt geen ander model gekozen.');
 // A real reload drops File objects. Only explicitly reselected originals can
 // recreate the draft; filenames alone are never used to read local files.
 const originalPerson=d.personFile??(sameFile(personFile,d.person)?personFile:null),originalMotion=d.motionFile??(sameFile(motionFile,d.motion)?motionFile:null);
 if(!originalPerson||!originalMotion){guideToFiles('Kies je oorspronkelijke foto of referentievideo en bewegingsvideo opnieuw. Je eerdere instellingen zijn bewaard; ga daarna verder met je volledige video.',{person:!originalPerson,motion:!originalMotion});return false;}
 const binding={request:window.rigRequest,active:window.rigSessionActive,storage:window.rigScopedStorage},operation={},oldDisabled=new Map();let revision=draftRevision;
 const sessionCurrent=()=>window.rigRequest===binding.request&&window.rigSessionActive===binding.active&&window.rigScopedStorage===binding.storage&&binding.active?.()===true;
 const current=()=>restoreOperation===operation&&!operation.canceled&&sessionCurrent()&&revision===draftRevision;
 const assertCurrent=()=>{if(!current())throw Error('Je selectie of aanmelding is gewijzigd. Je eerdere selectie is niet verder teruggezet.');if(!availableQualities().includes(d.quality))throw Error('Je eerder gekozen videotype is nu niet beschikbaar.');};
 restoreOperation=operation;busy=true;for(const element of document.querySelectorAll('button,input,textarea')){oldDisabled.set(element,element.disabled);element.disabled=true;}renderContinuation();
 try{
  assertCurrent();if(personFile!==originalPerson||!imageSource){putInputFile('personInput',originalPerson);usePersonFile(originalPerson,sessionCurrent);revision=draftRevision;}if(motionFile!==originalMotion){putInputFile('motionInput',originalMotion);useMotionFile(originalMotion,sessionCurrent);revision=draftRevision;}
  const sourceDraft={...d,personFile:originalPerson,motionFile:originalMotion};await waitForSources(sourceDraft,assertCurrent);assertCurrent();
  let main=d.mainReferenceBlob;
  // Reconstruct only an explicitly selected frame, then recheck the binding
  // and draft revision before publishing any restored settings or image bytes.
  if(originalPerson.type.startsWith('video/')){
   if(!main&&d.mainSelection){await seekPortrait(d.mainSelection.time,assertCurrent);assertCurrent();const snapshot=await window.rigMedia.prepareImage($('personVideo'),d.mainSelection.crop);assertCurrent();main=snapshot.blob;}
   await seekPortrait(d.frameTime,assertCurrent);assertCurrent();
  }else if(!main&&d.mainSelection){const snapshot=await window.rigMedia.prepareImage(imageSource,d.mainSelection.crop);assertCurrent();main=snapshot.blob;}
  videoMode=d.mode;selectedEditQuality=d.mode==='edit'?d.quality:d.editQuality;
  if(d.mode==='motion')for(const radio of document.querySelectorAll('input[name=quality]'))radio.checked=radio.value===d.quality;
  crops.person={...d.crops.person};crops.motion={...d.crops.motion};$('editPrompt').value=d.prompt;modePrompts[modeKey()]=d.prompt;modeDurations[modeKey()]=d.seconds;modeSound[modeKey()]=d.sound;$('sound').checked=d.sound;$('steady').checked=d.steady;$('cleanupEnabled').checked=d.cleanup===true;
  $('duration').max=String(Math.min(durationLimit(),Math.floor($('motionVideo').duration)));$('duration').value=String(d.seconds);$('duration').setCustomValidity('');$('start').value=String(d.start);updateStartMax();$('motionVideo').currentTime=d.start;
  mainReferenceBlob=main;mainReferenceSelection=d.mainSelection?copyMainSelection(d.mainSelection):null;
  if(originalPerson.type.startsWith('video/')){$('frameTime').value=String(d.frameTime);$('frameOutput').textContent=`${d.frameTime.toFixed(1)} s`;}
  faceReferenceBlob=d.personFile?d.faceReferenceBlob:d.faceRequired?faceReferenceBlob:null;angleReferenceBlobs=d.personFile?[...d.angleReferenceBlobs]:d.angleCount?angleReferenceBlobs:[];
  invalidate();revision=draftRevision;drawImage(imageSource);updateMotionPreview();renderReferences();
  if(!recasting()&&(d.faceRequired&&!faceReferenceBlob||angleReferenceBlobs.length!==d.angleCount)){showError('Kies je eerdere close-up en hoeken opnieuw. Ze zijn niet in de browser opgeslagen. Ga daarna verder met je volledige video.');$('moreOptions').open=true;return false;}
  return true;
 }finally{if(restoreOperation===operation){restoreOperation=null;busy=false;for(const [element,disabled] of oldDisabled)element.disabled=disabled;if(sessionCurrent())updateCapabilities();renderContinuation();}}
}
async function continueFullVideo(){
 if(!continuationAvailable())return;
 if(continuationBlocked())return;
 $('quoteDialog').close();
 const continuation=trialContinuation;
 try{if(!await restoreFullDraft(continuation.draft)||trialContinuation!==continuation||window.rigSessionActive?.()!==true)return;
  if(continuation.draft.seconds<=trialSeconds()){trialContinuation=null;continuationOffer=false;renderContinuation();persistTrialContinuation();guideToDuration('Je oorspronkelijke keuze was even kort als het proefje. Kies zelf een langere duur onder je video en bekijk daarna de prijs.');return;}
  reviewingFull=true;clearBriefFeedback();refreshButton();$('briefDialog').showModal();briefFeedback(`Volledige video: ${continuation.draft.seconds} seconden vanaf ${continuation.draft.start.toFixed(1)} s. ${continuationPriceNote}`);$('editPrompt').focus();
 }catch(error){if(window.rigSessionActive?.()===true)showError(error.message||'Je eerdere selectie kon niet worden hersteld.');}
}

document.addEventListener('rig-generation-busy-change',renderContinuation);
document.addEventListener('rig-prepared-ready',()=>{continuationOffer=false;renderContinuation();});
$('resultInput').addEventListener('change',event=>{if(event.target.files[0]&&acceptsMedia(event.target.files[0],'video')){lastCompletedResult=null;continuationOffer=false;renderContinuation();}});
window.rigTrialTokenForQuote=quoteId=>trialContinuation?.quoteId===quoteId?trialContinuation.token:null;
window.rigTrialDispose=()=>{cancelAutoCrop();if(restoreOperation)restoreOperation.canceled=true;trialContinuation=null;lastCompletedResult=null;continuationOffer=false;reviewingFull=false;nonTrialJobs.clear();renderContinuation();};
window.rigMotionSelected=()=>Boolean(motionFile);
document.addEventListener('rig-generation-intent',event=>{const info=event.detail;if(info?.trialToken&&trialContinuation?.token===info.trialToken){trialContinuation.quoteId=info.quoteId;trialContinuation.state='pending';persistTrialContinuation();}});
document.addEventListener('rig-generation-accepted',event=>{const info=event.detail;if(info?.trialToken&&trialContinuation?.token===info.trialToken){trialContinuation.jobId=info.id;trialContinuation.state='accepted';persistTrialContinuation();}else if(!info?.trialToken){if(info?.fromCurrent)nonTrialJobs.add(info.id);trialContinuation=null;try{window.rigScopedStorage?.removeItem(trialStorageKey);}catch{}}lastCompletedResult=null;continuationOffer=false;renderContinuation();});
document.addEventListener('rig-generation-completed',event=>{
 const id=event.detail?.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))return;
 lastCompletedResult=id;
 const trial=trialContinuation?.jobId===id,changed=trial&&Number.isInteger(trialContinuation.revision)&&trialContinuation.revision!==draftRevision;
 continuationOffer=trial&&!changed&&!nonTrialJobs.has(id);
 if(trial){trialContinuation.state='completed';persistTrialContinuation();$('resultName').textContent='Jouw proefje';$('quoteMessage').textContent=`Je proefje is klaar. ${continuationPriceNote}`;}
 if(event.detail?.popup!==false&&$('quoteDialog').open){$('quoteDialog').close();if(!changed){$('resultDisplay').scrollIntoView?.({behavior:'smooth',block:'center'});$('resultVideo').focus();}}
 showError(trial?changed?'Je proefje is klaar. Je nieuwe selectie blijft behouden.':'Je proefje is klaar. Je volledige selectie staat klaar.':'Je video is klaar.');renderContinuation();
});
document.addEventListener('rig-generation-failed',event=>{if(trialContinuation?.jobId===event.detail?.id){trialContinuation.state='failed';lastCompletedResult=null;renderContinuation();}});
readTrialContinuation();renderContinuation();
// Stable handoff for the future authenticated uploader; no automatic uploads.
window.rigPreparedMedia = () => prepared;
window.addEventListener('pagehide',()=>Object.values(urls).forEach(URL.revokeObjectURL));

$('editPrompt').value=modePrompts[modeKey()];$('duration').max=String(durationLimit());if(editing())$('duration').value='5';
updateCapabilities();
