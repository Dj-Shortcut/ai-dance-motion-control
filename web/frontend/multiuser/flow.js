'use strict';
(() => {
 window.rigFlowDispose?.();
 const el=id=>document.getElementById(id),primary=el('prepare'),screens=[...document.querySelectorAll('[data-flow-screen]')];
 if(!primary||screens.length!==4||!el('flowBack'))return;
 const binding={request:window.rigRequest,active:window.rigSessionActive},controller=new AbortController();
 let disposed=false,view='start',ready=!primary.disabled,inputsReady=false,continuation=false,lockedChoice=false,processing=false,plan='trial',fullReview=false,fullIntent=false,continuationLabel='Volledige versie maken',priceSequence=0,priceTimer=null,shareFile=null,shareSequence=0;
 const current=()=>!disposed&&window.rigRequest===binding.request&&window.rigSessionActive===binding.active&&binding.active?.()===true;
 const on=(target,type,handler,options={})=>target?.addEventListener(type,handler,{...options,signal:controller.signal});
 const source=()=>el('motionVideo'),seconds=()=>Number(el('duration').value),minimum=()=>Number(el('duration').min)||3;
 const trialSeconds=()=>window.rigGenerationQuality?.()==='human-recast'?6:5;
 const euro=cents=>new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(cents/100);
 const decimal=value=>new Intl.NumberFormat('nl-BE',{maximumFractionDigits:1}).format(value);
 const trialAllowed=()=>!fullReview&&seconds()>trialSeconds()&&Number.isFinite(source().duration)&&source().duration-Number(el('start').value)>=trialSeconds();
 function show(next,{focus=true}={}){
  if(!current())return dispose();
  view=next;render();
  if(focus){const target=['files','where'].includes(next)?el('flowTitle'):next==='result'?el('resultTitle'):document.querySelector('.intro h1');target?.setAttribute('tabindex','-1');target?.focus({preventScroll:true});window.scrollTo?.({top:0,behavior:'instant'});}
 }
 function drawPreviews(){
  for(const [from,to] of [[el('personFrame'),el('flowPhotoPreview')],[source(),el('flowVideoPreview')]]){
   if(!from||!to)continue;
   try{const width=from.videoWidth||from.width,height=from.videoHeight||from.height;if(!width||!height)continue;to.width=480;to.height=Math.round(480*height/width);to.getContext('2d').drawImage(from,0,0,to.width,to.height);}catch{}
  }
 }
 function updateClip(){
  const duration=source().duration,start=Number(el('start').value),length=seconds(),valid=Number.isFinite(duration)&&duration>0;
  const first=el('flowClipStart'),last=el('flowClipEnd');
  if(!first||!last)return;
  first.disabled=last.disabled=!valid||window.rigGenerationBusy?.()===true;
  first.min=last.min='0';first.max=last.max=valid?String(duration):'0';first.value=String(start);last.value=String(start+length);
  el('flowClipLength').textContent=`${decimal(length)} sec`;
  first.parentElement?.style.setProperty('--clip-start',valid?`${start/duration*100}%`:'0%');
  first.parentElement?.style.setProperty('--clip-end',valid?`${(start+length)/duration*100}%`:'100%');
 }
 function setClip(start,length){el('start').value=String(start);el('duration').value=String(length);el('duration').dispatchEvent(new Event('change',{bubbles:true}));el('start').dispatchEvent(new Event('change',{bubbles:true}));}
 function choose(next){if(!current()||lockedChoice)return;if(next==='trial'&&!trialAllowed())return;plan=next;renderPlans();}
 function renderPlans(){
  if(!el('chooseFullVideo'))return;
  if(!trialAllowed())plan='full';
  el('tryShortVideo').hidden=!trialAllowed();
  el('tryShortVideo').setAttribute('aria-pressed',String(plan==='trial'));
  el('chooseFullVideo').setAttribute('aria-pressed',String(plan==='full'));
  el('chooseFullVideo').disabled=lockedChoice||el('confirmBrief').disabled;
  el('flowTrialDuration').textContent=`${trialSeconds()} sec · kort proefje`;
  el('flowFullDuration').textContent=`${decimal(seconds())} sec · zoals gekozen`;
 }
 function render(){
  if(!current())return dispose();
  document.body.dataset.flowView=view;
  for(const screen of screens)screen.hidden=screen.dataset.flowScreen!==view;
  const navigating=view==='files'||view==='where';
  el('flowNavigation').hidden=!navigating;
  const step=view==='files'?1:view==='where'?2:3;
  el('flowStep').textContent=`Stap ${step} van 3`;
  el('flowTitle').textContent=view==='files'?'Kies je foto en video':'Waar moet het gebeuren?';
  for(const [index,bar] of [...el('flowProgress').children].entries())bar.dataset.complete=String(index<step);
  primary.hidden=view==='make'||view==='result'&&!continuation;
  if(view==='start'){primary.textContent='Probeer met je eigen foto';primary.disabled=false;}
  else if(view==='files'){primary.textContent='Verder';primary.disabled=!inputsReady;}
  else if(view==='where'){
   primary.textContent='Verder';primary.disabled=!ready;
   const qualities=Array.isArray(window.rigVideoQualities)?window.rigVideoQualities:[];
   el('videoModeTabs').hidden=false;
   el('motionModeButton').hidden=!qualities.some(value=>value==='standard'||value==='pro');
   el('editModeButton').hidden=!qualities.some(value=>value==='edit-standard'||value==='human-recast');
   drawPreviews();
  }
  else if(view==='result'){primary.textContent=continuationLabel;primary.disabled=!ready;}
  const footer=primary.closest('footer');if(footer)footer.hidden=view==='make';
  el('newVideo').hidden=view!=='result'||processing;
  if(view==='result'){
   if(processing)el('resultTitle').textContent='Je video wordt gemaakt';
   el('newVideo').disabled=window.rigGenerationBusy?.()===true||!!window.rigScopedStorage?.getItem('rig-generation-job')||!!window.rigScopedStorage?.getItem('rig-generation-pending');
  }
  updateClip();renderPlans();
 }
 function refresh(value={}){
  if(typeof value.ready==='boolean')ready=value.ready;
  if(typeof value.inputsReady==='boolean')inputsReady=value.inputsReady;
  if(typeof value.lockedChoice==='boolean')lockedChoice=value.lockedChoice;
  if(typeof value.continuation==='boolean')continuation=value.continuation;
  if(['Volledige versie maken','Verder met deze video'].includes(value.continuationLabel))continuationLabel=value.continuationLabel;
  render();
 }
 function schedulePrices(){
  clearTimeout(priceTimer);const sequence=++priceSequence;
  for(const id of ['flowTrialPrice','flowFullPrice'])if(el(id))el(id).textContent='Prijs ophalen…';
  if(view!=='make')return;
  priceTimer=setTimeout(()=>void loadPrices(sequence),250);
 }
 async function loadPrices(sequence){
  const quality=window.rigGenerationQuality?.(),full=seconds(),trial=trialSeconds();
  if(!current()||!quality||!Number.isInteger(full))return;
  if(el('cleanupEnabled')?.checked){for(const id of ['flowTrialPrice','flowFullPrice'])el(id).textContent='Na maskercontrole';return;}
  await Promise.allSettled([['flowTrialPrice',trial],['flowFullPrice',full]].map(async([id,duration])=>{
   if(id==='flowTrialPrice'&&!trialAllowed())return;
   try{
    const response=await binding.request(`/api/estimate/fal?${new URLSearchParams({quality,duration:String(duration)})}`,{cache:'no-store'});
    const value=await response.json();
    if(!current()||sequence!==priceSequence)return;
    if(!response.ok||value.quality!==quality||value.durationSeconds!==duration)throw Error();
    if(window.rigVideoFunding==='owner-provider'){
     const amount=value.providerEstimate?.usdMicros;
     if(value.funding!=='owner-provider'||value.providerEstimate?.currency!=='USD'||value.providerEstimate.binding!==false||!Number.isSafeInteger(amount)||amount<1||value.billedSeconds!==Math.ceil(duration))throw Error();
     el(id).textContent='≈ '+new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD'}).format(amount/1000000);
    }else{
     const offer=value.customerProposal;
     if(!['credits','sponsored'].includes(window.rigVideoFunding)||offer?.currency!=='EUR'||offer.binding!==false||!Number.isSafeInteger(offer.priceCents)||offer.priceCents<1)throw Error();
     el(id).textContent='≈ '+euro(offer.priceCents);
    }
   }catch{if(current()&&sequence===priceSequence)el(id).textContent='Na controle van je fragment';}
  }));
 }
 function openMake({full=false}={}){fullReview=full||fullIntent;plan=fullReview||!trialAllowed()?'full':'trial';show('make',{focus:false});schedulePrices();}
 function showProcessing(){processing=true;shareSequence++;shareFile=null;el('shareResult').hidden=true;el('export').hidden=true;el('resultVideo').pause();el('resultVideo').hidden=true;el('resultEmpty').hidden=false;el('newVideo').hidden=true;show('result',{focus:false});el('quoteDialog').classList.add('flow-processing');}
 async function prepareShare(){
  const sequence=++shareSequence;shareFile=null;el('shareResult').hidden=true;
  if(typeof navigator.share!=='function'||typeof navigator.canShare!=='function')return;
  const url=el('resultVideo').src;if(!url.startsWith('blob:'))return;
  try{const response=await fetch(url);const blob=await response.blob();if(!current()||processing||sequence!==shareSequence||el('resultVideo').src!==url||blob.size<1||blob.size>64*1024*1024)return;const file=new File([blob],'RIG-video.mp4',{type:'video/mp4'});if(navigator.canShare({files:[file]})){shareFile=file;el('shareResult').hidden=false;}}catch{}
 }
 on(primary,'click',event=>{
  if(primary.disabled||!current())return;
  if(view==='files'&&fullIntent&&continuation&&continuationLabel==='Volledige versie maken'){event.stopImmediatePropagation();void window.rigResumeFullDraft?.();return;}
  if(view==='start'||view==='files'){event.stopImmediatePropagation();show(view==='start'?'files':'where');return;}
  if(view==='where'){openMake();return;}
 },{capture:true});
 on(el('flowBack'),'click',()=>show(view==='where'?'files':'start'));
 on(el('closeBrief'),'click',()=>{if(!el('closeBrief').disabled){const back=fullReview?'result':'where';fullReview=false;show(back);}},{capture:true});
 on(el('briefDialog'),'cancel',event=>{if(!event.defaultPrevented){const back=fullReview?'result':'where';fullReview=false;show(back);}});
 on(el('tryShortVideo'),'click',event=>{event.stopImmediatePropagation();choose('trial');},{capture:true});
 on(el('chooseFullVideo'),'click',()=>choose('full'));
 on(el('confirmBrief'),'click',event=>{event.stopImmediatePropagation();if(!el('confirmBrief').disabled&&current())void window.rigPrepareChoice?.(plan==='trial');},{capture:true});
 on(el('flowClipStart'),'input',()=>{
  const end=Number(el('start').value)+seconds(),maximum=Number(el('duration').max);
  const requested=Math.max(0,end-maximum,Math.min(Number(el('flowClipStart').value),end-minimum(),source().duration-minimum()));
  const duration=Math.max(minimum(),Math.min(maximum,Math.floor(end-requested))),start=end-duration;
  setClip(start,duration);
 });
 on(el('flowClipEnd'),'input',()=>{el('duration').value=String(Math.max(minimum(),Math.min(Number(el('duration').max),Math.floor(Number(el('flowClipEnd').value)-Number(el('start').value)))));el('duration').dispatchEvent(new Event('change',{bubbles:true}));});
 on(el('flowClipStart'),'keydown',event=>{
  if(!current()||el('flowClipStart').disabled||event.altKey||event.ctrlKey||event.metaKey)return;
  const delta={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-5,PageUp:5};
  if(!Object.hasOwn(delta,event.key)&&!['Home','End'].includes(event.key))return;
  event.preventDefault();const end=Number(el('start').value)+seconds(),max=Math.floor(Math.min(Number(el('duration').max),end));
  const requested=event.key==='Home'?max:event.key==='End'?minimum():seconds()-delta[event.key],length=Math.max(minimum(),Math.min(max,requested));
  setClip(end-length,length);
 });
 // A tenth-second native key step would be rounded back to the same whole
 // generation duration. Give keyboard users the same usable one-second edits.
 on(el('flowClipEnd'),'keydown',event=>{
  if(!current()||el('flowClipEnd').disabled||event.altKey||event.ctrlKey||event.metaKey)return;
  const delta={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-5,PageUp:5};
  if(!Object.hasOwn(delta,event.key)&&!['Home','End'].includes(event.key))return;
  event.preventDefault();const max=Math.floor(Math.min(Number(el('duration').max),source().duration-Number(el('start').value)));
  const requested=event.key==='Home'?minimum():event.key==='End'?max:seconds()+delta[event.key];
  el('duration').value=String(Math.max(minimum(),Math.min(max,requested)));el('duration').dispatchEvent(new Event('change',{bubbles:true}));
 });
 for(const id of ['start','duration','cleanupEnabled'])on(el(id),'change',()=>{updateClip();if(view==='make')schedulePrices();});
 on(source(),'loadedmetadata',()=>queueMicrotask(updateClip));on(source(),'seeked',drawPreviews);
 on(el('newVideo'),'click',()=>{if(window.rigNewDraft?.()!==false){fullReview=false;fullIntent=false;shareSequence++;shareFile=null;show('start');}});
 on(el('shareResult'),'click',async()=>{if(!current()||!shareFile)return;try{await navigator.share({files:[shareFile],title:'Mijn RIG-video'});}catch(error){if(error.name!=='AbortError')el('status').textContent='Delen lukte niet. Je kunt de video bewaren.';}});
 on(document,'rig-generation-mode-change',()=>{drawPreviews();if(view==='make')schedulePrices();});
 // Closing an unpaid preparation/price pop-out returns to the same make
 // screen. Queue this check so an upload-to-quote transition stays intact.
 for(const id of ['uploadDialog','quoteDialog'])on(el(id),'close',()=>queueMicrotask(()=>{
  if(!current()||view!=='make'||processing||window.rigGenerationBusy?.()===true||document.querySelector('dialog[open]'))return;
  show('make',{focus:false});el('briefDialog').showModal();schedulePrices();
 }));
 on(document,'rig-generation-accepted',showProcessing);
 on(document,'rig-generation-completed',()=>{processing=false;el('quoteDialog').classList.remove('flow-processing');el('newVideo').hidden=false;show('result');void prepareShare();});
 on(document,'rig-generation-failed',()=>{processing=false;el('quoteDialog').classList.remove('flow-processing');el('newVideo').hidden=false;show('result',{focus:false});});
 const observer=new MutationObserver(()=>{
  if(!current())return;
  if(el('briefDialog').open&&view!=='make')openMake({full:el('tryShortVideo').hidden});
  if(el('quoteDialog').open&&!el('checkGeneration').hidden&&el('confirmGeneration').hidden)showProcessing();
 });
 observer.observe(el('briefDialog'),{attributes:true,attributeFilter:['open']});
 observer.observe(el('checkGeneration'),{attributes:true,attributeFilter:['hidden']});
 function dispose(){if(disposed)return;disposed=true;controller.abort();observer.disconnect();clearTimeout(priceTimer);priceSequence++;shareSequence++;shareFile=null;if(window.rigFlow===api)delete window.rigFlow;if(window.rigFlowDispose===dispose)delete window.rigFlowDispose;}
 const api={refresh,openFullReview:()=>{fullIntent=false;openMake({full:true});},revealFiles:({advanced=false,full=false}={})=>{fullIntent=full;show('files',{focus:false});el('flowAdvanced').open=advanced;},dispose};window.rigFlow=api;window.rigFlowDispose=dispose;
 on(window,'pagehide',dispose);on(el('authLogout'),'click',dispose);render();
})();
