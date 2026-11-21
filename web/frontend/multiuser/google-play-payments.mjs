const BILLING='https://play.google.com/billing';
const PREFIX='/api/payments/google-play',CONFIG=PREFIX+'/config',INTENTS=PREFIX+'/intents',CONFIRM=PREFIX+'/confirm',STATUS=PREFIX+'/status';
const STORAGE_KEY='rig-google-play-intent:v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PRODUCT=/^[a-z][a-z0-9._-]{0,99}$/;
const STATES=new Set(['prepared','pending','credited','refund_pending','refunded','review','cancelled','expired']);
const unavailable='Tegoed kopen via Google Play is hier nog niet beschikbaar. Je bestaande RIG-tegoed kun je gebruiken.';
const uncertain='Je aankoop wordt gecontroleerd. Koop niet opnieuw voordat de status is nagekeken.';
const tokenValid=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[\u0000-\u0020\u007f]/.test(value);
const amountValid=value=>Number.isSafeInteger(value)&&value>0&&value<=1000000;
const money=cents=>new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(cents/100);

function checkedConfig(value){
 if(value?.enabled!==true&&value?.recoveryReady!==true)return null;
 if(typeof value.enabled!=='boolean'||!['live','test'].includes(value.mode)||value.currency!=='EUR'||!/^[a-f0-9]{64}$/.test(value.accountId??'')||!Array.isArray(value.products)||!value.products.length||value.products.length>10)throw Error(unavailable);
 const products=new Map();
 for(const product of value.products){
  if(!PRODUCT.test(product?.productId??'')||products.has(product.productId)||!amountValid(product.creditsCents)||!amountValid(product.priceCents))throw Error(unavailable);
  products.set(product.productId,{productId:product.productId,creditsCents:product.creditsCents,priceCents:product.priceCents});
 }
 return {enabled:value.enabled,recoveryReady:value.recoveryReady===true||value.enabled,accountId:value.accountId,products,mode:value.mode};
}

function checkedDetails(values,config){
 if(!Array.isArray(values)||values.length>20)throw Error(unavailable);
 const catalog=new Map();
 for(const item of values){
  if(!config.products.has(item?.itemId)||catalog.has(item.itemId)||item.type!==undefined&&item.type!=='product')continue;
  const value=item.price?.value;
  // RIG's first Play catalogue is EUR only; reject unsupported pricing before
  // a payment sheet rather than discovering it after charging the customer.
  if(item.price?.currency!=='EUR'||typeof value!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/.test(value)||!Number.isFinite(Number(value))||Number(value)<=0)continue;
  const [whole,fraction='']=value.split('.'),cents=Number(whole)*100+Number((fraction+'00').slice(0,2));
  if(/[^0]/.test(fraction.slice(2))||cents!==config.products.get(item.itemId).priceCents)continue;
  const price={value,currency:'EUR'},formatted=new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(Number(value));
  catalog.set(item.itemId,{...config.products.get(item.itemId),price,formatted});
 }
 return catalog;
}

function checkedIntent(value,config){
 if(!value||!UUID.test(value.intentId??'')||!PRODUCT.test(value.productId??'')||!/^[a-f0-9]{64}$/.test(value.accountId??'')||config&&value.accountId!==config.accountId||!STATES.has(value.state)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0||!amountValid(value.creditsCents)||typeof value.consumed!=='boolean'||typeof value.recoveryPending!=='boolean'||typeof value.newPurchasesBlocked!=='boolean'||value.refundPending!==undefined&&typeof value.refundPending!=='boolean')throw Error(uncertain);
 return {intentId:value.intentId,productId:value.productId,accountId:value.accountId,expiresAt:value.expiresAt,state:value.state,creditsCents:value.creditsCents,consumed:value.consumed,recoveryPending:value.recoveryPending,newPurchasesBlocked:value.newPurchasesBlocked,refundPending:value.refundPending===true};
}

