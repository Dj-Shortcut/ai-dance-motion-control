'use strict';
(() => {
  const el = id => document.getElementById(id);
  const currency = n => new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(n/100);
  const providerCurrency = micros => new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD',maximumFractionDigits:3}).format(micros/1000000);
  const ownerProvider = data => data?.funding==='owner-provider';
  const privateTestOwner = () => window.rigVideoFunding==='owner'&&window.rigVideoMode!=='live';
  const mayShowPricePreview = () => ['credits','sponsored','owner-provider'].includes(window.rigVideoFunding)||privateTestOwner();
  const failureFinalized = data => ownerProvider(data)?data.finalizationConfirmed===true:data.refundConfirmed===true;
  const falTransferPolicy = 'fal-temporary-links-v1';
  const falTransferNotice = 'Voor deze bewerking gebruikt Fal tijdelijke links voor je gekozen foto’s, bronvideo en resultaat (24 uur). Iedereen met zo’n link kan die bestanden openen. Met ‘Bevestig videobewerking’ ga je daarmee akkoord.';
  const falRecastNotice = 'Voor deze bewerking gebruikt Fal tijdelijke links voor je hoofdportret, bronvideo en resultaat (24 uur). Iedereen met zo’n link kan die bestanden openen. Met ‘Bevestig videobewerking’ ga je daarmee akkoord.';
  let quote = null, active = false, recentId=null,ownerVerifying=false;
  let workflowIntent=null,cleanupModule=null;
  const loadCleanupModule=()=>cleanupModule??=(typeof window.rigLoadCleanupModule==='function'?window.rigLoadCleanupModule():import('/multiuser/cleanup-client.js')).catch(error=>{cleanupModule=null;throw error;});
  const getBinding=()=>({request:window.rigRequest,active:window.rigSessionActive,storage:window.rigScopedStorage});
  function stopWorkflowIntent(){workflowIntent?.abort.abort();workflowIntent=null;}
  function beginWorkflowIntent(){stopWorkflowIntent();const binding=getBinding(),intent={abort:new AbortController(),binding};intent.current=()=>workflowIntent===intent&&!intent.abort.signal.aborted&&window.rigRequest===binding.request&&window.rigSessionActive===binding.active&&window.rigScopedStorage===binding.storage&&binding.active?.()===true;workflowIntent=intent;return intent;}

  const setActive=value=>{active=value;el('recentVideo').disabled=value;el('checkGeneration').disabled=value;el('checkGeneration').textContent=value?'Status wordt gecontroleerd…':'Controleer opdracht';document.dispatchEvent(new Event('rig-generation-busy-change'));};
  window.rigGenerationBusy=()=>active||ownerVerifying;
  let quotePortraitURL=null;
  function clearQuotePortrait(){
    const preview=el('quotePortraitPreview'),image=el('quotePortraitImage');if(preview)preview.hidden=true;if(image)image.removeAttribute('src');
    if(quotePortraitURL){URL.revokeObjectURL(quotePortraitURL);quotePortraitURL=null;}
  }
  function showQuotePortrait(media){
    clearQuotePortrait();
    if(window.rigSessionActive?.()!==true||!el('quotePortraitPreview')||!el('quotePortraitImage')||media.quality!=='human-recast'||!(media.image?.blob instanceof Blob)||media.image.blob.type!=='image/jpeg')throw new Error('Het gebruikte hoofdbeeld kon niet worden getoond. Bereid je beelden opnieuw voor.');
    // Keep the exact prepared bytes while fixing their interpretation to a
    // non-active raster MIME. The original File is never used for this preview.
    quotePortraitURL=URL.createObjectURL(new Blob([media.image.blob],{type:'image/jpeg'}));
    el('quotePortraitImage').src=quotePortraitURL;el('quotePortraitPreview').hidden=false;
  }
  window.rigGenerationDispose=()=>{stopWorkflowIntent();window.rigCleanupDispose?.();window.rigTrialDispose?.();if(ownerVerifying)window.rigOwnerVerification?.cancel?.();quote=null;clearQuotePortrait();if(el('confirmGeneration'))el('confirmGeneration').hidden=true;};
  window.addEventListener('pagehide',()=>{stopWorkflowIntent();clearQuotePortrait();});
  const note = text => { el('quoteMessage').textContent = text; };
  const refreshBalance = () => document.dispatchEvent(new Event('rig-balance-changed'));
  function providerFailureMessage(data){
    if(data.state!=='failed')return null;
    if(data.failureCode==='provider_billing_locked'){
      if(ownerProvider(data))return 'Je Fal-account heeft onvoldoende tegoed. Controleer je saldo op fal.ai.'+(failureFinalized(data)?' De opdracht is afgesloten.':' De opdracht wordt nog gecontroleerd. Start niet opnieuw.');
      return 'De videodienst is tijdelijk niet beschikbaar.'+(data.refundConfirmed===true?' Je RIG-tegoed is teruggezet.':' Je RIG-tegoed wordt nog gecontroleerd. Start de opdracht niet opnieuw.');
    }
    const reason=data.failureCode==='provider_input_unavailable'?'Fal kon je foto of video niet openen.':data.failureCode==='provider_subject_not_detected'?'Fal herkende geen duidelijk menselijk bovenlichaam op je foto.':null;
    if(ownerProvider(data))return (reason||'De video kon niet worden gemaakt.')+(failureFinalized(data)?' De opdracht is afgesloten. De werkelijke Fal-kosten zie je op fal.ai.':' De opdracht wordt nog gecontroleerd. Start niet opnieuw.');
    return reason?reason+(data.refundConfirmed===true?' Je RIG-tegoed is teruggezet.':' Je RIG-tegoed wordt nog gecontroleerd. Start de opdracht niet opnieuw.'):null;
  }
  function showReviewedType(quality){const edit=quality==='edit-standard'||quality==='human-recast';el('quoteTitle').textContent=edit?'In de video':'Op je foto';el('confirmGeneration').textContent=edit?'Bevestig videobewerking':'Bevestig persoonsvideo';}
  async function call(path, options={}) {
    const response=await window.rigRequest(path,{credentials:'same-origin',cache:'no-store',...options});
    let data; try { data=await response.json(); } catch { throw new Error('De dienst is momenteel niet beschikbaar.'); }
    if (!response.ok) { const error=new Error(data.error || 'De dienst is momenteel niet beschikbaar.'); error.status=response.status;if([400,409].includes(response.status)&&data.code==='subject_rejected'&&data.generationStarted===false){error.code='subject_rejected';error.generationStarted=false;}if(response.status===400&&data.code==='provider_limit_exceeded'&&typeof data.error==='string'&&data.error.length>0&&data.error.length<=300)error.code='provider_limit_exceeded';throw error; }
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
    if(active)return;clearQuotePortrait();if(window.rigScopedStorage.getItem('rig-generation-pending') || window.rigScopedStorage.getItem('rig-generation-job')){el('uploadDialog').close();el('quoteDialog').showModal();note('Er is al een opdracht gestart. Controleer eerst de status.');el('checkGeneration').hidden=false;return;}const media=window.rigPreparedMedia();if(!media){note('Bereid eerst je beelden voor.');return;}
    setActive(true);quote=null;el('confirmUpload').disabled=true;el('uploadDialog').close();el('quoteDialog').showModal();el('confirmGeneration').hidden=true;
    showReviewedType(media.quality);
    try {
      const recast=media.quality==='human-recast',edit=recast||media.quality==='edit-standard',limit=edit?15:30,min=recast?6:3;
      if(edit&&(!Array.isArray(window.rigVideoQualities)||!window.rigVideoQualities.includes(media.quality)))throw new Error('Video bewerken is momenteel niet beschikbaar.');
      const seconds=media.selectedSeconds??Number(el('duration').value);if(!Number.isInteger(seconds)||seconds<min||seconds>limit)throw new Error(`Kies een geheel aantal seconden tussen ${min} en ${limit}.`);
      if(!media.prompt?.trim()||media.prompt.trim().length>1900)throw new Error('Beschrijf eerst kort wat je wilt maken.');
      if(edit&&media.steady)throw new Error('Bij videobewerking volgt de camera je bronvideo.');
      if(recast&&media.keepSound!==true)throw new Error('Deze bewerking behoudt het originele geluid. Bereid je video opnieuw voor.');
      if(recast&&(media.face||media.angles.length))throw new Error('Deze bewerking gebruikt één portret, zonder extra close-up of hoeken.');
      if(media.angles.length && !media.face) throw new Error('Kies eerst een close-up voor de extra hoeken.');
      note('Je bestanden worden veilig voorbereid…');
      const cleanup=media.cleanup;
      if(cleanup){const module=await loadCleanupModule();if(!recast||!module.cleanupAllowed(window)||cleanup.version!=='owner-cleanup-v1'||cleanup.reviewed!==true||!/^[A-Za-z0-9_-]{1,100}$/.test(cleanup.sourceId||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(cleanup.maskId||''))throw new Error('Controleer het masker opnieuw voor je de prijs bekijkt.');}
      const imageId=await upload('image',media.image.blob),videoId=cleanup?cleanup.sourceId:await upload('video',media.video.blob,{duration:seconds,keepSound:media.keepSound,maxDuration:limit});
      const faceId=media.face ? await upload('face',media.face) : null;
      const angleIds=[];for(const angle of media.angles)angleIds.push(await upload('angle',angle));
      if(window.rigPreparedMedia()!==media)throw new Error('Je instellingen zijn gewijzigd. Bereid je bestanden opnieuw voor.');
      const request={imageId,videoId,faceId,angleIds,quality:media.quality,keepSound:media.keepSound,prompt:media.prompt,...(edit?{transferPolicy:falTransferPolicy}:{steadyCamera:media.steady}),...(cleanup?{cleanupMaskId:cleanup.maskId}:{})};
      const data=await call('/api/generation-quotes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||'')||!Number.isFinite(data.durationSeconds)||!Number.isInteger(data.billedSeconds)||data.billedSeconds!==Math.ceil(data.durationSeconds))throw new Error('De prijs kon niet worden bevestigd.');
      const ownFal=window.rigVideoFunding==='owner-provider';
      if(ownFal){
        if(window.rigVideoMode!=='live'||!ownerProvider(data)||data.providerCurrency!=='USD'||!Number.isSafeInteger(data.providerEstimateUsdMicros)||data.providerEstimateUsdMicros<1||data.durationSeconds<3||Object.hasOwn(data,'priceCents')||Object.hasOwn(data,'currency'))throw new Error('De Fal-raming kon niet worden bevestigd.');
      }else if(ownerProvider(data)||!Number.isSafeInteger(data.priceCents)||data.priceCents<1||data.currency!=='EUR')throw new Error('De prijs kon niet worden bevestigd.');
      if((recast?data.quality!==media.quality:data.quality!==undefined&&data.quality!==media.quality)||data.durationSeconds>limit||recast&&data.durationSeconds<5)throw new Error('De prijs hoort niet bij je gekozen videobewerking.');
      if(edit&&data.transferPolicy!==falTransferPolicy||!edit&&data.transferPolicy!==undefined)throw new Error('De bestandsoverdracht kon niet worden bevestigd. Bereid je bestanden opnieuw voor.');
      if(cleanup?data.workflowVersion!=='rig-workflow-v2':data.workflowVersion==='rig-workflow-v2')throw new Error('De volledige verwerkingsprijs kon niet worden bevestigd. Bekijk opnieuw de prijs.');
      if(recast&&data.outputResolution!=='1080P')throw new Error('De 1080p-kwaliteit kon niet worden bevestigd. Vraag opnieuw de prijs op.');
      const hasApproval=Object.hasOwn(data,'approvalToken')||Object.hasOwn(data,'idempotencyKey');
      if(hasApproval&&(!/^[A-Za-z0-9_-]{43}$/.test(data.approvalToken||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(data.idempotencyKey||'')))throw new Error('De prijsbevestiging is niet beschikbaar. Bereid je bestanden opnieuw voor.');
      const approved={funding:window.rigVideoFunding,...(hasApproval?{approvalToken:data.approvalToken,idempotencyKey:data.idempotencyKey}:{}),...(edit?{transferPolicy:falTransferPolicy}:{})};
      if(ownFal){
        if(window.rigNativeSite===true&&!hasApproval){note('De Fal-raming is beschikbaar, maar je bevestiging kon niet worden voorbereid. Bereid je bestanden opnieuw voor.');return;}
        quote={id:data.id,media,...approved};
        note(`Je gebruikt je eigen fal-account. Fal-raming: ${providerCurrency(data.providerEstimateUsdMicros)} voor ${data.billedSeconds} seconden. De werkelijke Fal-kosten kunnen afwijken. Pas na je bevestiging wordt de video gestart.`);
      }else if(window.rigVideoFunding==='credits'){
        if(window.rigVideoMode!=='live')throw new Error('Je betaalde tegoed kon niet worden gecontroleerd.');
        const status=await call('/api/payments/balance');
        if(status?.mode!=='live'||status.currency!=='EUR'||status.frozen===true||!Number.isSafeInteger(status.balance)||status.balance<0)throw new Error('Je RIG-tegoed kon niet worden gecontroleerd.');
        if(window.rigPreparedMedia()!==media)throw new Error('Je instellingen zijn gewijzigd. Bereid je bestanden opnieuw voor.');
        if(data.priceCents>status.balance){note(`Deze video kost ${currency(data.priceCents)}. Je hebt ${currency(status.balance)} RIG-tegoed. Koop tegoed of kies een korter fragment.`);return;}
        if(window.rigNativeSite===true&&!hasApproval){note(`Deze video kost ${currency(data.priceCents)}. De prijsbevestiging is momenteel niet beschikbaar. Bereid je bestanden opnieuw voor.`);return;}
        quote={id:data.id,media,...approved};note(`Als je bevestigt, betaal je ${currency(data.priceCents)} uit je RIG-tegoed. Je hebt ${currency(status.balance)} beschikbaar. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
      }else if(window.rigVideoFunding==='sponsored'){
        const status=await call('/api/sponsor-invitations/status');
        if(status?.state!=='eligible'||!Number.isSafeInteger(status.remainingCents)||status.remainingCents<0||status.remainingCents>500)throw new Error('Je gratis testtegoed kon niet worden gecontroleerd.');
        if(window.rigPreparedMedia()!==media)throw new Error('Je instellingen zijn gewijzigd. Bereid je bestanden opnieuw voor.');
        if(data.priceCents>status.remainingCents){note(`Deze video kost ${currency(data.priceCents)}. Je hebt ${currency(status.remainingCents)} gratis testtegoed; dat is niet voldoende. Kies een korter fragment of een andere kwaliteit.`);return;}
        if(window.rigNativeSite===true&&!hasApproval){note(`Deze video kost ${currency(data.priceCents)}. De prijsbevestiging is momenteel niet beschikbaar. Bereid je bestanden opnieuw voor.`);return;}
        quote={id:data.id,media,...approved};note(`Als je bevestigt, gaat ${currency(data.priceCents)} van je gratis testtegoed af. Je hebt ${currency(status.remainingCents)} testtegoed. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
      }else{
        if(window.rigNativeSite===true&&!hasApproval){note(`Deze video kost ${currency(data.priceCents)}. De prijsbevestiging is momenteel niet beschikbaar. Bereid je bestanden opnieuw voor.`);return;}
        if(privateTestOwner()){
          if(!Number.isSafeInteger(data.providerEstimateUsdMicros)||data.providerEstimateUsdMicros<1)throw new Error('De actuele fal-prijs kon niet worden gecontroleerd.');
          quote={id:data.id,media,...approved};note(`Als je bevestigt, gaat ${currency(data.priceCents)} van je fictieve testtegoed af. fal.ai-raming (echt fal-tegoed): ${providerCurrency(data.providerEstimateUsdMicros)} voor ${data.billedSeconds} seconden. De werkelijke fal-kost kan afwijken. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
        }else{
          quote={id:data.id,media,...approved};note(`Als je bevestigt, kost deze video ${currency(data.priceCents)}. Je video duurt ${data.durationSeconds.toFixed(2)} seconden.`);
        }
      }
      if(cleanup)note(el('quoteMessage').textContent+'\nDit is de totale raming voor tekst en overlays bijwerken en je persoon in de video plaatsen. Sluit RIG tijdens de lokale tussenstap niet af; je kunt een onderbroken opdracht later hervatten.');
      if(recast){note(el('quoteMessage').textContent+'\nKwaliteit: '+data.outputResolution.toLowerCase()+'.');showQuotePortrait(media);}
      if(edit)note(el('quoteMessage').textContent+'\n\n'+(cleanup?'Voor deze bewerking gebruikt Fal tijdelijke links voor je hoofdportret, bronvideo, masker, opgeschoonde clip en resultaat (24 uur). Iedereen met zo’n link kan die bestanden openen. Met ‘Bevestig videobewerking’ ga je daarmee akkoord.':recast?falRecastNotice:falTransferNotice));
      el('confirmGeneration').hidden=false;
    } catch(error) { quote=null;clearQuotePortrait();note(error.message || 'De prijs kon niet worden berekend.'); }
    finally { setActive(false);el('confirmUpload').disabled=false; }
  }
  async function recoverGeneration() {
    if(active)return;const intent=beginWorkflowIntent();setActive(true);el('checkGeneration').disabled=true;
    try {
      let id=window.rigScopedStorage.getItem('rig-generation-job');
      if(!id){const raw=window.rigScopedStorage.getItem('rig-generation-pending');if(!raw){note('Er is geen eerdere opdracht om te controleren.');return;}let entry;try{entry=JSON.parse(raw)}catch{throw new Error('De opgeslagen opdracht kan niet worden gelezen.')}
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(entry.quoteId||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.idempotencyKey||''))throw new Error('De opgeslagen opdracht kan niet worden gelezen.');
        const data=await call(`/api/generation-intents/${encodeURIComponent(entry.idempotencyKey)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quoteId:entry.quoteId})});
        if(data.state==='canceled'){window.rigScopedStorage.removeItem('rig-generation-pending');el('checkGeneration').hidden=true;note('De opdracht is niet gestart. Je kunt opnieuw een prijs berekenen.');return;}
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||''))throw new Error('De opdrachtstatus is onbekend.');id=data.id;window.rigScopedStorage.setItem('rig-generation-job',id);window.rigScopedStorage.removeItem('rig-generation-pending');document.dispatchEvent(new CustomEvent('rig-generation-accepted',{detail:{id,trialToken:window.rigTrialTokenForQuote?.(entry.quoteId)??null}}));}
      if(intent.current())await follow(id,intent);
    }catch(error){if(intent.current())note(`${error.message || 'De opdrachtstatus is onbekend.'} Start geen nieuwe opdracht voordat dit is opgelost.`)}finally{refreshBalance();setActive(false);el('checkGeneration').disabled=false;}
  }
  async function confirm() {
    if(active||!quote)return;
    if(window.rigPreparedMedia()!==quote.media||quote.funding!==window.rigVideoFunding||typeof window.rigGenerationQuality==='function'&&window.rigGenerationQuality()!==quote.media.quality){note('Je videotype of instellingen zijn gewijzigd. Bereken de prijs opnieuw.');el('confirmGeneration').hidden=true;return;}
    const intent=beginWorkflowIntent();setActive(true);el('confirmGeneration').disabled=true;
    const current=quote,requestId=current.idempotencyKey??crypto.randomUUID(),ownFal=current.funding==='owner-provider';
    const binding={request:window.rigRequest,active:window.rigSessionActive,storage:window.rigScopedStorage};
    const sessionCurrent=()=>window.rigRequest===binding.request&&window.rigSessionActive===binding.active&&window.rigScopedStorage===binding.storage&&typeof binding.active==='function'&&binding.active()===true;
    const quoteCurrent=()=>quote===current&&window.rigPreparedMedia()===current.media&&current.funding===window.rigVideoFunding&&(typeof window.rigGenerationQuality!=='function'||window.rigGenerationQuality()===current.media.quality);
    const payload={quoteId:current.id,idempotencyKey:requestId,...(current.transferPolicy===falTransferPolicy?{transferConsent:falTransferPolicy}:{})};let verification=null,submitted=false;
    try {
      if(ownFal){
        if(!sessionCurrent())return;
        if(typeof window.rigOwnerVerification?.prepare!=='function')throw new Error('Vernieuw RIG om deze video veilig te bevestigen.');
        note('Bevestig het gebruik van je eigen Fal-tegoed op je apparaat.');ownerVerifying=true;
        try{verification=await window.rigOwnerVerification.prepare('owner-generation',payload);}finally{ownerVerifying=false;}
        if(!sessionCurrent()||!intent.current())return;
        if(!quoteCurrent()){quote=null;note('Je videotype of instellingen zijn gewijzigd. Bereken de prijs opnieuw.');el('confirmGeneration').hidden=true;return;}
        if(!verification)throw new Error('De beveiligingscontrole is niet afgerond. De video is niet gestart.');
      }
      if(!intent.current())return;
      binding.storage.setItem('rig-generation-pending',JSON.stringify({quoteId:current.id,idempotencyKey:requestId}));document.dispatchEvent(new CustomEvent('rig-generation-intent',{detail:{trialToken:current.media.trialToken??null,quoteId:current.id}}));quote=null;clearQuotePortrait();submitted=true;
      note('Je opdracht wordt gestart…');
      const data=await call('/api/generations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,...(current.approvalToken?{approvalToken:current.approvalToken}:{}),...(verification?{verification}:{})})});
      if(ownFal&&!sessionCurrent())return;
      refreshBalance();
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.id||''))throw new Error('De opdrachtstatus is onbekend.');
      if(data.state==='failed'&&failureFinalized(data)){window.rigScopedStorage.removeItem('rig-generation-pending');el('confirmGeneration').hidden=true;el('checkGeneration').hidden=true;note(providerFailureMessage(data)||'Je bestanden konden niet worden voorbereid. Je tegoed is teruggezet.');return;}
      document.dispatchEvent(new CustomEvent('rig-generation-accepted',{detail:{id:data.id,trialToken:current.media.trialToken??null,fromCurrent:true}}));window.rigScopedStorage.setItem('rig-generation-job',data.id);window.rigScopedStorage.removeItem('rig-generation-pending');recentId=data.id;el('recentVideo').hidden=false;el('confirmGeneration').hidden=true;el('checkGeneration').hidden=false;
      if(intent.current())await follow(data.id,intent);
    } catch(error) {
      if(ownFal&&!sessionCurrent()||!intent.current())return;
      if(!submitted){
        const reusable=quoteCurrent();if(!reusable)quote=null;
        note(reusable?(error.message||'De bevestiging is geannuleerd. De video is niet gestart.'):'Je videotype of instellingen zijn gewijzigd. Bereken de prijs opnieuw.');el('confirmGeneration').hidden=!reusable;el('checkGeneration').hidden=true;return;
      }
      if([400,409].includes(error.status)&&error.code==='subject_rejected'&&error.generationStarted===false){
        let pending;try{pending=JSON.parse(window.rigScopedStorage.getItem('rig-generation-pending'));}catch{}
        if(pending?.quoteId===current.id&&pending.idempotencyKey===requestId)window.rigScopedStorage.removeItem('rig-generation-pending');
        note('Deze video is niet gestart: het gekozen videotype past niet bij je referentie. Kies zelf een passend videotype, bereid je beelden opnieuw voor en controleer de nieuwe prijs.');el('confirmGeneration').hidden=true;el('checkGeneration').hidden=true;
      }else{note(`${error.message || 'De opdrachtstatus is onbekend.'} Start niet opnieuw voordat de status is gecontroleerd.`);el('confirmGeneration').hidden=true;el('checkGeneration').hidden=false;}
    }
    finally{ownerVerifying=false;setActive(false);if(!ownFal||sessionCurrent()){refreshBalance();el('confirmGeneration').disabled=false;}}
  }
  async function follow(id,intent=null) {
    for(let i=0;i<180;i++) {
      if(intent&&!intent.current())return;
      const data=await call(`/api/generations/${encodeURIComponent(id)}`,intent?{signal:intent.abort.signal}:{});
      if(intent&&!intent.current())return;
      if(data.workflowVersion==='rig-workflow-v2'&&['awaiting_client_processing','ready_to_advance'].includes(data.state)){
        if(!intent){note('De lokale tussenstap staat klaar. Klik op Controleer opdracht om je bestaande video verder te verwerken.');el('checkGeneration').hidden=false;return;}
        const module=await loadCleanupModule();if(!intent.current())return;
        if(!module.cleanupSupported(window)){note('Deze browser kan de lokale tussenstap niet uitvoeren. Open je bestaande opdracht in een ondersteunde browser.');el('checkGeneration').hidden=false;return;}
        note('Je video wordt lokaal gecombineerd; het oorspronkelijke beeld en geluid blijven buiten het masker behouden. Houd RIG open.');
        await module.resumeClientProcessing({jobId:id,getBinding,signal:intent.abort.signal,isCurrent:intent.current,onProgress:progress=>{if(intent.current())note(progress.stage==='advance'?'Je bestaande opdracht gaat verder…':'Je video wordt lokaal gecombineerd…');}});
        if(!intent.current())return;
        continue;
      }
      if(data.state==='completed') {
        const expected=`/api/generations/${id}/video`;if(data.videoPath!==expected)throw new Error('Het resultaat kon niet veilig worden geopend.');
        const videoUrl=await window.rigOpenVideo(expected);if(!window.rigSessionActive())throw new Error('De aanmelding is beëindigd.');const video=el('resultVideo');video.src=videoUrl;video.hidden=false;el('resultEmpty').hidden=true;el('resultName').textContent='Jouw nieuwe video';el('export').href=videoUrl;el('export').download='RIG-video.mp4';el('export').hidden=false;if(window.rigScopedStorage.getItem('rig-generation-job')===id)window.rigScopedStorage.removeItem('rig-generation-job');const recovery=!!window.rigScopedStorage.getItem('rig-generation-job')||!!window.rigScopedStorage.getItem('rig-generation-pending');el('checkGeneration').hidden=!recovery;note(recovery?'Je eerdere video is klaar. Controleer de status van je nieuwe opdracht.':'Je video is klaar.');document.dispatchEvent(new CustomEvent('rig-generation-completed',{detail:{id,popup:!recovery}}));return;
      }
      if(data.state==='failed'){
        document.dispatchEvent(new CustomEvent('rig-generation-failed',{detail:{id}}));
        const providerMessage=providerFailureMessage(data),finalized=failureFinalized(data);
        if(finalized)window.rigScopedStorage.removeItem('rig-generation-job');
        el('checkGeneration').hidden=finalized;
        note(providerMessage||(finalized?'De video kon niet worden gemaakt. Je tegoed is teruggezet.':'De video kon niet worden gemaakt. Je tegoed wordt gecontroleerd.'));return;
      }
      if(['unknown','needs_review'].includes(data.state)){note('De opdracht wordt gecontroleerd. Start niet opnieuw.');return;}
      note('Je video wordt gemaakt…');await delay(5000);
    }
    note('Je opdracht loopt nog. Je kunt de status later opnieuw bekijken.');
  }
  async function discoverRecent(){try{const data=await call('/api/generations/recent');if(data.job && ['completed','submitting','queued','processing','awaiting_client_processing','ready_to_advance','unknown','needs_review','failed'].includes(data.job.state) && /^[A-Za-z0-9_-]{1,100}$/.test(data.job.id||'')){recentId=data.job.id;el('recentVideo').hidden=false;if(data.job.state==='completed'&&window.rigScopedStorage.getItem('rig-generation-job')===data.job.id)window.rigScopedStorage.removeItem('rig-generation-job');}}catch{}}
  el('recentVideo').addEventListener('click',async()=>{if(!recentId||active)return;el('quoteDialog').showModal();setActive(true);try{await follow(recentId)}catch{note('Je video is momenteel niet beschikbaar.')}finally{setActive(false)}});
  // The Mac app shows a non-binding fal USD estimate before submission.
  // This preliminary preview uses only browser metadata and the fixed dated
  // reference rate from the test backend; it never authorizes a charge.
  let estimateSequence=0, estimateTimer=null, lastEstimateKey=null, lastEstimate=null, inFlightKey=null, inFlight=null;
  async function updateProviderEstimate(seq){
    const target=el('providerEstimate'), video=el('motionVideo');
    if(!mayShowPricePreview()){target.hidden=true;target.textContent='';return;}
    if(el('cleanupEnabled')?.checked&&window.rigVideoCleanup?.enabled===true&&window.rigVideoFunding==='owner-provider'&&window.rigGenerationQuality?.()==='human-recast'){target.textContent='Totale Fal-raming na controle van tekst en overlays.';target.hidden=false;return;}
    const duration=Number(el('duration').value), start=Number(el('start').value);
    const quality=typeof window.rigGenerationQuality==='function'?window.rigGenerationQuality():document.querySelector('input[name="quality"]:checked')?.value;
    if(!(typeof window.rigMotionSelected==='function'?window.rigMotionSelected():el('motionInput').files.length) || !Number.isFinite(video.duration) || !Number.isFinite(duration) || !Number.isFinite(start) || duration<(quality==='human-recast'?6:3) || duration>(['edit-standard','human-recast'].includes(quality)?15:30) || start<0 || start+duration>video.duration+0.05){target.hidden=true;target.textContent='';return;}
    try {
      const params=new URLSearchParams({quality,duration:String(duration)});
      const key=`${window.rigVideoFunding}:${window.rigVideoMode}:${params}`;
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
      if(!mayShowPricePreview()){target.hidden=true;target.textContent='';return;}
      if(data.quality!==quality || data.durationSeconds!==duration)throw Error();
      if(window.rigVideoFunding==='credits'){
        const proposed=data.customerProposal;
        if(window.rigVideoMode!=='live'||proposed?.currency!=='EUR'||proposed.binding!==false||!Number.isSafeInteger(proposed.priceCents)||proposed.priceCents<1)throw Error();
        lastEstimateKey=key;lastEstimate=data;
        target.textContent=`Raming: ${currency(proposed.priceCents)}. Je bevestigt de definitieve prijs vóór de video wordt gemaakt.`;target.hidden=false;return;
      }
      if(window.rigVideoFunding==='sponsored'){
        const proposed=data.customerProposal;
        if(proposed?.currency!=='EUR'||proposed.binding!==false||!Number.isSafeInteger(proposed.priceCents)||proposed.priceCents<1)throw Error();
        lastEstimateKey=key;lastEstimate=data;
        target.textContent=`Raming: ${currency(proposed.priceCents)} uit je gratis testtegoed. De prijs kan veranderen nadat de duur is gecontroleerd.`;target.hidden=false;return;
      }
      if(data.providerEstimate?.currency!=='USD' || !Number.isSafeInteger(data.providerEstimate?.usdMicros) || data.providerEstimate?.usdMicros<1 || data.providerEstimate?.binding!==false)throw Error();
      const usd=new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD'}).format(data.providerEstimate.usdMicros/1000000);
      if(window.rigVideoFunding==='owner-provider'){
        if(window.rigVideoMode!=='live'||!ownerProvider(data)||!Number.isSafeInteger(data.billedSeconds)||data.billedSeconds!==Math.ceil(duration))throw Error();
        lastEstimateKey=key;lastEstimate=data;
        target.textContent=`Fal-raming: ${usd} · ${data.billedSeconds} s. Je gebruikt je eigen fal-account. Je bevestigt vóór de video start; de werkelijke kosten kunnen afwijken.`;target.hidden=false;return;
      }
      lastEstimateKey=key;lastEstimate=data;
      const checked=/^\d{4}-\d{2}-\d{2}$/.test(data.providerEstimate.rateCheckedOn||'')?` (tarief gecontroleerd op ${data.providerEstimate.rateCheckedOn})`:'';
      target.textContent=`fal.ai-raming: ${usd} · ${data.billedSeconds} s${checked}. De uiteindelijke fal-kost kan afwijken.`;target.hidden=false;
    }catch(error){if(seq===estimateSequence){target.textContent=window.rigVideoFunding==='owner-provider'&&quality==='human-recast'&&error?.status===400&&error.code==='provider_limit_exceeded'?error.message:error?.status===429?'Te veel prijsaanvragen. Wacht even en probeer opnieuw.':['sponsored','credits'].includes(window.rigVideoFunding)?'De prijsraming is tijdelijk niet beschikbaar.':'De fal.ai-raming is tijdelijk niet beschikbaar.';target.hidden=false;}}
  }
  function scheduleProviderEstimate(){
    const seq=++estimateSequence;
    el('providerEstimate').hidden=true;
    if(estimateTimer!==null)clearTimeout(estimateTimer);
    estimateTimer=setTimeout(()=>{estimateTimer=null;void updateProviderEstimate(seq);},250);
  }
  for(const target of [el('duration'),el('start'),...document.querySelectorAll('input[name=quality]')]){target.addEventListener('input',scheduleProviderEstimate);target.addEventListener('change',scheduleProviderEstimate)}
  el('cleanupEnabled')?.addEventListener('change',scheduleProviderEstimate);
  el('motionInput').addEventListener('change',()=>{estimateSequence++;if(estimateTimer!==null)clearTimeout(estimateTimer);estimateTimer=null;el('providerEstimate').hidden=true;});
  // Wait for app.js to update the duration after metadata has loaded.
  el('motionVideo').addEventListener('loadedmetadata',()=>queueMicrotask(scheduleProviderEstimate));
  document.addEventListener('rig-generation-mode-change',()=>{if(ownerVerifying)window.rigOwnerVerification?.cancel?.();scheduleProviderEstimate();});
  discoverRecent();
  el('resultVideo').addEventListener('error',()=>{el('resultVideo').hidden=true;el('resultEmpty').hidden=false;el('export').hidden=true;el('status').textContent='Het resultaat kon niet worden geladen. Probeer later opnieuw.';});
  if(window.rigScopedStorage.getItem('rig-generation-pending')||window.rigScopedStorage.getItem('rig-generation-job')){el('quoteDialog').showModal();note('Een eerdere opdracht is nog niet afgerond. Controleer de status voordat je een nieuwe start.');el('checkGeneration').hidden=false;}
  document.addEventListener('rig-prepared-change',()=>{clearQuotePortrait();if(ownerVerifying)window.rigOwnerVerification?.cancel?.();quote=null;el('confirmGeneration').hidden=true;});
  document.addEventListener('rig-prepared-ready',async()=>{
    if(active)return;setActive(true);
    try {
      if(window.rigScopedStorage.getItem('rig-generation-pending')||window.rigScopedStorage.getItem('rig-generation-job')){el('quoteDialog').showModal();note('Een eerdere opdracht wordt nog gecontroleerd.');el('checkGeneration').hidden=false;return;}
      const data=await call('/api/generations/recent');
      if(data.job && ['submitting','queued','processing','awaiting_client_processing','ready_to_advance','unknown','needs_review'].includes(data.job.state)){
        if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.job.id||''))throw new Error('De vorige opdracht kon niet worden gecontroleerd.');
        window.rigScopedStorage.setItem('rig-generation-job',data.job.id);el('quoteDialog').showModal();note('Er loopt al een opdracht. Controleer eerst de status.');el('checkGeneration').hidden=false;return;
      }
      el('uploadDialog').showModal();
    } catch(error) {el('quoteDialog').showModal();note(error.message||'Een eerdere opdracht kon niet worden gecontroleerd.');el('checkGeneration').hidden=true;}
    finally {setActive(false);}
  });el('closeUpload').addEventListener('click',()=>el('uploadDialog').close());el('confirmUpload').addEventListener('click',getQuote);
  el('quoteDialog').addEventListener('close',()=>{stopWorkflowIntent();clearQuotePortrait();});el('quoteDialog').addEventListener('cancel',stopWorkflowIntent);el('closeQuote').addEventListener('click',()=>{stopWorkflowIntent();clearQuotePortrait();if(ownerVerifying)window.rigOwnerVerification?.cancel?.();el('quoteDialog').close();});el('confirmGeneration').addEventListener('click',confirm);el('checkGeneration').addEventListener('click',recoverGeneration);
})();
