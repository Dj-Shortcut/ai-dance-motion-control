import {startRegistration,startAuthentication,browserSupportsWebAuthn,WebAuthnAbortService} from '@simplewebauthn/browser';

const operations=new Set(['finance-policy','finance-expense','owner-generation']);
const identifier=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const failure=(message,code,status)=>Object.assign(Error(message),{code,status});
const ceremonyError=error=>{
 const name=error?.cause?.name||error?.name;
 if(name==='NotAllowedError'||name==='AbortError'||error?.code==='ERROR_CEREMONY_ABORTED')return failure('Bevestiging geannuleerd of verlopen. Er is niets gewijzigd.','verification_cancelled');
 if(name==='SecurityError'||error?.code==='ERROR_INVALID_RP_ID'||error?.code==='ERROR_INVALID_DOMAIN')return failure('Bevestigen kan niet in dit venster. Open RIG apart in Chrome of Safari en probeer opnieuw.','browser_unsupported');
 return error;
};

// No browser flag grants permission and no reusable unlock is stored. Each
// assertion belongs to exactly one server challenge and original operation.
export function createOwnerVerification({window:browser,document=browser?.document,webauthn={startRegistration,startAuthentication,browserSupportsWebAuthn,cancel:()=>WebAuthnAbortService.cancelCeremony()}}={}){
 const request=browser?.rigRequest,active=browser?.rigSessionActive;
 if(!browser||!document||browser.rigNativeSite!==true||typeof request!=='function'||typeof active!=='function')throw Error('Je aanmelding is gewijzigd.');
 let disposed=false,busy=false,popup=null,rejectPopup=null,mountRoot=null,statusNode=null,setupButton=null,refreshButton=null,pendingNode=null,pending=null,poll=null,sequence=0,refreshSequence=0;
 const current=()=>!disposed&&browser.rigRequest===request&&browser.rigSessionActive===active&&active()===true;
 const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 const supported=()=>{try{return webauthn.browserSupportsWebAuthn()===true;}catch{return false;}};
 function check(){if(!current()){dispose();throw failure('Je aanmelding is gewijzigd.','session_changed',401);}}
 function status(message,error=false){if(!current()||!statusNode)return;statusNode.textContent=message;statusNode.dataset.error=String(error);}
 function stopPoll(){if(poll!==null){browser.clearTimeout(poll);poll=null;}}
 function cancel(){
  sequence++;try{webauthn.cancel();}catch{}
  if(rejectPopup){const reject=rejectPopup;rejectPopup=null;reject(failure('Bevestiging geannuleerd.','verification_cancelled'));}
  if(popup?.open)popup.close();popup?.remove();popup=null;
 }
 function dispose(){
  if(disposed)return;cancel();disposed=true;stopPoll();pending=null;
  mountRoot?.replaceChildren();mountRoot=null;statusNode=null;pendingNode=null;
  browser.removeEventListener('pagehide',dispose);document.getElementById('authLogout')?.removeEventListener('click',dispose);
 }
 async function call(path,payload){
  check();const response=await request(path,{cache:'no-store',...(payload===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})});check();
  if(response.status===401||response.status===403){dispose();throw failure('Deze beveiliging is alleen beschikbaar voor de eigenaar.','access_denied',response.status);}
  let body;try{body=await response.json();}catch{throw failure('De beveiligingscontrole is tijdelijk niet beschikbaar.','security_unavailable',response.status);}
  check();
  if(!response.ok)throw failure(typeof body?.error==='string'?body.error.slice(0,240):'De beveiligingscontrole is niet gelukt.',typeof body?.code==='string'?body.code:'security_unavailable',response.status);
  return body;
 }
 function browserHint(){
  const paragraph=element('p','Open RIG in een apart Chrome- of Safari-venster om op je apparaat te bevestigen.');paragraph.className='finance-policy-note owner-security-browser-hint';
  const link=element('a','Open RIG');link.href=new URL('/',browser.location.href).href;link.target='_blank';link.rel='noopener noreferrer';link.className='finance-export';paragraph.append(' ',link);return paragraph;
 }
 function confirm(summary){
  check();return new Promise((resolve,reject)=>{
   popup=element('dialog');popup.className='owner-verification-dialog';popup.setAttribute('aria-labelledby','ownerVerificationTitle');
   const title=element('strong','Extra bevestiging');title.id='ownerVerificationTitle';
   const text=element('p',typeof summary==='string'&&summary.length<=1600?summary:'Bevestig deze handeling op je apparaat.');text.className='owner-verification-summary';
   const note=element('p','Je apparaat vraagt om Touch ID, een apparaatcode of je beveiligingssleutel.');note.className='finance-policy-note';
   const actions=element('div'),approve=element('button','Bevestigen op mijn apparaat'),decline=element('button','Annuleren');approve.type=decline.type='button';actions.className='owner-verification-actions';actions.append(approve,decline);
   popup.append(title,text,note,actions);document.body.append(popup);rejectPopup=reject;
   const cleanup=()=>{rejectPopup=null;if(popup?.open)popup.close();popup?.remove();popup=null;};
   approve.addEventListener('click',()=>{cleanup();resolve();},{once:true});decline.addEventListener('click',()=>{cleanup();reject(failure('Bevestiging geannuleerd.','verification_cancelled'));},{once:true});
   popup.addEventListener('cancel',event=>{event.preventDefault();cleanup();reject(failure('Bevestiging geannuleerd.','verification_cancelled'));},{once:true});popup.showModal();
  });
 }
 async function prepare(operation,payload){
  check();if(busy)throw failure('Rond eerst je huidige beveiligingscontrole af.','verification_busy');
  if(!operations.has(operation)||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.hasOwn(payload,'verification'))throw failure('Controleer de handeling die je wilt bevestigen.','invalid_operation');
  const original=JSON.stringify(payload),frozen=JSON.parse(original),token=++sequence;busy=true;
  try{
   const options=await call('/api/owner/security/verification/options',{operation,payload:frozen});
   if(token!==sequence||JSON.stringify(payload)!==original)throw failure('De handeling is gewijzigd. Controleer en bevestig opnieuw.','operation_changed');
   if(operation==='finance-policy'&&options?.required===false&&!options.challengeId&&!options.publicKey)return null;
   if(!identifier(options?.challengeId)||!options.publicKey||!Number.isFinite(options.expiresAt)||options.expiresAt<=Date.now())throw failure('Vraag een nieuwe beveiligingscontrole aan.','verification_expired');
   if(!supported())throw failure('Bevestigen op je apparaat is hier niet beschikbaar. Open RIG in Chrome of Safari.','browser_unsupported');
   await confirm(options.summary);check();if(token!==sequence||JSON.stringify(payload)!==original)throw failure('De handeling is gewijzigd. Controleer en bevestig opnieuw.','operation_changed');
   const credential=await webauthn.startAuthentication({optionsJSON:options.publicKey});check();
   if(token!==sequence||JSON.stringify(payload)!==original)throw failure('De handeling is gewijzigd. Controleer en bevestig opnieuw.','operation_changed');
   if(Date.now()>=options.expiresAt)throw failure('Je bevestiging is verlopen. Probeer opnieuw.','verification_expired');
   return {challengeId:options.challengeId,credential};
  }catch(error){
   const safe=ceremonyError(error);if(safe?.code==='browser_unsupported'&&current()&&mountRoot&&!mountRoot.querySelector('.owner-security-browser-hint'))mountRoot.append(browserHint());throw safe;
  }finally{busy=false;}
 }
 function showPending(value){
  pending=value;pendingNode.replaceChildren();pendingNode.hidden=false;
  pendingNode.append(element('p','Je apparaat is gecontroleerd. Deze aanvraag moet nog apart worden goedgekeurd.'),element('code',value.candidateId),element('small','Vingerafdruk: '+value.fingerprint));
  status('Wacht op aparte goedkeuring. Je gegevens blijven leesbaar.');
 }
 async function pendingStatus(){
  if(!current()||!pending)return;
  const token=pending.candidateId;try{
   const value=await call('/api/owner/security/registration/'+token);if(!current()||pending?.candidateId!==token)return;
   if(value.status==='active'){pending=null;stopPoll();pendingNode.replaceChildren();pendingNode.hidden=true;await refresh();return;}
   if(value.status==='expired'||value.status==='rejected'){pending=null;stopPoll();pendingNode.hidden=true;status('Deze aanvraag is niet actief. Je kunt opnieuw instellen.',true);return;}
   if(value.status!=='pending')throw failure('Controleer de status opnieuw.','security_unavailable');
  }catch(error){status(error.message,true);}
  if(current()&&pending){stopPoll();poll=browser.setTimeout(()=>void pendingStatus(),10000);}
 }
 async function enroll(){
  check();if(busy||!setupButton)return;if(!supported()){status('Open RIG in Chrome of Safari om je apparaat in te stellen.',true);return;}
  const token=++sequence;busy=true;setupButton.disabled=true;status('Volg de bevestiging op je apparaat.');
  try{
   const options=await call('/api/owner/security/registration/options',{label:'Mijn RIG-apparaat'});
   if(token!==sequence)throw failure('Instellen geannuleerd.','verification_cancelled');
   if(!identifier(options?.challengeId)||!options.publicKey||!Number.isFinite(options.expiresAt)||options.expiresAt<=Date.now())throw failure('De aanvraag is verlopen. Probeer opnieuw.','verification_expired');
   const credential=await webauthn.startRegistration({optionsJSON:options.publicKey});check();if(token!==sequence)throw failure('Instellen geannuleerd.','verification_cancelled');
   if(Date.now()>=options.expiresAt)throw failure('De aanvraag is verlopen. Probeer opnieuw.','verification_expired');
   const value=await call('/api/owner/security/registration/verify',{challengeId:options.challengeId,credential});
   if(!identifier(value?.candidateId)||typeof value.fingerprint!=='string'||value.fingerprint.length>128||value.status!=='pending')throw failure('De aanvraag kon niet veilig worden klaargezet.','security_unavailable');
   showPending(value);stopPoll();poll=browser.setTimeout(()=>void pendingStatus(),10000);
  }catch(error){const safe=ceremonyError(error);status(safe?.code==='verification_cancelled'?'Instellen geannuleerd. Er is nog geen apparaat geactiveerd.':safe.message,true);if(safe?.code==='browser_unsupported'&&current()&&mountRoot&&!mountRoot.querySelector('.owner-security-browser-hint'))mountRoot.append(browserHint());}
  finally{busy=false;if(current()&&setupButton)setupButton.disabled=!supported();}
 }
 async function refresh({manual=false}={}){
  if(!current())return;const token=++refreshSequence;
  if(refreshButton){refreshButton.disabled=true;refreshButton.textContent='Controleren…';}
  mountRoot?.setAttribute('aria-busy','true');status('Beveiligingsstatus wordt gecontroleerd…');
  try{
   const value=await call('/api/owner/security');if(!Number.isSafeInteger(value?.activeCredentialCount)||value.activeCredentialCount<0||value.configured!==(value.activeCredentialCount>0))throw failure('De beveiligingsstatus is niet beschikbaar.','security_unavailable');
   if(token!==refreshSequence)return;
   const checked=manual?' Laatst gecontroleerd om '+new Date().toLocaleTimeString('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'.':'';
   setupButton.hidden=value.configured;
   if(value.configured){pending=null;stopPoll();pendingNode.replaceChildren();pendingNode.hidden=true;status('Extra verificatie actief. Gevoelige handelingen bevestig je steeds op je apparaat.'+checked);}
   else status((pending?'Wacht op aparte goedkeuring. Je gegevens blijven leesbaar.':'Stel eerst je apparaat in. Gevoelige handelingen zijn tot dan geblokkeerd.')+checked);
   setupButton.disabled=!supported();if(pending)await pendingStatus();
  }catch(error){if(token===refreshSequence)status('Status controleren is niet gelukt. '+error.message,true);}
  finally{if(current()&&token===refreshSequence){if(refreshButton){refreshButton.disabled=false;refreshButton.textContent='Status controleren';}mountRoot?.setAttribute('aria-busy','false');}}
 }
 function mount(container){
  check();if(mountRoot===container)return;
  stopPoll();mountRoot=container;container.replaceChildren();container.classList.add('owner-security-panel');
  const title=element('strong','Extra beveiliging');statusNode=element('p','Beveiligingsstatus ophalen…');statusNode.className='finance-status';statusNode.setAttribute('role','status');statusNode.setAttribute('aria-live','polite');
  const actions=element('div');actions.className='owner-verification-actions';setupButton=element('button','Apparaat instellen');refreshButton=element('button','Status controleren');setupButton.type=refreshButton.type='button';actions.append(setupButton,refreshButton);
  pendingNode=element('div');pendingNode.className='owner-security-pending';pendingNode.hidden=true;container.append(title,statusNode,actions,pendingNode);if(!supported())container.append(browserHint());
  setupButton.addEventListener('click',()=>void enroll());refreshButton.addEventListener('click',()=>void refresh({manual:true}));void refresh();
 }
 browser.addEventListener('pagehide',dispose);document.getElementById('authLogout')?.addEventListener('click',dispose);
 return {prepare,mount,dispose,cancel};
}

if(typeof window!=='undefined'&&window.document&&window.rigNativeSite===true&&typeof window.rigRequest==='function'&&typeof window.rigSessionActive==='function'){
 window.rigOwnerVerification?.dispose?.();window.rigOwnerVerification=createOwnerVerification({window});
}
