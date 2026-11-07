// UI convenience only: the private service independently enforces identity,
// enabled state and spending limits for every video request.
export async function enableVideoIfAvailable({binding,window,document,loadScript}) {
 const unavailable=()=>{const changed=window.rigVideoEnabled===true||window.rigVideoQualities?.includes('edit-standard');window.rigVideoEnabled=false;window.rigVideoQualities=[];if(changed&&binding.isActive())document.dispatchEvent(new window.Event('rig-video-availability'));return false;};
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
  if(!Array.isArray(qualities)||!qualities.length||qualities.some(value=>!['standard','pro','edit-standard'].includes(value))||new Set(qualities).size!==qualities.length)return unavailable();
  window.rigVideoFunding=config.funding==='sponsored'?'sponsored':'owner';
  window.rigVideoQualities=[...qualities];
  window.rigVideoUnavailableReason=null;
  await loadGenerationUi();
  if (!binding.isActive()) return unavailable();
  window.rigVideoEnabled=true;
  document.getElementById('videoAvailabilityNote').textContent=window.rigVideoFunding==='sponsored'?'Je testvideo’s worden betaald uit je gratis testtegoed.':'Mollie staat in testmodus. Videogeneratie gebruikt echt fal-tegoed.';
  document.dispatchEvent(new window.Event('rig-video-availability'));
  return true;
 } catch {return unavailable();}
}
