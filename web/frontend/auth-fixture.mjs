import {createBrowserAuth} from '../browser-auth.mjs';

// Separate experimental screen. The default config in bootstrap is disabled;
// the regular owner UI, routing, and real providers are not modified.
export async function initializeAuthFixture({document,browser,config,authFactory=createBrowserAuth}) {
  const status=document.getElementById('authStatus'),login=document.getElementById('authLogin'),
    logout=document.getElementById('authLogout'),balance=document.getElementById('authBalance');
  if(config?.enabled!==true){status.textContent='Deze aanmeldproef staat uit.';return;}
  let auth;
  try{auth=authFactory({...config,browser});}catch{status.textContent='De aanmeldproef is niet ingericht.';return;}
  async function refresh(){
    try {
      const signedIn=await auth.currentSession();
      login.hidden=signedIn;logout.hidden=!signedIn;balance.hidden=!signedIn;
      status.textContent=signedIn?'Aangemeld voor de lokale proef.':'Meld je aan voor de lokale proef.';
    } catch {status.textContent='De aanmelding is tijdelijk niet beschikbaar.';}
  }
  login.addEventListener('click',async()=>{try{await auth.beginGoogleSignIn();}catch{status.textContent='Aanmelden is niet gelukt.';}});
  logout.addEventListener('click',async()=>{try{await auth.signOut();await refresh();}catch{status.textContent='Afmelden is niet gelukt.';}});
  balance.addEventListener('click',async()=>{try{
    const response=await auth.api('/api/payments/balance');const body=await response.json();
    if(!response.ok || !Number.isSafeInteger(body.balance))throw Error('invalid');
    status.textContent=`Fictief testsaldo: ${new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(body.balance/100)}`;
  }catch{status.textContent='Het testsaldo kon niet worden opgehaald.';}});
  try{await auth.finishRedirect();await refresh();}catch{status.textContent='Aanmelden is niet gelukt.';}
}
