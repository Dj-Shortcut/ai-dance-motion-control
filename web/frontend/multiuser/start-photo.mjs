const PATH='/api/start-photo';

export function mountStartPhoto({browser,document,binding,selection}){
 const el=id=>document.getElementById(id);
 const actions=el('startPhotoActions'),dialog=el('startPhotoDialog');
 if(typeof dialog?.showModal!=='function'||!selection||typeof browser.crypto?.randomUUID!=='function')return ()=>{};
 const create=el('startPhotoCreate'),edit=el('startPhotoEdit'),title=el('startPhotoTitle'),form=el('startPhotoForm');
 const description=el('startPhotoDescription'),hint=el('startPhotoHint'),status=el('startPhotoStatus'),make=el('startPhotoMake');
 const image=el('startPhotoPreview'),save=el('startPhotoSave'),use=el('startPhotoUse'),close=el('startPhotoClose');
 const controller=new AbortController();
 let mode='create',pending=false,preview=null,url=null;
 let canCreate=false,canEdit=false;
 const active=()=>!controller.signal.aborted&&binding.isActive();
 const offered=operation=>operation==='create'?canCreate:canEdit&&selection.canEdit();

 function message(text){status.textContent=text;status.hidden=!text;}
 function refreshActions(){
  create.hidden=!canCreate;
  edit.hidden=!offered('edit');
  actions.hidden=create.hidden&&edit.hidden;
 }
 function reset(){
  if(url)browser.URL.revokeObjectURL(url);
  url=null;preview=null;image.removeAttribute('src');save.removeAttribute('href');
  image.hidden=save.hidden=use.hidden=true;
  form.hidden=false;description.value='';message('');
 }
 function open(next){
  if(!active()||dialog.open||!offered(next))return;
  reset();mode=next;
  title.textContent=mode==='create'?'Maak een typetje':'Bewerk mijn foto';
  hint.textContent=mode==='create'
   ?'Beschrijf je personage, outfit en omgeving. OpenAI maakt er een startfoto van.'
   :'Bijsnijden gebeurt op je toestel. Voor een AI-bewerking sturen we je geselecteerde foto naar OpenAI.';
  dialog.showModal();description.focus();
 }
 function closeDialog(){
  if(pending)return;
  dialog.close();reset();
  (mode==='edit'&&!edit.hidden?edit:create).focus();
 }
 function selectPhoto(){
  if(!active()||!preview)return;
  const photo=preview;
  closeDialog();selection.use(photo);
 }
 async function generate(event){
  event.preventDefault();
  const prompt=description.value.trim();
  if(pending||!active()||!dialog.open||!offered(mode)||!prompt||prompt.length>400)return;
  if(/^(?:(?:mijn |de )?foto\s+)?(?:bijsnijden|uitsnijden|crop)[.!]?$/i.test(prompt)){
   const crop=el('personCropButton');
   if(crop.hidden){message('Kies eerst een foto op scherm 1 om die bij te snijden.');return;}
   closeDialog();crop.click();return;
  }
  pending=true;make.disabled=close.disabled=description.disabled=true;
  message('Startfoto maken…');
  let workingUrl=null;
  try{
   const data=new browser.FormData();
   data.set('mode',mode);data.set('prompt',prompt);data.set('requestId',browser.crypto.randomUUID());
   if(mode==='edit')data.set('image',await selection.prepare(),'startfoto.jpg');
   if(!active())return;
   const response=await binding.request(PATH,{method:'POST',body:data,signal:controller.signal});
   if(!response.ok){
    const error=await response.json().catch(()=>null);
    message(error?.error??'Je foto kon niet worden opgehaald. Probeer opnieuw.');
    return;
   }
   if(response.headers.get('content-type')!=='image/jpeg')throw Error('Ongeldige afbeelding.');
   const blob=await response.blob();
   if(!active())return;
   if(!blob.size||blob.size>4*1024*1024)throw Error('Ongeldige afbeelding.');
   workingUrl=browser.URL.createObjectURL(blob);
   image.src=workingUrl;
   await image.decode();
   if(!active())return;
   url=workingUrl;workingUrl=null;
   preview=new browser.File([blob],'rig-startfoto.jpg',{type:'image/jpeg'});
   title.textContent='Bekijk je startfoto';save.href=url;
   form.hidden=true;image.hidden=save.hidden=use.hidden=false;
   use.focus();
  }catch{
   if(active())message('Je foto kon niet worden geopend. Probeer opnieuw.');
  }finally{
   if(workingUrl){image.removeAttribute('src');browser.URL.revokeObjectURL(workingUrl);}
   pending=false;make.disabled=close.disabled=description.disabled=false;
  }
 }
 function cancel(event){event.preventDefault();closeDialog();}
 const listeners=[[create,'click',()=>open('create')],[edit,'click',()=>open('edit')],[close,'click',closeDialog],
  [use,'click',selectPhoto],[form,'submit',generate],[dialog,'cancel',cancel],[document,'rig-photo-selection',refreshActions]];
 for(const [target,type,listen] of listeners)target.addEventListener(type,listen);
 void binding.request(PATH,{signal:controller.signal}).then(async response=>{
  const value=response.ok?await response.json():null;
  if(value?.available===true&&active()){
   // Servers before per-operation offers supported both buttons.
   const legacy=!Object.hasOwn(value,'canCreate')&&!Object.hasOwn(value,'canEdit');
   canCreate=legacy||value.canCreate===true;
   canEdit=legacy||value.canEdit===true;
   refreshActions();
  }
 }).catch(()=>{});
 return ()=>{
  controller.abort();
  for(const [target,type,listen] of listeners)target.removeEventListener(type,listen);
  if(dialog.open)dialog.close();
  actions.hidden=true;reset();
 };
}
