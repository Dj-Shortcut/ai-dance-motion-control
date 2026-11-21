import {protectPrivateHistory} from './history-privacy.mjs';
import {createNativeSiteAuth} from './native-site-auth.mjs';
import {prepareGuardedBinding} from './guarded-binding.mjs';
import {enableVideoIfAvailable} from './video-capability.mjs';
import {captureSponsorInvitation,mountSponsorInvitation} from './invitation.mjs';
import {isMollieCheckoutURL} from '../../mollie-checkout-url.mjs';

// Bundle this export as the Site's browser entry and call it once. It shares
// the existing studio, media editor and account-scoped recovery state.
export async function startNativeSiteApp({window:browser,document=browser?.document,auth,loadScript}={}){
 const invitation=captureSponsorInvitation({browser});
 const el=id=>document.getElementById(id),status=el('authStatus'),inlineStatus=el('authInlineStatus'),gate=el('authGate'),studio=el('rigStudio');
 // This marker is emitted only by the separate server-built /android/ entry.
 // It selects the store UI, never an identity, entitlement or price authority.
 const androidPath=new URL(browser.location.href).pathname==='/android/';
 const googlePlay=document.querySelector('meta[name="rig-app-channel"]')?.getAttribute('content')==='google-play'&&androidPath;
 if(androidPath&&!googlePlay){status.textContent='De Android-versie is momenteel niet beschikbaar.';studio.hidden=true;gate.hidden=false;return {dispose(){}};}
 function anchor(id,href,text){const current=el(id);if(!current)throw Error('RIG-pagina ontbreekt.');let link=current;if(current.tagName!=='A'){link=document.createElement('a');link.id=id;link.className=current.className;link.hidden=current.hidden;current.replaceWith(link);}link.href=href;link.target='_top';link.textContent=text;return link;}
 const login=anchor('authLogin',googlePlay?'/signin-with-chatgpt?return_to=%2Fandroid%2F':'/signin-with-chatgpt?return_to=%2F','Inloggen met ChatGPT'),logout=anchor('authLogout',googlePlay?'/signout-with-chatgpt?return_to=%2Fandroid%2F':'/signout-with-chatgpt','Afmelden');
 auth??=createNativeSiteAuth({browser,fetchImpl:browser.fetch.bind(browser)});
 loadScript??=(name=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=`/multiuser/${name}`;script.onload=resolve;script.onerror=reject;document.body.appendChild(script);}));
 let binding=null,unsubscribe=()=>{},invitationUi=null,ended=false;
 protectPrivateHistory(browser,()=>binding?.dispose());
 browser.rigNativeSite=true;browser.rigVideoEnabled=false;browser.rigPaymentChannel=googlePlay?'google-play':'mollie';
 function endSession(){if(ended)return;ended=true;browser.rigGenerationDispose?.();browser.rigFlowDispose?.();browser.rigOwnerVerification?.dispose();browser.rigCustomerVerification?.dispose();browser.rigFinanceDispose?.();browser.rigOwnerAdministration?.dispose();browser.rigPaymentsDispose?.();invitationUi?.dispose();binding?.dispose();unsubscribe();auth.dispose?.();studio.hidden=true;gate.hidden=false;login.hidden=false;logout.hidden=true;status.textContent='Je aanmelding is gewijzigd. Meld je opnieuw aan.';}
 logout.addEventListener('click',()=>{binding?.dispose({logout:true});endSession();});
 const enable=async()=>{const ready=await enableVideoIfAvailable({binding,window:browser,document,loadScript});if(binding?.isActive())el('videoAvailabilityNote').textContent=browser.rigVideoAvailabilityMessage??(browser.rigVideoUnavailableReason==='owner_test_limit'?'Je eenmalige eigenaarstest is gebruikt. Je bestaande video-opdracht blijft bereikbaar.':browser.rigVideoFunding==='owner-provider'?'Je gebruikt je eigen fal-account. Je ziet de Fal-raming vóór je bevestigt.':browser.rigVideoFunding==='credits'?'Je ziet de prijs vóór je bevestigt. Je betaalt met je RIG-tegoed.':browser.rigVideoFunding==='sponsored'?'Je video’s worden betaald uit je gratis testtegoed. Je ziet de prijs vóór je bevestigt.':ready?'Je ziet de prijs vóór je bevestigt. Een bevestigde video gebruikt echt fal-tegoed.':'Activeer je uitnodiging om een video te maken.');return ready;};
 try{
  if(!await auth.currentSession()){status.textContent='Meld je aan om RIG te gebruiken.';login.hidden=false;return {dispose:endSession};}
  const guarded=await prepareGuardedBinding({auth,browser,onChanged:endSession});binding=guarded.binding;unsubscribe=guarded.stop;
  if(ended){binding.dispose();unsubscribe();return {dispose:endSession};}
  browser.rigScopedStorage=binding.scopedStorage;browser.rigDraftStorage=binding.draftStorage;
  browser.rigRequest=googlePlay?(path,options={})=>{
   const googleStatus=typeof path==='string'&&/^\/api\/payments\/google-play\/status(?:\?intentId=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(path);
   if(typeof path==='string'&&path.startsWith('/api/payments/')&&!googleStatus&&!['/api/payments/balance','/api/payments/google-play/config','/api/payments/google-play/intents','/api/payments/google-play/confirm'].includes(path))throw Error('Tegoed kopen gaat hier via Google Play.');
   return binding.request(path,options);
  }:binding.request;
  browser.rigOpenVideo=binding.openVideo;browser.rigSessionActive=binding.isActive;browser.rigSessionDispose=()=>binding?.dispose();
  // Recheck the bound account immediately before leaving for Mollie. A late
  // checkout response from an ended session must never navigate this tab.
  browser.rigCheckout=async value=>{
   if(googlePlay)throw Error('Tegoed kopen gaat hier via Google Play.');
   if(!isMollieCheckoutURL(value))throw Error('Ongeldige betaalpagina.');
   if(!binding.isActive()||await auth.sessionSubject()!==binding.userId){endSession();throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');}
   if(!binding.isActive())throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');
   browser.location.assign(new URL(value).href);
  };
  logout.hidden=false;login.hidden=true;gate.hidden=true;studio.hidden=false;status.textContent='Aangemeld bij RIG.';
  for(const name of ['media.js','app.js','flow.js']){await loadScript(name);if(!binding.isActive())throw Error('Aanmelding gewijzigd.');}
  await loadScript('owner-security.js');if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  await loadScript('customer-security.js');if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  await enable();if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  await loadScript(googlePlay?'google-play-payments.js':'payments.js');if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  // Finance is an optional owner view. Its availability never blocks the studio.
  try{await loadScript('owner-administration.js');await loadScript('finance.js');}catch{}
  if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  invitationUi=mountSponsorInvitation({invitation,binding,document,onRedeemed:enable});
  return {binding,dispose:endSession};
 }catch{if(!ended)(studio.hidden?status:inlineStatus).textContent='Aanmelden is momenteel niet beschikbaar. Probeer opnieuw.';return {dispose:endSession};}
}
if(typeof window!=='undefined'&&window.document)void startNativeSiteApp({window});
