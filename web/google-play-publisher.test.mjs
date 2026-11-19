import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayPublisherClient,orderForGooglePlayProof,reversalForGooglePlayProof} from './google-play-publisher.mjs';
import {playSha256} from './google-play-provider-common.mjs';
import {providerNow} from './google-play-provider-fixture.mjs';
const rawToken='private-order-fixture-token',orderId='GPA.fixture-order-123',attemptId='11111111-1111-4111-8111-111111111111';
const eur=(units,nanos=0)=>({currencyCode:'EUR',units:String(units),nanos});
function orderBody(delta={}){return {orderId,purchaseToken:rawToken,state:'PROCESSED',createTime:new Date(providerNow-1000).toISOString(),lastEventTime:new Date(providerNow).toISOString(),total:eur(5),tax:eur(0,867768595),developerRevenueInBuyerCurrency:eur(3,512396694),buyerAddress:{buyerCountry:'NL',buyerPostcode:'private-address'},orderDetails:{taxInclusive:true},lineItems:[{productId:'rig_credit_5',oneTimePurchaseDetails:{quantity:1},total:eur(5),tax:eur(0,867768595),listingPrice:eur(5)}],...delta};}
function fixture({body=orderBody(),response,refundStatus=204}={}){
 const calls=[];const client=createGooglePlayPublisherClient({enabled:true,mode:'live',now:()=>providerNow,getAccessToken:async()=> 'ya29.fake-fixture-token',network:async(url,options)=>{
  calls.push({url,method:options.method});assert.equal(new URL(url).origin,'https://androidpublisher.googleapis.com');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
  if(options.method==='POST'){assert.equal(options.body,undefined);return new Response(null,{status:refundStatus})}
  return response?response():Response.json(body);
 }});return {client,calls};
}

