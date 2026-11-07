const storageKey='rig-sponsored-invitation:v1';
const codePattern=/^[A-Za-z0-9_-]{43}$/;
const ownerPattern=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invitations=new WeakMap();

function readStored(storage){
 try{
  const value=storage.getItem(storageKey);if(value===null)return null;
  const record=JSON.parse(value);
  if(codePattern.test(record?.code||'') && (record.userId===null || ownerPattern.test(record.userId||'')))return {code:record.code,userId:record.userId};
 }catch{}
 try{storage.removeItem(storageKey)}catch{}
 return null;
}
function writeStored(storage,record){try{storage.setItem(storageKey,JSON.stringify(record));return true}catch{return false}}
function clearStored(storage,expected){
 const current=readStored(storage);
 if(current?.code!==expected.code || current.userId!==expected.userId)return;
 try{storage.removeItem(storageKey)}catch{}
}

// Call synchronously before starting Google sign-in. Only this tab keeps the
// invitation; neither the OAuth redirect nor subsequent URLs receive its code.
// The returned handle deliberately exposes no bearer code.
export function captureSponsorInvitation({browser}={}){
 let storage,current;
 try{storage=browser.sessionStorage;current=new URL(browser.location.href)}catch{return null}
 let pending=readStored(storage);
 if(/^#invite(?:=|&|$)/.test(current.hash)){
  const match=/^#invite=([A-Za-z0-9_-]{43})$/.exec(current.hash);
  // Erase even malformed invitation fragments before any auth/network work.
  try{browser.history.replaceState(browser.history.state,'',current.pathname+current.search)}catch{
   try{storage.removeItem(storageKey)}catch{}
   return null;
  }
  if(!match){try{storage.removeItem(storageKey)}catch{}return null}
  const next=pending?.code===match[1]?pending:{code:match[1],userId:null};
  if(!writeStored(storage,next))return null;
  pending=next;
 }
 if(!pending)return null;
 const invitation=Object.freeze({});invitations.set(invitation,{storage});return invitation;
}

// A prepared backend-verified binding is mandatory. This UI never redeems on
// page load: the explicit action pins retries to its first verified account.
export function mountSponsorInvitation({invitation,binding,document,onRedeemed}={}){
 const state=invitations.get(invitation),userId=binding?.userId;
 const active=()=>{try{return binding?.userId===userId && binding.isActive()===true}catch{return false}};
 if(!state || !ownerPattern.test(userId||'') || typeof binding.request!=='function' || !active())return null;
 const {storage}=state,pending=readStored(storage),studio=document?.getElementById('rigStudio'),main=studio?.querySelector('main');
 if(!pending || !studio || !main)return null;
 const element=document.createElement('section'),message=document.createElement('p'),button=document.createElement('button');
 element.className='sponsor-invitation';element.setAttribute('aria-label','Gratis testtegoed');
 element.style.cssText='margin-top:18px;padding:14px 16px;border:1px solid #40685a;border-radius:10px;background:#192a23';
 message.setAttribute('role','status');message.style.cssText='margin:0 0 10px;line-height:1.5';
 message.textContent='Je bent uitgenodigd om RIG te proberen. Je krijgt gratis €5 testtegoed om je video te maken.';
 button.type='button';button.className='primary';button.textContent='Activeer gratis €5 testtegoed';
 element.append(message,button);studio.insertBefore(element,main);
 let busy=false,finished=false,disposed=false;
 const accountChanged=()=>{button.hidden=true;message.textContent='Deze uitnodiging hoort bij het account waarmee je het activeren bent gestart. Meld je aan met dat account.'};
 if(pending.userId!==null && pending.userId!==userId)accountChanged();
 async function activate(){
  if(busy || finished || disposed || !active())return;
  const current=readStored(storage);
  if(!current || current.code!==pending.code){button.hidden=true;return}
  if(current.userId!==null && current.userId!==userId){accountChanged();return}
  const bound={code:current.code,userId};
  if(!writeStored(storage,bound)){message.textContent='Je uitnodiging kon niet bewaard worden. Probeer dit tabblad opnieuw.';return}
  busy=true;button.disabled=true;message.textContent='Je gratis testtegoed wordt geactiveerd…';
  try{
   if(!active())return;
   const response=await binding.request('/api/sponsor-invitations/redeem',{
    method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({code:bound.code}),
   });
   let body;try{body=await response.json()}catch{throw Error('retry')}
   if(response.ok && body?.state==='redeemed' && body.amountCents===500){
    clearStored(storage,bound);finished=true;button.hidden=true;
    if(disposed || !active())return;
    message.textContent='Je gratis €5 testtegoed is actief. Je kunt nu je video maken.';
    document.dispatchEvent(new document.defaultView.Event('rig-balance-changed'));
    if(typeof onRedeemed==='function'){try{await onRedeemed()}catch{}}
   }else if(response.ok && body?.state==='owner'){
    clearStored(storage,bound);finished=true;button.hidden=true;
    if(!disposed && active())message.textContent='Deze uitnodiging is voor je tester. Deel de uitnodigingslink met hem.';
   }else if([200,400,404,410].includes(response.status) && ['unavailable','invalid','expired'].includes(body?.state)){
    clearStored(storage,bound);finished=true;button.hidden=true;
    if(!disposed && active())message.textContent='Deze uitnodiging is niet meer beschikbaar.';
   }else{throw Error('retry')}
  }catch{
   if(!disposed && active())message.textContent='Activeren kon nog niet worden bevestigd. Probeer opnieuw met ditzelfde account.';
  }finally{busy=false;button.disabled=finished || disposed || !active()}
 }
 const click=()=>{void activate()};button.addEventListener('click',click);
 return {element,dispose(){disposed=true;button.removeEventListener('click',click);element.remove()}};
}
