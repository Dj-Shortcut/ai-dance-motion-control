// Inactive server-only foundation. No HTTP route or wallet write is installed
// by importing this module. Production activation needs the separate funding,
// refund/RTDN, Google OAuth and accounting adapters described in the docs.
export const GOOGLE_PLAY_PACKAGE='dev.andyarijs.rig';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
const proofData=new WeakMap();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
const encode=value=>new TextEncoder().encode(value);
const failure=code=>Object.assign(Error('Google Play-aankoop is nog niet beschikbaar.'),{code});
const rejectedPurchaseStatus=status=>[400,404,410,422].includes(status);
const tokenOk=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[^\x21-\x7e]/.test(value);
const validTime=value=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
const validOrder=value=>value===undefined||typeof value==='string'&&value.length>=1&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
async function sha256(value){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(value))));}

// Server configuration assigns EUR wallet cents; Google supplies the actual
// localized purchase price. A browser cannot choose its own credit amount.
export function googlePlayCatalog(value){
 const supported=new Map([['rig_credit_5',500],['rig_credit_10',1000],['rig_credit_25',2500]]);
 if(!Array.isArray(value)||value.length!==3||value.some(item=>!object(item)||Object.keys(item).sort().join(',')!=='creditsCents,productId'||supported.get(item.productId)!==item.creditsCents)||new Set(value.map(item=>item.productId)).size!==3)throw failure('play_catalog');
 return Object.freeze(value.map(item=>Object.freeze({productId:item.productId,creditsCents:item.creditsCents})));
}

export async function googlePlayAccountId({key,userId,siteId,mode}){
 if(typeof key!=='string'||key.length<32||key.length>512||/[^\x21-\x7e]/.test(key)||!USER.test(userId||'')||typeof siteId!=='string'||!/^[A-Za-z0-9_~-]{8,160}$/.test(siteId)||!['test','live'].includes(mode))throw failure('play_binding');
 const secret=await crypto.subtle.importKey('raw',encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(new Uint8Array(await crypto.subtle.sign('HMAC',secret,encode(JSON.stringify(['rig-play-account-v1',GOOGLE_PLAY_PACKAGE,siteId,mode,userId])))));
}

async function boundedJson(response){
 if(!response?.ok||response.status!==200)throw failure(rejectedPurchaseStatus(response?.status)?'play_rejected':'play_provider');
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw failure('play_response');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))throw failure('play_response');
 const reader=response.body?.getReader();if(!reader)throw failure('play_response');
 const chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('play_response')),15000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array)||(size+=value.byteLength)>32768)throw failure('play_response');chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!object(result))throw failure('play_response');return result;
 }catch{throw failure('play_response')}
 finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}

// Only objects actually produced by a successful server verification may reach
// the store. JSON copies, client fields and caller-forged receipts are refused.
export function receiptForGooglePlayProof(proof){
 const data=object(proof)&&proofData.get(proof);if(!data?.receipt)throw failure('play_proof');
 return data.receipt;
}

export function purchaseForGooglePlayProof(proof){
 const data=object(proof)&&proofData.get(proof);if(!data?.purchase)throw failure('play_proof');return data.purchase;
}

export function notificationPurchaseForGooglePlayProof(proof){
 const data=object(proof)&&proofData.get(proof);if(!data?.notificationPurchase)throw failure('play_proof');return data.notificationPurchase;
}

