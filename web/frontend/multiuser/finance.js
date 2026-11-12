'use strict';
(() => {
  const button=document.getElementById('financeButton');
  window.rigFinanceDispose?.();
  if(!button)return;
  button.hidden=true;
  if(window.rigNativeSite!==true||typeof window.rigRequest!=='function'||typeof window.rigSessionActive!=='function'||window.rigSessionActive()!==true)return;
  const context={request:window.rigRequest,active:window.rigSessionActive};
  const current=()=>!disposed&&window.rigRequest===context.request&&window.rigSessionActive===context.active&&context.active()===true;
  const euro=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(value/100):'Onbekend';
  const dollars=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('nl-BE',{style:'currency',currency:'USD'}).format(value/1000000):'Onbekend';
  const percent=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('nl-BE',{maximumFractionDigits:1}).format(value/100)+'%':'Onbekend';
  const date=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('nl-BE',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Europe/Brussels'}).format(d);};
  const element=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
  const integer=value=>Number.isSafeInteger(value);
  const stateNames={submitting:'Wordt verstuurd',unknown:'Wordt gecontroleerd',queued:'In verwerking',completed:'Klaar',failed:'Mislukt'};
  const categories={'fal-charge':'Fal-verbruik van één video','fal-topup':'Fal-tegoed bijgekocht','mollie':'Mollie-betaalkosten','hosting':'Hosting en opslag','other':'Andere bedrijfskosten','refund':'Terugbetaling (alleen registratie)'};
  const paymentMethods={bancontact:'Bancontact',creditcard:'Kaart',ideal:'iDEAL',wero:'Wero',paypal:'PayPal',applepay:'Apple Pay',googlepay:'Google Pay',banktransfer:'Overschrijving',belfius:'Belfius',kbc:'KBC/CBC'};
  const paymentReasons={profile_mismatch:'Het Mollie-profiel komt niet overeen met de betaalinstellingen van RIG.',profile_blocked:'Mollie heeft het betaalprofiel geblokkeerd.',no_enabled_methods:'Mollie biedt momenteel geen betaalmethode aan voor € 5,00.',rate_limited:'De betaalstatus is te vaak gecontroleerd. Probeer later opnieuw.',funding_unavailable:'Nieuwe tegoedaankopen zijn gepauzeerd totdat er voldoende gecontroleerde Fal-dekking is. Bestaande betalingen worden verder verwerkt.'};
  const policyFields=[
    ['eurPerUsdMicros','Euro per US$1',1000000,0.5,2,0.000001],
    ['providerVatBps','Reserve voor btw op Fal (%)',100,0,30,0.01],
    ['paymentFeeBps','Reserve voor betaalkosten (%)',100,0,30,0.01],
    ['failureBufferBps','Reserve voor mislukkingen (%)',100,0,100,0.01],
    ['preparationCents','Voorbereiding per video (€)',100,0,5,0.01],
    ['minMarginBps','Minimale geraamde marge (%)',100,0,90,0.01],
    ['dailyProviderLimitUsdMicros','Daglimiet Fal (US$, UTC-dag)',1000000,0.1,1000,0.01],
    ['minPriceCents','Minimumprijs Standaard / bewerken (€)',100,0.01,12,0.01],
    ['minProPriceCents','Minimumprijs Pro (€)',100,0.01,12,0.01]
  ];
  let disposed=false,dialog=null,ui=null,data=null,loadSequence=0,loading=false,salesSequence=0,salesLoading=false,expensePending=null,policyPending=null,correction=null;

  function dispose(){
    if(disposed)return;disposed=true;loadSequence++;salesSequence++;data=null;expensePending=null;policyPending=null;correction=null;
    window.rigOwnerVerification?.cancel?.();window.rigOwnerAdministration?.dispose?.();
    button.hidden=true;button.closest('header')?.classList.remove('has-finance');button.removeEventListener('click',open);window.removeEventListener('pagehide',dispose);document.getElementById('authLogout')?.removeEventListener('click',dispose);
    if(dialog?.open)dialog.close();dialog?.remove();dialog=null;ui=null;
    if(window.rigFinanceDispose===dispose)delete window.rigFinanceDispose;
  }
  window.rigFinanceDispose=dispose;
  window.addEventListener('pagehide',dispose);
  document.getElementById('authLogout')?.addEventListener('click',dispose);

  async function request(path,init={}){
    if(!current()){dispose();throw Error('Je aanmelding is gewijzigd.');}
    const response=await context.request(path,{cache:'no-store',...init});
    if(!current()){dispose();throw Error('Je aanmelding is gewijzigd.');}
    if(response.status===401||response.status===403){dispose();throw Error('Dit overzicht is alleen beschikbaar voor de eigenaar.');}
    let body;try{body=await response.json();}catch{throw Error('Je financieel overzicht is tijdelijk niet beschikbaar.');}
    if(!current()){dispose();throw Error('Je aanmelding is gewijzigd.');}
    if(!response.ok){const message=typeof body?.error==='string'?body.error.slice(0,240):'Opslaan is niet gelukt. Probeer opnieuw.';const error=Error(message);error.status=response.status;if(typeof body?.code==='string')error.code=body.code;throw error;}
    return body;
  }
  function validSummary(value){
    return value?.currency==='EUR'&&value.period&&value.income&&value.credits&&value.costs&&value.margin&&value.policy&&typeof value.policy.version==='string'&&policyFields.every(([key])=>integer(value.policy[key]))&&Array.isArray(value.jobs)&&Array.isArray(value.expenses)&&Array.isArray(value.warnings)&&integer(value.income.cashReceivedCents)&&integer(value.income.earnedVideoCents)&&integer(value.credits.outstandingCents);
  }
  function status(message,error=false){if(!current()||!ui)return;ui.status.textContent=message;ui.status.dataset.error=String(error);}
  function field(parent,label,id,type='text'){
    const wrap=element('label',undefined,'finance-field'),caption=element('span',label),input=element(type==='select'?'select':'input');
    input.id=id;if(type!=='select')input.type=type;wrap.append(caption,input);parent.append(wrap);return input;
  }
  function card(parent,label,id,description){
    const wrap=element('div',undefined,'finance-card'),title=element('span',label),value=element('strong','—'),note=element('small',description);value.id=id;wrap.append(title,value,note);parent.append(wrap);return {wrap,value,note};
  }
  function details(parent,title){const node=element('details',undefined,'finance-details');node.append(element('summary',title));parent.append(node);return node;}
  function build(){
    dialog=element('dialog',undefined,'finance-dialog');dialog.id='financeDialog';dialog.setAttribute('aria-labelledby','financeTitle');
    const head=element('div',undefined,'settings-head'),heading=element('div',undefined,'finance-heading'),title=element('strong','Financiën');title.id='financeTitle';heading.append(element('small','Alleen voor jou'),title);
    const close=element('button','×','close');close.type='button';close.setAttribute('aria-label','Financiën sluiten');close.addEventListener('click',()=>dialog.close());head.append(heading,close);dialog.append(head);
    const toolbar=element('div',undefined,'finance-toolbar'),month=field(toolbar,'Periode','financeMonth','month'),refresh=element('button','Vernieuwen'),all=element('button','Alles');refresh.type=all.type='button';toolbar.append(refresh,all);dialog.append(toolbar);
    const message=element('p','', 'finance-status');message.id='financeStatus';message.setAttribute('role','status');message.setAttribute('aria-live','polite');dialog.append(message);
    const sales=details(dialog,'Tegoed verkopen');sales.id='financeSales';
    const salesStatus=element('p','Open dit onderdeel om de actuele betaalstatus te controleren.','finance-note');salesStatus.id='financeSalesStatus';salesStatus.setAttribute('role','status');salesStatus.setAttribute('aria-live','polite');
    const salesMethods=element('p','','finance-note');salesMethods.id='financeSalesMethods';
    const salesChecked=element('small','Nog niet gecontroleerd.');salesChecked.id='financeSalesChecked';
    sales.append(salesStatus,salesMethods,salesChecked,element('p','Dit controleert welke methoden Mollie voor € 5,00 aanbiedt. De klant kiest en bevestigt zelf bij Mollie. Tegoed verschijnt pas na een gecontroleerde betaling. Gebruik Vernieuwen om opnieuw te controleren.','finance-policy-note'));
    const fundingStatus=element('p','De dekking voor klanttegoed is nog niet gecontroleerd.','finance-note');fundingStatus.id='financeFundingStatus';fundingStatus.setAttribute('role','status');
    const fundingFigures=element('p','','finance-note');fundingFigures.id='financeFundingFigures';
    const fundingChecked=element('small','');fundingChecked.id='financeFundingChecked';
    sales.append(fundingStatus,fundingFigures,fundingChecked,element('p','De controle telt beschikbaar klanttegoed, lopende video’s en open betalingen mee vóór een nieuwe aankoop. Automatische aanvulling regel je eenmalig bij Fal; RIG doet zelf geen kaartafschrijving. Het saldo kan achterlopen en uitgaven buiten RIG blijven apart.','finance-policy-note'));
    const security=element('section');security.id='financeSecurity';dialog.append(security);
    if(typeof window.rigOwnerVerification?.mount==='function')window.rigOwnerVerification.mount(security);
    else security.append(element('p','De extra beveiliging is tijdelijk niet beschikbaar. Vernieuw RIG om gevoelige handelingen te bevestigen.','finance-note'));
    const cards=element('div',undefined,'finance-cards');dialog.append(cards);
    const cash=card(cards,'Ontvangen betalingen','financeCash','Betaalde tegoedaankopen, vóór kosten.'),earned=card(cards,'Gebruikt voor video’s','financeEarned','Afgerond klanttegoed voor video’s.'),liability=card(cards,'Openstaand RIG-tegoed','financeLiability','Beschikbaar en gereserveerd, over alle periodes.'),margin=card(cards,'Geraamde marge','financeMargin','Na kostenreserves, vóór vaste kosten en belasting.');
    const warning=element('p','', 'finance-warning');warning.hidden=true;dialog.append(warning);
    dialog.append(element('p','De kostenraming gebruikt je onderstaande aannames. Werkelijke kosten worden pas meegenomen als je ze vastlegt. Bedragen zijn vóór inkomstenbelasting.','finance-note'));
    const breakdown=element('dl',undefined,'finance-breakdown');dialog.append(breakdown);
    const rows=new Map();for(const [key,label]of [['estimatedFalCents','Fal-verbruik · raming'],['estimatedPaymentCents','Betaalkosten · reserve'],['estimatedPreparationCents','Voorbereiding · reserve'],['estimatedFailureReserveCents','Mislukkingen · reserve'],['estimatedOperatingResultCents','Geraamd resultaat na vastgelegde vaste kosten'],['actualRecordedCents','Vastgelegde werkelijke kosten'],['recordedResultCents','Resultaat met vastgelegde kosten'],['actualProfitCents','Volledig werkelijk resultaat'],['falTopupsCents','Fal-tegoed bijgekocht · kasuitgave'],['refundedCents','Vastgelegde terugbetalingen (kasuitstroom)'],['creditIssuedCents','Uitgegeven gekocht RIG-tegoed'],['promoIssuedCents','Uitgegeven gratis RIG-tegoed'],['outstandingCents','Beschikbaar klanttegoed'],['heldCents','Gereserveerd voor lopende video’s'],['negativeBalanceCents','Negatieve klantensaldi']]){const row=element('div'),dt=element('dt',label),dd=element('dd','—');row.append(dt,dd);breakdown.append(row);rows.set(key,dd);}
    const jobsSection=element('section',undefined,'finance-section');jobsSection.append(element('h3','Laatste 50 video-opdrachten'));const jobsWrap=element('div',undefined,'finance-table-wrap');jobsSection.append(jobsWrap);dialog.append(jobsSection);
    const expensesSection=element('section',undefined,'finance-section');expensesSection.append(element('h3','Laatste 100 kosten en kasregistraties'));const expensesWrap=element('div',undefined,'finance-table-wrap');expensesSection.append(expensesWrap);dialog.append(expensesSection);
    const expenseDetails=details(dialog,'Werkelijke kosten toevoegen'),expenseForm=element('form',undefined,'finance-form');expenseDetails.append(expenseForm);
    const correctionNotice=element('p','','finance-policy-note finance-wide');correctionNotice.hidden=true;expenseForm.append(correctionNotice);
    const category=field(expenseForm,'Soort','financeExpenseCategory','select');for(const [key,label]of Object.entries(categories)){const option=element('option',label);option.value=key;category.append(option);}
    const expenseDate=field(expenseForm,'Factuurdatum','financeExpenseDate','date');expenseDate.required=true;expenseDate.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const amount=field(expenseForm,'Bedrag in euro, inclusief niet-aftrekbare btw','financeExpenseAmount','text');amount.inputMode='decimal';amount.required=true;amount.placeholder='0,00';amount.maxLength=12;
    const job=field(expenseForm,'Video-opdracht','financeExpenseJob','select');job.required=true;
    const note=field(expenseForm,'Omschrijving of factuurreferentie','financeExpenseNote');note.required=true;note.maxLength=240;note.parentElement.classList.add('finance-wide');
    const expenseNote=element('p','Een Fal-opwaardering is een kasuitgave en wordt niet opnieuw als videokost geteld. Leg per video het werkelijk aangerekende Fal-verbruik vast; dit kan ook €0 zijn. Registreren voert geen betaling uit en wijzigt geen RIG-saldo. Bij een correctie laat €0 de oorspronkelijke kost vervallen.','finance-policy-note finance-wide');expenseForm.append(expenseNote);
    const expenseActions=element('div',undefined,'finance-wide'),expenseSubmit=element('button','Kosten vastleggen'),cancelCorrection=element('button','Nieuwe kost');expenseSubmit.type='submit';cancelCorrection.type='button';cancelCorrection.hidden=true;expenseActions.append(expenseSubmit,cancelCorrection);expenseForm.append(expenseActions);
    const policyDetails=details(dialog,'Aannames en uitgavenlimiet'),policyForm=element('form',undefined,'finance-form'),inputs=new Map();policyDetails.append(policyForm);
    for(const [key,label,scale,min,max,step]of policyFields){const input=field(policyForm,label,'financePolicy-'+key,'number');input.required=true;input.min=String(min);input.max=String(max);input.step=String(step);inputs.set(key,{input,scale});}
    const policyNote=element('p','Deze instellingen bewaken nieuwe video’s. De btw- en kostenreserves zijn begrotingsaannames, geen vaststelling van je facturen. De margecontrole kan de basisprijs verhogen; je klant ziet altijd zijn exacte prijs vóór bevestiging. Een eerder bevestigde klantprijs wordt nooit stilzwijgend verhoogd. De daglimiet wordt per kalenderdag in UTC bijgehouden.','finance-policy-note finance-wide');policyForm.append(policyNote);
    const policySubmit=element('button','Bevestigen en bewaren');policySubmit.type='submit';policySubmit.className='finance-wide';policyForm.append(policySubmit);
    const administration=element('section');administration.id='financeAdministration';dialog.append(administration);
    if(typeof window.rigOwnerAdministration?.mount==='function')window.rigOwnerAdministration.mount(administration,{onChanged:()=>void reload()});
    document.body.append(dialog);
    ui={month,refresh,all,status:message,sales,salesStatus,salesMethods,salesChecked,fundingStatus,fundingFigures,fundingChecked,cash,earned,liability,margin,warning,rows,jobsWrap,expensesWrap,expenseDetails,expenseForm,category,expenseDate,amount,job,note,expenseSubmit,correctionNotice,cancelCorrection,policyForm,inputs,policySubmit};
    sales.addEventListener('toggle',()=>{if(sales.open&&dialog.open)void reloadSales();});
    refresh.addEventListener('click',()=>{void reload();if(sales.open)void reloadSales();});all.addEventListener('click',()=>{month.value='';void reload();});month.addEventListener('change',()=>void reload());
    category.addEventListener('change',()=>{job.parentElement.hidden=category.value!=='fal-charge';job.required=category.value==='fal-charge';if(category.value!=='fal-charge')job.value='';});category.dispatchEvent(new Event('change'));
    cancelCorrection.addEventListener('click',()=>{if(!ui.expenseSubmit.disabled)resetExpense();});
    expenseForm.addEventListener('submit',saveExpense);policyForm.addEventListener('submit',savePolicy);
  }
  function table(target,headings,rows,empty){
    target.replaceChildren();if(!rows.length){target.append(element('p',empty,'finance-empty'));return;}
    const table=element('table',undefined,'finance-table'),head=element('thead'),tr=element('tr');for(const title of headings)tr.append(element('th',title));head.append(tr);table.append(head);const body=element('tbody');
    for(const cells of rows){const row=element('tr');for(const content of cells){const cell=element('td');if(content instanceof Node)cell.append(content);else cell.textContent=String(content);row.append(cell);}body.append(row);}table.append(body);target.append(table);
  }
  function render(value){
    if(!current())return;
    data=value;
    if(!dialog)build();
    button.hidden=false;button.closest('header')?.classList.add('has-finance');
    ui.cash.value.textContent=euro(value.income.cashReceivedCents);ui.earned.value.textContent=euro(value.income.earnedVideoCents);ui.liability.value.textContent=euro(value.credits.liabilityCents??value.credits.outstandingCents);ui.margin.value.textContent=euro(value.margin.estimatedContributionCents);ui.margin.wrap.dataset.negative=String(value.margin.estimatedContributionCents<0);ui.margin.note.textContent=`${percent(value.margin.estimatedMarginBps)} · raming vóór vaste kosten en belasting.`;
    for(const [key,node]of ui.rows){const source=Object.hasOwn(value.income,key)?value.income:Object.hasOwn(value.credits,key)?value.credits:Object.hasOwn(value.margin,key)?value.margin:value.costs;node.textContent=euro(source[key]);}
    const warnings=value.warnings.filter(x=>typeof x==='string').slice(0,8);
    if(value.costs.missingEstimateJobs>0)warnings.push(`${value.costs.missingEstimateJobs} oudere video-opdracht(en) missen een kostenraming. Daarom kan de geraamde marge onbekend zijn.`);
    if(value.costs.actualCoverageComplete!==true)warnings.unshift(`Het werkelijke resultaat is nog onbekend. ${integer(value.costs.missingActualJobs)?value.costs.missingActualJobs+' video-opdracht(en) missen werkelijke Fal-kosten. ':''}Vul ook je betaal- en vaste kosten aan.`);
    ui.warning.textContent=warnings.join(' ');ui.warning.hidden=warnings.length===0;
    if(value.costs.actualCoverageComplete!==true)ui.rows.get('actualProfitCents').textContent='Nog onbekend';
    table(ui.jobsWrap,['Datum / opdracht','Status','Klantprijs','Kosten · raming','Werkelijk Fal-verbruik','Marge · raming'],value.jobs.slice(0,100).map(job=>{
      const label=element('span',date(job.recognizedAt??job.createdAt));label.append(element('small',typeof job.id==='string'?job.id:'—'));const state=stateNames[job.state]||'Wordt gecontroleerd';
      return [label,`${state}${job.fundingKind==='owner-provider'?' · eigen gebruik':''}`,job.fundingKind==='owner-provider'?'Eigen Fal-account':euro(job.priceCents),euro(job.estimatedCostCents),euro(job.actualCostCents),euro(job.estimatedMarginCents)];
    }),'Nog geen video-opdrachten in deze periode.');
    table(ui.expensesWrap,['Datum','Soort','Omschrijving','Bedrag',''],value.expenses.slice(0,100).map(expense=>{
      const edit=element('button','Corrigeren','finance-correct');edit.type='button';edit.addEventListener('click',()=>startCorrection(expense));
      return [date(expense.date),categories[expense.category]||'Kosten',typeof expense.note==='string'?expense.note:'',euro(expense.amountCents),edit];
    }),'Nog geen werkelijke kosten vastgelegd in deze periode.');
    const selected=ui.job.value;ui.job.replaceChildren();const choose=element('option','Kies een video-opdracht');choose.value='';ui.job.append(choose);
    for(const job of value.jobs.slice(0,100)){if(typeof job.id!=='string'||job.actualCostCents!==null||job.canRecordFalCost!==true)continue;const option=element('option',`${date(job.recognizedAt??job.createdAt)} · ${stateNames[job.state]||'Wordt gecontroleerd'} · ${job.id}`);option.value=job.id;ui.job.append(option);}
    if(correction?.category==='fal-charge')correctionJob(correction.jobId);else ui.job.value=selected;
    for(const [key,{input,scale}]of ui.inputs)input.value=String(value.policy[key]/scale);
    status('Bijgewerkt. Je klanten zien alleen hun eigen videoprijs.');
  }
  async function reload({initial=false}={}){
    if(!current()){dispose();return;}
    const sequence=++loadSequence;loading=true;if(ui){ui.refresh.disabled=true;status('Overzicht ophalen…');}
    try{
      const month=ui?.month.value||'';if(month&&!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))throw Error('Kies een geldige maand.');
      const value=await request('/api/owner/finance'+(month?'?month='+month:''));if(sequence!==loadSequence||!current())return;
      if(!validSummary(value))throw Error('Het financieel overzicht is tijdelijk niet beschikbaar.');render(value);
    }catch(error){if(!initial)status(error.message,true);}
    finally{if(sequence===loadSequence){loading=false;if(current()&&ui)ui.refresh.disabled=false;}}
  }
  async function reloadFunding(sequence){
    ui.fundingStatus.textContent='Dekking voor klanttegoed controleren…';ui.fundingFigures.textContent='';ui.fundingChecked.textContent='';
    try{
      const value=await request('/api/owner/finance/funding');if(!current()||sequence!==salesSequence)return;
      if(value?.enabled===false&&value.status==='setup'){ui.fundingStatus.textContent='De voorraadbeveiliging moet nog worden ingesteld. Nieuwe tegoedaankopen blijven gepauzeerd.';return;}
      if(value?.enabled!==true||!['ready','insufficient'].includes(value.status)||!['availableUsdMicros','requiredUsdMicros','headroomUsdMicros','newCreditCapacityCents','fetchedAt','expiresAt'].every(key=>integer(value[key]))||value.availableUsdMicros<0||value.requiredUsdMicros<0||value.newCreditCapacityCents<0||value.fetchedAt>Date.now()||value.expiresAt<=Date.now()||value.expiresAt<=value.fetchedAt)throw Error('Invalid funding status');
      ui.fundingStatus.textContent=value.status==='ready'?'Gecontroleerde ruimte voor maximaal '+euro(value.newCreditCapacityCents)+' nieuw RIG-tegoed.':'Nieuwe verkopen zijn gepauzeerd: de huidige Fal-voorraad dekt de reserveringen niet.';
      ui.fundingFigures.textContent='Fal-saldo: '+dollars(value.availableUsdMicros)+' · Nodige dekking met buffer: '+dollars(value.requiredUsdMicros)+' · '+(value.headroomUsdMicros>=0?'Vrije ruimte: '+dollars(value.headroomUsdMicros):'Tekort: '+dollars(-value.headroomUsdMicros))+'.';
      ui.fundingChecked.textContent='Saldo opgevraagd om '+new Intl.DateTimeFormat('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Brussels'}).format(new Date(value.fetchedAt))+'. Fal geeft geen tijdstip van het onderliggende saldo mee.';
    }catch{if(current()&&sequence===salesSequence){ui.fundingStatus.textContent='De voorraaddekking kan nu niet worden gecontroleerd. Nieuwe verkoop is niet als gereed bevestigd.';ui.fundingFigures.textContent='';ui.fundingChecked.textContent='';}}
  }
  async function reloadSales(){
    if(!current()||!ui||salesLoading)return;
    const sequence=++salesSequence;salesLoading=true;ui.salesStatus.textContent='Mollie controleren…';ui.salesStatus.dataset.error='false';ui.salesMethods.textContent='';ui.salesChecked.textContent='Bezig met controleren…';
    void reloadFunding(sequence);
    try{
      const value=await request('/api/payments/readiness');if(!current()||sequence!==salesSequence)return;
      if(typeof value?.ready!=='boolean'||!Array.isArray(value.methods)||value.methods.length>64||value.methods.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9_]{1,39}$/.test(id))||new Set(value.methods).size!==value.methods.length||value.ready&&value.methods.length===0||!value.ready&&value.methods.length>0&&value.reason!=='funding_unavailable'||value.ready&&value.reason!==undefined||value.reason!==undefined&&(typeof value.reason!=='string'||value.reason.length>80))throw Error('Invalid payment status');
      ui.salesStatus.textContent=value.ready?'Mollie biedt betaalmethoden aan voor € 5,00.':Object.hasOwn(paymentReasons,value.reason)?paymentReasons[value.reason]:'Betalen is momenteel niet beschikbaar. Controleer je Mollie-instellingen.';
      ui.salesStatus.dataset.error=String(!value.ready);
      ui.salesMethods.textContent=value.methods.length?'Bij Mollie beschikbaar: '+value.methods.map(id=>Object.hasOwn(paymentMethods,id)?paymentMethods[id]:'Andere betaalmethode').join(', ')+'.':'';
    }catch{
      if(!current()||sequence!==salesSequence)return;
      ui.salesStatus.textContent='De betaalstatus is tijdelijk niet beschikbaar. Kies Vernieuwen om opnieuw te controleren.';ui.salesStatus.dataset.error='true';ui.salesMethods.textContent='';
    }finally{
      if(current()&&sequence===salesSequence){salesLoading=false;ui.salesChecked.textContent='Gecontroleerd om '+new Intl.DateTimeFormat('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Europe/Brussels'}).format(new Date())+'.';}
    }
  }
  function open(){if(!current()){dispose();return;}if(dialog&&!dialog.open)dialog.showModal();if(!loading)void reload();if(ui?.sales.open)void reloadSales();}
  function parseAmount(raw){if(typeof raw!=='string'||!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(raw.trim()))return null;const [whole,fraction='']=raw.trim().replace(',','.').split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));return integer(cents)&&cents<=100000000?cents:null;}
  function correctionJob(id){
    if(typeof id!=='string')return;
    if(!Array.from(ui.job.options).some(option=>option.value===id)){const option=element('option',`Bestaande opdracht · ${id}`);option.value=id;option.dataset.correctionOnly='true';ui.job.append(option);}ui.job.value=id;
  }
  function resetExpense(){
    correction=null;expensePending=null;for(const option of ui.job.querySelectorAll('[data-correction-only]'))option.remove();if(!ui.expenseSubmit.disabled){ui.category.disabled=false;ui.expenseDate.disabled=false;ui.job.disabled=false;}ui.category.value='fal-charge';ui.expenseDate.value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());ui.amount.value='';ui.note.value='';ui.job.value='';ui.correctionNotice.hidden=true;ui.correctionNotice.textContent='';ui.cancelCorrection.hidden=true;ui.expenseSubmit.textContent='Kosten vastleggen';ui.category.dispatchEvent(new Event('change'));
  }
  function startCorrection(expense){
    if(!current()||ui.expenseSubmit.disabled||typeof expense.id!=='string'||!Object.hasOwn(categories,expense.category)||!integer(expense.amountCents))return;
    correction={id:expense.id,category:expense.category,jobId:expense.jobId};expensePending=null;ui.category.value=expense.category;ui.expenseDate.value=expense.date;ui.amount.value=(expense.amountCents/100).toFixed(2).replace('.',',');ui.note.value=expense.note||'';ui.job.value='';ui.category.dispatchEvent(new Event('change'));if(expense.category==='fal-charge')correctionJob(expense.jobId);
    ui.correctionNotice.textContent='Je vervangt deze kost door een correctie. De oorspronkelijke registratie blijft bewaard en wordt niet dubbel geteld.';ui.correctionNotice.hidden=false;ui.cancelCorrection.hidden=false;ui.expenseSubmit.textContent='Correctie vastleggen';ui.expenseDetails.open=true;ui.category.disabled=true;ui.expenseDate.disabled=true;ui.job.disabled=true;ui.amount.focus();
  }
  function formBusy(form,busy){for(const control of form.querySelectorAll('input,select,textarea,button'))control.disabled=busy;if(!busy&&form===ui.expenseForm&&correction){ui.category.disabled=true;ui.expenseDate.disabled=true;ui.job.disabled=true;}}
  function pendingRecord(previous,payload){const signature=JSON.stringify(payload);return previous?.signature===signature?previous:{signature,body:{idempotencyKey:crypto.randomUUID(),...payload}};}
  async function verifiedWrite(operation,path,payload){
    if(typeof window.rigOwnerVerification?.prepare!=='function')throw Error('Vernieuw RIG om deze handeling veilig te bevestigen.');
    const verification=await window.rigOwnerVerification.prepare(operation,payload);if(!current())return false;
    if(operation!=='finance-policy'&&!verification)throw Error('De beveiligingscontrole is niet afgerond. Er is niets gewijzigd.');
    if(operation==='finance-policy'&&data?.policy.version!==payload.expectedVersion){const error=Error('De aannames zijn ondertussen gewijzigd. Controleer ze opnieuw.');error.status=409;throw error;}
    await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,...(verification?{verification}:{})})});return true;
  }
  async function saveExpense(event){
    event.preventDefault();if(!current()||!data||ui.expenseSubmit.disabled)return;
    const amountCents=parseAmount(ui.amount.value),category=ui.category.value,date=ui.expenseDate.value,note=ui.note.value.trim(),jobId=ui.job.value;
    if(amountCents===null||(!amountCents&&category!=='fal-charge'&&!correction)||!Object.hasOwn(categories,category)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!note||note.length>240||category==='fal-charge'&&!jobId){status('Vul een geldige datum, bedrag, omschrijving en zo nodig een video-opdracht in.',true);return;}
    expensePending=pendingRecord(expensePending,{category,date,amountCents,note,...(category==='fal-charge'?{jobId}:{}),...(correction?{replacesExpenseId:correction.id}:{})});formBusy(ui.expenseForm,true);status('Kosten bewaren…');
    try{
      if(!await verifiedWrite('finance-expense','/api/owner/finance/expenses',expensePending.body)||!current())return;
      const corrected=Boolean(correction);resetExpense();await reload();if(current())status(corrected?'Correctie vastgelegd. De oorspronkelijke kost wordt niet dubbel geteld.':'Kosten vastgelegd.');
    }catch(error){status(error.message,true);}finally{if(current())formBusy(ui.expenseForm,false);}
  }
  async function savePolicy(event){
    event.preventDefault();if(!current()||!data||ui.policySubmit.disabled)return;
    const payload={expectedVersion:data.policy.version};
    for(const [key,{input,scale}]of ui.inputs){const raw=Number(input.value),value=Math.round(raw*scale);if(!input.value||!Number.isFinite(raw)||!integer(value)||raw<Number(input.min)||raw>Number(input.max)||Math.abs(raw*scale-value)>0.00001){status('Controleer de aannames en uitgavenlimiet.',true);return;}payload[key]=value;}
    const signature=JSON.stringify(payload);if(policyPending?.signature!==signature)policyPending={signature,payload};formBusy(ui.policyForm,true);status('Aannames bewaren…');
    try{
      if(!await verifiedWrite('finance-policy','/api/owner/finance/policy',policyPending.payload)||!current())return;
      policyPending=null;await reload();if(current())status('Aannames opgeslagen. Nieuwe video’s worden hiermee gecontroleerd.');
    }catch(error){if(error.status===409&&current()){policyPending=null;await reload();if(current())status('De aannames zijn ondertussen gewijzigd. Controleer de huidige waarden vóór je opnieuw bewaart.',true);}else status(error.message,true);}finally{if(current())formBusy(ui.policyForm,false);}
  }
  button.addEventListener('click',open);
  void reload({initial:true});
})();
