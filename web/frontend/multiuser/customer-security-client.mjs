import {startRegistration,startAuthentication,browserSupportsWebAuthn,WebAuthnAbortService} from '@simplewebauthn/browser';

const identifier=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const failure=(message,code)=>Object.assign(Error(message),{code});
const browserMessage='Open RIG in een apart Chrome- of Safari-venster om met Face ID, je vingerafdruk of schermcode te bevestigen.';
const safeError=error=>{
 const name=error?.cause?.name||error?.name;
 if(name==='AbortError'||name==='NotAllowedError'||error?.code==='ERROR_CEREMONY_ABORTED')return failure('Bevestiging geannuleerd of verlopen. Je video is niet gestart.','verification_cancelled');
 if(name==='SecurityError'||['ERROR_INVALID_RP_ID','ERROR_INVALID_DOMAIN'].includes(error?.code))return failure(browserMessage,'browser_unsupported');
 return error;
};

// No reusable unlock: every video obtains a fresh server challenge bound to
// its exact quote and idempotency key. Registration never submits a video.
export function createCustomerVerification({window:browser,document=browser?.document,webauthn={startRegistration,startAuthentication,browserSupportsWebAuthn,cancel:()=>WebAuthnAbortService.cancelCeremony()}}={}){
 const request=browser?.rigRequest,active=browser?.rigSessionActive,storage=browser?.rigScopedStorage;
 if(!browser||!document||browser.rigNativeSite!==true||typeof request!=='function'||typeof active!=='function')throw Error('Je aanmelding is gewijzigd.');
 let disposed=false,busy=false,sequence=0,refreshSequence=0,panel=null,statusNode=null,summaryNode=null,setupButton=null,mountRoot=null,configured=false;
 const current=()=>!disposed&&browser.rigRequest===request&&browser.rigSessionActive===active&&browser.rigScopedStorage===storage&&active()===true;
 const supported=()=>{try{return webauthn.browserSupportsWebAuthn()===true;}catch{return false;}};
 const node=(tag,text)=>{const result=document.createElement(tag);if(text!==undefined)result.textContent=text;return result;};
 const status=(message,error=false)=>{if(current()&&statusNode){statusNode.textContent=message;statusNode.dataset.error=String(error);}};
 function check(token){if(!current())throw failure('Je aanmelding is gewijzigd. Meld je opnieuw aan.','session_changed');if(token!==undefined&&token!==sequence)throw failure('Bevestiging geannuleerd. Je video is niet gestart.','verification_cancelled');}
 function clearSummary(){if(summaryNode){summaryNode.textContent='';summaryNode.hidden=true;}}
 function cancel(){sequence++;busy=false;clearSummary();try{webauthn.cancel();}catch{}if(current()&&setupButton)setupButton.disabled=!supported();}
 function dispose(){if(disposed)return;cancel();disposed=true;refreshSequence++;panel?.remove();panel=statusNode=summaryNode=setupButton=null;mountRoot?.removeEventListener('close',cancel);mountRoot?.removeEventListener('cancel',cancel);browser.removeEventListener('pagehide',pagehide);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('rig-prepared-change',cancel);document.removeEventListener('rig-generation-mode-change',cancel);document.getElementById('authLogout')?.removeEventListener('click',dispose);}
 async function call(path,payload,token){
  check(token);const response=await request(path,{cache:'no-store',...(payload===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});check(token);
  let value;try{value=await response.json();}catch{throw failure('De beveiligingscontrole is tijdelijk niet beschikbaar.','security_unavailable');}check(token);
  if(!response.ok)throw Object.assign(failure(value?.code==='security_setup_required'?'Stel eerst je passkey in. Bevestig daarna je video opnieuw.':value?.code==='credential_management_locked'?'Er is al een passkey ingesteld. Gebruik die om je video te bevestigen.':'De beveiligingscontrole is niet gelukt. Probeer opnieuw.',typeof value?.code==='string'?value.code:'security_unavailable'),{status:response.status});
  return value;
 }
 function validChallenge(options,{registration=false}={}){
  if(!identifier(options?.challengeId)||!options.publicKey||!Number.isFinite(options.expiresAt)||options.expiresAt<=Date.now())throw failure('De bevestiging is verlopen. Probeer opnieuw.','verification_expired');
  if((registration?options.publicKey.authenticatorSelection?.userVerification:options.publicKey.userVerification)!=='required')throw failure('Veilig bevestigen is tijdelijk niet beschikbaar.','security_unavailable');
 }
 async function refresh(){
  if(!current()||!panel)return;const token=++refreshSequence;
  try{
   const value=await call('/api/security');if(token!==refreshSequence||!current())return;
   if(!Number.isSafeInteger(value?.activeCredentialCount)||value.activeCredentialCount<0||value.configured!==(value.activeCredentialCount>0))throw failure('De beveiligingsstatus is tijdelijk niet beschikbaar.','security_unavailable');
   configured=value.configured;setupButton.hidden=configured;setupButton.disabled=busy||!supported();
   status(!supported()?browserMessage:configured?'Je bevestigt elke video met Face ID, je vingerafdruk of schermcode.':'Stel eenmalig je passkey in. Bevestig daarna elke video op je apparaat.');return configured;
  }catch(error){if(token===refreshSequence){configured=false;setupButton.hidden=true;status(safeError(error).message,true);}throw error;}
 }
 function mount(container=document.getElementById('quoteDialog')){
  check();if(!container)throw Error('De prijsbevestiging ontbreekt.');
  if(!panel){
   mountRoot=container;container.addEventListener('close',cancel);container.addEventListener('cancel',cancel);
   panel=node('section');panel.className='customer-security-panel';panel.setAttribute('aria-label','Bevestigen op je apparaat');
   summaryNode=node('p');summaryNode.className='customer-verification-summary';summaryNode.hidden=true;
   statusNode=node('p');statusNode.className='finance-policy-note';statusNode.setAttribute('role','status');statusNode.setAttribute('aria-live','polite');
   setupButton=node('button','Passkey instellen');setupButton.type='button';setupButton.hidden=true;setupButton.addEventListener('click',()=>void enroll());panel.append(summaryNode,statusNode,setupButton);container.querySelector('#confirmGeneration')?.before(panel);if(!panel.isConnected)container.append(panel);
  }
  clearSummary();panel.hidden=false;void refresh().catch(()=>{});return panel;
 }
 async function enroll(){
  check();if(busy||configured)return;if(!supported()){status(browserMessage,true);return;}
  const token=++sequence;busy=true;setupButton.disabled=true;status('Volg de stappen op je apparaat om je passkey in te stellen.');
  try{
   const options=await call('/api/security/registration/options',{label:'Mijn RIG-passkey'},token);validChallenge(options,{registration:true});
   const credential=await webauthn.startRegistration({optionsJSON:options.publicKey});check(token);if(!credential||typeof credential.id!=='string'||!credential.id)throw failure('Je passkey is niet ingesteld. Probeer opnieuw.','verification_invalid');if(Date.now()>=options.expiresAt)throw failure('Instellen is verlopen. Probeer opnieuw.','verification_expired');
   const result=await call('/api/security/registration/verify',{challengeId:options.challengeId,credential},token);
   if(result?.configured!==true||result.status!=='active')throw failure('Je passkey kon niet worden geactiveerd. Probeer opnieuw.','security_unavailable');
   configured=true;setupButton.hidden=true;status('Passkey ingesteld. Bevestig nu je video opnieuw.');
  }catch(error){if(current()&&token===sequence)status(safeError(error).message,true);}
  finally{if(token===sequence){busy=false;if(current()&&setupButton)setupButton.disabled=!supported();}}
 }
 async function prepare(operation,payload){
  check();if(busy)throw failure('Rond eerst je huidige apparaatbevestiging af.','verification_busy');
  if(operation!=='customer-generation'||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.hasOwn(payload,'verification'))throw failure('Controleer je video opnieuw.','invalid_operation');
  const original=JSON.stringify(payload),frozen=JSON.parse(original);mount();
  if(!supported()){status(browserMessage,true);throw failure(browserMessage,'browser_unsupported');}
  const token=++sequence;busy=true;setupButton.disabled=true;
  try{
   const state=await call('/api/security',undefined,token);if(!Number.isSafeInteger(state?.activeCredentialCount)||state.activeCredentialCount<0||state.configured!==(state.activeCredentialCount>0))throw failure('De beveiligingsstatus is tijdelijk niet beschikbaar.','security_unavailable');if(!state.configured){configured=false;setupButton.hidden=false;throw failure('Stel eerst je passkey in. Bevestig daarna je video opnieuw.','security_setup_required');}
   configured=true;setupButton.hidden=true;
   const options=await call('/api/security/verification/options',{operation,payload:frozen},token);validChallenge(options);
   if(options.required!==true||typeof options.summary!=='string'||!options.summary.trim()||options.summary.length>1600)throw failure('De videobevestiging is tijdelijk niet beschikbaar.','security_unavailable');
   if(JSON.stringify(payload)!==original)throw failure('Je video is gewijzigd. Controleer de nieuwe prijs.','operation_changed');
   summaryNode.textContent=options.summary;summaryNode.hidden=false;status('Bevestig deze video met Face ID, je vingerafdruk of schermcode.');
   // Publish the authoritative operation and price in the existing quote popup
   // before opening the authenticator; no separate generation action is added.
   await new Promise(resolve=>typeof browser.requestAnimationFrame==='function'?browser.requestAnimationFrame(()=>browser.requestAnimationFrame(resolve)):browser.setTimeout(resolve,0));check(token);
   if(JSON.stringify(payload)!==original)throw failure('Je video is gewijzigd. Controleer de nieuwe prijs.','operation_changed');
   const credential=await webauthn.startAuthentication({optionsJSON:options.publicKey});check(token);
   if(!credential||typeof credential.id!=='string'||!credential.id)throw failure('De apparaatbevestiging is niet afgerond. Je video is niet gestart.','verification_invalid');
   if(JSON.stringify(payload)!==original)throw failure('Je video is gewijzigd. Controleer de nieuwe prijs.','operation_changed');
   if(Date.now()>=options.expiresAt)throw failure('Je bevestiging is verlopen. Probeer opnieuw.','verification_expired');
   return {challengeId:options.challengeId,credential};
  }catch(error){const safe=safeError(error);status(safe.message,true);throw safe;}
  finally{if(token===sequence){busy=false;if(current()&&setupButton)setupButton.disabled=!supported();}}
 }
 function pagehide(event){if(event.persisted===true)cancel();else dispose();}
 function visibility(){if(document.visibilityState==='hidden')cancel();}
 browser.addEventListener('pagehide',pagehide);document.addEventListener('visibilitychange',visibility);document.addEventListener('rig-prepared-change',cancel);document.addEventListener('rig-generation-mode-change',cancel);document.getElementById('authLogout')?.addEventListener('click',dispose);
 return {prepare,mount,cancel,dispose,hide(){clearSummary();if(panel)panel.hidden=true;}};
}

if(typeof window!=='undefined'&&window.document&&window.rigNativeSite===true&&typeof window.rigRequest==='function'&&typeof window.rigSessionActive==='function'){
 window.rigCustomerVerification?.dispose?.();window.rigCustomerVerification=createCustomerVerification({window});
}
