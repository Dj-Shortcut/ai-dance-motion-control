// UI convenience only: the private service independently enforces identity,
// enabled state and spending limits for every video request.
const refreshes=new WeakMap();
export async function enableVideoIfAvailable({binding,window,document,loadScript}) {
 const unavailable=()=>{const changed=window.rigVideoInvitationLimits!=null||window.rigVideoCleanup!=null||window.rigVideoEnabled===true||Array.isArray(window.rigVideoQualities)&&window.rigVideoQualities.some(q=>q==='edit-standard'||q==='human-recast');window.rigVideoEnabled=false;window.rigVideoQualities=[];window.rigVideoCleanup=null;window.rigVideoInvitationLimits=null;window.rigVideoAvailabilityMessage=null;if(changed&&binding.isActive())document.dispatchEvent(new window.Event('rig-video-availability'));return false;};
 const loadGenerationUi=async()=>{
  if(window.rigGenerationUiLoaded===true||window.rigVideoEnabled===true){window.rigGenerationUiLoaded=true;return;}
  if(!window.rigGenerationUiLoading)window.rigGenerationUiLoading=Promise.resolve().then(()=>loadScript('generation-ui.js'));
  const pending=window.rigGenerationUiLoading;
  try{await pending;if(binding.isActive())window.rigGenerationUiLoaded=true;}finally{if(window.rigGenerationUiLoading===pending)window.rigGenerationUiLoading=null;}
 };
 try {
  if (!binding.isActive()) return unavailable();
  const response=await binding.request('/api/video-config',{cache:'no-store'});
  if (!binding.isActive() || !response.ok) return unavailable();
  const config=await response.json();
  if(binding.isActive()&&config?.enabled===false&&config.unavailableReason==='owner_test_limit'){
   window.rigVideoUnavailableReason='owner_test_limit';
   await loadGenerationUi();
   if(binding.isActive())document.getElementById('videoAvailabilityNote').textContent='Je eenmalige eigenaarstest is gebruikt. Je bestaande video-opdracht blijft bereikbaar.';
   return unavailable();
  }
  if (!binding.isActive() || config?.enabled!==true) return unavailable();
  const qualities=config.qualities===undefined?['standard','pro']:config.qualities;
  if(!Array.isArray(qualities)||!qualities.length||qualities.some(value=>!['standard','pro','edit-standard','human-recast'].includes(value))||new Set(qualities).size!==qualities.length)return unavailable();
  if(qualities.includes('human-recast')&&config.funding!=='owner-provider')return unavailable();
  if(config.funding==='credits'&&(config.mode!=='live'||config.currency!=='EUR'))return unavailable();
  if(config.funding==='owner-provider'&&(config.mode!=='live'||config.providerCurrency!=='USD'))return unavailable();
  const invitation=config.invitationLimits;
  if(invitation!==undefined&&(config.funding!=='credits'||invitation?.version!=='first-tester-bounded-v1'||invitation.maxDurationSeconds!==10||!Number.isInteger(invitation.remainingAttempts)||invitation.remainingAttempts<0||invitation.remainingAttempts>2||invitation.referenceImages!==1||invitation.orientation!=='image'||qualities.some(q=>!['standard','pro'].includes(q))))return unavailable();
  window.rigVideoInvitationLimits=invitation===undefined?null:Object.freeze({version:invitation.version,maxDurationSeconds:10,remainingAttempts:invitation.remainingAttempts,referenceImages:1,orientation:'image'});
  window.rigVideoFunding=['credits','sponsored','owner-provider'].includes(config.funding)?config.funding:'owner';
  window.rigVideoMode=['credits','owner-provider'].includes(config.funding)?'live':'test';
  window.rigVideoQualities=[...qualities];
  const cleanup=config.cleanup;window.rigVideoCleanup=config.funding==='owner-provider'&&qualities.includes('human-recast')&&cleanup?.enabled===true&&cleanup.version==='owner-cleanup-v1'&&cleanup.quality==='human-recast'&&cleanup.maxDurationSeconds===15?Object.freeze({enabled:true,version:'owner-cleanup-v1',quality:'human-recast',maxDurationSeconds:15}):null;
  window.rigVideoUnavailableReason=invitation?.remainingAttempts===0?'invitation_limit':null;
  await loadGenerationUi();
  if (!binding.isActive()) return unavailable();
  window.rigVideoEnabled=invitation?.remainingAttempts!==0;
  window.rigVideoAvailabilityMessage=invitation?invitation.remainingAttempts===0?'Je 2 videopogingen zijn gebruikt. Je bestaande video’s blijven beschikbaar.':`€5 RIG-tegoed · nog ${invitation.remainingAttempts} ${invitation.remainingAttempts===1?'videopoging':'videopogingen'} van maximaal 10 seconden. Een mislukte poging kan meetellen, ook als je tegoed terugkrijgt.`:null;
  document.getElementById('videoAvailabilityNote').textContent=window.rigVideoAvailabilityMessage??(window.rigVideoFunding==='owner-provider'?'Je gebruikt je eigen fal-account. Je ziet de Fal-raming vóór je bevestigt.':window.rigVideoFunding==='credits'?'Je ziet de prijs vóór je bevestigt. Je betaalt met je RIG-tegoed.':window.rigVideoFunding==='sponsored'?'Je testvideo’s worden betaald uit je gratis testtegoed.':'Mollie staat in testmodus. Videogeneratie gebruikt echt fal-tegoed.');
  window.rigRefreshVideoCapabilities=()=>{
   if(!binding.isActive())return Promise.resolve(false);
   if(refreshes.has(binding))return refreshes.get(binding);
   const pending=enableVideoIfAvailable({binding,window,document,loadScript});refreshes.set(binding,pending);
   return pending.finally(()=>{if(refreshes.get(binding)===pending)refreshes.delete(binding);});
  };
  document.dispatchEvent(new window.Event('rig-video-availability'));
  return window.rigVideoEnabled;
 } catch {return unavailable();}
}
