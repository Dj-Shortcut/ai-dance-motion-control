'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const money = amount => new Intl.NumberFormat('nl-BE', {style:'currency',currency:'EUR'}).format(amount / 100);
  const message = text => { byId('creditsMessage').textContent = text; };
  const requestIdKey = 'rig-payment-request';
  let purchaseReady=false;
  let balanceRequestSequence=0;
  function setPurchaseReady(ready){purchaseReady=ready;for(const button of byId('packageList').children)button.disabled=!ready;}
  async function request(path, options={}) {
    const response = await fetch(path, {credentials:'same-origin',cache:'no-store',...options});
    let body; try { body = await response.json(); } catch { throw new Error('Tegoed is momenteel niet beschikbaar.'); }
    if (!response.ok) throw new Error(body?.error || 'Tegoed is momenteel niet beschikbaar.');
    return body;
  }
  function isCheckout(value) {
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
  async function refreshBalance() {
    const sequence=++balanceRequestSequence;
    try {
      const value = await request('/api/payments/balance');
      if (!Number.isSafeInteger(value.balance)) throw new Error();
      if(sequence!==balanceRequestSequence)return;
      byId('creditsButton').textContent = `Testtegoed ${money(value.balance)}`;
      if (value.frozen) message('Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.');
    } catch { if(sequence===balanceRequestSequence)byId('creditsButton').textContent = 'Testtegoed'; }
  }
  async function showPackages() {
    message('Tegoedpakketten ophalen…'); byId('packageList').replaceChildren();
    try {
      const data = await request('/api/payments/packages');
      if (!Array.isArray(data.packages) || !data.packages.length) throw new Error('Tegoed is momenteel niet beschikbaar.');
      for (const item of data.packages) {
        if (!/^[a-z0-9_-]{1,40}$/.test(item.id || '') || !Number.isSafeInteger(item.amountCents) || item.amountCents < 1 || !Number.isSafeInteger(item.credits) || item.credits < 1) continue;
        const button = document.createElement('button'); button.type='button'; button.className='package-button';
        button.textContent = `${money(item.credits)} tegoed · ${money(item.amountCents)}`; button.disabled=true;
        button.addEventListener('click',()=>createPayment(item.id,button)); byId('packageList').appendChild(button);
      }
      message(byId('packageList').children.length ? 'Kies een testpakket. De betaling verloopt via Mollie in testmodus.' : 'Tegoed is momenteel niet beschikbaar.');
    } catch (error) { message(error.message || 'Tegoed is momenteel niet beschikbaar.'); }
  }
  async function createPayment(packageId, button) {
    if(!purchaseReady)return;setPurchaseReady(false);
    let stored = sessionStorage.getItem(requestIdKey);
    if (stored) { message('Er is al een betaling gestart. Controleer eerst de status.'); return; }
    const id = crypto.randomUUID(); sessionStorage.setItem(requestIdKey,id);
    button.disabled = true; message('Betaling wordt klaargezet…');
    try {
      const data=await request('/api/payments/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId,requestId:id})});
      if (!isCheckout(data.checkoutUrl)) throw new Error('De betaalpagina kon niet worden gecontroleerd.');
      location.assign(data.checkoutUrl);
    } catch (error) {
      message(`${error.message || 'Betaling kon niet worden gestart.'} Controleer de status voordat je opnieuw probeert.`);
    } finally { setPurchaseReady(false); }
  }
  let resumeUrl=null;
  byId('resumePayment').addEventListener('click',()=>{if(isCheckout(resumeUrl))location.assign(resumeUrl)});
  async function recover() {
    setPurchaseReady(false);let id = sessionStorage.getItem(requestIdKey);
    if (!id) { try { const result=await request('/api/payments/orders');if(!Array.isArray(result.orders))throw new Error();const unfinished=result.orders.find(x=>['open','unknown','creating','credit_pending_review'].includes(x.state)); if(unfinished && /^[a-zA-Z0-9_-]{12,80}$/.test(unfinished.requestId||'')){id=unfinished.requestId;sessionStorage.setItem(requestIdKey,id);}else if(unfinished)throw new Error(); } catch { message('Eerdere betalingen konden niet worden gecontroleerd. Probeer later opnieuw.');return; } }
    if (!id){await refreshBalance();setPurchaseReady(true);return;} if(!/^[a-zA-Z0-9_-]{12,80}$/.test(id)){message('De eerdere betaling moet worden gecontroleerd.');return;}
    try {
      const order=await request(`/api/payments/orders/${encodeURIComponent(id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      if (order.state==='paid') { byId('resumePayment').hidden=true;resumeUrl=null;sessionStorage.removeItem(requestIdKey); await refreshBalance(); message('Betaling ontvangen. Controleer je tegoed.');setPurchaseReady(true); }
      else if (['failed','expired','canceled'].includes(order.state)) { byId('resumePayment').hidden=true;resumeUrl=null;sessionStorage.removeItem(requestIdKey); message('De betaling is niet afgerond. Je kunt opnieuw kiezen.');setPurchaseReady(true); }
      else if(order.state==='open' && isCheckout(order.checkoutUrl)){resumeUrl=order.checkoutUrl;byId('resumePayment').hidden=false;message('Deze betaling staat nog open. Je kunt verdergaan bij Mollie.');}
      else { byId('resumePayment').hidden=true;message('De betaling wordt nog gecontroleerd. Vernieuw de status later.'); }
    } catch { message('De betaalstatus is nog niet beschikbaar. Probeer later opnieuw.'); }
  }
  byId('creditsButton').addEventListener('click',()=>{byId('creditsDialog').showModal();showPackages().then(recover)});
  byId('refreshPayment').addEventListener('click',recover);
  document.addEventListener('rig-balance-changed',refreshBalance);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refreshBalance();});
  if (new URL(location.href).searchParams.get('payment') === 'return') { byId('creditsDialog').showModal();showPackages().then(recover); }
  refreshBalance();
})();
