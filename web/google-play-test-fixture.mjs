// Synthetic helper shared by offline verifier and actual-D1 adapter tests.
import assert from 'node:assert/strict';
import {createGooglePlayPurchaseVerifier,googlePlayAccountId,GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
export const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
export const now=Date.parse('2026-11-19T12:00:00Z'),key='fixture-account-binding-key-never-a-real-key',siteId='appgprj_fixture_rig',token='fixture-google-purchase-token-1234567890';
export const catalog=[{productId:'rig_credit_5',creditsCents:500},{productId:'rig_credit_10',creditsCents:1000},{productId:'rig_credit_25',creditsCents:2500}];
export async function purchaseFixture({mode='live',mutate=()=>{},response,consumeResponse,networkError=false}={}){
 const accountId=await googlePlayAccountId({key,userId:USER,siteId,mode}),calls=[];
 const body={kind:'androidpublisher#productPurchaseV2',obfuscatedExternalAccountId:accountId,purchaseStateContext:{purchaseState:'PURCHASED'},productLineItem:[{productId:'rig_credit_5',productOfferDetails:{quantity:1,refundableQuantity:1,consumptionState:'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'}}],purchaseCompletionTime:'2026-11-19T11:59:00Z',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',...(mode==='test'?{testPurchaseContext:{fopType:'TEST'}}:{})};mutate(body);
 const verifier=createGooglePlayPurchaseVerifier({enabled:true,mode,accountKey:key,siteId,catalog,now:()=>now,getAccessToken:async()=> 'fixture_access_token_123456789',network:async(url,init)=>{
  assert.ok(url.startsWith('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/'+GOOGLE_PLAY_PACKAGE+'/'));
  assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture_access_token_123456789');assert.equal(init.body,undefined);
  calls.push({url,method:init.method});if(networkError)throw Error('must not leak '+token);
  return init.method==='POST'?(consumeResponse?consumeResponse():new Response(null,{status:204})):(response?response():Response.json(body));
 }});
 return {verifier,input:{userId:USER,productId:'rig_credit_5',purchaseToken:token},body,calls,accountId};
}
