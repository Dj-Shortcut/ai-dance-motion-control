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
const qualityUnavailableMessage='Je gekozen kwaliteit is nu niet beschikbaar. Kies zelf een kwaliteit in Instellingen.';
const editUnavailableMessage='Videobewerking is nu niet beschikbaar. Kies zelf een ander videotype of probeer later opnieuw.';
const modeDurations={motion:null,edit:5,'human-recast':6};
const modeSound={motion:true,edit:true,'human-recast':true};
let selectedEditQuality=null;
const defaultPrompts={motion:"Laat de persoon of het dier op mijn foto de bewegingen uit de video natuurlijk nadoen. Behoud het uiterlijk van mijn foto.",edit:"Vervang de hoofdpersoon in de video door de persoon of het dier op mijn foto. Behoud de bewegingen, de timing, de achtergrond en de camera van de video."};
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
let mainReferenceBlob=null, faceReferenceBlob=null, angleReferenceBlobs=[], referenceRevision=0;const referenceWork={capture:null,face:null,angles:null},thumbBlobs={};
const referencesBusy=()=>Object.values(referenceWork).some(Boolean);
function referenceThumb(id,blob){const angle=id.startsWith('angle'),item=$(angle?'angleReference'+id.slice(5):id+'Reference'),img=$(angle?'angleThumb'+id.slice(5):id+'Thumb');item.hidden=!blob;if(thumbBlobs[id]===blob)return;thumbBlobs[id]=blob;if(blob)img.src=setURL('ref-'+id,blob);else {if(typeof img.removeAttribute==='function')img.removeAttribute('src');else img.src='';if(urls['ref-'+id]){URL.revokeObjectURL(urls['ref-'+id]);delete urls['ref-'+id]}}}
function renderReferences(){
 const recast=recasting(),limit=angleLimit();$('referencePanel').hidden=!personFile;$('moreOptions').hidden=$('referencePanel').hidden;
 $('referenceOptionsTitle').textContent=recast?'Hoofdbeeld kiezen':'Meer opties: close-up en hoeken';$('referenceFiles').hidden=recast;$('recastReferenceNote').hidden=!recast;
 referenceThumb('main',mainReferenceBlob);referenceThumb('face',faceReferenceBlob);for(let i=0;i<3;i++)referenceThumb('angle'+i,angleReferenceBlobs[i]||null);
 if(recast){$('faceReference').hidden=true;for(let i=0;i<3;i++)$('angleReference'+i).hidden=true;}
 $('captureFace').hidden=recast;$('captureAngle').hidden=recast;
 $('captureAngle').disabled=recast||busy||referencesBusy()||!imageSource||!faceReferenceBlob||angleReferenceBlobs.length>=limit;
 $('captureMain').disabled=busy||referencesBusy()||!imageSource;$('captureFace').disabled=recast||busy||referencesBusy()||!imageSource;
 $('referenceHint').textContent=recast?'Alleen je hoofdbeeld wordt gebruikt.':!personFile?.type.startsWith('video/')?'Voeg een close-up en andere hoeken toe.':!mainReferenceBlob?'Kies een beeld en zet het vast als hoofdbeeld.':!faceReferenceBlob?'Kies een close-up met de schuif.':angleReferenceBlobs.length>limit?`Kies maximaal ${limit} hoeken voor deze bewerking.`:angleReferenceBlobs.length<limit?`Kies maximaal ${limit} hoeken met de schuif.`:'Referenties klaar.';
}
function clearReferences(){referenceRevision++;for(const key of Object.keys(referenceWork))referenceWork[key]=null;mainReferenceBlob=null;faceReferenceBlob=null;angleReferenceBlobs=[];$('faceInput').value='';$('anglesInput').value='';renderReferences();$('referenceStatus').textContent=''}
async function captureReference(kind){
 if(!imageSource||busy||referencesBusy()||recasting()&&kind!=='main'||kind==='angle'&&(!faceReferenceBlob||angleReferenceBlobs.length>=angleLimit()))return;
 const token={};referenceWork.capture=token;invalidate();renderReferences();
 const revision=referenceRevision,source=imageSource,crop={...crops.person};
 try{
  const image=await window.rigMedia.prepareImage(source,crop);
  if(image.width<340||image.height<340||image.width/image.height<0.4||image.width/image.height>2.5)throw Error('Kies een duidelijk beeld van minstens 340 × 340 pixels.');
  if(revision!==referenceRevision||referenceWork.capture!==token)return;
  if(kind==='main')mainReferenceBlob=image.blob;else if(kind==='face')faceReferenceBlob=image.blob;else if(angleReferenceBlobs.length<angleLimit())angleReferenceBlobs.push(image.blob);
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
$('removeMain').addEventListener('click',()=>{referenceRevision++;mainReferenceBlob=null;invalidate();renderReferences()});$('removeFace').addEventListener('click',()=>{referenceRevision++;referenceWork.face=null;faceReferenceBlob=null;$('faceInput').value='';invalidate();renderReferences()});
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
function invalidate(){draftRevision++;document.dispatchEvent(new Event('rig-prepared-change'));prepared=null;$('previewPrepared').hidden=true;if(urls.prepared){URL.revokeObjectURL(urls.prepared);delete urls.prepared}refreshButton()}
// Server capability controls the interface; the server enforces authorization.
function refreshButton(){const enabled=window.rigVideoEnabled===true&&window.rigSessionActive?.()===true&&availableQualities().includes(selectedQuality());const promptReady=$('editPrompt').value.trim().length>0;$('prepare').disabled=!enabled||busy||referencesBusy()||!imageSource||!motionFile;$('prepare').textContent=enabled?(prepared?'Verder':'Maak video'):'Nog niet beschikbaar';$('confirmBrief').disabled=!enabled||busy||referencesBusy()||!promptReady;$('confirmBrief').textContent=prepared?'Verder':'Bekijk de prijs';const start=Number($('start').value),remaining=$('motionVideo').duration-start,hasTrial=!!motionFile&&Number.isFinite(start)&&start>=0&&Number.isFinite(remaining)&&remaining>=trialSeconds()-1e-7;$('tryShortVideo').disabled=!enabled||busy||referencesBusy()||!imageSource||!promptReady||!hasTrial;$('shortTrialHint').hidden=!motionFile||hasTrial;$('motionModeButton').disabled=busy||!availableQualities().some(q=>q==='standard'||q==='pro');$('editModeButton').disabled=busy||!editAvailable();}
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
 renderReferences();refreshButton();renderIdeas();
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
// Idea tiles only preset the video type and description; files stay the user's own choice.
function ideaEditQuality(tile){return tile.dataset.ideaSubject==='animal'?'edit-standard':preferredEditQuality();}
function renderIdeas(){const prompt=$('editPrompt').value;let visible=0;for(const tile of document.querySelectorAll('[data-idea-mode]')){const mode=tile.dataset.ideaMode,available=mode==='edit'?availableQualities().includes(ideaEditQuality(tile)):availableQualities().some(q=>q==='standard'||q==='pro');tile.hidden=!available;tile.disabled=busy;if(available)visible++;tile.setAttribute('aria-pressed',String(available&&mode===videoMode&&(mode!=='edit'||selectedQuality()===ideaEditQuality(tile))&&tile.dataset.ideaPrompt===prompt));}const panel=document.querySelector('.ideas-panel');if(panel)panel.hidden=visible===0;}
function chooseIdea(tile){if(busy)return;const mode=tile.dataset.ideaMode,quality=mode==='edit'?ideaEditQuality(tile):undefined;if(mode==='edit'&&!availableQualities().includes(quality))return;setMode(mode,{quality});if(videoMode!==mode||mode==='edit'&&selectedQuality()!==quality)return;$('editPrompt').value=tile.dataset.ideaPrompt;modePrompts[modeKey()]=tile.dataset.ideaPrompt;invalidate();renderIdeas();showError(!personFile?'Idee gekozen. Kies nu een foto.':!motionFile?'Idee gekozen. Kies nu een video.':'Idee gekozen. Druk op Maak video.');if(!personFile)$('personStepTitle').scrollIntoView?.({behavior:'smooth',block:'start'});}
for(const tile of document.querySelectorAll('[data-idea-mode]'))tile.addEventListener('click',()=>chooseIdea(tile));
const promptChanged=()=>{clearBriefFeedback();modePrompts[modeKey()]=$('editPrompt').value;invalidate();renderIdeas();};
$('editPrompt').addEventListener('input',promptChanged);$('editPrompt').addEventListener('change',promptChanged);
document.addEventListener('rig-video-availability',updateCapabilities);
for(const [button,input] of [['personChoose','personInput'],['personName','personInput'],['motionChoose','motionInput'],['motionName','motionInput'],['resultName','resultInput']]) $(button).addEventListener('click',()=>$(input).click());
$('previewPrepared').addEventListener('click',()=>{if(!prepared||!urls.prepared)return;$('preparedVideo').src=urls.prepared;$('downloadPrepared').href=urls.prepared;$('preparedDialog').showModal()});
$('preparedDialog').addEventListener('close',()=>$('preparedVideo').pause());
$('settingsToggle').addEventListener('click',()=>{$('settings').showModal();$('settingsToggle').setAttribute('aria-expanded','true')});
$('settings').addEventListener('close',()=>$('settingsToggle').setAttribute('aria-expanded','false'));
function drawImage(source){const c=$('personFrame'); const w=source.videoWidth||source.naturalWidth; const h=source.videoHeight||source.naturalHeight;if(!w||!h)return;imageSource=source;window.rigMedia.paint(c,source,crops.person,1280,1280);c.hidden=false;$('personChoose').hidden=true;$('personCropButton').hidden=false;refreshButton();renderReferences()}
$('personInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'media'))return;personFile=file;imageSource=null;crops.person=fullCrop();clearReferences();invalidate();$('referencePanel').hidden=false;$('referenceCapture').hidden=!file.type.startsWith('video/');const url=setURL('person',file);$('personName').textContent=file.name;$('personName').title=file.name;$('frameControl').hidden=true;$('personFrame').hidden=true;$('personCropButton').hidden=true;if(file.type.startsWith('video/')){const video=$('personVideo');video.src=url;video.onloadedmetadata=()=>{if(personFile!==file)return;if(!Number.isFinite(video.duration)||video.duration<=0){showError('Deze video kon niet worden gelezen.');return}$('frameTime').max=Math.max(0,video.duration-0.01);$('frameTime').value=0;$('frameOutput').textContent='0.0 s';$('frameControl').hidden=false;video.currentTime=Math.min(0.01,video.duration)};video.onseeked=()=>{if(personFile===file)drawImage(video)};video.onloadeddata=()=>{if(personFile===file)drawImage(video)};video.onerror=()=>{if(personFile===file)showError('Deze video kan niet worden geopend in je browser.')}}else{let image=new Image();image.onload=()=>{if(personFile===file)drawImage(image)};image.onerror=()=>{if(personFile===file)showError('Deze afbeelding kan niet worden geopend.')};image.src=url}if(needsRecastFrame()){$('moreOptions').open=true;showError(recastFrameHint);}else showError(motionFile?'Klaar? Druk op Maak video.':'Kies nu een video.')});
$('frameTime').addEventListener('input',event=>{const time=Number(event.target.value);$('frameOutput').textContent=`${time.toFixed(1)} s`;imageSource=null;invalidate();$('personVideo').currentTime=time;if(!$('personVideo').seeking)drawImage($('personVideo'))});
$('motionInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'video'))return;motionFile=null;crops.motion=fullCrop();invalidate();$('motionCropped').hidden=true;$('motionCropControls').hidden=true;const video=$('motionVideo');video.pause();video.src=setURL('motion',file);video.hidden=false;$('motionChoose').hidden=true;$('motionName').textContent=file.name;$('motionName').title=file.name;video.onloadedmetadata=()=>{if(motionFile===file)return;if(!Number.isFinite(video.duration)||video.duration<3){showError('Kies een video van minstens 3 seconden.');return}motionFile=file;$('trim').hidden=false;$('start').value=0;$('start').max=Math.max(0,Math.floor((video.duration-3)*10+1e-7)/10);$('duration').setCustomValidity('');modeDurations.motion=null;modeDurations.edit=5;modeDurations['human-recast']=6;$('duration').max=Math.min(durationLimit(),Math.floor(video.duration));$('duration').value=editing()?String(Math.max(durationMinimum(),Math.min(trialSeconds(),Number($('duration').max)))):$('duration').max;updateStartMax();$('motionSeek').max=video.duration;updateMotionPreview();$('motionCropButton').hidden=false;refreshButton()};video.onerror=()=>showError('Deze video kan niet worden geopend in je browser.');showError(personFile?'Klaar? Druk op Maak video.':'Kies nu een foto.')});
for(const id of ['start','duration'])$(id).addEventListener('focus',e=>e.target.select());function updateStartMax(){const v=$('motionVideo'),duration=Number($('duration').value);if(!Number.isFinite(v.duration)||!Number.isInteger(duration)||duration<durationMinimum()||duration>durationLimit())return null;const max=Math.max(0,Math.floor((v.duration-duration)*10+1e-7)/10);$('start').max=String(max);return max}function applyStart(value){const v=$('motionVideo'),max=updateStartMax();if(max===null||!Number.isFinite(value))return;const start=Math.min(max,Math.max(0,value));$('start').value=String(start);v.currentTime=start} $('start').addEventListener('change',()=>{if($('start').value!=='')applyStart(Number($('start').value));invalidate()});$('useCurrentStart').addEventListener('click',()=>{const v=$('motionVideo');if(!Number.isFinite(v.currentTime)||!Number.isFinite(v.duration))return;$('start').value=String(Math.floor(v.currentTime*10)/10);$('start').dispatchEvent(new Event('change',{bubbles:true}));});$('duration').addEventListener('change',()=>{const input=$('duration'),value=Number(input.value),max=Number(input.max);if(!Number.isInteger(value)||value<durationMinimum()||value>durationLimit()||value>max){const msg=`Kies een duur van ${durationMinimum()} tot ${Math.min(durationLimit(),max)} seconden.`;showError(msg);input.setCustomValidity(msg)}else{input.setCustomValidity('');const startMax=updateStartMax();if(startMax!==null&&Number($('start').value)>startMax)applyStart(startMax)}invalidate()});$('sound').addEventListener('change',()=>{modeSound[modeKey()]=$('sound').checked;invalidate();});$('steady').addEventListener('change',invalidate);for(const r of document.querySelectorAll('input[name=quality]'))r.addEventListener('change',invalidate);
$('resultInput').addEventListener('change',event=>{const file=event.target.files[0];if(!file||rejectMedia(event.target,file,'video'))return;const url=setURL('result',file);$('resultVideo').src=url;$('resultVideo').hidden=false;$('resultEmpty').hidden=true;$('resultName').textContent=file.name;$('export').href=url;$('export').download=file.name;$('export').hidden=false});
$('backgroundInput').addEventListener('change',e=>{$('backgroundName').textContent=e.target.files[0]?.name||'Nog niet beschikbaar';invalidate()});
$('faceInput').addEventListener('change',e=>importReferences('face',[...e.target.files]));
$('anglesInput').addEventListener('change',e=>importReferences('angles',[...e.target.files]));
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
$('applyCrop').addEventListener('click',()=>{try{window.rigMedia.bounds(cropValues());crops[cropTarget]=cropValues();$('cropDialog').close();invalidate();if(cropTarget==='person'&&imageSource)drawImage(imageSource);else if(cropTarget==='motion')updateMotionPreview();showError(cropTarget==='person'&&mainReferenceBlob?'Uitsnede gekozen. Zet het hoofdbeeld opnieuw vast als je deze uitsnede wilt gebruiken.':'Uitsnede gekozen. Bereid de beelden opnieuw voor.')}catch(e){$('cropError').textContent=e.message}});
function clearBriefFeedback(){
 $('briefError').textContent='';$('briefError').hidden=true;$('correctBriefDuration').hidden=true;
}
function briefFeedback(message){if($('briefError').textContent!==message)$('briefError').textContent=message;$('briefError').hidden=false;showError(message);}
function availableBriefDuration(){
 const start=Number($('start').value),sourceDuration=$('motionVideo').duration;
 return Number.isFinite(start)&&start>=0&&Number.isFinite(sourceDuration)?Math.min(durationLimit(),Math.floor(sourceDuration-start+1e-7)):0;
}
async function prepareWithPrompt(){
 if(window.rigVideoEnabled!==true||window.rigSessionActive?.()!==true||busy||referencesBusy()||!imageSource||!motionFile)return;
 clearBriefFeedback();
 const edit=editing(),quality=selectedQuality(),prompt=$('editPrompt').value.trim(),start=Number($('start').value),duration=Number($('duration').value),limit=edit?15:30,max=availableBriefDuration();
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
 if(prepared&&prepared.prompt===prompt&&prepared.quality===quality){$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));return;}
 busy=true;$('briefDialog').setAttribute('aria-busy','true');const disabledBefore=new Map();for(const el of document.querySelectorAll('button,input,textarea')){disabledBefore.set(el,el.disabled);el.disabled=true;}
 refreshButton();invalidate();const revision=draftRevision;let complete=false;
 try{
  briefFeedback('Beeld voorbereiden…');const image=mainReferenceBlob?{blob:mainReferenceBlob}:await window.rigMedia.prepareImage(imageSource,crops.person);
  briefFeedback('Video voorbereiden… Houd RIG in beeld.');
  const progress=p=>briefFeedback(`Video voorbereiden… ${Math.round(p*100)}% · Houd RIG in beeld.`);
  const video=edit?await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress,{minSide:720,maxDuration:15}):await window.rigMedia.prepareVideo($('motionVideo'),crops.motion,start,duration,$('sound').checked,progress);
  if(revision!==draftRevision||editing()!==edit||window.rigSessionActive?.()!==true)throw Error('Je instellingen zijn gewijzigd. Bereid je beelden opnieuw voor.');
  prepared={image,video,face:recasting()?null:faceReferenceBlob,angles:recasting()?[]:[...angleReferenceBlobs],quality,keepSound:$('sound').checked,steady:edit?false:$('steady').checked,prompt};
  setURL('prepared',video.blob);$('previewPrepared').hidden=false;showError('Beelden lokaal voorbereid.');complete=true;
 }catch(e){briefFeedback(e.message||'Voorbereiden is mislukt.');}
 finally{for(const [el,wasDisabled] of disabledBefore)el.disabled=wasDisabled;busy=false;$('briefDialog').setAttribute('aria-busy','false');updateCapabilities();}
 if(complete){clearBriefFeedback();$('briefDialog').close();document.dispatchEvent(new Event('rig-prepared-ready'));}
}
$('prepare').addEventListener('click',()=>{if($('prepare').disabled||busy)return;clearBriefFeedback();refreshButton();$('briefDialog').showModal();$('editPrompt').focus();});
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
 // Reuse the reviewed preparation and price flow. This only shortens the
 // fragment: its chosen start, crop, description and generation consent stay.
 $('duration').value=String(trialSeconds());$('duration').setCustomValidity('');modeDurations[modeKey()]=trialSeconds();
 $('duration').dispatchEvent(new Event('change',{bubbles:true}));
 prepareWithPrompt();
});
$('closeBrief').addEventListener('click',()=>{if(!busy)$('briefDialog').close();});
$('briefDialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
// Stable handoff for the future authenticated uploader; no automatic uploads.
window.rigPreparedMedia = () => prepared;
window.addEventListener('pagehide',()=>Object.values(urls).forEach(URL.revokeObjectURL));

$('editPrompt').value=modePrompts[modeKey()];$('duration').max=String(durationLimit());if(editing())$('duration').value='5';
updateCapabilities();
