import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayPushAuthenticator,GOOGLE_PLAY_PUSH_JWKS_URL} from './google-play-push-auth.mjs';
import {decodeGooglePlayRtdn,tokenForGooglePlayNotification} from './google-play-rtdn.mjs';
import {providerNow,providerEmail,providerAudience,providerSubscription,providerKeys,signedPush,rtdnEnvelope} from './google-play-provider-fixture.mjs';

test('Google Pub/Sub OIDC requires real RS256 and exact audience/verified service account; cache bounded keys',async()=>{
 const f=await providerKeys();let calls=0;
 const auth=createGooglePlayPushAuthenticator({enabled:true,audience:providerAudience,email:providerEmail,now:()=>providerNow,network:async(url,options)=>{calls++;assert.equal(url,GOOGLE_PLAY_PUSH_JWKS_URL);assert.equal(options.redirect,'manual');return Response.json({keys:[f.jwk]},{headers:{'cache-control':'public, max-age=600'}})}});
 const jwt=await signedPush();assert.equal((await auth.verifyAuthorization(jwt)).email,providerEmail);await auth.verifyAuthorization(jwt);assert.equal(calls,1);
 for(const claims of [{aud:providerAudience+'other'},{email:'other@rig-fixture.iam.gserviceaccount.com'},{email_verified:'true'},{iss:'https://attacker.invalid'},{exp:Math.floor(providerNow/1000)},{iat:Math.floor(providerNow/1000)+1000},{sub:'not-google-subject'},{aud:[providerAudience]}])await assert.rejects(auth.verifyAuthorization(await signedPush({claims})),{code:'play_push_auth'});
 for(const header of [{alg:'none'},{alg:'HS256'},{jku:'https://attacker.invalid'},{kid:'unknown-key'}])await assert.rejects(auth.verifyAuthorization(await signedPush({header})),{code:'play_push_auth'});
 assert.equal(calls,1,'unknown kids do not cause attacker-controlled key refresh storms');
 const broken=jwt.slice(0,-2)+(jwt.endsWith('AA')?'BB':'AA');await assert.rejects(auth.verifyAuthorization(broken),{code:'play_push_auth'});
});
test('OIDC rejects redirected/malformed JWKS and disabled auth never trusts a Google-looking payload',async()=>{
 await assert.rejects(createGooglePlayPushAuthenticator().verifyAuthorization(await signedPush()),{code:'play_push_setup'});
 for(const network of [async()=>new Response(null,{status:302}),async()=>Response.json({keys:[]}),async()=>{throw Error('raw-private-provider-detail')}]){
  const auth=createGooglePlayPushAuthenticator({enabled:true,audience:providerAudience,email:providerEmail,network,now:()=>providerNow});await assert.rejects(auth.verifyAuthorization(await signedPush()),e=>e.code==='play_push_auth'&&!String(e).includes('private-provider'));
 }
});
test('RTDN decodes a bounded fixed-package message, keeps raw token out of inbox descriptor, requires fresh provider read',async()=>{
 const envelope=rtdnEnvelope({oneTimeProductNotification:{version:'1.0',notificationType:1,sku:'rig_credit_5',purchaseToken:'fixture-private-token'}});
 const event=await decodeGooglePlayRtdn(envelope,{subscription:providerSubscription,now:()=>providerNow});assert.equal(event.kind,'purchased');assert.equal(event.requiresProviderRead,true);assert.match(event.tokenHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(event).includes('fixture-private-token'));assert.equal(tokenForGooglePlayNotification(event),'fixture-private-token');
 assert.throws(()=>tokenForGooglePlayNotification(JSON.parse(JSON.stringify(event))),{code:'play_rtdn_descriptor'});
 const duplicate=await decodeGooglePlayRtdn(envelope,{subscription:providerSubscription,now:()=>providerNow});assert.equal(event.messageKey,duplicate.messageKey);assert.equal(event.payloadHash,duplicate.payloadHash);
});
test('RTDN wrong subscription/package, mixed variants, unsupported SKU/base64, future timestamps fail closed',async()=>{
 const base={oneTimeProductNotification:{version:'1.0',notificationType:2,sku:'rig_credit_5',purchaseToken:'fixture-private-token'}};
 const options={subscription:providerSubscription,now:()=>providerNow};
 for(const envelope of [rtdnEnvelope(base,{subscription:'projects/other/subscriptions/other'}),rtdnEnvelope({...base,packageName:'attacker.app'}),rtdnEnvelope({...base,testNotification:{version:'1.0'}}),rtdnEnvelope({oneTimeProductNotification:{...base.oneTimeProductNotification,sku:'rogue'}}),rtdnEnvelope({...base,eventTimeMillis:String(providerNow+300001)}),{...rtdnEnvelope(base),message:{messageId:'message-1',data:'not base64'}}])await assert.rejects(decodeGooglePlayRtdn(envelope,options),{code:'play_rtdn_input'});
 const cancel=await decodeGooglePlayRtdn(rtdnEnvelope(base),options);assert.equal(cancel.kind,'cancelled');
 const voided=await decodeGooglePlayRtdn(rtdnEnvelope({voidedPurchaseNotification:{purchaseToken:'fixture-private-token',orderId:'GPA.fixture-order',productType:2,refundType:1}}),options);assert.equal(voided.kind,'voided');assert.equal(voided.requiresProviderRead,true);
 const testEvent=await decodeGooglePlayRtdn(rtdnEnvelope({testNotification:{version:'1.0'}}),options);assert.equal(testEvent.kind,'test');assert.equal(testEvent.requiresProviderRead,false);assert.equal(tokenForGooglePlayNotification(testEvent),null);
});
