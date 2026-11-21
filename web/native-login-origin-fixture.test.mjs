import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeOriginFixtureResponse} from './native-login-origin-fixture.mjs';
import {nativePkceChallenge} from './native-auth.mjs';
const origin='http://127.0.0.1:54321';
test('local browser fixture preserves the real consent HTML/CSP and changes only the referrer header',async()=>{
 const broken=await nativeOriginFixtureResponse(new Request(origin+'/broken'),{origin});
 const fixed=await nativeOriginFixtureResponse(new Request(origin+'/fixed'),{origin});
 assert.equal(broken.headers.get('referrer-policy'),'no-referrer');assert.equal(fixed.headers.get('referrer-policy'),'same-origin');assert.equal(broken.headers.get('content-security-policy'),fixed.headers.get('content-security-policy'));assert.equal(await broken.text(),await fixed.text());
});
test('strict real POST rejects opaque Origin but accepts same-origin; observations contain no form or credentials',async()=>{
 const observations=[],body='flow=app-link-v1&challenge='+await nativePkceChallenge('v'.repeat(43))+'&state='+'s'.repeat(43);
 for(const [value,status]of [['null',400],[origin,200]]){
  const response=await nativeOriginFixtureResponse(new Request(origin+'/native/authorize',{method:'POST',headers:{origin:value,'sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded'},body}),{origin,observations});assert.equal(response.status,status);
 }
 assert.deepEqual(observations,[{origin:'null',secFetchSite:'same-origin',status:400},{origin,secFetchSite:'same-origin',status:200}]);assert.doesNotMatch(JSON.stringify(observations),/challenge|code|state|cookie|token/);
});
