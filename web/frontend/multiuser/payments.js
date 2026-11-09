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
  const canPurchase=()=>!ownerProvider()&&payment.enabled&&!payment.frozen;
  const budgetLabel=()=>ownerProvider()?'Eigen fal-account':payment.mode==='live'?'RIG-tegoed':sponsored()?'Gratis RIG-tegoed':window.rigVideoFunding==='owner'?'RIG-testbudget':'RIG-testtegoed';
  function configureCreditsDialog(){
    const gift=sponsored()&&payment.mode!=='live',explanation=byId('creditExplanation');
    byId('creditsTitle').textContent=budgetLabel();
    if(explanation)explanation.textContent=ownerProvider()?'Je video’s gebruiken het gekoppelde fal-account. Je hoeft hiervoor geen RIG-tegoed te kopen. Je ziet de Fal-raming vóór je bevestigt.':payment.mode==='live'?'Koop RIG-tegoed in euro. Je ziet de prijs vóór elke video. Dit staat los van een eigen fal.ai-saldo.':gift?'Gratis RIG-tegoed voor je testvideo’s. Je betaalt niets; de maker betaalt de generatie.':window.rigVideoFunding==='owner'?'Dit is fictief RIG-testbudget. Je echte fal-tegoed staat apart op fal.ai.':'Dit is RIG-testtegoed voor deze proef; geen saldo van fal.ai.';
    byId('refreshPayment').hidden=!canPurchase();
    if(!canPurchase()){setPurchaseReady(false);byId('packageList').replaceChildren();clearResume();}
  }
  function clearResume(){resumeUrl=null;resumeContext=null;byId('resumePayment').hidden=true;}
  function setPurchaseReady(ready){purchaseReady=ready&&canPurchase();for(const button of byId('packageList').children)button.disabled=!purchaseReady;}
  async function request(path,options={},ctx=captureContext()){
    checkContext(ctx);
    const response=await ctx.request(path,{credentials:'same-origin',cache:'no-store',...options});
    checkContext(ctx);
    let body;try{body=await response.json();}catch{throw Error('Tegoed is momenteel niet beschikbaar.');}
    checkContext(ctx);
    if(!response.ok)throw Error(body?.error||'Tegoed is momenteel niet beschikbaar.');
    return body;
  }
  function isCheckout(value){
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&(url.hostname==='mollie.com'||url.hostname.endsWith('.mollie.com'));}catch{return false;}
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
      if(payment.frozen)message('Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.');
      return true;
    }catch{
      if(sequence===balanceRequestSequence&&current(ctx)){payment={mode:null,enabled:false,frozen:false};configureCreditsDialog();byId('creditsButton').textContent=budgetLabel();message(sponsored()?'Je gratis RIG-tegoed is momenteel niet beschikbaar.':'Je tegoed kon niet worden gecontroleerd. Probeer later opnieuw.');}
      return false;
    }
  }
  async function showPackages(ctx=captureContext()){
    if(!canPurchase())return false;
    setPurchaseReady(false);message('Tegoedpakketten ophalen…');byId('packageList').replaceChildren();
    try{
      const data=await request('/api/payments/packages',{},ctx),details=paymentDetails(data);
      if(!details.enabled||details.mode!==payment.mode||details.frozen)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      if(!Array.isArray(data.packages)||!data.packages.length)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      for(const item of data.packages){
        if(!/^[a-z0-9_-]{1,40}$/.test(item?.id||'')||!Number.isSafeInteger(item.amountCents)||item.amountCents<1||item.amountCents>1000000||!Number.isSafeInteger(item.credits)||item.credits<1||item.credits>100000000)continue;
        const button=document.createElement('button');button.type='button';button.className='package-button';
        button.textContent=`${money(item.credits)} tegoed · ${money(item.amountCents)}`;button.disabled=true;
        button.addEventListener('click',()=>{void createPayment(item.id,ctx);});byId('packageList').appendChild(button);
      }
      if(!byId('packageList').children.length)throw Error('Tegoed kopen is momenteel niet beschikbaar.');
      message(details.mode==='live'?'Kies je tegoed. Je betaalt veilig via Mollie.':'Kies een testpakket. Mollie staat in testmodus; er wordt geen echt geld afgeschreven.');
      return true;
    }catch(error){if(current(ctx)){byId('packageList').replaceChildren();message(error.message||'Tegoed is momenteel niet beschikbaar.');}return false;}
  }
  async function navigateCheckout(url,ctx){
    checkContext(ctx);
    if(!isCheckout(url)||typeof window.rigCheckout!=='function')throw Error('De betaalpagina kon niet worden gecontroleerd.');
    await window.rigCheckout(url);
  }
  async function createPayment(packageId,ctx){
    if(!purchaseReady||!canPurchase()||!current(ctx))return;
    setPurchaseReady(false);clearResume();
    try{
      if(ctx.storage.getItem(requestIdKey)){message('Er is al een betaling gestart. Controleer eerst de status.');return;}
      const id=crypto.randomUUID();ctx.storage.setItem(requestIdKey,id);message('Betaling wordt klaargezet…');
      const data=await request('/api/payments/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId,requestId:id})},ctx);
      await navigateCheckout(data.checkoutUrl,ctx);
    }catch(error){if(current(ctx))message(`${error.message||'Betaling kon niet worden gestart.'} Controleer de status voordat je opnieuw probeert.`);}
    finally{if(current(ctx))setPurchaseReady(false);}
  }
  async function recover(ctx=captureContext()){
    if(!canPurchase()||!current(ctx))return;
    setPurchaseReady(false);clearResume();
    try{
      let id=ctx.storage.getItem(requestIdKey);
      if(!id){
        const result=await request('/api/payments/orders',{},ctx);
        if(!Array.isArray(result.orders))throw Error();
        const unfinished=result.orders.find(x=>['open','unknown','creating','credit_pending_review','reversal_review'].includes(x?.state));
        if(unfinished){if(!/^[a-zA-Z0-9_-]{12,80}$/.test(unfinished.requestId||''))throw Error();id=unfinished.requestId;ctx.storage.setItem(requestIdKey,id);}
      }
      if(!id){if(await refreshBalance()&&current(ctx)){setPurchaseReady(true);message(payment.mode==='live'?'Kies je tegoed. Je betaalt veilig via Mollie.':'Kies een testpakket. Mollie staat in testmodus; er wordt geen echt geld afgeschreven.');}return;}
      if(!/^[a-zA-Z0-9_-]{12,80}$/.test(id)){message('De eerdere betaling moet worden gecontroleerd.');return;}
      const order=await request(`/api/payments/orders/${encodeURIComponent(id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},ctx);
      if(order.state==='paid'){
        ctx.storage.removeItem(requestIdKey);
        if(await refreshBalance()){message('Betaling ontvangen. Je tegoed is bijgewerkt.');setPurchaseReady(true);}
      }else if(['failed','expired','canceled'].includes(order.state)){
        ctx.storage.removeItem(requestIdKey);message('De betaling is niet afgerond. Je kunt opnieuw kiezen.');setPurchaseReady(true);
      }else if(order.state==='open'&&isCheckout(order.checkoutUrl)){
        resumeUrl=order.checkoutUrl;resumeContext=ctx;byId('resumePayment').hidden=false;message('Deze betaling staat nog open. Je kunt verdergaan bij Mollie.');
      }else message('De betaling wordt nog gecontroleerd. Vernieuw de status later.');
    }catch{if(current(ctx))message('De betaalstatus is nog niet beschikbaar. Probeer later opnieuw.');}
  }
  async function openCredits(){
    const sequence=++dialogSequence,ctx=captureContext();
    configureCreditsDialog();setPurchaseReady(false);byId('creditsDialog').showModal();
    if(!await refreshBalance()||sequence!==dialogSequence||!current(ctx)||!canPurchase())return;
    if(await showPackages(ctx)&&sequence===dialogSequence&&current(ctx))await recover(ctx);
  }
  byId('resumePayment').addEventListener('click',()=>{const ctx=resumeContext,url=resumeUrl;if(!ctx||!canPurchase()||!current(ctx))return;clearResume();void navigateCheckout(url,ctx).catch(()=>{if(current(ctx))message('De betaalpagina kon niet worden geopend. Controleer de status.');});});
  byId('creditsButton').addEventListener('click',()=>{void openCredits();});
  byId('refreshPayment').addEventListener('click',()=>{void recover();});
  byId('closeCredits').addEventListener('click',()=>{dialogSequence++;byId('creditsDialog').close();});
  document.addEventListener('rig-balance-changed',()=>{void refreshBalance();});
  document.addEventListener('rig-video-availability',()=>{configureCreditsDialog();void refreshBalance();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshBalance();});
  if(new URL(location.href).searchParams.get('payment')==='return')void openCredits();
  else void refreshBalance();
})();
