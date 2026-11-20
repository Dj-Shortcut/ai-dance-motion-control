import {createNativeSiteAuth} from './native-site-auth.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable='Je aanvraag kon niet worden bevestigd. Controleer de status voordat je opnieuw probeert.';

async function readJson(response,max=16_384){
 if(!response.body)throw Error(unavailable);
 const reader=response.body.getReader(),parts=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw Error(unavailable);parts.push(value);}}
 finally{try{void reader.cancel().catch(()=>{});}catch{}}
 const data=new Uint8Array(total);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw Error(unavailable);}
}

export function validDeletionReceipt(value){
 return value&&UUID.test(value.id??'')&&value.type==='account-deletion'&&value.status==='pending'&&
  Number.isSafeInteger(value.createdAt)&&value.createdAt>0&&!Number.isNaN(new Date(value.createdAt).getTime())&&
  typeof value.replayed==='boolean'&&value.actionPerformed===false&&
  typeof value.acknowledgement==='string'&&value.acknowledgement.length>0&&value.acknowledgement.length<=500&&
  !Object.hasOwn(value,'jobId');
}

/** The public resource also works after the Android app has been removed.
 * It records a request; this client cannot delete accounts, media or money. */
export async function mountAccountDeletionPage({browser=window,document=browser.document,auth}={}){
 const node=id=>document.getElementById(id),form=node('deletionForm'),confirm=node('deletionConfirm'),submit=node('deletionSubmit'),login=node('deletionLogin'),status=node('deletionStatus'),receipt=node('deletionReceipt'),refresh=node('deletionCheck');
 if(!form||!confirm||!submit||!login||!status||!receipt||!refresh)throw Error('De accountpagina is niet volledig.');
 auth??=createNativeSiteAuth({browser,fetchImpl:browser.fetch.bind(browser)});
 let bound=null,disposed=false,busy=false,requestId=null,received=false,sequence=0,stop=()=>{};
 const current=()=>!disposed&&USER.test(bound??'');
 const text=(message,error=false)=>{status.textContent=message;status.dataset.error=String(error);};
 const controls=()=>{submit.disabled=!current()||busy||!confirm.checked||received;confirm.disabled=!current()||busy||received;refresh.disabled=!current()||busy;form.hidden=!current();login.hidden=current();};
 function end(){
  if(disposed)return;disposed=true;sequence++;bound=null;requestId=null;received=false;receipt.replaceChildren();confirm.checked=false;controls();
  stop();auth.dispose?.();text('Je aanmelding is gewijzigd. Meld je opnieuw aan.');
 }
 function dispose(){if(disposed)return;disposed=true;sequence++;bound=null;requestId=null;stop();auth.dispose?.();browser.removeEventListener?.('pagehide',onPageHide);}
 function onPageHide(event){if(event.persisted!==true)dispose();}
 function show(value){
  if(!validDeletionReceipt(value))throw Error(unavailable);
  receipt.replaceChildren();
  const heading=document.createElement('h2');heading.textContent='Verzoek ontvangen';
  const acknowledgement=document.createElement('p');acknowledgement.textContent=value.acknowledgement;
  const id=document.createElement('p');id.textContent='Referentie: '+value.id;
  const date=document.createElement('p');date.textContent='Ontvangen: '+new Intl.DateTimeFormat('nl-BE',{timeZone:'Europe/Brussels',dateStyle:'medium',timeStyle:'short'}).format(new Date(value.createdAt));
  const note=document.createElement('p');note.textContent='Dit is een ontvangstbevestiging. Je account is nog niet verwijderd; de verkoper behandelt je verzoek.';
  receipt.append(heading,acknowledgement,id,date,note);received=true;text('Je verwijderverzoek is geregistreerd.');controls();
 }
 async function request(path,options,expected){
  const response=await auth.api(path,{cache:'no-store',...options},expected);
  const data=await readJson(response);
  if(!current()||bound!==expected)throw Error('Je aanmelding is gewijzigd.');
  if(!response.ok)throw Error(response.status===429?'Je hebt te vaak gecontroleerd. Probeer later opnieuw.':unavailable);
  return data;
 }
 async function load(){
  if(!current()||busy)return;const expected=bound,token=++sequence;busy=true;controls();text('Je aanvraag controleren…');
  try{
   const data=await request('/api/account-deletion-requests',{method:'GET'},expected);
   if(token!==sequence||!current())return;
   if(data?.limit!==20||!Array.isArray(data.requests)||data.requests.length>20||!data.requests.every(validDeletionReceipt))throw Error(unavailable);
   if(data.requests.length)show(data.requests[0]);
   else{text('Er is nog geen verwijderverzoek geregistreerd.');received=false;receipt.replaceChildren();}
  }catch(error){if(token===sequence&&!disposed)text(error.message||unavailable,true);}
  finally{if(token===sequence&&!disposed){busy=false;controls();}}
 }
 async function send(event){
  event.preventDefault();if(!current()||busy||!confirm.checked||received)return;
  const expected=bound,token=++sequence;busy=true;controls();text('Je verzoek versturen…');
  try{
   if(await auth.sessionSubject()!==expected){end();return;}
   requestId??=browser.crypto.randomUUID();
   if(!UUID.test(requestId))throw Error(unavailable);
   const value=await request('/api/account-deletion-requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId})},expected);
   if(token!==sequence||!current())return;
   show(value);
  }catch(error){if(token===sequence&&!disposed)text(error.message||unavailable,true);}
  finally{if(token===sequence&&!disposed){busy=false;controls();}}
 }
 form.addEventListener('submit',send);confirm.addEventListener('change',controls);refresh.addEventListener('click',()=>void load());browser.addEventListener?.('pagehide',onPageHide);
 controls();text('Je aanmelding controleren…');
 try{
  stop=auth.watchSession?.(value=>{if(bound!==null&&value!==bound)end();})??(()=>{});
  const user=await auth.sessionSubject();if(disposed)return {dispose};
  if(!USER.test(user??'')){text('Meld je aan om een verzoek voor jouw RIG-account in te dienen.');controls();return {dispose};}
  bound=user;controls();await load();
 }catch{if(!disposed){text('Je aanmelding kon niet worden gecontroleerd. Meld je opnieuw aan.',true);controls();}}
 return {dispose};
}

if(typeof window!=='undefined'&&window.document?.getElementById('deletionForm'))void mountAccountDeletionPage({browser:window});