// Google supplies prices; the authenticated server alone reserves capacity,
// grants credit, consumes receipts and refunds. No balance is granted locally.
export function startGooglePlayPayments({browser,document=browser?.document}={}){
 if(!browser||!document||browser.rigPaymentChannel!=='google-play')throw Error('Ongeldige betaalomgeving.');
 const el=id=>document.getElementById(id),required=['creditsButton','creditsDialog','creditsTitle','creditExplanation','creditsMessage','packageList','refreshPayment','resumePayment','closeCredits'];
 if(required.some(id=>!el(id)))throw Error('RIG-pagina ontbreekt.');
 const context={request:browser.rigRequest,storage:browser.rigScopedStorage,active:browser.rigSessionActive};
 let disposed=false,balanceSequence=0,viewSequence=0,busy=false,reconciling=false,balanceKnown=false,balanceMode=null,frozen=true,service=null,catalog=new Map(),config=null,intent=null,unresolved=false,lastOutcome=null,expiryTimer=null,wasHidden=false;
 const listeners=[],buttons=new Map();
 const current=()=>!disposed&&context.request===browser.rigRequest&&context.storage===browser.rigScopedStorage&&context.active===browser.rigSessionActive&&typeof context.active==='function'&&context.active()===true;
 const check=()=>{if(!current())throw Error('Je aanmelding is gewijzigd. Meld je opnieuw aan.');};
 const message=text=>{if(current())el('creditsMessage').textContent=text;};
 const owner=()=>browser.rigVideoFunding==='owner-provider';
 const listen=(target,name,handler)=>{target.addEventListener(name,handler);listeners.push(()=>target.removeEventListener(name,handler));};
 const expired=value=>value?.state==='prepared'&&value.expiresAt<=Date.now();
 // A prepared intent blocks *new* admissions but still authorizes its one
 // matching payment. Pending receipts/refunds block even that retry.
 const blocked=value=>value&&(value.recoveryPending||value.refundPending||value.state!=='prepared'&&value.newPurchasesBlocked||['pending','refund_pending','review'].includes(value.state)||value.state==='credited'&&!value.consumed);
 const terminal=value=>value&&['credited','refunded','cancelled','expired'].includes(value.state)&&!blocked(value);
 const canPay=productId=>config?.enabled===true&&service&&typeof browser.PaymentRequest==='function'&&intent?.state==='prepared'&&intent.productId===productId&&intent.accountId===config.accountId&&!blocked(intent)&&!expired(intent)&&catalog.has(productId);
 function controls(){
  const locked=busy||reconciling||!current();
  for(const [productId,button]of buttons){
   const item=catalog.get(productId),selected=intent?.state==='prepared'&&intent.productId===productId;
   button.textContent=selected?`Betaal ${item.formatted} via Google Play`:`${money(item.creditsCents)} tegoed · ${item.formatted}`;
   button.disabled=locked||!balanceKnown||frozen||unresolved||!config?.enabled||Boolean(intent)&&!canPay(productId);
  }
  el('creditsButton').disabled=locked;el('refreshPayment').disabled=locked;
 }
 async function request(path,options={}){
  check();const response=await context.request(path,{credentials:'same-origin',cache:'no-store',...options});check();
  let body;try{body=await response.json();}catch{throw Error(uncertain);}check();
  if(!response.ok){const error=Error(body?.code==='google_play_pending'?uncertain:'Je aankoop of tegoed kon niet worden gecontroleerd.');error.code=body?.code;error.status=response.status;throw error;}
  return body;
 }
 function readSlot(){
  check();const raw=context.storage.getItem(STORAGE_KEY);if(raw===null)return null;
  try{
   const value=JSON.parse(raw);
   if(typeof raw!=='string'||raw.length>200||!value||Object.keys(value).sort().join(',')!=='intentId,requestId'||!UUID.test(value.intentId)||value.intentId!==value.requestId)throw Error();
   return value;
  }catch{context.storage.removeItem(STORAGE_KEY);return null;}
 }
 function remember(id){
  check();if(!UUID.test(id))throw Error(uncertain);
  const raw=JSON.stringify({intentId:id,requestId:id});context.storage.setItem(STORAGE_KEY,raw);
  if(context.storage.getItem(STORAGE_KEY)!==raw)throw Error('Je aankoop kon niet veilig worden voorbereid. Probeer later opnieuw.');
 }
 function forget(){check();context.storage.removeItem(STORAGE_KEY);}
 function clearButtons(){buttons.clear();el('packageList').replaceChildren();}
 function clearCatalog(){clearButtons();catalog=new Map();config=null;service=null;}
 function setIntent(value){
  intent=value;
  if(expiryTimer!==null){browser.clearTimeout(expiryTimer);expiryTimer=null;}
  if(value){
   remember(value.intentId);
   if(value.state==='prepared'&&!expired(value))expiryTimer=browser.setTimeout(()=>{expiryTimer=null;if(current()){controls();if(el('creditsDialog').open)message('Je aankoopaanvraag is verlopen. Controleer de status om verder te gaan.');}},Math.min(value.expiresAt-Date.now()+20,2147483647));
  }
 }
 function stateMessage(){
  if(intent?.state==='credited')return blocked(intent)||unresolved?intent.refundPending||lastOutcome==='refund_pending'?'Je tegoed is bijgeschreven. Een extra betaling wordt terugbetaald.':'Je tegoed is bijgeschreven. Een eerdere aankoop wordt nog afgehandeld.':'Je RIG-tegoed is bijgeschreven.';
  if(intent?.state==='refund_pending')return 'Je terugbetaling wordt verwerkt. Koop niet opnieuw voordat dit is afgerond.';
  if(intent?.state==='refunded')return 'Je betaling is terugbetaald. Je tegoed is bijgewerkt.';
  if(intent?.state==='review'||unresolved)return uncertain;
  if(intent?.state==='pending')return 'Je betaling wordt nog gecontroleerd. Koop niet opnieuw; je tegoed verschijnt na bevestiging.';
  if(intent?.state==='prepared')return expired(intent)?'Je aankoopaanvraag is verlopen. Controleer de status om verder te gaan.':blocked(intent)?uncertain:!config?.enabled?'Nieuwe aankopen zijn tijdelijk gepauzeerd. Je bestaande tegoed blijft beschikbaar.':'Je aankoop staat klaar. Bevestig het bedrag via Google Play.';
  return config?.enabled&&catalog.size?'Kies je tegoed. Je betaalt via Google Play.':unavailable;
 }
 function renderOffers(){
  clearButtons();if(unresolved||blocked(intent)||!config?.enabled||!service||typeof browser.PaymentRequest!=='function')return;
  for(const item of catalog.values()){
   const button=document.createElement('button');button.type='button';button.className='package-button';
   button.addEventListener('click',()=>{if(canPay(item.productId))void pay(item.productId);else if(!intent)void prepare(item.productId);});
   buttons.set(item.productId,button);el('packageList').append(button);
  }
  controls();
 }
 async function refreshBalance(){
  const sequence=++balanceSequence;
  if(owner()){
   if(!current())return false;balanceKnown=false;frozen=true;
   el('creditsTitle').textContent='Eigen fal-account';el('creditsButton').textContent='Eigen fal-account';
   el('creditExplanation').textContent='Je video’s gebruiken het gekoppelde fal-account. Je ziet de Fal-raming vóór je bevestigt.';message('Je eigen fal-account blijft gekoppeld.');controls();return true;
  }
  try{
   const value=await request('/api/payments/balance');if(sequence!==balanceSequence||!current())return false;
   if(value?.currency!=='EUR'||!['live','test'].includes(value.mode)||!Number.isSafeInteger(value.balance))throw Error();
   balanceKnown=true;balanceMode=value.mode;frozen=value.frozen===true;
   el('creditsButton').textContent=`${balanceMode==='test'?'RIG-testtegoed':'RIG-tegoed'} ${money(value.balance)}`;
   if(!busy&&!reconciling)message(frozen?'Je tegoed wordt gecontroleerd. Neem contact op met de ondersteuning.':`Je hebt ${money(value.balance)} RIG-tegoed. Je ziet de prijs vóór je bevestigt.`);
   controls();return true;
  }catch{if(sequence===balanceSequence&&current()){balanceKnown=false;balanceMode=null;frozen=true;el('creditsButton').textContent='RIG-tegoed';message('Je tegoed kon niet worden gecontroleerd. Probeer later opnieuw.');controls();}return false;}
 }
 async function getStatus(id){
  const value=await request(STATUS+(id?'?intentId='+id:''));
  if(!value||!Object.hasOwn(value,'intent'))throw Error(uncertain);
  const found=value.intent===null?null:checkedIntent(value.intent,config);
  if(found&&id&&found.intentId!==id)throw Error(uncertain);return found;
 }
 async function loadStatus(){
  const slot=readSlot();let found=await getStatus(slot?.intentId);
  if(!found&&slot)found=await getStatus();
  if(found)setIntent(found);else{setIntent(null);forget();}return found;
 }
 function checkedOutcome(value,owned){
  if(!value||!STATES.has(value.state)||['prepared','cancelled','expired'].includes(value.state)||value.intentId!==undefined&&value.intentId!==owned.intentId||value.productId!==undefined&&value.productId!==owned.productId)throw Error(uncertain);
  if(value.state==='credited'&&(!amountValid(value.creditsCents)||value.creditsCents!==owned.creditsCents||typeof value.consumed!=='boolean'))throw Error(uncertain);return value;
 }
 async function confirmPurchase(purchase,owned){
  check();if(purchase.itemId!==owned.productId||!tokenValid(purchase.purchaseToken))throw Error(uncertain);
  const result=checkedOutcome(await request(CONFIRM,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intentId:owned.intentId,productId:owned.productId,purchaseToken:purchase.purchaseToken})}),owned);
  check();lastOutcome=result.state;
  // Server acknowledgement is authoritative, including when consumption still
  // needs a retry. The amount displayed still comes only from the ledger read.
  await refreshBalance();check();return result;
 }
 async function recoverPurchases(){
  if(!service)return;
  const purchases=await service.listPurchases();check();
  if(!Array.isArray(purchases)||purchases.length>50)throw Error(uncertain);
  const seen=new Set();let unmatched=false;
  for(const purchase of purchases){
   check();if(!PRODUCT.test(purchase?.itemId??'')||!tokenValid(purchase.purchaseToken))throw Error(uncertain);
   if(seen.has(purchase.purchaseToken))continue;seen.add(purchase.purchaseToken);
   if(!intent||purchase.itemId!==intent.productId){unmatched=true;continue;}
   await confirmPurchase(purchase,intent);
  }
  if(intent){const latest=await getStatus(intent.intentId);if(!latest)throw Error(uncertain);setIntent(latest);}
  unresolved=unmatched;
 }
 function settleIntent(){
  if(!unresolved&&terminal(intent)){const completed=intent;setIntent(null);forget();return completed;}return null;
 }
 async function prepare(productId){
  if(busy||reconciling||unresolved||intent||!balanceKnown||frozen||!config?.enabled||!service||!catalog.has(productId))return;
  check();busy=true;controls();
  try{
   const id=browser.crypto.randomUUID();remember(id);message('Je aankoop voorbereiden…');
   const value=checkedIntent(await request(INTENTS,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId,requestId:id})}),config);
   check();if(value.intentId!==id||value.productId!==productId||value.creditsCents!==catalog.get(productId).creditsCents||value.state!=='prepared'||blocked(value)||expired(value))throw Error(uncertain);
   setIntent(value);unresolved=false;message(stateMessage());
  }catch{
   if(current()){
    unresolved=true;clearButtons();
    try{await loadStatus();await refreshBalance();unresolved=false;const completed=settleIntent();renderOffers();message(intent?stateMessage():completed?.state==='credited'?'Je RIG-tegoed is bijgeschreven.':'De aankoop is niet gestart. Kies opnieuw je tegoed.');}catch{message(uncertain);}
   }
  }finally{busy=false;if(current())controls();}
 }
 async function pay(productId){
  if(busy||reconciling||unresolved||!balanceKnown||frozen||!canPay(productId))return;
  check();busy=true;controls();const owned=intent,item=catalog.get(productId);let response=null,confirmed=null;
  try{
   // Second explicit package click: preserve user activation by invoking show
   // synchronously, with no network request/await between the click and show.
   remember(owned.intentId);
   const payment=new browser.PaymentRequest([{supportedMethods:BILLING,data:{sku:productId,obfuscatedAccountId:owned.accountId}}],{total:{label:'RIG-tegoed',amount:item.price}});
   const shown=payment.show();response=await shown;check();
   confirmed=await confirmPurchase({itemId:productId,purchaseToken:response?.details?.purchaseToken},owned);
   if(confirmed.state==='credited')setIntent({...owned,state:'credited',consumed:confirmed.consumed,recoveryPending:true,newPurchasesBlocked:true});
   const latest=await getStatus(owned.intentId);if(!latest)throw Error(uncertain);setIntent(latest);unresolved=false;
   const completed=settleIntent();renderOffers();message(completed?completed.state==='refunded'?'Je betaling is terugbetaald. Je tegoed is bijgewerkt.':'Je RIG-tegoed is bijgeschreven.':stateMessage());
   await response.complete(confirmed.state==='credited'?'success':'unknown');
  }catch(error){
   if(response&&typeof response.complete==='function')try{await response.complete('unknown');}catch{}
   if(current()){
    if(error?.name==='AbortError'&&!response)message('Betaling geannuleerd. Je kunt opnieuw bevestigen.');
    else{unresolved=true;clearButtons();message(confirmed?.state==='credited'?'Je tegoed is bijgeschreven. De aankoopstatus wordt nog gecontroleerd.':uncertain);}
   }
  }finally{busy=false;if(current())controls();}
 }
 async function openCredits({showDialog=true}={}){
  if(!current()||busy||reconciling)return;
  reconciling=true;controls();const sequence=++viewSequence;
  try{
   clearCatalog();if(showDialog)el('creditsDialog').showModal();
   if(!await refreshBalance()||!current()||sequence!==viewSequence||owner())return;
   config=checkedConfig(await request(CONFIG));if(config&&config.mode!==balanceMode)throw Error(unavailable);
   await loadStatus();check();if(sequence!==viewSequence)return;unresolved=false;
   if(config?.recoveryReady&&typeof browser.getDigitalGoodsService==='function'){
    service=await browser.getDigitalGoodsService(BILLING);check();if(sequence!==viewSequence)return;
    if(!service||['getDetails','listPurchases'].some(name=>typeof service[name]!=='function'))throw Error(unavailable);
    catalog=checkedDetails(await service.getDetails([...config.products.keys()]),config);check();
    message('Eerdere aankopen controleren…');await recoverPurchases();
   }else if(intent&&!terminal(intent)){unresolved=true;}
   if(!current()||sequence!==viewSequence)return;
   const completed=settleIntent();renderOffers();
   message(unresolved||intent?stateMessage():completed?.state==='refunded'?'Je betaling is terugbetaald. Je tegoed is bijgewerkt.':completed?.state==='credited'?'Je RIG-tegoed is bijgeschreven.':unavailable);
   if(!unresolved&&!intent&&config?.enabled&&service&&catalog.size&&typeof browser.PaymentRequest==='function'&&!['credited','refunded'].includes(completed?.state))message('Kies je tegoed. Je betaalt via Google Play.');
  }catch{if(current()){unresolved=true;clearButtons();if(sequence===viewSequence)message(config||intent?uncertain:unavailable);}}
  finally{reconciling=false;if(current())controls();}
 }
 const resume=(force=false)=>{if(!current()||busy||reconciling)return;try{if(force||unresolved||blocked(intent)||!intent&&readSlot())void openCredits({showDialog:el('creditsDialog').open});}catch{message(uncertain);}};
 function dispose(){
  if(disposed)return;disposed=true;balanceSequence++;viewSequence++;clearCatalog();
  if(expiryTimer!==null)browser.clearTimeout(expiryTimer);
  for(const remove of listeners)remove();el('creditsDialog').close();el('creditsMessage').textContent='Meld je opnieuw aan om je tegoed te bekijken.';
 }
 el('creditsTitle').textContent='RIG-tegoed';el('creditExplanation').textContent='Je ziet de prijs vóór elke video. Je bestaande RIG-tegoed blijft beschikbaar.';
 el('resumePayment').hidden=true;el('resumePayment').textContent='';el('refreshPayment').textContent='Controleer aankoop';
 listen(el('creditsButton'),'click',()=>{void openCredits();});listen(el('closeCredits'),'click',()=>{viewSequence++;el('creditsDialog').close();});listen(el('refreshPayment'),'click',()=>{void openCredits();});
 listen(document,'rig-balance-changed',()=>{void refreshBalance();});listen(browser,'focus',()=>resume());listen(browser,'pageshow',event=>{if(event.persisted===true)resume(true);});
 listen(document,'visibilitychange',()=>{if(document.visibilityState==='hidden')wasHidden=true;else if(document.visibilityState==='visible'&&wasHidden){wasHidden=false;resume(true);}});
 listen(browser,'pagehide',dispose);browser.rigPaymentsDispose=dispose;
 const ready=(async()=>{await refreshBalance();if(current()&&!owner()&&readSlot())await openCredits({showDialog:false});})().catch(()=>{message(uncertain);});
 return Object.freeze({dispose,refreshBalance,openCredits,ready});
}

if(typeof window!=='undefined'&&window.document&&window.rigPaymentChannel==='google-play')startGooglePlayPayments({browser:window});
