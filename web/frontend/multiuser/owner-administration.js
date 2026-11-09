'use strict';
(() => {
 window.rigOwnerAdministration?.dispose?.();
 if(window.rigNativeSite!==true||typeof window.rigRequest!=='function'||typeof window.rigSessionActive!=='function')return;
 const binding={request:window.rigRequest,active:window.rigSessionActive},UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
 const INVOICE_NUMBER=/^RIG-20\d{2}-\d{6,12}$/;
 const issueReasons={payment_not_verified:'Betaalbewijs controleren',credit_not_verified:'Tegoedbijschrijving controleren',payment_reversed:'Terugboeking controleren',external_document_exists:'Bestaande externe registratie controleren',acceptance_missing:'Aankoopbevestiging ontbreekt',acceptance_invalid:'Aankoopbevestiging controleren',seller_invalid:'Verkopersgegevens controleren',billing_missing:'Factuuradres ontbreekt',billing_invalid:'Factuurgegevens controleren',invoice_snapshot_invalid:'Bewaarde factuur controleren',number_collision:'Factuurnummer is al in gebruik',numbering_exhausted:'Factuurnummering controleren',source_changed:'Aankoopgegevens zijn gewijzigd',invoice_storage_unavailable:'Factuuropslag niet beschikbaar',production_unavailable:'Factuuromgeving controleren'};
 const invoiceMail={'not-sent':'Nog niet per e-mail overgedragen',sending:'Verzending wordt gecontroleerd',sent:'Mail door verzenddienst aanvaard; controle in Accountable blijft nodig',unknown:'Verzenduitkomst onbekend; eerst onderzoeken',failed:'Verzending niet bevestigd; handmatig controleren'};
 const exports=new Map([['purchases','Aankopen'],['credit-events','Tegoedverloop'],['costs','Vastgelegde kosten'],['estimates','Kostenramingen']]);
 const recordTypes={'invoice':'Factuur','accounting-entry':'Boekingsreferentie'},delivery={'prepared':'Referentie klaargezet','recorded-in-accountable':'Zelf verwerkt in Accountable','peppol-sent-manually':'Zelf via Peppol verzonden'};
 const caseStatuses={'investigating':'In onderzoek','waiting-provider':'Wacht op aanbieder','reviewed':'Onderzocht, uitkomst apart beoordelen'};
 const states={creating:'Wordt aangemaakt',open:'Nog niet betaald',paid:'Betaald',expired:'Verlopen',failed:'Mislukt',unknown:'Onbekende uitkomst',credit_pending_review:'Tegoed in onderzoek',reversal_review:'Terugboeking in onderzoek',submitting:'Wordt verstuurd',queued:'In verwerking'};
 let disposed=false,root=null,onChanged=()=>{},accounting=null,recovery=null;
 const urls=new Set(),timers=new Set();
 const current=()=>!disposed&&window.rigRequest===binding.request&&window.rigSessionActive===binding.active&&binding.active()===true;
 const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node;};
 const euro=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(value/100):'Nog onbekend';
 const date=value=>{const d=new Date(typeof value==='string'&&/^\d{4}-\d{2}-\d{2} /.test(value)?value.replace(' ','T')+'Z':value);return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',year:'numeric'}).format(d);};
 const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 function dispose(){
  if(disposed)return;disposed=true;
  for(const state of [accounting,recovery])if(state){state.loadId++;state.actionId++;}
  if(accounting?.verifying||recovery?.verifying)window.rigOwnerVerification?.cancel?.();
  for(const url of urls)URL.revokeObjectURL(url);urls.clear();for(const timer of timers)clearTimeout(timer);timers.clear();
  root?.replaceChildren();root=null;accounting=null;recovery=null;
  window.removeEventListener('pagehide',dispose);document.getElementById('authLogout')?.removeEventListener('click',dispose);
 }
 function check(){if(!current()){dispose();throw Error('Je aanmelding is gewijzigd.');}}
 function message(state,text,error=false){if(!current()||!state)return;state.status.textContent=text;state.status.dataset.error=String(error);}
 async function response(path,options={}){
  check();const result=await binding.request(path,{cache:'no-store',...options});check();
  if(result.status===401||result.status===403){dispose();throw Error('Administratie is alleen beschikbaar voor de eigenaar.');}
  return result;
 }
 async function request(path,options={}){
  const result=await response(path,options);let data;try{data=await result.json();}catch{throw Error('Het antwoord kon niet worden gelezen. Probeer opnieuw.');}check();
  if(!result.ok){const error=Error(typeof data?.error==='string'?data.error.slice(0,400):'De aanvraag is niet gelukt.');error.status=result.status;error.code=data?.code;throw error;}return data;
 }
 function field(parent,label,id,type='text',choices){
  const wrap=el('label',undefined,'finance-field'),input=el(type==='select'?'select':type==='textarea'?'textarea':'input');input.id=id;if(type!=='select'&&type!=='textarea')input.type=type;wrap.append(el('span',label),input);parent.append(wrap);
  if(choices)for(const [value,text]of Object.entries(choices)){const option=el('option',text);option.value=value;input.append(option);}return input;
 }
 function table(parent,labels,rows,empty){
  if(!rows.length){parent.append(el('p',empty,'finance-empty'));return;}
  const wrap=el('div',undefined,'finance-table-wrap'),node=el('table',undefined,'finance-table'),thead=el('thead'),head=el('tr'),body=el('tbody');
  for(const text of labels)head.append(el('th',text));thead.append(head);node.append(thead,body);for(const row of rows){const tr=el('tr');for(const item of row){const cell=el('td');if(item instanceof Node)cell.append(item);else cell.textContent=String(item??'—');tr.append(cell);}body.append(tr);}wrap.append(node);parent.append(wrap);
 }
 function panel(parent,title){
  const details=el('details',undefined,'finance-details'),status=el('p','Open dit onderdeel om de gegevens op te halen.','finance-status'),output=el('section',undefined,'finance-section'),bar=el('div',undefined,'finance-toolbar'),refresh=el('button','Vernieuwen');refresh.type='button';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  details.append(el('summary',title),bar,status,output);bar.append(refresh);parent.append(details);
  return {details,status,output,bar,refresh,loaded:false,loading:false,loadId:0,actionId:0,verifying:false};
 }
 function formLock(form){const prior=[...form.querySelectorAll('input,select,textarea,button')].map(node=>[node,node.disabled]);for(const [node]of prior)node.disabled=true;return()=>{if(current()&&form.isConnected)for(const [node,value]of prior)node.disabled=value;};}
 async function protectedPost(state,form,operation,payload,path,snapshot,body=payload){
  check();if(typeof window.rigOwnerVerification?.prepare!=='function')throw Error('De apparaatbevestiging is niet beschikbaar. Vernieuw RIG.');
  if(state.mutating)throw Error('Er wordt al een beheerwijziging verwerkt.');
  const action=++state.actionId,load=state.loadId,initial=snapshot();state.verifying=true;state.mutating=true;
  try{
   let verification;try{verification=await window.rigOwnerVerification.prepare(operation,payload);}finally{state.verifying=false;}
   check();if(action!==state.actionId||load!==state.loadId||!form.isConnected||snapshot()!==initial)throw Error('De gegevens zijn gewijzigd. Controleer en bevestig opnieuw.');
   if(!verification)throw Error('De apparaatbevestiging is niet afgerond. Er is niets bewaard.');
   return await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,verification})});
  }finally{state.mutating=false;}
 }
 function watchForm(state,form){const changed=()=>{if(state.verifying){state.actionId++;window.rigOwnerVerification?.cancel?.();}};form.addEventListener('input',changed);form.addEventListener('change',changed);}
 async function download(kind){
  if(!exports.has(kind))throw Error('Deze export is niet beschikbaar.');const state=accounting,month=state.month.value,query=month?'?month='+month:'';
  if(query&&!/^\?month=20\d{2}-(?:0[1-9]|1[0-2])$/.test(query))throw Error('Kies een geldige maand.');
  message(state,'Export ophalen…');const result=await response('/api/owner/accounting/export/'+kind+'.csv'+query);
  if(!result.ok){let data;try{data=await result.json();}catch{}throw Error(data?.error||'De export kon niet worden opgehaald.');}
  if(!(result.headers.get('content-type')||'').toLowerCase().startsWith('text/csv'))throw Error('Het antwoord is geen administratie-export.');
  const blob=await result.blob();check();if(blob.size>8*1024*1024)throw Error('Deze export is te groot. Kies een afzonderlijke maand.');
  const url=URL.createObjectURL(blob);urls.add(url);const anchor=el('a');anchor.href=url;anchor.download='RIG-'+kind+'-'+(month||'alle-periodes')+'.csv';document.body.append(anchor);anchor.click();anchor.remove();
  const timer=setTimeout(()=>{timers.delete(timer);URL.revokeObjectURL(url);urls.delete(url);},1000);timers.add(timer);message(state,'Export gedownload. Dit is een handmatige overdracht, geen automatische Accountable-import.');
 }
 async function loadAccounting(){
  const state=accounting;if(!current()||!state)return;const token=++state.loadId;state.actionId++;state.loading=true;state.refresh.disabled=true;message(state,'Administratie ophalen…');
  try{
   const month=state.month.value;if(month&&!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month))throw Error('Kies een geldige maand.');
   const data=await request('/api/owner/accounting'+(month?'?month='+month:''));if(token!==state.loadId)return;
   if(data?.provider!=='accountable'||data.connection!=='manual'||data.formalAccountingComplete!==false||!Array.isArray(data.purchases)||!Array.isArray(data.documents)||!Array.isArray(data.checklist))throw Error('Het administratieoverzicht is niet beschikbaar.');
   state.data=data;state.loaded=true;renderAccounting(state,data);if(typeof data.automaticInvoiceIssuance==='boolean')await loadInvoices(state,token,month);if(token!==state.loadId)return;message(state,'Bijgewerkt. Accountable-verwerking blijft apart te controleren; Referenties zijn handmatig door jou geregistreerd.');
  }catch(error){if(token===state.loadId)message(state,error.message,true);}finally{if(current()&&token===state.loadId){state.loading=false;state.refresh.disabled=false;}}
 }
 function renderAccounting(state,data){
  state.output.replaceChildren();state.invoiceOutput=null;state.output.append(el('p',data.automaticInvoiceIssuance===true?'RIG geeft de originele factuur uit voor bevestigde aankopen. Importeer deze als externe factuur in Accountable; maak geen tweede verkoopfactuur. Accountable controleert en boekt de invoer afzonderlijk.':'Accountable is je facturatie- en boekhoudapp. RIG is niet automatisch verbonden en verstuurt geen Peppol-facturen. Maak de juiste registratie in Accountable en bewaar hier de referentie.','finance-policy-note'));
  if(typeof data.automaticInvoiceIssuance==='boolean'){
   const section=el('section',undefined,'finance-section');section.append(el('h3','Originele RIG-facturen'),el('p',data.accountableDeliveryConfigured===true?'Factuurmail is ingesteld. Een verzendbevestiging bewijst geen ontvangst, validatie of boeking in Accountable.':'Factuurmail is nog niet ingesteld. Download de PDF’s of maand-ZIP en importeer de originele bestanden zelf in Accountable.','finance-policy-note'));
   const zip=el('button','Facturen van deze maand · ZIP');zip.type='button';zip.dataset.invoiceZip='true';zip.disabled=!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(state.month.value);zip.addEventListener('click',async()=>{const month=state.month.value;if(!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)){message(state,'Kies eerst een maand voor de facturenexport.',true);return;}zip.disabled=true;try{await downloadDocument('/api/owner/invoices/export.zip?month='+month,'RIG-facturen-'+month+'.zip','application/zip',13*1024*1024,state);}catch(error){message(state,error.message,true);}finally{if(current()&&zip.isConnected)zip.disabled=false;}});section.append(zip,el('p',state.month.value?'De factuurlijst en ZIP volgen de factuurdatum in deze maand.':'Kies hierboven een maand om een ZIP met originele facturen te downloaden.','finance-policy-note'));state.invoiceOutput=el('div','Facturen ophalen…');section.append(state.invoiceOutput);state.output.append(section);
  }
  state.output.append(el('p',`${data.paidPurchaseCount??0} bevestigde aankopen · ${data.purchasesWithoutReference??0} zonder gekoppelde referentie · ontvangen: ${euro(data.verifiedGrossReceiptsCents)}. Openstaand RIG-tegoed: ${euro(data.outstandingCreditLiabilityCents)}. Volledig werkelijk resultaat: nog onbekend.`));
  const files=el('div',undefined,'finance-toolbar');for(const [kind,label]of exports){const button=el('button','CSV · '+label);button.type='button';button.dataset.exportKind=kind;button.addEventListener('click',async()=>{button.disabled=true;try{await download(kind);}catch(error){message(state,error.message,true);}finally{if(current()&&button.isConnected)button.disabled=false;}});files.append(button);}state.output.append(files);
  state.output.append(el('p','CSV-bedragen staan in centen; Fal-ramingen in de ramingenexport ook in USD-micro-eenheden. Boek een tegoedaankoop en later videogebruik niet tweemaal als ontvangen geld. Een Fal-opwaardering is geen tweede verbruikskost.','finance-policy-note'));
  const formDetails=el('details',undefined,'finance-details');formDetails.append(el('summary','Referentie uit Accountable vastleggen'));const form=el('form',undefined,'finance-form');form.id='ownerAccountingDocumentForm';formDetails.append(form);
  const order=field(form,'Betaalde aankoop','ownerAccountingOrder','select');order.required=true;for(const purchase of data.purchases.filter(p=>p.currentlyPaid===true&&UUID.test(p.orderId||''))){const option=el('option',euro(purchase.orderAmountCents)+' · '+purchase.orderReference);option.value=purchase.orderId;order.append(option);}
  const ref=field(form,'Factuur- of boekingsreferentie uit Accountable','ownerAccountingReference');ref.required=true;ref.maxLength=80;
  const documentDate=field(form,'Datum van de registratie','ownerAccountingDate','date');documentDate.required=true;documentDate.value=documentDate.max=today();
  const recordType=field(form,'Soort registratie','ownerAccountingRecordType','select',recordTypes),deliveryStatus=field(form,'Zelf bijgehouden voortgang','ownerAccountingDelivery','select',delivery),note=field(form,'Eigen toelichting (optioneel)','ownerAccountingNote','textarea');note.maxLength=240;note.parentElement.classList.add('finance-wide');
  const correction=el('p','','finance-policy-note finance-wide'),submit=el('button','Referentie bewaren');submit.type='submit';submit.className='finance-wide';form.append(correction,submit);state.output.append(formDetails);
  let replacesDocumentId=null,pending=null,selectedInvoice=null;
  function selectPurchase(id){
   const purchase=data.purchases.find(p=>p.orderId===id);order.value=id;const document=purchase?.document&&data.documents.find(d=>d.id===purchase.document.id);selectedInvoice=purchase?.invoice&&INVOICE_NUMBER.test(purchase.invoice.number||'')?purchase.invoice:null;replacesDocumentId=document?.id??null;ref.value=document?.externalInvoiceReference??selectedInvoice?.number??'';documentDate.value=document?.documentDate??today();recordType.value=document?.recordType??'invoice';deliveryStatus.value=document?.deliveryStatus??'prepared';note.value=document?.note??'';pending=null;
   updateReference();
   correction.textContent=(replacesDocumentId?'Je voegt een correctie toe. De vorige registratie blijft bewaard. ':'')+(selectedInvoice?'De originele factuur bestaat al. Gebruik dit RIG-factuurnummer bij import. Kies Boekingsreferentie voor een ander extern registratienummer.':'Dit bewaart alleen jouw referentie. RIG bevestigt niet dat een factuur of Peppol-bericht is verzonden.');
  }
  function updateReference(){ref.readOnly=Boolean(selectedInvoice&&recordType.value==='invoice');if(ref.readOnly)ref.value=selectedInvoice.number;}
  recordType.addEventListener('change',()=>{if(selectedInvoice&&recordType.value==='accounting-entry'&&ref.value===selectedInvoice.number)ref.value='';updateReference();pending=null;});
  order.addEventListener('change',()=>selectPurchase(order.value));if(order.options.length)selectPurchase(order.value);else{submit.disabled=true;correction.textContent='Er zijn nog geen betaalde aankopen om aan Accountable te koppelen.';}
  const fields=()=>({orderId:order.value,externalInvoiceReference:ref.value,documentDate:documentDate.value,recordType:recordType.value,deliveryStatus:deliveryStatus.value,note:note.value,...(replacesDocumentId?{replacesDocumentId}:{})});watchForm(state,form);
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(state.verifying||state.mutating||state.loading||!form.checkValidity())return;const value=fields();if(!UUID.test(value.orderId)||!value.externalInvoiceReference.trim()){message(state,'Kies een betaalde aankoop en vul de Accountable-referentie in.',true);return;}
   if(value.recordType!=='invoice'&&value.deliveryStatus==='peppol-sent-manually'){message(state,'Een Peppol-verzendstatus hoort bij een factuur.',true);return;}
   const key=JSON.stringify(value);if(!pending||pending.key!==key)pending={key,id:crypto.randomUUID()};const payload={idempotencyKey:pending.id,...value},unlock=formLock(form);message(state,'Bevestig het bewaren op je apparaat.');
   try{await protectedPost(state,form,'accounting-document',payload,'/api/owner/accounting/documents',()=>JSON.stringify(fields()));check();pending=null;await loadAccounting();message(state,'Referentie bewaard als jouw handmatige registratie. Dit heeft geen factuur of Peppol-bericht verstuurd.');onChanged();}
   catch(error){message(state,error.message||'De referentie is niet opgeslagen.',true);}finally{unlock();}
  });
  table(state.output,['Datum','Aankoop','Betaalstatus','Ontvangen','Accountable'],data.purchases.slice(0,200).map(purchase=>{const label=el('span',purchase.orderReference||purchase.orderId);label.append(el('small',purchase.paymentReference||'Nog geen betaalnummer'));if(purchase.invoice&&INVOICE_NUMBER.test(purchase.invoice.number||''))label.append(el('small','Originele factuur '+purchase.invoice.number));else if(['review-required','unavailable','not-eligible'].includes(purchase.invoiceIssueState)){const warning=el('small','Factuur controleren'+(issueReasons[purchase.invoiceIssueReason]?' · '+issueReasons[purchase.invoiceIssueReason]:''));warning.dataset.invoiceReview=purchase.orderId;label.append(warning);}else if(data.automaticInvoiceIssuance===true&&purchase.currentlyPaid===true)label.append(el('small','Factuur wordt voorbereid'));const doc=el('span',purchase.document?.externalInvoiceReference||'Nog niet gekoppeld');if(purchase.document)doc.append(el('small',(delivery[purchase.document.deliveryStatus]||purchase.document.deliveryStatus)+' · door jou geregistreerd'));if(purchase.currentlyPaid===true&&UUID.test(purchase.orderId||'')){const edit=el('button',purchase.document?'Referentie wijzigen':'Referentie toevoegen');edit.type='button';edit.addEventListener('click',()=>{selectPurchase(purchase.orderId);formDetails.open=true;ref.focus();});doc.append(edit);}return [date(purchase.creditedAt||purchase.createdAt),label,states[purchase.state]||purchase.state,euro(purchase.verifiedReceiptCents),doc];}),'Nog geen aankopen in deze periode.');
  if(data.hasMorePurchases)state.output.append(el('p','Dit overzicht toont 200 aankopen. Kies een maand of gebruik de volledige CSV-export.','finance-policy-note'));
  const list=el('ul');for(const check of data.checklist.slice(0,10))list.append(el('li',check.text));state.output.append(list);
 }
 async function downloadDocument(path,filename,type,max,state){
  const result=await response(path);if(!result.ok){let data;try{data=await result.json();}catch{}throw Error(data?.error||'Het document kon niet worden opgehaald.');}
  if((result.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase()!==type)throw Error('Het antwoord is geen geldig factuurbestand.');
  const blob=await result.blob();check();if(blob.size>max)throw Error('Dit bestand is te groot. Kies een afzonderlijke maand.');
  const url=URL.createObjectURL(blob);urls.add(url);const anchor=el('a');anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();const timer=setTimeout(()=>{timers.delete(timer);URL.revokeObjectURL(url);urls.delete(url);},1000);timers.add(timer);message(state,'Originele factuur gedownload. Importeer als externe factuur in Accountable; maak geen tweede verkoopfactuur.');
 }
 async function loadInvoices(state,token,month){
  try{
   const data=await request('/api/owner/invoices'+(month?'?month='+month:''));check();if(token!==state.loadId||!state.invoiceOutput?.isConnected)return;
   if(!Array.isArray(data?.invoices)||data.accountableValidated!==false||data.peppolDeliveryVerified!==false)throw Error('De factuurgegevens konden niet worden gecontroleerd.');
   const rows=data.invoices.filter(item=>UUID.test(item?.id||'')&&UUID.test(item?.orderId||'')&&INVOICE_NUMBER.test(item?.number||'')&&Number.isSafeInteger(item.amountCents)&&item.currency==='EUR').slice(0,200);state.invoiceOutput.replaceChildren();
   table(state.invoiceOutput,['Factuurdatum','Originele factuur','Bedrag','Overdracht aan Accountable'],rows.map(item=>{const document=el('span',item.number),download=el('button','PDF downloaden');download.type='button';download.dataset.invoicePdf=item.id;download.addEventListener('click',async()=>{download.disabled=true;try{await downloadDocument('/api/owner/invoices/'+item.id+'/pdf',item.number+'.pdf','application/pdf',3*1024*1024,state);}catch(error){message(state,error.message,true);}finally{if(current()&&download.isConnected)download.disabled=false;}});document.append(download);const status=el('span',invoiceMail[item.mailState]||'Overdracht moet worden gecontroleerd');status.append(el('small','Boeking en Peppol-bezorging zijn niet bevestigd.'));return [date(item.issuedDate),document,euro(item.amountCents),status];}),'Nog geen uitgegeven facturen in deze periode.');
   if(data.hasMore)state.invoiceOutput.append(el('p','De lijst toont maximaal 200 facturen. Kies een afzonderlijke maand.','finance-policy-note'));
  }catch(error){if(current()&&token===state.loadId&&state.invoiceOutput?.isConnected)state.invoiceOutput.replaceChildren(el('p',error.message||'Facturen zijn tijdelijk niet beschikbaar.'));}
 }
 async function loadRecovery(){
  const state=recovery;if(!current()||!state)return;const token=++state.loadId;state.actionId++;state.loading=true;state.refresh.disabled=true;message(state,'Probleemgevallen en klantvragen ophalen…');
  try{
   const results=await Promise.allSettled([request('/api/owner/recovery'),request('/api/owner/support')]);check();if(token!==state.loadId)return;
   state.output.replaceChildren();let available=false;
   if(results[0].status==='fulfilled'&&Array.isArray(results[0].value?.cases)){renderCases(state,results[0].value.cases);available=true;}else state.output.append(el('p','Probleemgevallen konden niet worden opgehaald. Vernieuw om opnieuw te proberen.'));
   if(results[1].status==='fulfilled'&&Array.isArray(results[1].value?.cases)){renderSupport(state,results[1].value.cases);available=true;}else state.output.append(el('p','Klantvragen konden niet worden opgehaald. Vernieuw om opnieuw te proberen.'));
   state.loaded=available;message(state,available?'Bijgewerkt. Er is geen betaling of video opnieuw gestart.':'Het overzicht kon niet worden opgehaald.',!available);
  }catch(error){if(token===state.loadId)message(state,error.message,true);}finally{if(current()&&token===state.loadId){state.loading=false;state.refresh.disabled=false;}}
 }
 function renderCases(state,cases){
  state.output.append(el('h3','Betalingen en video’s in onderzoek'));if(!cases.length){state.output.append(el('p','Geen probleemgevallen aangetroffen.'));return;}
  for(const item of cases.slice(0,40)){
   if(!['payment','generation'].includes(item.kind)||!UUID.test(item.id||'')||!HASH.test(item.version||''))continue;
   const article=el('article',undefined,'finance-section');article.append(el('strong',(item.kind==='payment'?'Betaling':'Video')+' · '+item.id),el('p',(states[item.state]||item.state)+' · '+(item.fundingKind==='owner-provider'?'Eigen Fal-opdracht, geen klanttegoed':euro(item.amountCents))),el('p',item.nextStep||'Onderzoek de bestaande opdracht bij de aanbieder.'));if(item.providerRequestId)article.append(el('p','Verzoeknummer bij aanbieder: '+item.providerRequestId));
   for(const note of (item.notes||[]).slice(0,3))article.append(el('p',(caseStatuses[note.status]||note.status)+' · '+note.note,'finance-policy-note'));
   const form=el('form',undefined,'finance-form');form.dataset.recoveryKind=item.kind;form.dataset.caseId=item.id;const status=field(form,'Onderzoekstatus','recovery-status-'+item.id,'select',caseStatuses),note=field(form,'Onderzoeksnotitie','recovery-note-'+item.id,'textarea');note.required=true;note.maxLength=1000;note.parentElement.classList.add('finance-wide');const submit=el('button','Onderzoeksnotitie bewaren');submit.type='submit';form.append(submit);watchForm(state,form);let notePending=null;
   const noteFields=()=>({kind:item.kind,caseId:item.id,expectedVersion:item.version,status:status.value,note:note.value});
   form.addEventListener('submit',async event=>{event.preventDefault();if(state.verifying||state.mutating||state.loading||!form.checkValidity())return;const value=noteFields(),key=JSON.stringify(value);if(!notePending||notePending.key!==key)notePending={key,id:crypto.randomUUID()};const payload={idempotencyKey:notePending.id,...value},unlock=formLock(form);message(state,'Bevestig het bewaren van de onderzoeksnotitie.');try{await protectedPost(state,form,'recovery-note',payload,'/api/owner/recovery/notes',()=>JSON.stringify(noteFields()));await loadRecovery();message(state,'Onderzoeksnotitie bewaard. Tegoed en opdrachtstatus zijn niet gewijzigd.');}catch(error){message(state,error.message,true);}finally{unlock();}});article.append(form);
   if(item.kind==='payment'){
    const adopt=el('form',undefined,'finance-form');adopt.dataset.paymentCase=item.id;const id=field(adopt,'Mollie-betalingsnummer voor deze bestelling','recovery-payment-'+item.id);id.required=true;id.pattern='tr_[A-Za-z0-9]{6,80}';id.value=item.providerRequestId||'';const verify=el('button','Bestaande Mollie-betaling controleren');verify.type='submit';adopt.append(el('p','De server vergelijkt bedrag, profiel en bestelling bij Mollie. Alleen een bevestigde betaling kan het bijbehorende tegoed vrijgeven. Er wordt geen nieuwe betaling aangemaakt.','finance-policy-note finance-wide'),verify);watchForm(state,adopt);let paymentPending=null;
    adopt.addEventListener('submit',async event=>{event.preventDefault();if(state.verifying||state.mutating||state.loading||!adopt.checkValidity())return;const value=id.value,key=value;if(!paymentPending||paymentPending.key!==key)paymentPending={key,id:crypto.randomUUID()};const payload={orderId:item.id,idempotencyKey:paymentPending.id,expectedVersion:item.version,providerPaymentId:value},unlock=formLock(adopt);message(state,'Bevestig het controleren van de bestaande Mollie-betaling.');try{const result=await protectedPost(state,adopt,'recovery-payment',payload,'/api/owner/recovery/payments/'+item.id+'/adopt',()=>id.value,{idempotencyKey:payload.idempotencyKey,expectedVersion:payload.expectedVersion,providerPaymentId:payload.providerPaymentId});await loadRecovery();message(state,result.creditConfirmed===true?'Bestaande betaling gecontroleerd en tegoed bevestigd.':result.message||'De betaling blijft in onderzoek; bruikbaar tegoed is niet bevestigd.');onChanged();}catch(error){message(state,error.message,true);}finally{unlock();}});article.append(adopt);
   }
   state.output.append(article);
  }
 }
 function renderSupport(state,requests){
  state.output.append(el('h3','Ontvangen klantvragen'));if(!requests.length){state.output.append(el('p','Nog geen klantvragen ontvangen.'));return;}
  for(const item of requests.slice(0,50)){const article=el('article',undefined,'finance-section');article.append(el('strong',(item.kind==='withdrawal'?'Herroepingsverzoek':'Vraag over betaling')+' · '+(item.id||'')),el('p',date(item.createdAt)+' · aankoop '+(item.orderRequestId||item.orderId||'—')),el('p',euro(item.amountCents)+' · actuele betaalstatus: '+(states[item.currentOrderState]||item.currentOrderState||'onbekend')+(item.paymentId?' · '+item.paymentId:'')),el('p',item.message||'Geen toelichting meegegeven.'),el('small','Ontvangen verzoek; geen beslissing of terugbetaling uitgevoerd.'));state.output.append(article);}
 }
 function mount(container,options={}){
  if(!current()){dispose();return;}if(root===container)return;if(root)root.replaceChildren();root=container;onChanged=typeof options.onChanged==='function'?options.onChanged:()=>{};container.replaceChildren();
  accounting=panel(container,'Administratie voor Accountable');accounting.month=field(accounting.bar,'Maand administratie (leeg = alle)','ownerAccountingMonth','month');accounting.details.addEventListener('toggle',()=>{if(accounting.details.open&&!accounting.loaded&&!accounting.loading)void loadAccounting();});accounting.refresh.addEventListener('click',()=>void loadAccounting());accounting.month.addEventListener('change',()=>{if(accounting.details.open)void loadAccounting();});
  recovery=panel(container,'Probleemgevallen en klantvragen');recovery.details.addEventListener('toggle',()=>{if(recovery.details.open&&!recovery.loaded&&!recovery.loading)void loadRecovery();});recovery.refresh.addEventListener('click',()=>void loadRecovery());
 }
 window.addEventListener('pagehide',dispose);document.getElementById('authLogout')?.addEventListener('click',dispose);window.rigOwnerAdministration={mount,dispose};
})();
