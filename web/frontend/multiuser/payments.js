'use strict';
(() => {
  const byId=id=>document.getElementById(id);
  const money=amount=>new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(amount/100);
  const message=text=>{byId('creditsMessage').textContent=text;};
  const requestIdKey='rig-payment-request';
  const sponsored=()=>window.rigVideoFunding==='sponsored';
  const ownerProvider=()=>window.rigVideoFunding==='owner-provider';
  const native=()=>window.rigNativeSite===true;
  let purchaseReady=false,balanceRequestSequence=0,dialogSequence=0,resumeUrl=null,resumeContext=null;
  let payment={mode:null,enabled:false,frozen:false};
  let commerce=null,historySequence=0;const downloadUrls=new Set(),availablePackages=new WeakSet();
  function captureContext(){return {request:window.rigRequest,storage:window.rigScopedStorage,active:window.rigSessionActive};}
  function current(ctx){return ctx.request===window.rigRequest&&ctx.storage===window.rigScopedStorage&&ctx.active===window.rigSessionActive&&(!ctx.active||ctx.active()===true);}
  function checkContext(ctx){if(!current(ctx))throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');}
  function paymentDetails(data){
    const declared=data?.mode!==undefined||data?.currency!==undefined||data?.purchasesEnabled!==undefined;
    if(declared){
      if(!['test','live'].includes(data.mode)||data.currency!=='EUR'||typeof data.purchasesEnabled!=='boolean')throw Error('De betaalinstellingen konden niet worden gecontroleerd.');
      return {mode:data.mode,enabled:data.purchasesEnabled,frozen:data.frozen===true};
    }
    // The older standalone frontend only supports test payments. The native
    // Site must receive an explicit authenticated checkout capability.
    return {mode:native()?null:'test',enabled:!native()&&!sponsored(),frozen:data?.frozen===true};
  }
  // Pausing new sales must not strand an already-attributed Mollie payment.
  const canRecover=()=>!ownerProvider()&&!sponsored()&&['test','live'].includes(payment.mode);
  const canResume=()=>canRecover()&&!payment.frozen;
  const canPurchase=()=>canResume()&&payment.enabled;
  const pausedMessage='Tegoed kopen is tijdelijk gepauzeerd. Je bestaande RIG-tegoed blijft beschikbaar.';
  const choiceMessage=()=>payment.frozen?'Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.':!payment.enabled?pausedMessage:!byId('packageList').children.length?'Tegoedpakketten zijn momenteel niet beschikbaar. Open dit venster later opnieuw.':![...byId('packageList').children].some(button=>availablePackages.has(button))?pausedMessage:payment.mode==='live'?'Kies je tegoed. Je betaalt veilig via Mollie.':'Kies een testpakket. Mollie staat in testmodus; er wordt geen echt geld afgeschreven.';
  const budgetLabel=()=>ownerProvider()?'Eigen fal-account':payment.mode==='live'?'RIG-tegoed':sponsored()?'Gratis RIG-tegoed':window.rigVideoFunding==='owner'?'RIG-testbudget':'RIG-testtegoed';
  function configureCreditsDialog(){
    const gift=sponsored()&&payment.mode!=='live',explanation=byId('creditExplanation');
    byId('creditsTitle').textContent=budgetLabel();
    if(explanation)explanation.textContent=ownerProvider()?'Je video’s gebruiken het gekoppelde fal-account. Je hoeft hiervoor geen RIG-tegoed te kopen. Je ziet de Fal-raming vóór je bevestigt.':payment.mode==='live'?'Koop RIG-tegoed in euro. Je ziet de prijs vóór elke video. Dit staat los van een eigen fal.ai-saldo.':gift?'Gratis RIG-tegoed voor je testvideo’s. Je betaalt niets; de maker betaalt de generatie.':window.rigVideoFunding==='owner'?'Dit is fictief RIG-testbudget. Je echte fal-tegoed staat apart op fal.ai.':'Dit is RIG-testtegoed voor deze proef; geen saldo van fal.ai.';
    byId('refreshPayment').hidden=!canRecover();
    if(!canPurchase()){setPurchaseReady(false);byId('packageList').replaceChildren();}
    if(!canResume())clearResume();
  }
  function clearResume(){resumeUrl=null;resumeContext=null;byId('resumePayment').hidden=true;}
  function setPurchaseReady(ready){purchaseReady=ready&&canPurchase()&&[...byId('packageList').children].some(button=>availablePackages.has(button));for(const button of byId('packageList').children)button.disabled=!(purchaseReady&&consentReady()&&availablePackages.has(button));}
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function consentReady(){return !commerce||['BE','NL'].includes(commerce.country)&&commerce.accepted===true&&(!commerce.billingRequired||billingReady());}
  function billingReady(){const b=commerce?.billing;return b&&['name','city'].every(key=>typeof b[key]==='string'&&b[key].trim().length>0)&&typeof b.street==='string'&&b.street.trim().length>=3&&(['BE','NL'].includes(commerce.country))&&(commerce.country==='BE'?/^\d{4}$/:/^\d{4}\s?[A-Za-z]{2}$/).test(b.postalCode.trim());}
  function resetCommerce(){commerce=null;byId('commerceChoice')?.remove();}
  async function applyCommerce(value,ctx,sequence){
    resetCommerce();
    if(value===undefined)return;
    if(value?.required!==true||typeof value.version!=='string'||!/^[a-z0-9-]{1,100}$/.test(value.version)||value.currency!=='EUR'||value.customerType!=='consumer'||!Array.isArray(value.countries)||value.countries.join(',')!=='BE,NL')throw Error('De aankoopvoorwaarden konden niet worden gecontroleerd.');
    if(value.billingRequired!==undefined&&(value.billingRequired!==true||value.electronicDelivery!=='rig-download-v1'))throw Error('De factuurinstellingen konden niet worden gecontroleerd.');
    commerce={version:value.version,country:'',accepted:false,billingRequired:value.billingRequired===true,billingEdited:false,billing:{name:'',street:'',postalCode:'',city:''}};
    const box=node('div');box.id='commerceChoice';box.className='commerce-choice';
    const label=node('label','Ik koop als particulier in '),select=node('select');select.id='buyerCountry';select.setAttribute('aria-label','Land van de particuliere koper');
    for(const [code,title] of [['','Kies je land'],['BE','België'],['NL','Nederland']]){const option=node('option',title);option.value=code;select.append(option);}label.append(select);
    const consent=node('label'),checkbox=node('input');checkbox.type='checkbox';checkbox.id='acceptCommerce';
    consent.append(checkbox,document.createTextNode(' Ik ga akkoord met de '));const terms=node('a','verkoopvoorwaarden');terms.href='/voorwaarden';terms.target='_blank';terms.rel='noopener noreferrer';consent.append(terms,document.createTextNode(commerce.billingRequired?' en ontvang mijn factuur digitaal in RIG. Ik vraag om het tegoed meteen beschikbaar te maken.':' en vraag om het tegoed meteen beschikbaar te maken.'));
    const privacy=node('a','Privacy en verkopersgegevens');privacy.href='/privacy';privacy.target='_blank';privacy.rel='noopener noreferrer';
    select.addEventListener('change',()=>{if(commerce){commerce.billingEdited=true;commerce.country=select.value;setPurchaseReady(purchaseReady);}});
    checkbox.addEventListener('change',()=>{if(commerce){commerce.accepted=checkbox.checked;setPurchaseReady(purchaseReady);}});
    box.append(label);
    if(commerce.billingRequired){
      const fields=node('div');fields.className='billing-fields';fields.append(node('strong','Factuurgegevens'),node('small','Voor je automatische factuur. We onthouden deze gegevens voor je volgende aankoop.'));
      for(const [key,title,autocomplete,max]of [['name','Naam op de factuur','billing name',120],['street','Straat en huisnummer','billing address-line1',180],['postalCode','Postcode','billing postal-code',8],['city','Gemeente','billing address-level2',100]]){
        const wrap=node('label',title),input=node('input');input.id='billing-'+key;input.type='text';input.autocomplete=autocomplete;input.required=true;input.maxLength=max;
        input.addEventListener('input',()=>{if(commerce){commerce.billingEdited=true;commerce.billing[key]=input.value;setPurchaseReady(purchaseReady);}});wrap.append(input);fields.append(wrap);
      }
      box.append(fields);
    }
    box.append(consent,privacy);byId('packageList').before(box);
    if(commerce.billingRequired){
      const selected=commerce;
      try{
        const result=await request('/api/payments/billing',{},ctx);if(!current(ctx)||sequence!==dialogSequence||commerce!==selected)return;
        const b=result.billing;
        if(!selected.billingEdited&&b&&['BE','NL'].includes(b.country)&&['name','street','postalCode','city'].every(key=>typeof b[key]==='string')){
          selected.country=b.country;select.value=b.country;for(const key of ['name','street','postalCode','city']){selected.billing[key]=b[key];byId('billing-'+key).value=b[key];}
        }
      }catch{ /* Manual entry stays available when a saved address cannot load. */ }
    }
  }
  function clearHistory(){historySequence++;byId('customerHistory')?.remove();for(const url of downloadUrls)URL.revokeObjectURL(url);downloadUrls.clear();}
  async function download(path,filename,ctx,valid){
    checkContext(ctx);const response=await ctx.request(path,{credentials:'same-origin',cache:'no-store'});checkContext(ctx);
    if(!valid())return;
    if(!response.ok)throw Error('Het document is nu niet beschikbaar. Probeer later opnieuw.');
    const blob=await response.blob();checkContext(ctx);if(!valid())return;
    const url=URL.createObjectURL(blob);downloadUrls.add(url);const link=node('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();
    window.setTimeout(()=>{if(downloadUrls.delete(url))URL.revokeObjectURL(url);},60000);
  }
  function mountHistory(ctx){
    clearHistory();if(ownerProvider()||!native())return;
    const sequence=historySequence,details=node('details'),summary=node('summary','Aankopen en hulp'),body=node('div');details.id='customerHistory';details.className='customer-history';details.append(summary,body);byId('creditsDialog').append(details);
    const valid=()=>sequence===historySequence&&current(ctx)&&details.isConnected;let loaded=false;
    details.addEventListener('toggle',()=>{if(details.open&&!loaded){loaded=true;void loadHistory();}});
    async function loadHistory(){
      body.replaceChildren(node('p','Aankopen ophalen…'));
      try{
        const data=await request('/api/payments/orders',{},ctx);if(!valid())return;
        if(!Array.isArray(data.orders))throw Error('Je aankopen zijn nu niet beschikbaar.');
        const orders=data.orders.filter(x=>/^[A-Za-z0-9_-]{12,80}$/.test(x?.requestId||'')&&Number.isSafeInteger(x.amountCents)&&x.amountCents>0&&typeof x.state==='string').slice(0,20);
        body.replaceChildren();
        if(!orders.length){body.append(node('p','Je hebt nog geen aankopen.'));return;}
        const states={paid:'Betaald',open:'Nog open',expired:'Verlopen',canceled:'Geannuleerd',failed:'Niet afgerond',creating:'Wordt klaargezet',unknown:'Wordt onderzocht',credit_pending_review:'Tegoed wordt onderzocht',reversal_review:'Terugboeking wordt onderzocht'};
        for(const order of orders){
          const row=node('div');row.className='customer-order';row.append(node('p',`${money(order.amountCents)} · ${states[order.state]||'Wordt onderzocht'}`));const ref=node('small',`Bestelling ${order.requestId}`);row.append(ref);
          if(order.state==='paid'){
            const receipt=node('button','Betalingsbewijs downloaden');receipt.type='button';receipt.addEventListener('click',()=>{receipt.disabled=true;void download(`/api/payments/orders/${encodeURIComponent(order.requestId)}/receipt`,`RIG-betalingsbewijs-${order.requestId}.html`,ctx,valid).catch(e=>{if(valid())feedback.textContent=e.message;}).finally(()=>{if(valid())receipt.disabled=false;});});row.append(receipt);
          }
          if(order.invoiceAvailable===true){
            const invoice=node('button','Factuur downloaden');invoice.type='button';invoice.addEventListener('click',()=>{invoice.disabled=true;void download(`/api/payments/orders/${encodeURIComponent(order.requestId)}/invoice`,`${/^RIG-20\d{2}-\d{6,12}$/.test(order.invoiceNumber||'')?order.invoiceNumber:'RIG-factuur'}.pdf`,ctx,valid).catch(e=>{if(valid())feedback.textContent=e.message;}).finally(()=>{if(valid())invoice.disabled=false;});});row.append(invoice);
          }else if(order.state==='paid'&&data.automaticInvoices===true)row.append(node('small','Je factuur wordt klaargezet. Vernieuw dit overzicht later als ze nog ontbreekt.'));
          body.append(row);
        }
        const panel=node('div');panel.className='customer-help-form';const title=node('strong','Vraag hulp of herroeping'),orderLabel=node('label','Bestelling'),choice=node('select');choice.setAttribute('aria-label','Bestelling voor je verzoek');
        for(const order of orders){const option=node('option',`${money(order.amountCents)} · ${order.requestId}`);option.value=order.requestId;choice.append(option);}orderLabel.append(choice);
        const kindLabel=node('label','Je verzoek'),kind=node('select');kind.setAttribute('aria-label','Soort verzoek');kindLabel.append(kind);
        function kinds(){const selected=orders.find(x=>x.requestId===choice.value);kind.replaceChildren();for(const [value,text] of [['payment-help','Hulp bij betaling of tegoed'],...(selected?.state==='paid'?[['withdrawal','Aankoop herroepen / terugbetaling vragen']]:[])]){const option=node('option',text);option.value=value;kind.append(option);}}
        choice.addEventListener('change',kinds);kinds();
        const messageLabel=node('label','Toelichting (optioneel)'),input=node('textarea');input.maxLength=1000;input.rows=3;messageLabel.append(input);
        const submit=node('button','Verzoek indienen');submit.type='button';const note=node('small','Je verzoek wordt geregistreerd. Een terugbetaling wordt daarna beoordeeld; er wordt nu geen geld of tegoed verplaatst.');
        const feedback=node('p');feedback.setAttribute('role','status');feedback.id='customerHelpMessage';let retry=null;
        submit.addEventListener('click',()=>{void send();});
        async function send(){
          if(!valid()||submit.disabled)return;
          const payload={orderRequestId:choice.value,kind:kind.value,message:input.value};const key=JSON.stringify(payload);if(!retry||retry.key!==key)retry={key,id:crypto.randomUUID()};
          submit.disabled=true;feedback.textContent='Je verzoek wordt opgeslagen…';
          try{
            const result=await request('/api/payments/support-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:retry.id,...payload})},ctx);if(!valid())return;
            if(!/^[a-f0-9-]{36}$/.test(result.id||'')||result.monetaryActionPerformed!==false)throw Error('De ontvangst moet nog worden gecontroleerd.');
            feedback.replaceChildren(document.createTextNode('Je verzoek is ontvangen. Bewaar de ontvangstbevestiging. '));
            const confirmation=node('button','Ontvangstbevestiging downloaden');confirmation.type='button';confirmation.addEventListener('click',()=>{void download(`/api/payments/support-requests/${encodeURIComponent(result.id)}/confirmation`,`RIG-verzoek-${result.id}.html`,ctx,valid).catch(e=>{if(valid())feedback.append(node('span',e.message));});});feedback.append(confirmation);retry=null;input.value='';
          }catch(e){if(valid())feedback.textContent=e.message||'Je verzoek kon niet worden bevestigd. Probeer hetzelfde verzoek opnieuw.';}
          finally{if(valid())submit.disabled=false;}
        }
        panel.append(title,orderLabel,kindLabel,messageLabel,note,submit,feedback);body.append(panel);
        let previous;try{previous=await request('/api/payments/support-requests',{},ctx);}catch{if(valid())body.append(node('p','Je eerdere hulpvragen zijn nu niet beschikbaar. Je aankopen en betalingsbewijzen staan hierboven.'));return;}if(!valid())return;
        if(Array.isArray(previous.requests)&&previous.requests.length){const list=node('div');list.append(node('strong','Eerdere verzoeken'));for(const item of previous.requests.slice(0,20)){if(!/^[a-f0-9-]{36}$/.test(item?.id||''))continue;const button=node('button',`${item.kind==='withdrawal'?'Herroeping':'Hulpvraag'} · Ontvangstbevestiging`);button.type='button';button.addEventListener('click',()=>{void download(`/api/payments/support-requests/${encodeURIComponent(item.id)}/confirmation`,`RIG-verzoek-${item.id}.html`,ctx,valid).catch(e=>{if(valid())feedback.textContent=e.message;});});list.append(button);}body.append(list);}
      }catch(e){if(valid())body.replaceChildren(node('p',e.message||'Je aankopen konden niet worden opgehaald. Sluit dit onderdeel en open Tegoed opnieuw.'));}
    }
  }
  window.rigPaymentsDispose=()=>{dialogSequence++;balanceRequestSequence++;purchaseReady=false;payment={mode:null,enabled:false,frozen:false};resetCommerce();clearHistory();clearResume();byId('packageList').replaceChildren();message('Meld je opnieuw aan om je tegoed te bekijken.');byId('creditsDialog').close();};
  async function request(path,options={},ctx=captureContext()){
    checkContext(ctx);
    const response=await ctx.request(path,{credentials:'same-origin',cache:'no-store',...options});
    checkContext(ctx);
    let body;try{body=await response.json();}catch{throw Error('Tegoed is momenteel niet beschikbaar.');}
    checkContext(ctx);
    if(!response.ok){const error=Error(body?.error||'Tegoed is momenteel niet beschikbaar.');error.status=response.status;error.code=body?.code;error.paymentCreated=body?.paymentCreated;throw error;}
    return body;
  }
  function isCheckout(value){
    // Keep this classic-script guard in sync with mollie-checkout-url.mjs.
    if(typeof value!=='string'||value.length>16384||/[\u0000-\u0020\u007f]/.test(value))return false;
    try{
      const url=new URL(value);
      if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)return false;
      if(url.hostname==='mollie.com'||url.hostname.endsWith('.mollie.com'))return true;
      if(url.hostname!=='redirect.ppro.com'||url.pathname!=='/v0/pages/')return false;
      const query=[...url.searchParams];
      return query.length===1&&query[0][0]==='redirection_token'&&query[0][1].length<=8192&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(query[0][1]);
    }catch{return false;}
  }
  async function refreshBalance(){
    const sequence=++balanceRequestSequence,ctx=captureContext(),funding=window.rigVideoFunding,nativeMode=native();
    if(ownerProvider()){
      if(!current(ctx))return false;
      payment={mode:null,enabled:false,frozen:false};configureCreditsDialog();
      byId('creditsButton').textContent=budgetLabel();
      message('RIG kan je Fal-saldo niet uitlezen. Bekijk je saldo en werkelijke kosten op fal.ai.');
      return true;
    }
    try{
      const gift=sponsored(),useGiftStatus=gift&&!nativeMode,value=await request(useGiftStatus?'/api/sponsor-invitations/status':'/api/payments/balance',{},ctx),balance=useGiftStatus?value.remainingCents:value.balance;
      if(!Number.isSafeInteger(balance)||(useGiftStatus&&(value.state!=='eligible'||balance<0||balance>500)))throw Error();
      if(sequence!==balanceRequestSequence||funding!==window.rigVideoFunding||nativeMode!==native()||!current(ctx))return false;
      payment=paymentDetails(value);configureCreditsDialog();
      byId('creditsButton').textContent=`${budgetLabel()} ${money(balance)}`;
      if(gift&&payment.mode!=='live')message(`Je hebt ${money(balance)} gratis RIG-tegoed over.`);
      else message(`Je hebt ${money(balance)} ${budgetLabel()}. Je ziet de prijs vóór je bevestigt.`);
      if(canRecover()&&!payment.enabled)message(pausedMessage);
      if(payment.frozen)message('Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.');
      return true;
    }catch{
      if(sequence===balanceRequestSequence&&current(ctx)){payment={mode:null,enabled:false,frozen:false};configureCreditsDialog();byId('creditsButton').textContent=budgetLabel();message(sponsored()?'Je gratis RIG-tegoed is momenteel niet beschikbaar.':'Je tegoed kon niet worden gecontroleerd. Probeer later opnieuw.');}
      return false;
    }
  }
  async function showPackages(ctx=captureContext()){
    if(!canPurchase())return false;
    const sequence=dialogSequence;
    setPurchaseReady(false);message('Tegoedpakketten ophalen…');byId('packageList').replaceChildren();
    try{
      const data=await request('/api/payments/packages',{},ctx),details=paymentDetails(data);
      if(sequence!==dialogSequence||!current(ctx))return false;
      if(details.mode!==payment.mode)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      if(!details.enabled||details.frozen){payment=details;configureCreditsDialog();message(choiceMessage());return false;}
      await applyCommerce(data.commerce,ctx,sequence);if(sequence!==dialogSequence||!current(ctx))return false;
      if(!Array.isArray(data.packages)||!data.packages.length)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      for(const item of data.packages){
        if(!/^[a-z0-9_-]{1,40}$/.test(item?.id||'')||!Number.isSafeInteger(item.amountCents)||item.amountCents<1||item.amountCents>1000000||!Number.isSafeInteger(item.credits)||item.credits<1||item.credits>100000000)continue;
        const button=document.createElement('button');button.type='button';button.className='package-button';
        button.textContent=`${money(item.credits)} tegoed · ${money(item.amountCents)}`;button.disabled=true;
        if(item.available===undefined||item.available===true)availablePackages.add(button);
        button.addEventListener('click',()=>{if(availablePackages.has(button))void createPayment(item.id,ctx);});byId('packageList').appendChild(button);
      }
      if(!byId('packageList').children.length)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      message(choiceMessage());
      return true;
    }catch(error){if(current(ctx)){byId('packageList').replaceChildren();message(error.message||'Tegoed is momenteel niet beschikbaar.');}return false;}
  }
  async function navigateCheckout(url,ctx){
    checkContext(ctx);
    if(!isCheckout(url)||typeof window.rigCheckout!=='function')throw Error('De betaalpagina kon niet worden gecontroleerd.');
    await window.rigCheckout(url);
  }
  async function createPayment(packageId,ctx){
    if(!purchaseReady||!canPurchase()||!consentReady()||!current(ctx))return;
    setPurchaseReady(false);clearResume();
    let id=null;
    try{
      if(ctx.storage.getItem(requestIdKey)){message('Er is al een betaling gestart. Controleer eerst de status.');return;}
      id=crypto.randomUUID();ctx.storage.setItem(requestIdKey,id);message('Betaling wordt klaargezet…');
      const data=await request('/api/payments/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId,requestId:id,...(commerce?{commerce:{version:commerce.version,country:commerce.country,customerType:'consumer',accepted:true},...(commerce.billingRequired?{billing:{...commerce.billing}}:{})}:{})})},ctx);
      await navigateCheckout(data.checkoutUrl,ctx);
    }catch(error){if(current(ctx)){
      // This response proves the server tombstoned this exact intent before an order existed.
      if(id&&error.status===503&&error.code==='funding_unavailable'&&error.paymentCreated===false&&ctx.storage.getItem(requestIdKey)===id){ctx.storage.removeItem(requestIdKey);payment={...payment,enabled:false};configureCreditsDialog();message(pausedMessage);}
      else message(`${error.message||'Betaling kon niet worden gestart.'} Controleer de status voordat je opnieuw probeert.`);
    }}
    finally{if(current(ctx))setPurchaseReady(false);}
  }
  async function recover(ctx=captureContext()){
    if(!canRecover()||!current(ctx))return;
    setPurchaseReady(false);clearResume();
    try{
      let id=ctx.storage.getItem(requestIdKey);
      if(!id){
        const result=await request('/api/payments/orders',{},ctx);
        if(!Array.isArray(result.orders))throw Error();
        const unfinished=result.orders.find(x=>['open','unknown','creating','credit_pending_review','reversal_review'].includes(x?.state));
        if(unfinished){if(!/^[a-zA-Z0-9_-]{12,80}$/.test(unfinished.requestId||''))throw Error();id=unfinished.requestId;ctx.storage.setItem(requestIdKey,id);}
      }
      if(!id){if(await refreshBalance()&&current(ctx)){setPurchaseReady(byId('packageList').children.length>0);message(choiceMessage());}return;}
      if(!/^[a-zA-Z0-9_-]{12,80}$/.test(id)){message('De eerdere betaling moet worden gecontroleerd.');return;}
      const order=await request(`/api/payments/orders/${encodeURIComponent(id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},ctx);
      if(order.state==='paid'){
        ctx.storage.removeItem(requestIdKey);
        if(await refreshBalance()){message('Betaling ontvangen. Je tegoed is bijgewerkt.');setPurchaseReady(true);}
      }else if(['failed','expired','canceled'].includes(order.state)){
        ctx.storage.removeItem(requestIdKey);message(canPurchase()?'De betaling is niet afgerond. Je kunt opnieuw kiezen.':'De betaling is niet afgerond. '+choiceMessage());setPurchaseReady(true);
      }else if(order.state==='open'&&canResume()&&isCheckout(order.checkoutUrl)){
        resumeUrl=order.checkoutUrl;resumeContext=ctx;byId('resumePayment').hidden=false;message('Deze betaling staat nog open. Je kunt verdergaan bij Mollie.');
      }else message('De betaling wordt nog gecontroleerd. Vernieuw de status later.');
    }catch{if(current(ctx))message('De betaalstatus is nog niet beschikbaar. Probeer later opnieuw.');}
  }
  async function openCredits(){
    const sequence=++dialogSequence,ctx=captureContext();
    resetCommerce();configureCreditsDialog();setPurchaseReady(false);mountHistory(ctx);byId('creditsDialog').showModal();
    if(!await refreshBalance()||sequence!==dialogSequence||!current(ctx))return;
    if(canPurchase())await showPackages(ctx);
    if(sequence===dialogSequence&&current(ctx)&&canRecover())await recover(ctx);
  }
  byId('resumePayment').addEventListener('click',()=>{const ctx=resumeContext,url=resumeUrl;if(!ctx||!canResume()||!current(ctx))return;clearResume();void navigateCheckout(url,ctx).catch(()=>{if(current(ctx))message('De betaalpagina kon niet worden geopend. Controleer de status.');});});
  byId('creditsButton').addEventListener('click',()=>{void openCredits();});
  byId('refreshPayment').addEventListener('click',()=>{void recover();});
  byId('closeCredits').addEventListener('click',()=>{dialogSequence++;clearHistory();resetCommerce();byId('creditsDialog').close();});
  window.addEventListener('pagehide',event=>{if(event.persisted!==true)window.rigPaymentsDispose();});
  document.addEventListener('rig-balance-changed',()=>{void refreshBalance();});
  document.addEventListener('rig-video-availability',()=>{configureCreditsDialog();void refreshBalance();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshBalance();});
  if(new URL(location.href).searchParams.get('payment')==='return')void openCredits();
  else void refreshBalance();
})();
