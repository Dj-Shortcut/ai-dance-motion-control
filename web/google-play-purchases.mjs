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
const tokenOk=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[^\x21-\x7e]/.test(value);
const validTime=value=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
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
 if(!response?.ok||response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw failure('play_provider');
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
 const data=object(proof)&&proofData.get(proof);if(!data)throw failure('play_proof');
 return data.receipt;
}

export function createGooglePlayPurchaseVerifier({enabled=false,mode='test',accountKey,siteId,catalog,network,getAccessToken,now=Date.now}={}){
 if(enabled!==true)return Object.freeze({enabled:false,async verify(){throw failure('play_setup')},async accountId(){throw failure('play_setup')},async consume(){throw failure('play_setup')}});
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
 async function verify(input){
  if(!object(input)||Object.keys(input).sort().join(',')!=='productId,purchaseToken,userId'||!USER.test(input.userId||'')||!byId.has(input.productId)||!tokenOk(input.purchaseToken))throw failure('play_input');
  const {userId,productId,purchaseToken}=input,expected=await accountId(userId);
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
  if(state!=='PURCHASED')return Object.freeze({state:state==='PENDING'?'pending':'cancelled'});
  if(offer.refundableQuantity!==1||!['CONSUMPTION_STATE_YET_TO_BE_CONSUMED','CONSUMPTION_STATE_CONSUMED'].includes(offer.consumptionState))throw failure('play_product');
  if(!validTime(resource.purchaseCompletionTime)||Date.parse(resource.purchaseCompletionTime)>now()+300000||!['ACKNOWLEDGEMENT_STATE_PENDING','ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'].includes(resource.acknowledgementState)||resource.orderId!==undefined&&(typeof resource.orderId!=='string'||resource.orderId.length<1||resource.orderId.length>512||/[\u0000-\u001f\u007f]/.test(resource.orderId)))throw failure('play_response');
  const tokenHash=await sha256(purchaseToken),creditsCents=byId.get(productId).creditsCents;
  const receipt=Object.freeze({tokenHash,userId,productId,creditsCents,mode,packageName:GOOGLE_PLAY_PACKAGE,accountId:expected,purchasedAt:Date.parse(resource.purchaseCompletionTime),orderId:resource.orderId??null,consumed:offer.consumptionState==='CONSUMPTION_STATE_CONSUMED'});
  const proof=Object.freeze({state:'verified',receipt});proofData.set(proof,{receipt,purchaseToken,issuer});return proof;
 }
 async function consume(proof,entitlement){
  const receipt=receiptForGooglePlayProof(proof),data=proofData.get(proof);
  if(data.issuer!==issuer||receipt.mode!==mode||!object(entitlement)||entitlement.state!=='credited'||entitlement.tokenHash!==receipt.tokenHash||entitlement.userId!==receipt.userId||entitlement.creditsCents!==receipt.creditsCents||entitlement.eventId!=='google-play:'+receipt.tokenHash)throw failure('play_entitlement');
  if(receipt.consumed||data.consumeState==='consumed')return {state:'already_consumed'};
  if(data.consumeState==='attempted')throw failure('play_consume_uncertain');
  data.consumeState='attempted';
  const response=await request('/purchases/products/'+encodeURIComponent(receipt.productId)+'/tokens/'+encodeURIComponent(data.purchaseToken)+':consume','POST');
  if(!response?.ok||![200,204].includes(response.status))throw failure('play_consume_uncertain');
  // No automatic repeat after an uncertain write; caller must re-read Google.
  if(response.body)void response.body.cancel().catch(()=>{});
  data.consumeState='consumed';
  return {state:'consumed'};
 }
 return Object.freeze({enabled:true,mode,products,accountId,verify,consume});
}
