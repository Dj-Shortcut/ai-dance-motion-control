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
 function anchor(id,href,text){const current=el(id);if(!current)throw Error('RIG-pagina ontbreekt.');let link=current;if(current.tagName!=='A'){link=document.createElement('a');link.id=id;link.className=current.className;link.hidden=current.hidden;current.replaceWith(link);}link.href=href;link.target='_top';link.textContent=text;return link;}
 const login=anchor('authLogin','/signin-with-chatgpt?return_to=%2F','Inloggen met ChatGPT'),logout=anchor('authLogout','/signout-with-chatgpt','Afmelden');
 auth??=createNativeSiteAuth({browser,fetchImpl:browser.fetch.bind(browser)});
 loadScript??=(name=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=`/multiuser/${name}`;script.onload=resolve;script.onerror=reject;document.body.appendChild(script);}));
 let binding=null,unsubscribe=()=>{},invitationUi=null,ended=false;
 browser.rigNativeSite=true;browser.rigVideoEnabled=false;
 function endSession(){if(ended)return;ended=true;browser.rigFinanceDispose?.();invitationUi?.dispose();binding?.dispose();unsubscribe();auth.dispose?.();studio.hidden=true;gate.hidden=false;login.hidden=false;logout.hidden=true;status.textContent='Je aanmelding is gewijzigd. Meld je opnieuw aan.';}
 logout.addEventListener('click',()=>{endSession();});
 const enable=async()=>{const ready=await enableVideoIfAvailable({binding,window:browser,document,loadScript});if(binding?.isActive())el('videoAvailabilityNote').textContent=browser.rigVideoUnavailableReason==='owner_test_limit'?'Je eenmalige eigenaarstest is gebruikt. Je bestaande video-opdracht blijft bereikbaar.':browser.rigVideoFunding==='owner-provider'?'Je gebruikt je eigen fal-account. Je ziet de Fal-raming vóór je bevestigt.':browser.rigVideoFunding==='credits'?'Je ziet de prijs vóór je bevestigt. Je betaalt met je RIG-tegoed.':browser.rigVideoFunding==='sponsored'?'Je video’s worden betaald uit je gratis testtegoed. Je ziet de prijs vóór je bevestigt.':ready?'Je ziet de prijs vóór je bevestigt. Een bevestigde video gebruikt echt fal-tegoed.':'Activeer je uitnodiging om een video te maken.';return ready;};
 try{
  if(!await auth.currentSession()){status.textContent='Meld je aan om RIG te gebruiken.';login.hidden=false;return {dispose:endSession};}
  const guarded=await prepareGuardedBinding({auth,browser,onChanged:endSession});binding=guarded.binding;unsubscribe=guarded.stop;
  if(ended){binding.dispose();unsubscribe();return {dispose:endSession};}
  browser.rigScopedStorage=binding.scopedStorage;browser.rigRequest=binding.request;browser.rigOpenVideo=binding.openVideo;browser.rigSessionActive=binding.isActive;
  // Recheck the bound account immediately before leaving for Mollie. A late
  // checkout response from an ended session must never navigate this tab.
  browser.rigCheckout=async value=>{
   if(!isMollieCheckoutURL(value))throw Error('Ongeldige betaalpagina.');
   if(!binding.isActive()||await auth.sessionSubject()!==binding.userId){endSession();throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');}
   if(!binding.isActive())throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');
   browser.location.assign(new URL(value).href);
  };
  logout.hidden=false;login.hidden=true;gate.hidden=true;studio.hidden=false;status.textContent='Aangemeld bij RIG.';
  for(const name of ['media.js','app.js']){await loadScript(name);if(!binding.isActive())throw Error('Aanmelding gewijzigd.');}
  await enable();if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  await loadScript('payments.js');if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  // Finance is an optional owner view. Its availability never blocks the studio.
  try{await loadScript('finance.js');}catch{}
  if(!binding.isActive())throw Error('Aanmelding gewijzigd.');
  invitationUi=mountSponsorInvitation({invitation,binding,document,onRedeemed:enable});
  return {binding,dispose:endSession};
 }catch{if(!ended)(studio.hidden?status:inlineStatus).textContent='Aanmelden is momenteel niet beschikbaar. Probeer opnieuw.';return {dispose:endSession};}
}
if(typeof window!=='undefined'&&window.document)void startNativeSiteApp({window});
