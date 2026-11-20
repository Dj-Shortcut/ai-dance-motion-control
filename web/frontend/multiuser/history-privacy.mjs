// A restored history entry must boot with a fresh session before showing private UI.
export function protectPrivateHistory(browser, disposeBinding) {
 const root=browser.document.documentElement;
 const conceal=()=>root.style.setProperty('display','none','important');
 browser.addEventListener('pagehide',event=>{
  if(event.persisted!==true)return;
  conceal();
  disposeBinding();
 },true);
 browser.addEventListener('pageshow',event=>{
  if(event.persisted!==true)return;
  conceal();
  browser.location.reload();
 },true);
}
