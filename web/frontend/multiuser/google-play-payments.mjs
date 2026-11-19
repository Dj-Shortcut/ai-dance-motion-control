const BILLING='https://play.google.com/billing';
const CONFIG='/api/payments/google-play/config',CONFIRM='/api/payments/google-play/confirm';
const PRODUCT=/^[a-z][a-z0-9._-]{0,99}$/;
const unavailable='Tegoed kopen via Google Play is hier nog niet beschikbaar. Je bestaande RIG-tegoed kun je gebruiken.';
const uncertain='Je aankoop wordt gecontroleerd. Koop niet opnieuw voordat de status is nagekeken.';
const tokenValid=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[\u0000-\u0020\u007f]/.test(value);
const money=cents=>new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(cents/100);

function checkedConfig(value){
 if(value?.enabled!==true)return null;
 if(!/^[a-f0-9]{64}$/.test(value.accountId??'')||!Array.isArray(value.products)||!value.products.length||value.products.length>10)throw Error(unavailable);
 const products=new Map();
 for(const product of value.products){
  if(!PRODUCT.test(product?.productId??'')||products.has(product.productId)||!Number.isSafeInteger(product.creditsCents)||product.creditsCents<=0||product.creditsCents>1000000)throw Error(unavailable);
  products.set(product.productId,{productId:product.productId,creditsCents:product.creditsCents});
 }
 return {accountId:value.accountId,products};
}

function checkedDetails(values,config){
 if(!Array.isArray(values)||values.length>20)throw Error(unavailable);
 const catalog=new Map();
 for(const item of values){
  if(!config.products.has(item?.itemId)||catalog.has(item.itemId)||item.type!==undefined&&item.type!=='product')continue;
  const amount=item.price?.value,currency=item.price?.currency;
  if(typeof amount!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/.test(amount)||!Number.isFinite(Number(amount))||Number(amount)<=0||!/^[A-Z]{3}$/.test(currency??''))continue;
  const price={value:amount,currency};
  let formatted;try{formatted=new Intl.NumberFormat('nl-BE',{style:'currency',currency}).format(Number(amount));}catch{continue;}
  catalog.set(item.itemId,{...config.products.get(item.itemId),price,formatted});
 }
 return catalog;
}

