import {GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {playProviderError as fail,playObject,playReadJson,playTokenValid,playHexValid,playSha256} from './google-play-provider-common.mjs';
const authority=new WeakMap(),products=new Set(['rig_credit_5','rig_credit_10','rig_credit_25']);
const orderIdValid=value=>typeof value==='string'&&value.length>=1&&value.length<=512&&!/[^\x21-\x7e]/.test(value);
const tokenValid=value=>typeof value==='string'&&value.length<=4096&&!/[^\x21-\x7e]/.test(value);
const states=new Set(['PENDING','PROCESSED','CANCELED','PENDING_REFUND','PARTIALLY_REFUNDED','REFUNDED']);
function time(value,now){const at=typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(value)?Date.parse(value):NaN;if(!Number.isSafeInteger(at)||at<0||at>now+300000)throw fail('play_order_response');return at;}
function money(value,{negative=false,optional=false}={}){
 if(value===undefined&&optional)return null;
 const unitsText=value?.units===undefined?'0':value.units;
 if(!playObject(value)||value.currencyCode!=='EUR'||typeof unitsText!=='string'||! /^-?(?:0|[1-9]\d{0,17})$/.test(unitsText)||!Number.isSafeInteger(value.nanos??0)||Math.abs(value.nanos??0)>999999999)throw fail('play_order_money');
 const units=BigInt(unitsText),nanos=value.nanos??0;
 if(units>0n&&nanos<0||units<0n&&nanos>0||!negative&&(units<0n||nanos<0))throw fail('play_order_money');
 return Object.freeze({currencyCode:'EUR',units:unitsText,nanos});
}
function refundEvent(value,now){
 if(value===undefined)return null;if(!playObject(value)||!playObject(value.refundDetails))throw fail('play_order_response');
 const reason=value.refundReason??null,state=value.state??null;
 if(reason!==null&&(typeof reason!=='string'||!/^[A-Z_]{1,64}$/.test(reason))||state!==null&&(typeof state!=='string'||!/^[A-Z_]{1,64}$/.test(state)))throw fail('play_order_response');
 return Object.freeze({eventTime:time(value.eventTime,now),total:money(value.refundDetails.total),tax:money(value.refundDetails.tax,{optional:true}),reason,state});
}
function partialRefundEvent(value,now){
 if(!playObject(value)||!playObject(value.refundDetails)||!['PENDING','PROCESSED_SUCCESSFULLY'].includes(value.state))throw fail('play_order_response');
 return Object.freeze({createTime:time(value.createTime,now),processTime:value.processTime===undefined&&value.state==='PENDING'?null:time(value.processTime,now),state:value.state,total:money(value.refundDetails.total),tax:money(value.refundDetails.tax,{optional:true})});
}
export function orderForGooglePlayProof(proof){const data=playObject(proof)&&authority.get(proof);if(!data?.order)throw fail('play_order_proof');return data.order;}
export function reversalForGooglePlayProof(proof){const data=playObject(proof)&&authority.get(proof);if(!data?.reversal)throw fail('play_reversal_proof');return data.reversal;}

// The caller owns durable attempts, authorization, ledger changes and retries.
// This transport never credits a wallet or retries a refund write automatically.
export function createGooglePlayPublisherClient(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false,async getOrder(){throw fail('play_publisher_setup')},async refundOrder(){throw fail('play_publisher_setup')},async listVoided(){throw fail('play_publisher_setup')}});
 const {mode='live',network,getAccessToken,now=Date.now}=options;
 if(!['test','live'].includes(mode)||typeof network!=='function'||typeof getAccessToken!=='function'||typeof now!=='function')throw fail('play_publisher_setup');
 const issuer={},refundAttempts=new Set();
 async function request(path,method='GET'){
  let access;try{access=await getAccessToken()}catch{throw fail('play_provider_oauth')}
  if(typeof access!=='string'||!/^[A-Za-z0-9._~-]{16,8192}$/.test(access))throw fail('play_provider_oauth');
  try{return await network('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+GOOGLE_PLAY_PACKAGE+path,{method,credentials:'omit',redirect:'manual',headers:{authorization:'Bearer '+access,accept:'application/json'},signal:AbortSignal.timeout(15000)})}catch{throw fail('play_provider')}
 }
 async function getOrder({orderId}={}){
  if(!orderIdValid(orderId))throw fail('play_order_input');
  const body=await playReadJson(await request('/orders/'+encodeURIComponent(orderId)),{max:131072}),verifiedAt=now();
  if(!Number.isSafeInteger(verifiedAt)||verifiedAt<0||body.orderId!==orderId||!playTokenValid(body.purchaseToken)||!states.has(body.state)||!Array.isArray(body.lineItems)||body.lineItems.length!==1)throw fail('play_order_response');
  const item=body.lineItems[0],detail=item?.oneTimePurchaseDetails;
  if(!products.has(item?.productId)||!playObject(detail)||detail.quantity!==1||Object.hasOwn(detail,'preorderDetails')||Object.hasOwn(detail,'rentalDetails')||Object.hasOwn(item,'subscriptionDetails')||Object.hasOwn(item,'paidAppDetails'))throw fail('play_order_product');
  const history=body.orderHistory??{};if(!playObject(history)||history.partialRefundEvents!==undefined&&!Array.isArray(history.partialRefundEvents)||(history.partialRefundEvents?.length??0)>100)throw fail('play_order_response');
  const country=body.buyerAddress?.buyerCountry??null;if(country!==null&&(typeof country!=='string'||!/^[A-Z]{2}$/.test(country)))throw fail('play_order_response');
  const taxInclusive=body.orderDetails?.taxInclusive??null;if(taxInclusive!==null&&typeof taxInclusive!=='boolean')throw fail('play_order_response');
  const createTime=time(body.createTime,verifiedAt),lastEventTime=time(body.lastEventTime,verifiedAt);if(lastEventTime<createTime)throw fail('play_order_response');
  const tokenHash=await playSha256(body.purchaseToken),inspectionId=crypto.randomUUID();
  const order=Object.freeze({orderId,tokenHash,packageName:GOOGLE_PLAY_PACKAGE,mode,productId:item.productId,quantity:1,state:body.state,createTime,lastEventTime,verifiedAt,inspectionId,buyerCountry:country,taxInclusive,
   total:money(body.total),tax:money(body.tax,{optional:true}),developerRevenueInBuyerCurrency:money(body.developerRevenueInBuyerCurrency,{negative:true,optional:true}),
   lineTotal:money(item.total),lineTax:money(item.tax,{optional:true}),listingPrice:money(item.listingPrice,{optional:true}),
   refundEvent:refundEvent(history.refundEvent,verifiedAt),partialRefundEvents:Object.freeze((history.partialRefundEvents??[]).map(value=>partialRefundEvent(value,verifiedAt)))});
  const reason=order.state==='REFUNDED'?'refunded':order.state==='CANCELED'?'cancelled':null;
  const reversal=reason?Object.freeze({tokenHash,packageName:GOOGLE_PLAY_PACKAGE,mode,reason,providerReference:'google-play-order:'+await playSha256(JSON.stringify([orderId,order.state,lastEventTime])),verifiedAt,inspectionId}):null;
  const proof=Object.freeze({state:'verified_order',order});authority.set(proof,{issuer,order,reversal});return proof;
 }
 async function refundOrder({orderId,tokenHash,attemptId}={}){
  if(!orderIdValid(orderId)||!playHexValid(tokenHash)||typeof attemptId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(attemptId))throw fail('play_refund_input');
  // A repeated/uncertain attempt must be reconciled by the controller, never
  // interpreted as an instruction to issue another non-idempotent POST.
  if(refundAttempts.has(attemptId)||refundAttempts.size>=2048)throw fail('play_refund_reconcile');
  refundAttempts.add(attemptId);
  const proof=await getOrder({orderId}),order=orderForGooglePlayProof(proof);
  if(order.tokenHash!==tokenHash)throw fail('play_refund_binding');
  if(order.state==='REFUNDED'||order.state==='CANCELED')return Object.freeze({state:'already_reversed',orderProof:proof});
  if(order.state==='PENDING_REFUND')return Object.freeze({state:'pending',orderProof:proof});
  if(order.state!=='PROCESSED')throw fail('play_refund_state');
  try{
   const response=await request('/orders/'+encodeURIComponent(orderId)+':refund?revoke=true','POST');
   if(response.body)void response.body.cancel().catch(()=>{});
   return Object.freeze({state:response.ok&&[200,204].includes(response.status)?'accepted':'uncertain'});
  }catch{return Object.freeze({state:'uncertain'});}
 }
 async function listVoided({startTime,endTime,pageToken=null}={}){
  const at=now();
  if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(startTime)||!Number.isSafeInteger(endTime)||startTime<0||pageToken===null&&startTime<Math.max(0,at-30*86400000)||endTime>at||endTime<startTime||pageToken!==null&&!tokenValid(pageToken))throw fail('play_voided_input');
  const query=new URLSearchParams({type:'0',includeQuantityBasedPartialRefund:'true','pageSelection.maxResults':'100',startTime:String(startTime),endTime:String(endTime)});if(pageToken!==null)query.set('pageSelection.token',pageToken);
  const body=await playReadJson(await request('/purchases/voidedpurchases?'+query.toString()),{max:524288});
  const entries=body.voidedPurchases??[];if(!Array.isArray(entries)||entries.length>100)throw fail('play_voided_response');
  const nextPageToken=body.tokenPagination?.nextPageToken??null;if(nextPageToken!==null&&!tokenValid(nextPageToken))throw fail('play_voided_response');
  const proofs=[],verifiedAt=now();if(!Number.isSafeInteger(verifiedAt)||verifiedAt<at)throw fail('play_voided_response');
  for(const row of entries){
   const purchaseTime=typeof row?.purchaseTimeMillis==='string'&&/^\d{1,16}$/.test(row.purchaseTimeMillis)?Number(row.purchaseTimeMillis):NaN,voidedAt=typeof row?.voidedTimeMillis==='string'&&/^\d{1,16}$/.test(row.voidedTimeMillis)?Number(row.voidedTimeMillis):NaN;
   if(!playTokenValid(row?.purchaseToken)||!orderIdValid(row.orderId)||!Number.isSafeInteger(purchaseTime)||!Number.isSafeInteger(voidedAt)||purchaseTime>voidedAt||voidedAt>verifiedAt+300000||![0,1,2].includes(row.voidedSource)||!Number.isSafeInteger(row.voidedReason)||row.voidedReason<0||row.voidedReason>20||row.voidedQuantity!==undefined&&row.voidedQuantity!==1)throw fail('play_voided_response');
   const tokenHash=await playSha256(row.purchaseToken),inspectionId=crypto.randomUUID(),providerReference='google-play-void:'+await playSha256(JSON.stringify([tokenHash,row.orderId,voidedAt,row.voidedSource,row.voidedReason,row.voidedQuantity??null]));
   const voided=Object.freeze({tokenHash,packageName:GOOGLE_PLAY_PACKAGE,mode,orderId:row.orderId,purchaseTime,voidedAt,source:row.voidedSource,reason:row.voidedReason,quantity:row.voidedQuantity??null,verifiedAt,inspectionId});
   const reversal=Object.freeze({tokenHash,packageName:GOOGLE_PLAY_PACKAGE,mode,reason:'voided',providerReference,verifiedAt,inspectionId});
   const proof=Object.freeze({state:'verified_void',voided});authority.set(proof,{issuer,voided,reversal});proofs.push(proof);
  }
  return Object.freeze({proofs:Object.freeze(proofs),nextPageToken});
 }
 return Object.freeze({enabled:true,getOrder,refundOrder,listVoided});
}
