'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const money = amount => new Intl.NumberFormat('nl-BE', {style:'currency',currency:'EUR'}).format(amount / 100);
  const message = text => { byId('creditsMessage').textContent = text; };
  const requestIdKey = 'rig-payment-request';
  let purchaseReady=false;
  let balanceRequestSequence=0;
  const sponsored=()=>window.rigVideoFunding==='sponsored';
  const native=()=>window.rigNativeSite===true;
  const budgetLabel=()=>sponsored()?'Gratis RIG-tegoed':window.rigVideoFunding==='owner'?'RIG-testbudget':'RIG-testtegoed';
  function configureCreditsDialog(){
    const gift=sponsored(), explanation=byId('creditExplanation');
    if(byId('creditsTitle'))byId('creditsTitle').textContent=budgetLabel();
    if(explanation)explanation.textContent=gift?'Gratis RIG-tegoed voor je testvideo’s. Je betaalt niets; de maker betaalt de generatie.':window.rigVideoFunding==='owner'?'Dit is fictief RIG-testbudget. Je echte fal-tegoed staat apart op fal.ai.':'Dit is RIG-testtegoed voor deze proef; geen saldo van fal.ai.';
    byId('refreshPayment').hidden=gift||native();byId('resumePayment').hidden=true;
    if(gift||native()){purchaseReady=false;byId('packageList').replaceChildren();}
  }
  function setPurchaseReady(ready){purchaseReady=ready;for(const button of byId('packageList').children)button.disabled=!ready;}
  async function request(path, options={}) {
    const response = await window.rigRequest(path, {credentials:'same-origin',cache:'no-store',...options});
    let body; try { body = await response.json(); } catch { throw new Error('Tegoed is momenteel niet beschikbaar.'); }
    if (!response.ok) throw new Error(body?.error || 'Tegoed is momenteel niet beschikbaar.');
    return body;
  }
  function isCheckout(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.hostname === 'mollie.com' || url.hostname.endsWith('.mollie.com')); } catch { return false; }
  }
  async function refreshBalance() {
    const sequence=++balanceRequestSequence;
    try {
      const funding=window.rigVideoFunding,nativeMode=native(),gift=sponsored(), useGiftStatus=gift&&!nativeMode, value = await request(useGiftStatus?'/api/sponsor-invitations/status':'/api/payments/balance');
      const balance=useGiftStatus?value.remainingCents:value.balance;
      if (!Number.isSafeInteger(balance)||(gift&&((useGiftStatus&&value.state!=='eligible')||balance<0||balance>500))) throw new Error();
      if(sequence!==balanceRequestSequence)return;
      if(funding!==window.rigVideoFunding||nativeMode!==native())return;
      byId('creditsButton').textContent = `${budgetLabel()} ${money(balance)}`;
      if(gift)message(`Je hebt ${money(balance)} gratis RIG-tegoed over.`);
      else if(native())message(`Je hebt ${money(balance)} ${budgetLabel()}. Je ziet de prijs vóór je bevestigt.`);
      if (value.frozen) message('Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.');
    } catch { if(sequence===balanceRequestSequence){byId('creditsButton').textContent = budgetLabel();if(sponsored())message('Je gratis RIG-tegoed is momenteel niet beschikbaar.');} }
  }
  async function showPackages() {
    if(sponsored()||native())return;
    message('Tegoedpakketten ophalen…'); byId('packageList').replaceChildren();
    try {
      const data = await request('/api/payments/packages');
      if(sponsored())return;
      if (!Array.isArray(data.packages) || !data.packages.length) throw new Error('Tegoed is momenteel niet beschikbaar.');
      for (const item of data.packages) {
        if (!/^[a-z0-9_-]{1,40}$/.test(item.id || '') || !Number.isSafeInteger(item.amountCents) || item.amountCents < 1 || !Number.isSafeInteger(item.credits) || item.credits < 1) continue;
        const button = document.createElement('button'); button.type='button'; button.className='package-button';
        button.textContent = `${money(item.credits)} tegoed · ${money(item.amountCents)}`; button.disabled=true;
        button.addEventListener('click',()=>createPayment(item.id,button)); byId('packageList').appendChild(button);
      }
      message(byId('packageList').children.length ? 'Kies een testpakket. Mollie staat in testmodus; er wordt geen echt geld afgeschreven.' : 'Tegoed is momenteel niet beschikbaar.');
    } catch (error) { if(!sponsored())message(error.message || 'Tegoed is momenteel niet beschikbaar.'); }
  }
  async function createPayment(packageId, button) {
    if(!purchaseReady||sponsored()||native())return;setPurchaseReady(false);
    let stored = window.rigScopedStorage.getItem(requestIdKey);
    if (stored) { message('Er is al een betaling gestart. Controleer eerst de status.'); return; }
    const id = crypto.randomUUID(); window.rigScopedStorage.setItem(requestIdKey,id);
    button.disabled = true; message('Betaling wordt klaargezet…');
    try {
      const data=await request('/api/payments/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId,requestId:id})});
      if (!isCheckout(data.checkoutUrl)) throw new Error('De betaalpagina kon niet worden gecontroleerd.');
      if(typeof window.rigCheckout!=='function')throw new Error('De betaalpagina kon niet worden geopend.');
      window.rigCheckout(data.checkoutUrl);
    } catch (error) {
      message(`${error.message || 'Betaling kon niet worden gestart.'} Controleer de status voordat je opnieuw probeert.`);
    } finally { setPurchaseReady(false); }
  }
  let resumeUrl=null;
  byId('resumePayment').addEventListener('click',()=>{if(!native()&&!sponsored()&&isCheckout(resumeUrl)&&typeof window.rigCheckout==='function')window.rigCheckout(resumeUrl)});
  async function recover() {
    if(sponsored()||native())return;
    setPurchaseReady(false);let id = window.rigScopedStorage.getItem(requestIdKey);
    if (!id) { try { const result=await request('/api/payments/orders');if(sponsored())return;if(!Array.isArray(result.orders))throw new Error();const unfinished=result.orders.find(x=>['open','unknown','creating','credit_pending_review'].includes(x.state)); if(unfinished && /^[a-zA-Z0-9_-]{12,80}$/.test(unfinished.requestId||'')){id=unfinished.requestId;window.rigScopedStorage.setItem(requestIdKey,id);}else if(unfinished)throw new Error(); } catch { if(!sponsored())message('Eerdere betalingen konden niet worden gecontroleerd. Probeer later opnieuw.');return; } }
    if (!id){await refreshBalance();setPurchaseReady(true);return;} if(!/^[a-zA-Z0-9_-]{12,80}$/.test(id)){message('De eerdere betaling moet worden gecontroleerd.');return;}
    try {
      const order=await request(`/api/payments/orders/${encodeURIComponent(id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if(sponsored())return;
      if (order.state==='paid') { byId('resumePayment').hidden=true;resumeUrl=null;window.rigScopedStorage.removeItem(requestIdKey); await refreshBalance(); message('Betaling ontvangen. Controleer je tegoed.');setPurchaseReady(true); }
      else if (['failed','expired','canceled'].includes(order.state)) { byId('resumePayment').hidden=true;resumeUrl=null;window.rigScopedStorage.removeItem(requestIdKey); message('De betaling is niet afgerond. Je kunt opnieuw kiezen.');setPurchaseReady(true); }
      else if(order.state==='open' && isCheckout(order.checkoutUrl)){resumeUrl=order.checkoutUrl;byId('resumePayment').hidden=false;message('Deze betaling staat nog open. Je kunt verdergaan bij Mollie.');}
      else { byId('resumePayment').hidden=true;message('De betaling wordt nog gecontroleerd. Vernieuw de status later.'); }
    } catch { if(!sponsored())message('De betaalstatus is nog niet beschikbaar. Probeer later opnieuw.'); }
  }
  byId('creditsButton').addEventListener('click',()=>{configureCreditsDialog();byId('creditsDialog').showModal();if(sponsored()||native())void refreshBalance();else showPackages().then(recover)});
  byId('refreshPayment').addEventListener('click',recover);
  byId('closeCredits').addEventListener('click',()=>byId('creditsDialog').close());
  document.addEventListener('rig-balance-changed',refreshBalance);
  document.addEventListener('rig-video-availability',()=>{configureCreditsDialog();void refreshBalance();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshBalance();});
  if (!native()&&!sponsored()&&new URL(location.href).searchParams.get('payment') === 'return') { byId('creditsDialog').showModal();showPackages().then(recover); }
  refreshBalance();
})();
