'use strict';
(() => {
  const el = id => document.getElementById(id);
  const currency = n => new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(n/100);
  const falTransferPolicy = 'fal-temporary-links-v1';
  const falTransferNotice = 'Voor deze bewerking gebruikt Fal tijdelijke links voor je foto, bronvideo en resultaat (24 uur). Iedereen met zo’n link kan die bestanden openen. Met ‘Bevestig videobewerking’ ga je daarmee akkoord.';
  let quote = null, active = false, recentId=null;
  const note = text => { el('quoteMessage').textContent = text; };
  const refreshBalance = () => document.dispatchEvent(new Event('rig-balance-changed'));
  function providerFailureMessage(data){
    if(data.state!=='failed')return null;
    const reason=data.failureCode==='provider_input_unavailable'?'Fal kon je foto of video niet openen.':data.failureCode==='provider_subject_not_detected'?'Fal herkende geen duidelijk menselijk bovenlichaam op je foto.':null;
    return reason?reason+(data.refundConfirmed===true?' Je RIG-tegoed is teruggezet.':' Je RIG-tegoed wordt nog gecontroleerd. Start de opdracht niet opnieuw.'):null;
  }
  function showReviewedType(quality){const edit=quality==='edit-standard';el('quoteTitle').textContent=edit?'Video bewerken':'Persoon laten bewegen';el('confirmGeneration').textContent=edit?'Bevestig videobewerking':'Bevestig persoonsvideo';}
  async function call(path, options={}) {
    const response=await window.rigRequest(path,{credentials:'same-origin',cache:'no-store',...options});
    let data; try { data=await response.json(); } catch { throw new Error('De dienst is momenteel niet beschikbaar.'); }
    if (!response.ok) { const error=new Error(data.error || 'De dienst is momenteel niet beschikbaar.'); error.status=response.status;if([400,409].includes(response.status)&&data.code==='subject_rejected'&&data.generationStarted===false){error.code='subject_rejected';error.generationStarted=false;}throw error; }
    return data;
  }
  const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
  async function upload(kind, blob, options={}) {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > 16*1024*1024) throw new Error('Een bestand is leeg of groter dan 16 MB.');
    const headers={'Content-Type':blob.type || 'application/octet-stream','X-Rig-Asset-Kind':kind};
    if(kind==='video'){if(!Number.isInteger(options.duration)||options.duration<3||options.duration>(options.maxDuration??30))throw new Error('Kies een geldig fragment.');headers['X-Rig-Duration-Seconds']=String(options.duration);headers['X-Rig-Keep-Sound']=String(options.keepSound===true);}
    let data = await call('/api/assets',{method:'POST',headers,body:blob});
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(data.id || '')) throw new Error('Het bestand kon niet worden gecontroleerd.');
    const id=data.id;
    for (let attempts=0;data.status==='processing' && attempts<60;attempts++) {
      await delay(2000); data=await call(`/api/assets/${encodeURIComponent(id)}`);
      if (data.id!==id) throw new Error('Het bestand kon niet worden gecontroleerd.');
    }
    if (data.status!=='ready' || data.kind && data.kind!==kind) throw new Error('Het bestand is nog niet klaar voor gebruik.');
    return id;
  }
  async function getQuote() {
    if(active)return;if(window.rigScopedStorage.getItem('rig-generation-pending') || window.rigScopedStorage.getItem('rig-generation-job')){el('uploadDialog').close();el('quoteDialog').showModal();note('Er is al een opdracht gestart. Controleer eerst de status.');el('checkGeneration').hidden=false;return;}const media=window.rigPreparedMedia();if(!media){note('Bereid eerst je beelden voor.');return;}
    active=true;quote=null;el('confirmUpload').disabled=true;el('uploadDialog').close();el('quoteDialog').showModal();el('confirmGeneration').hidden=true;
    showReviewedType(media.quality);
    try {
      const edit=media.quality==='edit-standard',limit=edit?15:30;
      if(edit&&(!Array.isArray(window.rigVideoQualities)||!window.rigVideoQualities.includes('edit-standard')))throw new Error('Video bewerken is momenteel niet beschikbaar.');
      const seconds=Number(el('duration').value);if(!Number.isInteger(seconds)||seconds<3||seconds>limit)throw new Error(`Kies een geheel aantal seconden tussen 3 en ${limit}.`);
      if(!media.prompt?.trim()||media.prompt.trim().length>1900)throw new Error('Beschrijf eerst kort wat je wilt maken.');
      if(edit&&(media.face||media.angles.length||media.steady))throw new Error('Beschrijf je videobewerking zonder extra hoeken of camera-instelling.');
      if(media.angles.length && !media.face) throw new Error('Kies eerst een close-up voor de extra hoeken.');
      note('Je bestanden worden veilig voorbereid…');
      const imageId=await upload('image',media.image.blob),videoId=await upload('video',media.video.blob,{duration:seconds,keepSound:media.keepSound,maxDuration:limit});
      const faceId=media.face ? await upload('face',media.face) : null;
      const angleIds=[];for(const angle of media.angles)angleIds.push(await upload('angle',angle));
      if(window.rigPreparedMedia()!==media)throw new Error('Je instellingen zijn gewijzigd. Bereid je bestanden opnieuw voor.');
      const request={imageId,videoId,quality:media.quality,keepSound:media.keepSound,prompt:media.prompt,...(edit?{transferPolicy:falTransferPolicy}:{faceId,angleIds,steadyCamera:media.steady})};
      const data=await call('/api/generation-quotes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||'')||!Number.isSafeInteger(data.priceCents)||data.priceCents<1||data.currency!=='EUR'||!Number.isFinite(data.durationSeconds)||!Number.isInteger(data.billedSeconds)||data.billedSeconds!==Math.ceil(data.durationSeconds))throw new Error('De prijs kon niet worden bevestigd.');
      if(data.quality!==undefined&&data.quality!==media.quality||data.durationSeconds>limit)throw new Error('De prijs hoort niet bij je gekozen videobewerking.');
      if(edit&&data.transferPolicy!==falTransferPolicy||!edit&&data.transferPolicy!==undefined)throw new Error('De bestandsoverdracht kon niet worden bevestigd. Bereid je bestanden opnieuw voor.');
      const hasApproval=Object.hasOwn(data,'approvalToken')||Object.hasOwn(data,'idempotencyKey');
      if(hasApproval&&(!/^[A-Za-z0-9_-]{43}$/.test(data.approvalToken||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(data.idempotencyKey||'')))throw new Error('De prijsbevestiging is niet beschikbaar. Bereid je bestanden opnieuw voor.');
      const approved={...(hasApproval?{approvalToken:data.approvalToken,idempotencyKey:data.idempotencyKey}:{}),...(edit?{transferPolicy:falTransferPolicy}:{})};
      if(window.rigVideoFunding==='sponsored'){
        const status=await call('/api/sponsor-invitations/status');
        if(status?.state!=='eligible'||!Number.isSafeInteger(status.remainingCents)||status.remainingCents<0||status.remainingCents>500)throw new Error('Je gratis testtegoed kon niet worden gecontroleerd.');
        if(window.rigPreparedMedia()!==media)throw new Error('Je instellingen zijn gewijzigd. Bereid je bestanden opnieuw voor.');
        if(data.priceCents>status.remainingCents){note(`Deze video kost ${currency(data.priceCents)}. Je hebt ${currency(status.remainingCents)} gratis testtegoed; dat is niet voldoende. Kies een korter fragment of een andere kwaliteit.`);return;}
        if(window.rigNativeSite===true&&!hasApproval){note(`Deze video kost ${currency(data.priceCents)}. De prijsbevestiging is momenteel niet beschikbaar. Bereid je bestanden opnieuw voor.`);return;}
        quote={id:data.id,media,...approved};note(`Als je bevestigt, gaat ${currency(data.priceCents)} van je gratis testtegoed af. Je hebt ${currency(status.remainingCents)} testtegoed. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
      }else{
        if(window.rigNativeSite===true&&!hasApproval){note(`Deze video kost ${currency(data.priceCents)}. De prijsbevestiging is momenteel niet beschikbaar. Bereid je bestanden opnieuw voor.`);return;}
        if(!Number.isSafeInteger(data.providerEstimateUsdMicros)||data.providerEstimateUsdMicros<1)throw new Error('De actuele fal-prijs kon niet worden gecontroleerd.');
        const providerUsd=new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD',maximumFractionDigits:3}).format(data.providerEstimateUsdMicros/1000000);
        quote={id:data.id,media,...approved};note(`Als je bevestigt, gaat ${currency(data.priceCents)} van je fictieve testtegoed af. fal.ai-raming (echt fal-tegoed): ${providerUsd} voor ${data.billedSeconds} seconden. De werkelijke fal-kost kan afwijken. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
      }
      if(edit)note(el('quoteMessage').textContent+'\n\n'+falTransferNotice);
      el('confirmGeneration').hidden=false;
    } catch(error) { quote=null; note(error.message || 'De prijs kon niet worden berekend.'); }
    finally { active=false;el('confirmUpload').disabled=false; }
  }
  async function recoverGeneration() {
    if(active)return;active=true;el('checkGeneration').disabled=true;
    try {
      let id=window.rigScopedStorage.getItem('rig-generation-job');
      if(!id){const raw=window.rigScopedStorage.getItem('rig-generation-pending');if(!raw){note('Er is geen eerdere opdracht om te controleren.');return;}let entry;try{entry=JSON.parse(raw)}catch{throw new Error('De opgeslagen opdracht kan niet worden gelezen.')}
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(entry.quoteId||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.idempotencyKey||''))throw new Error('De opgeslagen opdracht kan niet worden gelezen.');
        const data=await call(`/api/generation-intents/${encodeURIComponent(entry.idempotencyKey)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quoteId:entry.quoteId})});
        if(data.state==='canceled'){window.rigScopedStorage.removeItem('rig-generation-pending');el('checkGeneration').hidden=true;note('De opdracht is niet gestart. Je kunt opnieuw een prijs berekenen.');return;}
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||''))throw new Error('De opdrachtstatus is onbekend.');id=data.id;window.rigScopedStorage.setItem('rig-generation-job',id);window.rigScopedStorage.removeItem('rig-generation-pending');}
      await follow(id);
    }catch(error){note(`${error.message || 'De opdrachtstatus is onbekend.'} Start geen nieuwe opdracht voordat dit is opgelost.`)}finally{refreshBalance();active=false;el('checkGeneration').disabled=false;}
  }
  async function confirm() {
    if(active||!quote)return;
    if(window.rigPreparedMedia()!==quote.media||typeof window.rigGenerationQuality==='function'&&window.rigGenerationQuality()!==quote.media.quality){note('Je videotype of instellingen zijn gewijzigd. Bereken de prijs opnieuw.');el('confirmGeneration').hidden=true;return;}
    active=true;el('confirmGeneration').disabled=true;
    const current=quote;quote=null;const requestId=current.idempotencyKey??crypto.randomUUID();
    window.rigScopedStorage.setItem('rig-generation-pending',JSON.stringify({quoteId:current.id,idempotencyKey:requestId}));
    try {
      note('Je opdracht wordt gestart…');
      const data=await call('/api/generations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quoteId:current.id,idempotencyKey:requestId,...(current.approvalToken?{approvalToken:current.approvalToken}:{}),...(current.transferPolicy===falTransferPolicy?{transferConsent:falTransferPolicy}:{})})});
      refreshBalance();
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||''))throw new Error('De opdrachtstatus is onbekend.');
      if(data.state==='failed'&&data.refundConfirmed===true){window.rigScopedStorage.removeItem('rig-generation-pending');el('confirmGeneration').hidden=true;el('checkGeneration').hidden=true;note(providerFailureMessage(data)||'Je bestanden konden niet worden voorbereid. Je tegoed is teruggezet.');return;}
      window.rigScopedStorage.setItem('rig-generation-job',data.id);window.rigScopedStorage.removeItem('rig-generation-pending');el('confirmGeneration').hidden=true;el('checkGeneration').hidden=false;
      await follow(data.id);
    } catch(error) {
      if([400,409].includes(error.status)&&error.code==='subject_rejected'&&error.generationStarted===false){
        let pending;try{pending=JSON.parse(window.rigScopedStorage.getItem('rig-generation-pending'));}catch{}
        if(pending?.quoteId===current.id&&pending.idempotencyKey===requestId)window.rigScopedStorage.removeItem('rig-generation-pending');
        note('Deze video is niet gestart: het gekozen videotype past niet bij je referentie. Kies zelf een passend videotype, bereid je beelden opnieuw voor en controleer de nieuwe prijs.');el('confirmGeneration').hidden=true;el('checkGeneration').hidden=true;
      }else{note(`${error.message || 'De opdrachtstatus is onbekend.'} Start niet opnieuw voordat de status is gecontroleerd.`);el('confirmGeneration').hidden=true;el('checkGeneration').hidden=false;}
    }
    finally{refreshBalance();active=false;el('confirmGeneration').disabled=false;}
  }
  async function follow(id) {
    for(let i=0;i<180;i++) {
      const data=await call(`/api/generations/${encodeURIComponent(id)}`);
      if(data.state==='completed') {
        const expected=`/api/generations/${id}/video`;if(data.videoPath!==expected)throw new Error('Het resultaat kon niet veilig worden geopend.');
        const videoUrl=await window.rigOpenVideo(expected);if(!window.rigSessionActive())throw new Error('De aanmelding is beëindigd.');const video=el('resultVideo');video.src=videoUrl;video.hidden=false;el('resultEmpty').hidden=true;el('resultName').textContent='Jouw nieuwe video';el('export').href=videoUrl;el('export').download='RIG-video.mp4';el('export').hidden=false;window.rigScopedStorage.removeItem('rig-generation-job');note('Je video is klaar.');return;
      }
      if(data.state==='failed'){
        const providerMessage=providerFailureMessage(data),refundConfirmed=data.refundConfirmed===true;
        if(refundConfirmed)window.rigScopedStorage.removeItem('rig-generation-job');
        el('checkGeneration').hidden=refundConfirmed;
        note(providerMessage||(refundConfirmed?'De video kon niet worden gemaakt. Je tegoed is teruggezet.':'De video kon niet worden gemaakt. Je tegoed wordt gecontroleerd.'));return;
      }
      if(['unknown','needs_review'].includes(data.state)){note('De opdracht wordt gecontroleerd. Start niet opnieuw.');return;}
      note('Je video wordt gemaakt…');await delay(5000);
    }
    note('Je opdracht loopt nog. Je kunt de status later opnieuw bekijken.');
  }
  async function discoverRecent(){try{const data=await call('/api/generations/recent');if(data.job?.state==='completed' && /^[A-Za-z0-9_-]{1,100}$/.test(data.job.id||'')){recentId=data.job.id;el('recentVideo').hidden=false;}}catch{}}
  el('recentVideo').addEventListener('click',async()=>{if(!recentId||active)return;el('quoteDialog').showModal();active=true;try{await follow(recentId)}catch{note('Je video is momenteel niet beschikbaar.')}finally{active=false}});
  // The Mac app shows a non-binding fal USD estimate before submission.
  // This preliminary preview uses only browser metadata and the fixed dated
  // reference rate from the test backend; it never authorizes a charge.
  let estimateSequence=0, estimateTimer=null, lastEstimateKey=null, lastEstimate=null, inFlightKey=null, inFlight=null;
  async function updateProviderEstimate(seq){
    const target=el('providerEstimate'), video=el('motionVideo');
    const duration=Number(el('duration').value), start=Number(el('start').value);
    const quality=typeof window.rigGenerationQuality==='function'?window.rigGenerationQuality():document.querySelector('input[name="quality"]:checked')?.value;
    if(!el('motionInput').files.length || !Number.isFinite(video.duration) || !Number.isFinite(duration) || !Number.isFinite(start) || duration<3 || duration>(quality==='edit-standard'?15:30) || start<0 || start+duration>video.duration+0.05){target.hidden=true;target.textContent='';return;}
    try {
      const params=new URLSearchParams({quality,duration:String(duration)});
      const key=params.toString();
      let data;
      if(lastEstimateKey===key && lastEstimate) data=lastEstimate;
      else {
        if(inFlightKey!==key || !inFlight){
          const pending=call(`/api/estimate/fal?${params}`);
          inFlightKey=key;inFlight=pending;
          pending.finally(()=>{if(inFlight===pending){inFlight=null;inFlightKey=null;}}).catch(()=>{});
        }
        data=await inFlight;
      }
      if(seq!==estimateSequence)return;
      if(data.quality!==quality || data.durationSeconds!==duration)throw Error();
      if(window.rigVideoFunding==='sponsored'){
        const proposed=data.customerProposal;
        if(proposed?.currency!=='EUR'||proposed.binding!==false||!Number.isSafeInteger(proposed.priceCents)||proposed.priceCents<1)throw Error();
        lastEstimateKey=key;lastEstimate=data;
        target.textContent=`Raming: ${currency(proposed.priceCents)} uit je gratis testtegoed. De prijs kan veranderen nadat de duur is gecontroleerd.`;target.hidden=false;return;
      }
      if(data.providerEstimate?.currency!=='USD' || !Number.isSafeInteger(data.providerEstimate?.usdMicros) || data.providerEstimate?.binding!==false)throw Error();
      lastEstimateKey=key;lastEstimate=data;
      const usd=new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD'}).format(data.providerEstimate.usdMicros/1000000);
      const proposed=data.customerProposal;
      const checked=/^\d{4}-\d{2}-\d{2}$/.test(data.providerEstimate.rateCheckedOn||'')?` (tarief gecontroleerd op ${data.providerEstimate.rateCheckedOn})`:'';
      let message=`fal.ai-raming: ${usd} · ${data.billedSeconds} s${checked}. De uiteindelijke fal-kost kan afwijken.`;
      if(proposed?.currency==='EUR' && proposed.binding===false && Number.isSafeInteger(proposed.priceCents) && proposed.priceCents>0)message+=` Voorstel klantprijs: ${currency(proposed.priceCents)} (niet bindend).`;
      else message+=' Een klantprijs is nog niet ingesteld.';
      target.textContent=message;target.hidden=false;
    }catch(error){if(seq===estimateSequence){target.textContent=error?.status===429?'Te veel prijsaanvragen. Wacht even en probeer opnieuw.':window.rigVideoFunding==='sponsored'?'De prijsraming is tijdelijk niet beschikbaar.':'De fal.ai-raming is tijdelijk niet beschikbaar.';target.hidden=false;}}
  }
  function scheduleProviderEstimate(){
    const seq=++estimateSequence;
    el('providerEstimate').hidden=true;
    if(estimateTimer!==null)clearTimeout(estimateTimer);
    estimateTimer=setTimeout(()=>{estimateTimer=null;void updateProviderEstimate(seq);},250);
  }
  for(const target of [el('duration'),el('start'),...document.querySelectorAll('input[name=quality]')]){target.addEventListener('input',scheduleProviderEstimate);target.addEventListener('change',scheduleProviderEstimate)}
  el('motionInput').addEventListener('change',()=>{estimateSequence++;if(estimateTimer!==null)clearTimeout(estimateTimer);estimateTimer=null;el('providerEstimate').hidden=true;});
  // Wait for app.js to update the duration after metadata has loaded.
  el('motionVideo').addEventListener('loadedmetadata',()=>queueMicrotask(scheduleProviderEstimate));
  document.addEventListener('rig-generation-mode-change',scheduleProviderEstimate);
  discoverRecent();
  el('resultVideo').addEventListener('error',()=>{el('resultVideo').hidden=true;el('resultEmpty').hidden=false;el('export').hidden=true;el('status').textContent='Het resultaat kon niet worden geladen. Probeer later opnieuw.';});
  if(window.rigScopedStorage.getItem('rig-generation-pending')||window.rigScopedStorage.getItem('rig-generation-job')){el('quoteDialog').showModal();note('Een eerdere opdracht is nog niet afgerond. Controleer de status voordat je een nieuwe start.');el('checkGeneration').hidden=false;}
  document.addEventListener('rig-prepared-change',()=>{quote=null;el('confirmGeneration').hidden=true;});
  document.addEventListener('rig-prepared-ready',async()=>{
    if(active)return;active=true;
    try {
      if(window.rigScopedStorage.getItem('rig-generation-pending')||window.rigScopedStorage.getItem('rig-generation-job')){el('quoteDialog').showModal();note('Een eerdere opdracht wordt nog gecontroleerd.');el('checkGeneration').hidden=false;return;}
      const data=await call('/api/generations/recent');
      if(data.job && ['submitting','queued','processing','unknown','needs_review'].includes(data.job.state)){
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.job.id||''))throw new Error('De vorige opdracht kon niet worden gecontroleerd.');
        window.rigScopedStorage.setItem('rig-generation-job',data.job.id);el('quoteDialog').showModal();note('Er loopt al een opdracht. Controleer eerst de status.');el('checkGeneration').hidden=false;return;
      }
      el('uploadDialog').showModal();
    } catch(error) {el('quoteDialog').showModal();note(error.message||'Een eerdere opdracht kon niet worden gecontroleerd.');el('checkGeneration').hidden=true;}
    finally {active=false;}
  });el('closeUpload').addEventListener('click',()=>el('uploadDialog').close());el('confirmUpload').addEventListener('click',getQuote);
  el('closeQuote').addEventListener('click',()=>el('quoteDialog').close());el('confirmGeneration').addEventListener('click',confirm);el('checkGeneration').addEventListener('click',recoverGeneration);
})();
