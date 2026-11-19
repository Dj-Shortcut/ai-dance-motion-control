import test from 'node:test';
import assert from 'node:assert/strict';
import {googlePlaySalePolicy,googlePlayFinancialDecision} from './google-play-financial.mjs';
import {createGooglePlayPublisherClient} from './google-play-publisher.mjs';
import {playSha256} from './google-play-provider-common.mjs';
const token='fixture-financial-token',orderId='GPA.1111-2222-3333-44444',at=Date.parse('2026-11-19T12:00:00Z');
const policy=googlePlaySalePolicy(JSON.stringify({version:'rig-play-prices-v1',currency:'EUR',products:[{productId:'rig_credit_5',creditsCents:500,priceCents:899},{productId:'rig_credit_10',creditsCents:1000,priceCents:1799},{productId:'rig_credit_25',creditsCents:2500,priceCents:4499}]}));
const money=(units,nanos=0)=>({currencyCode:'EUR',units,nanos});
async function decision(mutate=()=>{}){
 const body={orderId,purchaseToken:token,state:'PROCESSED',createTime:'2026-11-19T11:59:00Z',lastEventTime:'2026-11-19T11:59:00Z',total:money('8',990000000),tax:money('1',560330579),developerRevenueInBuyerCurrency:money('5',200000000),lineItems:[{productId:'rig_credit_5',total:money('8',990000000),oneTimePurchaseDetails:{quantity:1}}]};mutate(body);
 const client=createGooglePlayPublisherClient({enabled:true,mode:'live',now:()=>at,getAccessToken:async()=> 'fixture_access_token_123456789',network:async()=>Response.json(body)});
 return googlePlayFinancialDecision(await client.getOrder({orderId}),{tokenHash:await playSha256(token),productId:'rig_credit_5',mode:'live',policy});
}
test('only exact owner-approved EUR catalog values are accepted',()=>{
 assert.equal(policy.products.length,3);assert.equal(policy.products[0].priceCents,899);
 for(const bad of ['', '{}',JSON.stringify({...policy,currency:'USD'}),JSON.stringify({...policy,products:policy.products.map((p,i)=>i?p:{...p,creditsCents:99999})}),JSON.stringify({...policy,products:policy.products.map((p,i)=>i?p:{...p,priceCents:499})})])assert.throws(()=>googlePlaySalePolicy(bad));
});
test('actual Google net revenue covers face credit, retaining exact Money and unknown bank settlement',async()=>{
 const result=await decision();assert.equal(result.state,'credit');assert.equal(result.record.tax.nanos,560330579);assert.equal(result.record.developerRevenueInBuyerCurrency.units,'5');assert.equal(result.record.settlementVerified,false);assert.equal(result.record.source,'google_order_v1');
 assert.equal((await decision(b=>{b.developerRevenueInBuyerCurrency=money('4',999999999)})).state,'refund');
 assert.equal((await decision(b=>{b.developerRevenueInBuyerCurrency=money('5')})).state,'credit');
});
test('missing or pending money is reviewed; unexpected offer prices or impossible totals are refunded',async()=>{
 assert.equal((await decision(b=>{delete b.developerRevenueInBuyerCurrency})).state,'review');
 for(const state of ['PENDING','PENDING_REFUND','PARTIALLY_REFUNDED'])assert.equal((await decision(b=>{b.state=state})).state,'review');
 assert.equal((await decision(b=>{b.total=money('9');b.lineItems[0].total=b.total})).state,'refund');
 assert.equal((await decision(b=>{b.developerRevenueInBuyerCurrency=money('10')})).state,'refund');
 for(const state of ['REFUNDED','CANCELED'])assert.equal((await decision(b=>{b.state=state})).state,'reversed');
});
test('financial JSON copies and browser amounts are not Google authority',()=>{
 assert.throws(()=>googlePlayFinancialDecision({order:{total:money('99999')}},{policy}));
});