// The server owns identity, product entitlements and the ledger. Neither the
// store response nor a displayed balance can grant RIG credit in this module.
export function startGooglePlayPayments({browser,document=browser?.document}={}){
 if(!browser||!document||browser.rigPaymentChannel!=='google-play')throw Error('Ongeldige betaalomgeving.');
 const el=id=>document.getElementById(id),required=['creditsButton','creditsDialog','creditsTitle','creditExplanation','creditsMessage','packageList','refreshPayment','resumePayment','closeCredits'];
 if(required.some(id=>!el(id)))throw Error('RIG-pagina ontbreekt.');
 const context={request:browser.rigRequest,storage:browser.rigScopedStorage,active:browser.rigSessionActive};
 let disposed=false,balanceSequence=0,viewSequence=0,busy=false,reconciling=false,balanceKnown=false,frozen=true,store=null,catalog=new Map(),config=null;
 const pending=new Set(),listeners=[];
 const current=()=>!disposed&&context.request===browser.rigRequest&&context.storage===browser.rigScopedStorage&&context.active===browser.rigSessionActive&&typeof context.active==='function'&&context.active()===true;
 const check=()=>{if(!current())throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');};
 const message=text=>{if(current())el('creditsMessage').textContent=text;};
 const owner=()=>browser.rigVideoFunding==='owner-provider';
 const listen=(target,name,handler)=>{target.addEventListener(name,handler);listeners.push(()=>target.removeEventListener(name,handler));};
 const controls=()=>{
  const blocked=busy||reconciling||!current();
  for(const button of el('packageList').children)button.disabled=blocked||!balanceKnown||frozen;
  el('creditsButton').disabled=blocked;el('refreshPayment').disabled=blocked;
 };
 async function request(path,options={}){
  check();const response=await context.request(path,{credentials:'same-origin',cache:'no-store',...options});check();
  let body;try{body=await response.json();}catch{throw Error('Je tegoed kon niet worden gecontroleerd.');}check();
  if(!response.ok)throw Error(body?.code==='google_play_pending'?uncertain:'Je aankoop of tegoed kon niet worden gecontroleerd.');
  return body;
 }
 function clearCatalog(){catalog=new Map();config=null;store=null;el('packageList').replaceChildren();}
 async function refreshBalance(){
  const sequence=++balanceSequence;
  if(owner()){
   if(!current())return false;
   balanceKnown=false;frozen=true;el('creditsTitle').textContent='Eigen fal-account';el('creditsButton').textContent='Eigen fal-account';
   el('creditExplanation').textContent='Je video’s gebruiken het gekoppelde fal-account. Je ziet de Fal-raming vóór je bevestigt.';
   message('Je eigen fal-account blijft gekoppeld.');controls();return true;
  }
  try{
   const value=await request('/api/payments/balance');
   if(sequence!==balanceSequence||!current())return false;
   if(value?.currency!=='EUR'||value.mode!=='live'||!Number.isSafeInteger(value.balance))throw Error();
   balanceKnown=true;frozen=value.frozen===true;
   el('creditsButton').textContent=`RIG-tegoed ${money(value.balance)}`;
   message(frozen?'Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.':`Je hebt ${money(value.balance)} RIG-tegoed. Je ziet de prijs vóór je bevestigt.`);
   controls();return true;
  }catch{
   if(sequence===balanceSequence&&current()){balanceKnown=false;frozen=true;el('creditsButton').textContent='RIG-tegoed';message('Je tegoed kon niet worden gecontroleerd. Probeer later opnieuw.');controls();}
   return false;
  }
 }
 async function creditPurchase(productId,purchaseToken,selectedConfig,service){
  check();const product=selectedConfig.products.get(productId);
  if(!product||!tokenValid(purchaseToken))throw Error(uncertain);
  if(pending.has(purchaseToken))return false;
  pending.add(purchaseToken);
  try{
   const result=await request(CONFIRM,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId,purchaseToken})});
   check();
   if(result?.state!=='credited'||result.creditsCents!==product.creditsCents)throw Error(uncertain);
   // Consuming an uncredited or pending token could strand a paid customer.
   // The backend must make repeated confirmations idempotent across devices.
   let consumed=true;try{check();await service.consume(purchaseToken);check();}catch(error){check();consumed=false;}
   await refreshBalance();check();
   message(consumed?'Je RIG-tegoed is bijgeschreven.':'Je RIG-tegoed is bijgeschreven. De aankoopbevestiging wordt nog afgerond.');
   return true;
  }finally{pending.delete(purchaseToken);}
 }
 async function buy(productId){
  if(busy||reconciling||!balanceKnown||frozen||!catalog.has(productId)||!config||!store)return;
  check();busy=true;controls();
  const selectedConfig=config,service=store,item=catalog.get(productId);let response=null;
  try{
   // Called from the explicit package click. Google supplies the real price;
   // accountId is an opaque server-derived binding, never a user-entered ID.
   const purchase=new browser.PaymentRequest([{supportedMethods:BILLING,data:{sku:productId,obfuscatedAccountId:selectedConfig.accountId}}],{total:{label:'RIG-tegoed',amount:item.price}});
   response=await purchase.show();check();
   const credited=await creditPurchase(productId,response?.details?.purchaseToken,selectedConfig,service);
   check();await response.complete(credited?'success':'unknown');
  }catch(error){
   if(response&&typeof response.complete==='function')try{await response.complete('unknown');}catch{}
   if(current()){
    if(error?.name==='AbortError'&&!response)message('Aankoop geannuleerd.');
    else{clearCatalog();message(uncertain);}
   }
  }finally{busy=false;if(current())controls();}
 }
 async function recover(selectedConfig,service){
  const purchases=await service.listPurchases();check();
  if(!Array.isArray(purchases)||purchases.length>50)throw Error(uncertain);
  const seen=new Set();
  for(const purchase of purchases){
   check();if(!selectedConfig.products.has(purchase?.itemId)||!tokenValid(purchase.purchaseToken)||seen.has(purchase.purchaseToken))continue;
   seen.add(purchase.purchaseToken);await creditPurchase(purchase.itemId,purchase.purchaseToken,selectedConfig,service);
  }
 }
 async function openCredits(){
  if(!current()||busy||reconciling)return;
  reconciling=true;controls();
  const sequence=++viewSequence;let checkingPurchases=false;
  try{
   clearCatalog();el('creditsDialog').showModal();
   if(!await refreshBalance()||!current()||sequence!==viewSequence||owner()||frozen)return;
   const selectedConfig=checkedConfig(await request(CONFIG));
   if(sequence!==viewSequence||!current())return;
   if(!selectedConfig||typeof browser.getDigitalGoodsService!=='function'||typeof browser.PaymentRequest!=='function'){message(unavailable);return;}
   const service=await browser.getDigitalGoodsService(BILLING);check();
   if(sequence!==viewSequence)return;
   if(!service||['getDetails','listPurchases','consume'].some(name=>typeof service[name]!=='function'))throw Error(unavailable);
   const details=await service.getDetails([...selectedConfig.products.keys()]);check();if(sequence!==viewSequence)return;
   config=selectedConfig;store=service;catalog=checkedDetails(details,selectedConfig);
   for(const item of catalog.values()){
    const button=document.createElement('button');button.type='button';button.textContent=`${money(item.creditsCents)} tegoed · ${item.formatted}`;
    button.addEventListener('click',()=>{void buy(item.productId);});el('packageList').append(button);
   }
   controls();message('Eerdere aankopen controleren…');
   // Reconcile only actual unconsumed store purchases. There is no local
   // success flag, purchase-token storage or client-side credit increment.
   checkingPurchases=true;await recover(selectedConfig,service);
   if(current()&&sequence===viewSequence)message(catalog.size?'Kies je tegoed. Je betaalt via Google Play.':unavailable);
  }catch{if(current()){clearCatalog();if(sequence===viewSequence)message(checkingPurchases?uncertain:unavailable);}}
  finally{reconciling=false;if(current())controls();}
 }
 function dispose(){
  if(disposed)return;disposed=true;balanceSequence++;viewSequence++;clearCatalog();pending.clear();
  for(const remove of listeners)remove();el('creditsDialog').close();el('creditsMessage').textContent='Meld je opnieuw aan om je tegoed te bekijken.';
 }
 el('creditsTitle').textContent='RIG-tegoed';el('creditExplanation').textContent='Je ziet de prijs vóór elke video. Je bestaande RIG-tegoed blijft beschikbaar.';
 el('resumePayment').hidden=true;el('resumePayment').textContent='';el('refreshPayment').textContent='Vernieuw tegoed';
 listen(el('creditsButton'),'click',()=>{void openCredits();});
 listen(el('closeCredits'),'click',()=>{viewSequence++;el('creditsDialog').close();});
 listen(el('refreshPayment'),'click',()=>{void openCredits();});
 listen(document,'rig-balance-changed',()=>{void refreshBalance();});
 listen(browser,'pagehide',event=>{if(event.persisted!==true)dispose();});
 browser.rigPaymentsDispose=dispose;
 void refreshBalance();
 return Object.freeze({dispose,refreshBalance,openCredits});
}

if(typeof window!=='undefined'&&window.document&&window.rigPaymentChannel==='google-play')startGooglePlayPayments({browser:window});
