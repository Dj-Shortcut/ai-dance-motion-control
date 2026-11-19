import {GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {playProviderError as fail,playObject,playTokenValid,playSha256} from './google-play-provider-common.mjs';
const secrets=new WeakMap(),products=new Set(['rig_credit_5','rig_credit_10','rig_credit_25']);
const variants=['oneTimeProductNotification','voidedPurchaseNotification','testNotification','subscriptionNotification','pendingRefundReviewNotification'];
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u0020\u007f]/.test(value);
export function tokenForGooglePlayNotification(descriptor){if(!secrets.has(descriptor))throw fail('play_rtdn_descriptor');return secrets.get(descriptor);}
export async function decodeGooglePlayRtdn(envelope,{subscription,now=Date.now}={}){
 if(!text(subscription,512)||!/^projects\/[A-Za-z0-9._:-]+\/subscriptions\/[A-Za-z0-9._~-]+$/.test(subscription)||typeof now!=='function'||!playObject(envelope)||envelope.subscription!==subscription||!playObject(envelope.message))throw fail('play_rtdn_input');
 const message=envelope.message;
 if(!text(message.messageId,200)||typeof message.data!=='string'||message.data.length>32768||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data))throw fail('play_rtdn_input');
 let payload;try{
  const binary=atob(message.data);if(binary.length>24576||btoa(binary)!==message.data)throw Error();
  payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0))));
 }catch{throw fail('play_rtdn_input');}
 const at=now(),eventTime=typeof payload?.eventTimeMillis==='string'&&/^\d{1,16}$/.test(payload.eventTimeMillis)?Number(payload.eventTimeMillis):NaN;
 if(!playObject(payload)||payload.version!=='1.0'||payload.packageName!==GOOGLE_PLAY_PACKAGE||!Number.isSafeInteger(at)||!Number.isSafeInteger(eventTime)||eventTime<0||eventTime>at+300000||variants.filter(key=>Object.hasOwn(payload,key)).length!==1)throw fail('play_rtdn_input');
 let kind,productId=null,token=null,orderId=null,refundType=null,unsupportedType=null;
 if(Object.hasOwn(payload,'oneTimeProductNotification')){
  const value=payload.oneTimeProductNotification;
  if(!playObject(value)||value.version!=='1.0'||![1,2].includes(value.notificationType)||!products.has(value.sku)||!playTokenValid(value.purchaseToken))throw fail('play_rtdn_input');
  kind=value.notificationType===1?'purchased':'cancelled';productId=value.sku;token=value.purchaseToken;
 }else if(Object.hasOwn(payload,'voidedPurchaseNotification')){
  const value=payload.voidedPurchaseNotification;
  // Google's productType=2 means a one-time product; 1 is a subscription.
  if(!playObject(value)||value.productType!==2||![1,2].includes(value.refundType)||!playTokenValid(value.purchaseToken)||!text(value.orderId,512))throw fail('play_rtdn_input');
  kind='voided';token=value.purchaseToken;orderId=value.orderId;refundType=value.refundType;
 }else if(Object.hasOwn(payload,'testNotification')){
  if(!playObject(payload.testNotification)||payload.testNotification.version!=='1.0')throw fail('play_rtdn_input');kind='test';
 }else{kind='unsupported';unsupportedType=Object.hasOwn(payload,'subscriptionNotification')?'subscription':'pending_refund_review';}
 const tokenHash=token===null?null:await playSha256(token),payloadHash=await playSha256(JSON.stringify(payload));
 const descriptor=Object.freeze({messageId:message.messageId,subscription,packageName:GOOGLE_PLAY_PACKAGE,eventTime,kind,productId,tokenHash,orderId,refundType,unsupportedType,payloadHash,messageKey:await playSha256(JSON.stringify([subscription,message.messageId])),requiresProviderRead:kind!=='test'&&kind!=='unsupported'});
 secrets.set(descriptor,token);return descriptor;
}