export function createGooglePlayPurchaseVerifier({enabled=false,mode='test',accountKey,siteId,catalog,network,getAccessToken,now=Date.now}={}){
 if(enabled!==true)return Object.freeze({enabled:false,async verify(){throw failure('play_setup')},async inspect(){throw failure('play_setup')},async inspectOwned(){throw failure('play_setup')},async inspectForNotification(){throw failure('play_setup')},async accountId(){throw failure('play_setup')},async consume(){throw failure('play_setup')}});
 const products=googlePlayCatalog(catalog);
 if(!['test','live'].includes(mode)||typeof network!=='function'||typeof getAccessToken!=='function'||typeof now!=='function')throw failure('play_setup');
 const byId=new Map(products.map(item=>[item.productId,item]));
 const issuer={};
 const accountId=userId=>googlePlayAccountId({key:accountKey,userId,siteId,mode});
 async function request(path,method='GET'){
  let access;
  try{access=await getAccessToken()}catch{throw failure('play_oauth')}
  if(typeof access!=='string'||access.length<16||access.length>8192||/[^A-Za-z0-9._~-]/.test(access))throw failure('play_oauth');
  try{return await network('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+GOOGLE_PLAY_PACKAGE+path,{method,redirect:'manual',credentials:'omit',headers:{authorization:'Bearer '+access,accept:'application/json'},signal:AbortSignal.timeout(15000)})}
  catch{throw failure('play_provider')}
 }
 async function inspectForNotification(input){
  if(!object(input)||!['purchaseToken','productId,purchaseToken'].includes(Object.keys(input).sort().join(','))||input.productId!==undefined&&!byId.has(input.productId)||!tokenOk(input.purchaseToken))throw failure('play_input');
  const resource=await boundedJson(await request('/purchases/productsv2/tokens/'+encodeURIComponent(input.purchaseToken)));
  if(resource.kind!=='androidpublisher#productPurchaseV2'||!HEX.test(resource.obfuscatedExternalAccountId??''))throw failure('play_account');
  const test=Object.hasOwn(resource,'testPurchaseContext');if(mode==='live'&&test||mode==='test'&&(!test||resource.testPurchaseContext?.fopType!=='TEST'))throw failure('play_environment');
  const items=resource.productLineItem,state=resource.purchaseStateContext?.purchaseState;
  if(!Array.isArray(items)||items.length!==1||!byId.has(items[0]?.productId)||input.productId!==undefined&&input.productId!==items[0].productId||items[0]?.productOfferDetails?.quantity!==1||Object.hasOwn(items[0].productOfferDetails,'rentOfferDetails')||Object.hasOwn(items[0].productOfferDetails,'preorderOfferDetails')||!['PURCHASED','PENDING','CANCELLED'].includes(state))throw failure('play_product');
  const verifiedAt=now(),purchasedAt=resource.purchaseCompletionTime===undefined&&state!=='PURCHASED'?null:validTime(resource.purchaseCompletionTime)?Date.parse(resource.purchaseCompletionTime):NaN;
  if(!Number.isSafeInteger(verifiedAt)||verifiedAt<0||purchasedAt!==null&&(!Number.isSafeInteger(purchasedAt)||purchasedAt<0||purchasedAt>verifiedAt+300000)||!validOrder(resource.orderId))throw failure('play_response');
  const notificationPurchase=Object.freeze({tokenHash:await sha256(input.purchaseToken),accountId:resource.obfuscatedExternalAccountId,productId:items[0].productId,mode,packageName:GOOGLE_PLAY_PACKAGE,state,purchasedAt,orderId:resource.orderId??null,inspectionId:crypto.randomUUID(),verifiedAt});
  const proof=Object.freeze({state:'notification_lookup',notificationPurchase});proofData.set(proof,{notificationPurchase,issuer});return proof;
 }
 async function inspectWithBinding(input,savedAccountId=null){
  if(!object(input)||Object.keys(input).sort().join(',')!=='productId,purchaseToken,userId'||!USER.test(input.userId||'')||!byId.has(input.productId)||!tokenOk(input.purchaseToken))throw failure('play_input');
  const {userId,productId,purchaseToken}=input,expected=savedAccountId??await accountId(userId);
  const resource=await boundedJson(await request('/purchases/productsv2/tokens/'+encodeURIComponent(purchaseToken)));
  if(resource.kind!=='androidpublisher#productPurchaseV2'||resource.obfuscatedExternalAccountId!==expected)throw failure('play_account');
  const test=Object.hasOwn(resource,'testPurchaseContext');
  if(mode==='live'&&test||mode==='test'&&(!test||resource.testPurchaseContext?.fopType!=='TEST'))throw failure('play_environment');
  const items=resource.productLineItem;
  if(!Array.isArray(items)||items.length!==1||items[0]?.productId!==productId||!object(items[0].productOfferDetails))throw failure('play_product');
  const offer=items[0].productOfferDetails;
  if(offer.quantity!==1||Object.hasOwn(offer,'rentOfferDetails')||Object.hasOwn(offer,'preorderOfferDetails'))throw failure('play_product');
  const state=resource.purchaseStateContext?.purchaseState;
  if(!['PURCHASED','PENDING','CANCELLED'].includes(state))throw failure('play_state');
  const consumed=offer.consumptionState===undefined&&state!=='PURCHASED'?null:offer.consumptionState==='CONSUMPTION_STATE_CONSUMED'?true:offer.consumptionState==='CONSUMPTION_STATE_YET_TO_BE_CONSUMED'?false:undefined;
  const refundableQuantity=offer.refundableQuantity===undefined&&state!=='PURCHASED'?null:offer.refundableQuantity;
  if(consumed===undefined||state==='PURCHASED'&&!Number.isInteger(refundableQuantity)||refundableQuantity!==null&&![0,1].includes(refundableQuantity))throw failure('play_product');
  const purchasedAt=resource.purchaseCompletionTime===undefined&&state!=='PURCHASED'?null:validTime(resource.purchaseCompletionTime)?Date.parse(resource.purchaseCompletionTime):NaN;
  const acknowledgementState=resource.acknowledgementState===undefined&&state!=='PURCHASED'?null:resource.acknowledgementState;
  const verifiedAt=now();
  if(!Number.isSafeInteger(verifiedAt)||verifiedAt<0||state==='PURCHASED'&&acknowledgementState===null||purchasedAt!==null&&(!Number.isFinite(purchasedAt)||purchasedAt>verifiedAt+300000)||acknowledgementState!==null&&!['ACKNOWLEDGEMENT_STATE_PENDING','ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(acknowledgementState)||!validOrder(resource.orderId))throw failure('play_response');
  const tokenHash=await sha256(purchaseToken),creditsCents=byId.get(productId).creditsCents,inspectionId=crypto.randomUUID();
  const purchase=Object.freeze({state,tokenHash,userId,productId,creditsCents,mode,packageName:GOOGLE_PLAY_PACKAGE,accountId:expected,purchasedAt,orderId:resource.orderId??null,quantity:1,refundableQuantity,consumed,acknowledgementState,inspectionId,verifiedAt});
  const receipt=state==='PURCHASED'&&refundableQuantity===1?Object.freeze({tokenHash,userId,productId,creditsCents,mode,packageName:GOOGLE_PLAY_PACKAGE,accountId:expected,purchasedAt,orderId:resource.orderId??null,consumed,inspectionId,verifiedAt}):null;
  const proof=Object.freeze({state:'inspected',purchase});proofData.set(proof,{purchase,receipt,purchaseToken,issuer});return proof;
 }
 // Only server-owned immutable intents may provide a historical binding.
 // The browser input contract still contains exactly userId/productId/token.
 const inspect=input=>inspectWithBinding(input);
 async function inspectOwned(input,options){
  if(!object(options)||Object.keys(options).join(',')!=='accountId'||!HEX.test(options.accountId??''))throw failure('play_binding');
  return inspectWithBinding(input,options.accountId);
 }
 async function verify(input){
  const inspected=await inspect(input),data=proofData.get(inspected),purchase=data.purchase;
  if(purchase.state!=='PURCHASED')return Object.freeze({state:purchase.state==='PENDING'?'pending':'cancelled'});
  if(!data.receipt)throw failure('play_product');
  const proof=Object.freeze({state:'verified',receipt:data.receipt});proofData.set(proof,data);return proof;
 }
 async function consume(proof,entitlement){
  const receipt=receiptForGooglePlayProof(proof),data=proofData.get(proof);
  if(data.issuer!==issuer||receipt.mode!==mode||!object(entitlement)||entitlement.state!=='credited'||entitlement.tokenHash!==receipt.tokenHash||entitlement.userId!==receipt.userId||entitlement.creditsCents!==receipt.creditsCents||entitlement.eventId!=='google-play:'+receipt.tokenHash)throw failure('play_entitlement');
  if(receipt.consumed||data.consumeState==='consumed')return {state:'already_consumed'};
  const checkedAt=now();if(!Number.isSafeInteger(checkedAt)||checkedAt<receipt.verifiedAt||checkedAt-receipt.verifiedAt>60000)throw failure('play_consume_reinspect');
  if(data.consumeState==='attempted')throw failure('play_consume_uncertain');
  data.consumeState='attempted';
  const response=await request('/purchases/products/'+encodeURIComponent(receipt.productId)+'/tokens/'+encodeURIComponent(data.purchaseToken)+':consume','POST');
  if(!response?.ok||![200,204].includes(response.status))throw failure('play_consume_uncertain');
  // No automatic repeat after an uncertain write; caller must re-read Google.
  if(response.body)void response.body.cancel().catch(()=>{});
  data.consumeState='consumed';
  return {state:'consumed'};
 }
 return Object.freeze({enabled:true,mode,products,accountId,inspect,inspectOwned,inspectForNotification,verify,consume});
}
