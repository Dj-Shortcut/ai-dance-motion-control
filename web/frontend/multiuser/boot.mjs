import {createBrowserAuth} from '../../browser-auth.mjs';
import {prepareGuardedBinding} from './guarded-binding.mjs';
import {enableVideoIfAvailable} from './video-capability.mjs';
import {captureSponsorInvitation,mountSponsorInvitation} from './invitation.mjs';

const invitation=captureSponsorInvitation({browser:window});

const status=document.getElementById('authStatus'),login=document.getElementById('authLogin'),logout=document.getElementById('authLogout'),inlineStatus=document.getElementById('authInlineStatus'),gate=document.getElementById('authGate'),studio=document.getElementById('rigStudio');
async function main(){
 try{
  // Public configuration contains only the Supabase URL and publishable key.
  const response=await fetch('/api/auth-config',{credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
  if(!response.ok)throw Error('unconfigured');const config=await response.json();
  if(config?.enabled!==true)throw Error('unconfigured');
  const auth=createBrowserAuth({...config,browser:window});
  let binding=null,ended=false,unsubscribe=()=>{},invitationUi=null;
  const endSession=()=>{if(ended)return;ended=true;invitationUi?.dispose();binding?.dispose();unsubscribe();status.textContent='Je aanmelding is gewijzigd. Meld je opnieuw aan.';location.reload();};
  window.rigVideoEnabled=false;
  login.addEventListener('click',async()=>{try{await auth.beginGoogleSignIn()}catch{status.textContent='Aanmelden is niet gelukt. Probeer opnieuw.'}});
  logout.addEventListener('click',async()=>{binding?.dispose();try{await auth.signOut();endSession()}catch{inlineStatus.textContent='Afmelden is niet gelukt.'}});
  await auth.finishRedirect();
  if(!await auth.currentSession()){login.hidden=false;status.textContent='Meld je aan om verder te gaan.';}
  else{
   const guarded=await prepareGuardedBinding({auth,browser:window,onChanged:endSession});
   binding=guarded.binding;unsubscribe=guarded.stop;if(ended){binding.dispose();return;}
   window.rigScopedStorage=binding.scopedStorage;window.rigRequest=binding.request;window.rigOpenVideo=binding.openVideo;window.rigSessionActive=binding.isActive;
   window.rigCheckout=url=>{if(!binding.isActive())throw Error('Je aanmelding is beëindigd.');location.assign(url);};
   logout.hidden=false;gate.hidden=true;studio.hidden=false;
   status.textContent='Aangemeld. Mollie staat in testmodus.';
   const loadScript=name=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=`/multiuser/${name}`;script.onload=resolve;script.onerror=reject;document.body.appendChild(script)});
   for(const name of ['media.js','app.js','payments.js'])await loadScript(name);
   invitationUi=mountSponsorInvitation({invitation,binding,document,onRedeemed:()=>enableVideoIfAvailable({binding,window,document,loadScript})});
   await enableVideoIfAvailable({binding,window,document,loadScript});
  }
 }catch{(studio.hidden?status:inlineStatus).textContent='Aanmelden is nog niet beschikbaar. Probeer later opnieuw.';}
}
void main();
