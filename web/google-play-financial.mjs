// Trusted Google Orders data only. Wallet value is not a sale price, Google
// developer revenue is not a bank payout, and no Mollie invoice is fabricated.
import {orderForGooglePlayProof} from './google-play-publisher.mjs';
const supported=new Map([['rig_credit_5',500],['rig_credit_10',1000],['rig_credit_25',2500]]);
const fail=()=>Object.assign(Error('Google Play-prijzen zijn nog niet ingesteld.'),{code:'play_price_policy'});
export function googlePlaySalePolicy(value){
 if(typeof value!=='string'||value.length>4096)throw fail();let data;try{data=JSON.parse(value)}catch{throw fail()}
 if(data?.version!=='rig-play-prices-v1'||data.currency!=='EUR'||!Array.isArray(data.products)||data.products.length!==3||Object.keys(data).sort().join(',')!=='currency,products,version')throw fail();
 const products=data.products.map(p=>{if(!p||Object.keys(p).sort().join(',')!=='creditsCents,priceCents,productId'||supported.get(p.productId)!==p.creditsCents||!Number.isSafeInteger(p.priceCents)||p.priceCents<p.creditsCents||p.priceCents>100000)throw fail();return Object.freeze({...p})});
 if(new Set(products.map(p=>p.productId)).size!==3)throw fail();return Object.freeze({version:data.version,currency:'EUR',products:Object.freeze(products)});
}
function nanos(money){
 if(!money||money.currencyCode!=='EUR'||typeof money.units!=='string'||! /^-?(?:0|[1-9]\d{0,17})$/.test(money.units)||!Number.isSafeInteger(money.nanos)||Math.abs(money.nanos)>999999999)throw fail();
 return BigInt(money.units)*1000000000n+BigInt(money.nanos);
}
export function googlePlayFinancialDecision(proof,{tokenHash,productId,mode,policy}={}){
 const o=orderForGooglePlayProof(proof),p=policy?.products?.find(p=>p.productId===productId);
 if(!p||o.tokenHash!==tokenHash||o.productId!==productId||o.mode!==mode||o.quantity!==1)throw fail();
 const record=Object.freeze({version:1,source:'google_order_v1',orderId:o.orderId,productId,mode,currency:'EUR',state:o.state,verifiedAt:o.verifiedAt,total:o.total,tax:o.tax,developerRevenueInBuyerCurrency:o.developerRevenueInBuyerCurrency,lineTotal:o.lineTotal,lineTax:o.lineTax,buyerCountry:o.buyerCountry,taxInclusive:o.taxInclusive,refundEvent:o.refundEvent,partialRefundEvents:o.partialRefundEvents,settlementVerified:false});
 if(o.state==='REFUNDED'||o.state==='CANCELED')return {state:'reversed',record};
 if(o.state!=='PROCESSED'||!o.developerRevenueInBuyerCurrency)return {state:'review',record};
 const gross=nanos(o.total),net=nanos(o.developerRevenueInBuyerCurrency),tax=o.tax?nanos(o.tax):null,line=nanos(o.lineTotal);
 // One-time credits have one fixed EUR offer. Actual net after Google's taxes
 // and fees must cover the entire wallet credit, preserving the existing video
 // margin policy. Browser prices or assumed Google fee rates cannot authorize it.
 const credit=BigInt(p.creditsCents)*10000000n,approved=BigInt(p.priceCents)*10000000n;
 if(gross<0n||net<0n||net>gross||tax!==null&&(tax<0n||tax>gross)||line!==gross||gross!==approved||net<credit)return {state:'refund',record};
 return {state:'credit',record};
}
