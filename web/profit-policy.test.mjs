import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProfitPolicy,profitPolicyRow,retailPriceCents,createProfitSnapshot,validProfitSnapshot,profitable} from './profit-policy.mjs';
const row={id:1,version:'rig-margin-2026-11-09-v1',eur_per_usd_micros:1000000,provider_vat_bps:2100,payment_fee_bps:1000,failure_buffer_bps:1000,preparation_cents:5,min_margin_bps:3000,daily_provider_limit_usd_micros:10000000,min_price_cents:100,min_pro_price_cents:125};
const policy=parseProfitPolicy(row);
test('approved rates and minima produce consistent affordable customer prices',()=>{
 for(const [quality,rate,usd,price]of [['standard',30,630000,150],['pro',40,840000,200],['edit-standard',35,700000,175]]){
  assert.equal(retailPriceCents(policy,{quality,billedSeconds:5,rateCents:rate}),price);
  const snapshot=createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:price,providerEstimateUsdMicros:usd});
  assert.equal(profitable(snapshot),true);assert.equal(snapshot.revenueCents,price);assert.equal(snapshot.marginCents,price-snapshot.estimatedCostCents);
 }
 for(const [quality,rate,usd,price]of [['standard',30,378000,100],['pro',40,504000,125],['edit-standard',35,420000,105]]){
  assert.equal(retailPriceCents(policy,{quality,billedSeconds:3,rateCents:rate}),price);
  assert.equal(profitable(createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:price,providerEstimateUsdMicros:usd})),true);
 }
 assert.equal(retailPriceCents(policy,{quality:'pro',billedSeconds:30,rateCents:40}),1200);
});
test('every supported integer duration gets the smallest safe new price, including rounding-sensitive four-second clips',()=>{
 for(const [quality,rate,usdRate,max]of [['standard',30,126000,30],['pro',40,168000,30],['edit-standard',35,140000,15]]){
  for(let billedSeconds=3;billedSeconds<=max;billedSeconds++){
   const usd=usdRate*billedSeconds,args={quality,billedSeconds,rateCents:rate,providerEstimateUsdMicros:usd};
   const base=retailPriceCents(policy,{quality,billedSeconds,rateCents:rate}),price=retailPriceCents(policy,args);
   assert.ok(price>=base);assert.ok(price<=1200);assert.equal(profitable(createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:price,providerEstimateUsdMicros:usd})),true,quality+' '+billedSeconds);
   if(price>base)assert.equal(profitable(createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:price-1,providerEstimateUsdMicros:usd})),false);
  }
 }
 assert.equal(retailPriceCents(policy,{quality:'standard',billedSeconds:4,rateCents:30,providerEstimateUsdMicros:504000}),125);
 assert.equal(retailPriceCents(policy,{quality:'pro',billedSeconds:4,rateCents:40,providerEstimateUsdMicros:672000}),163);
 assert.equal(retailPriceCents(policy,{quality:'standard',billedSeconds:5,rateCents:30,providerEstimateUsdMicros:630000}),150);
 assert.equal(retailPriceCents(policy,{quality:'pro',billedSeconds:5,rateCents:40,providerEstimateUsdMicros:840000}),200);
 assert.equal(retailPriceCents(policy,{quality:'edit-standard',billedSeconds:5,rateCents:35,providerEstimateUsdMicros:700000}),175);
});
test('a changed provider rate adjusts only a fresh quote, and impossible margin or cap fails closed',()=>{
 const args={quality:'standard',billedSeconds:5,rateCents:30,providerEstimateUsdMicros:630000};
 const first=retailPriceCents(policy,args);assert.equal(first,150);
 const newer=retailPriceCents(policy,{...args,providerEstimateUsdMicros:1500000});assert.ok(newer>first);assert.equal(profitable(createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:newer,providerEstimateUsdMicros:1500000})),true);
 assert.equal(profitable(createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:first,providerEstimateUsdMicros:1500000})),false);
 assert.throws(()=>retailPriceCents(policy,{...args,providerEstimateUsdMicros:6000000,maxPriceCents:100}));
 assert.throws(()=>retailPriceCents(parseProfitPolicy({...row,min_margin_bps:9000}),args));
 assert.equal(retailPriceCents(policy,{...args,providerEstimateUsdMicros:1500000,fundingKind:'owner-provider'}),150);
});
test('budget components round upward and unprofitable retail cannot pass',()=>{
 const snapshot=createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:100,providerEstimateUsdMicros:700000});
 assert.equal(snapshot.providerNetCostCents,70);assert.equal(snapshot.providerVatReserveCents,15);assert.equal(snapshot.providerCostCents,85);
 assert.equal(snapshot.failureReserveCents,9);assert.equal(snapshot.paymentFeeReserveCents,10);assert.equal(snapshot.estimatedCostCents,109);assert.equal(snapshot.marginCents,-9);assert.equal(profitable(snapshot),false);
 const owner=createProfitSnapshot({policy,fundingKind:'owner-provider',retailPriceCents:100,providerEstimateUsdMicros:700000});
 assert.equal(owner.revenueCents,0);assert.equal(owner.paymentFeeReserveCents,0);assert.equal(owner.marginCents,-99);assert.equal(owner.marginBps,null);assert.equal(profitable(owner),true);
});
test('a cost snapshot binds every assumption, funding and exact confirmed retail price',()=>{
 const args={policy,fundingKind:'credits',retailPriceCents:175,providerEstimateUsdMicros:700000},snapshot=createProfitSnapshot(args);
 assert.equal(validProfitSnapshot(snapshot,args),true);
 for(const key of Object.keys(snapshot))assert.equal(validProfitSnapshot({...snapshot,[key]:snapshot[key]===null?0:typeof snapshot[key]==='number'?snapshot[key]+1:String(snapshot[key])+'x'},args),false,key);
 assert.equal(validProfitSnapshot({...snapshot,actualCostCents:0},args),false);
 assert.equal(validProfitSnapshot(snapshot,{...args,policy:parseProfitPolicy({...row,version:'revised-v2'})}),false);
 assert.equal(validProfitSnapshot(snapshot,{...args,fundingKind:'owner-provider'}),false);
 assert.equal(validProfitSnapshot(null,args),false);
});
test('missing or malformed policy and invalid values fail closed instead of inventing costs',()=>{
 assert.deepEqual(profitPolicyRow(policy),row);
 for(const changed of [null,{...row,id:2},{...row,version:''},{...row,eur_per_usd_micros:0},{...row,provider_vat_bps:-1},{...row,daily_provider_limit_usd_micros:0},{...row,min_pro_price_cents:NaN}])assert.throws(()=>parseProfitPolicy(changed));
 for(const usd of [0,-1,0.1,6000001,Number.MAX_SAFE_INTEGER])assert.throws(()=>createProfitSnapshot({policy,fundingKind:'credits',retailPriceCents:175,providerEstimateUsdMicros:usd}));
 assert.throws(()=>createProfitSnapshot({policy,fundingKind:'forged',retailPriceCents:175,providerEstimateUsdMicros:700000}));
});