test('Orders reader preserves exact Google financial Money and does not leak purchase token or buyer address',async()=>{
 const f=fixture(),proof=await f.client.getOrder({orderId}),order=orderForGooglePlayProof(proof);
 assert.equal(order.tokenHash,await playSha256(rawToken));assert.equal(order.productId,'rig_credit_5');assert.deepEqual(order.developerRevenueInBuyerCurrency,eur(3,512396694));assert.deepEqual(order.tax,eur(0,867768595));assert.equal(order.buyerCountry,'NL');assert.equal(order.state,'PROCESSED');assert.match(order.inspectionId,/^[a-f0-9-]{36}$/);
 assert.ok(!JSON.stringify(proof).includes(rawToken));assert.ok(!JSON.stringify(proof).includes('private-address'));assert.throws(()=>orderForGooglePlayProof(JSON.parse(JSON.stringify(proof))),{code:'play_order_proof'});assert.throws(()=>reversalForGooglePlayProof(proof),{code:'play_reversal_proof'});
});
test('full verified refunds mint reversal proof; pending/partial never imply full credit reversal',async()=>{
 const full=fixture({body:orderBody({state:'REFUNDED',developerRevenueInBuyerCurrency:eur(0,-100000000),orderHistory:{refundEvent:{eventTime:new Date(providerNow).toISOString(),refundReason:'CHARGEBACK',refundDetails:{total:eur(5),tax:{currencyCode:'EUR'}}}}})});
 const proof=await full.client.getOrder({orderId});assert.equal(reversalForGooglePlayProof(proof).reason,'refunded');assert.equal(orderForGooglePlayProof(proof).refundEvent.tax.units,'0');
 for(const state of ['PENDING_REFUND','PARTIALLY_REFUNDED']){
  const f=fixture({body:orderBody({state,orderHistory:{partialRefundEvents:[{createTime:new Date(providerNow-1000).toISOString(),processTime:new Date(providerNow).toISOString(),state:'PROCESSED_SUCCESSFULLY',refundDetails:{total:eur(1)}}]}})}),p=await f.client.getOrder({orderId});
  assert.equal(orderForGooglePlayProof(p).partialRefundEvents[0].total.units,'1');assert.throws(()=>reversalForGooglePlayProof(p),{code:'play_reversal_proof'});
 }
});
test('Orders rejects mismatched ID, SKU, quantities, rental, unsupported currency and bad money',async()=>{
 for(const delta of [{orderId:'different'},{lineItems:[{productId:'wrong',oneTimePurchaseDetails:{quantity:1}}]},{lineItems:[{productId:'rig_credit_5',oneTimePurchaseDetails:{quantity:2}}]},{lineItems:[{productId:'rig_credit_5',oneTimePurchaseDetails:{quantity:1,rentalDetails:{}}}]},{total:{currencyCode:'USD',units:'5'}},{tax:eur(0,-1)},{total:eur(1,1000000000)},{state:'UNKNOWN'}])await assert.rejects(fixture({body:orderBody(delta)}).client.getOrder({orderId}));
});
test('refund performs fresh bound read then exactly one POST, including concurrent and uncertain attempts',async()=>{
 const f=fixture({refundStatus:503}),tokenHash=await playSha256(rawToken);
 const results=await Promise.allSettled([f.client.refundOrder({orderId,tokenHash,attemptId}),f.client.refundOrder({orderId,tokenHash,attemptId})]);
 assert.equal(results.filter(x=>x.status==='fulfilled'&&x.value.state==='uncertain').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);assert.deepEqual(f.calls.map(x=>x.method),['GET','POST']);assert.ok(f.calls[1].url.endsWith(':refund?revoke=true'));
 await assert.rejects(f.client.refundOrder({orderId,tokenHash,attemptId}),{code:'play_refund_reconcile'});assert.equal(f.calls.length,2);
 const wrong=fixture();await assert.rejects(wrong.client.refundOrder({orderId,tokenHash:'a'.repeat(64),attemptId}),{code:'play_refund_binding'});assert.deepEqual(wrong.calls.map(x=>x.method),['GET']);
});
test('already refunded and pending-refund orders do not issue another financial write',async()=>{
 for(const [state,result]of [['REFUNDED','already_reversed'],['PENDING_REFUND','pending']]){
  const f=fixture({body:orderBody({state})});assert.equal((await f.client.refundOrder({orderId,tokenHash:await playSha256(rawToken),attemptId})).state,result);assert.deepEqual(f.calls.map(x=>x.method),['GET']);
 }
});
test('voided pull uses documented 30-day seen window/pagination, private single-quantity reversal proofs',async()=>{
 const body={voidedPurchases:[{purchaseToken:rawToken,orderId,purchaseTimeMillis:String(providerNow-10000),voidedTimeMillis:String(providerNow-1000),voidedSource:2,voidedReason:7}],tokenPagination:{nextPageToken:'opaque+/cursor='}},f=fixture({body});
 const page=await f.client.listVoided({startTime:providerNow-86400000,endTime:providerNow});assert.equal(page.proofs.length,1);assert.equal(page.nextPageToken,'opaque+/cursor=');assert.equal(reversalForGooglePlayProof(page.proofs[0]).reason,'voided');assert.ok(!JSON.stringify(page).includes(rawToken));
 const query=new URL(f.calls[0].url).searchParams;assert.equal(query.get('type'),'0');assert.equal(query.get('includeQuantityBasedPartialRefund'),'true');assert.equal(query.get('pageSelection.maxResults'),'100');
 await assert.rejects(f.client.listVoided({startTime:providerNow-31*86400000,endTime:providerNow}),{code:'play_voided_input'});
 await f.client.listVoided({startTime:providerNow-31*86400000,endTime:providerNow,pageToken:'opaque+/cursor='});assert.equal(new URL(f.calls.at(-1).url).searchParams.get('pageSelection.token'),'opaque+/cursor=');
 const multi=fixture({body:{voidedPurchases:[{...body.voidedPurchases[0],voidedQuantity:2}]}});await assert.rejects(multi.client.listVoided({startTime:providerNow-1000,endTime:providerNow}),{code:'play_voided_response'});
});
test('Publisher disabled/default and redirects cannot cause refunds, proof or credential disclosure',async()=>{
 const disabled=createGooglePlayPublisherClient({get getAccessToken(){throw Error('secret read')}});await assert.rejects(disabled.getOrder({orderId}),{code:'play_publisher_setup'});
 const f=fixture({response:()=>new Response(null,{status:302})});await assert.rejects(f.client.getOrder({orderId}));assert.deepEqual(f.calls.map(x=>x.method),['GET']);
});
