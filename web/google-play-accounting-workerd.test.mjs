// Real isolated D1, synthetic provider responses, no Google/Fal/mail requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayAccounting} from './google-play-accounting.mjs';
import {googlePlayFulfillmentFixture,USER,OTHER,sealedToken} from './google-play-fulfillment-fixture.mjs';
const origin='https://rig.example',money=(units,nanos=0)=>({currencyCode:'EUR',units:String(units),nanos});
const financial={version:1,source:'google_order_v1',mode:'live',productId:'rig_credit_5',orderId:'GPA.1234-5678-9012-34567',state:'PROCESSED',currency:'EUR',total:money(9),tax:money(1,500000000),developerRevenueInBuyerCurrency:money(6),partialRefundEvents:[]};
function handler(f){
 const env={DB:{testOnly:true},PRODUCTION_DB:f.db,RIG_PRODUCTION_OWNER_USER_ID:USER};
 const handle=createGooglePlayAccounting({tenant:async()=>({DB:f.db,RIG_MODE:'live',RIG_PUBLIC_ORIGIN:origin}),limiter:async()=>true});
 return (path='/api/owner/accounting/google-play',userId=USER)=>handle(new Request(origin+path),env,{userId});
}
test('real atomic Google grant is reported exactly once without creating Mollie orders, invoices or accounting writes',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const intent=await f.prepare(),p=await f.inspect();assert.equal((await f.grant(intent.intentId,p.proof,{financial})).state,'credited');
  const before=await f.counts(),request=handler(f),response=await request(),value=await response.json();assert.equal(response.status,200);assert.equal(value.receiptCount,1);assert.equal(value.creditEventCount,1);assert.equal(value.issuedCreditCents,500);assert.equal(value.providerGross.amount.decimal,'9.000000000');assert.equal(value.providerTax.amount.decimal,'1.500000000');assert.equal(value.providerDeveloperRevenue.amount.decimal,'6.000000000');assert.equal(value.providerFeesDerived.amount.decimal,'1.500000000');assert.equal(value.purchases[0].consumed,false);
  const text=await(await request('/api/owner/accounting/export/google-play.csv')).text();assert.doesNotMatch(text,new RegExp(p.token));assert.doesNotMatch(text,new RegExp(sealedToken));const receipt=await f.store.getReceipt(value.purchases[0].receiptReference.slice(3));assert.doesNotMatch(text,new RegExp(receipt.account_id));assert.match(text,/rig-credit-issued/);assert.deepEqual(await f.counts(),before);assert.equal(before.orders,0);assert.equal(before.ledger,1);assert.equal((await request(undefined,OTHER)).status,403);
 }finally{await f.mf.dispose()}
});
test('real verified reversal exports full wallet reversal without fabricating a cash refund or changing original fees',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),p=await f.inspect();await f.grant(i.intentId,p.proof,{financial});const returned=await f.inspect({token:p.token,refundableQuantity:0});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:returned.proof,sealedToken});
  const request=handler(f),value=await(await request()).json();assert.equal(value.issuedCreditCents,500);assert.equal(value.reversedCreditCents,500);assert.equal(value.providerFeesDerived.amount.decimal,'1.500000000');assert.equal(value.providerVerifiedCashRefunds.amount,null);assert.equal(value.providerVerifiedCashRefunds.unknownCount,1);assert.equal(value.purchases[0].verifiedCashRefund,null);assert.equal(value.actualBankPayout,null);assert.equal(value.invoiceCreated,false);assert.equal(value.purchases[0].state,'reversed');
  const receipt=await f.db.prepare('SELECT token_hash FROM rig_google_play_receipts').first();await f.db.prepare('UPDATE rig_google_play_receipts SET finance_json=? WHERE token_hash=?').bind(JSON.stringify({...financial,state:'REFUNDED',developerRevenueInBuyerCurrency:money(0),refundEvent:{total:money(9)},partialRefundEvents:[]}),receipt.token_hash).run();
  const refunded=await(await request()).json();assert.equal(refunded.providerGross.amount.decimal,'9.000000000');assert.equal(refunded.providerDeveloperRevenue.amount.decimal,'6.000000000');assert.equal(refunded.providerVerifiedCashRefunds.amount.decimal,'9.000000000');assert.equal(refunded.purchases[0].latestGoogleDeveloperRevenue.decimal,'0.000000000');assert.equal((await f.counts()).ledger,2);
 }finally{await f.mf.dispose()}
});
test('real D1 calendar filter selects the receipt, claim and reversal independently',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),p=await f.inspect();await f.grant(i.intentId,p.proof,{financial});const returned=await f.inspect({token:p.token,refundableQuantity:0});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:returned.proof,sealedToken});
  await f.db.prepare('UPDATE rig_google_play_receipts SET created_at=?').bind(Date.parse('2026-02-28T23:00:00Z')).run();await f.db.prepare('UPDATE rig_google_play_credit_claims SET created_at=?').bind(Date.parse('2026-03-31T22:00:00Z')).run();await f.db.prepare('UPDATE rig_google_play_reversals SET created_at=?').bind(Date.parse('2026-04-30T22:00:00Z')).run();
  const request=handler(f),march=await(await request('/api/owner/accounting/google-play?month=2026-03')).json(),april=await(await request('/api/owner/accounting/google-play?month=2026-04')).json(),may=await(await request('/api/owner/accounting/google-play?month=2026-05')).json();
  assert.equal(march.receiptCount,1);assert.equal(march.issuedCreditCents,0);assert.equal(march.reversedCreditCents,0);assert.equal(april.receiptCount,0);assert.equal(april.issuedCreditCents,500);assert.equal(april.reversedCreditCents,0);assert.equal(may.receiptCount,0);assert.equal(may.issuedCreditCents,0);assert.equal(may.reversedCreditCents,500);
 }finally{await f.mf.dispose()}
});
