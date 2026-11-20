import test from 'node:test';
import assert from 'node:assert/strict';
import {assetLinks} from './assetlinks.mjs';

test('Digital Asset Links trust only the pinned package and exact full public certificate',()=>{
 const fingerprint=Array.from({length:32},(_,i)=>i.toString(16).padStart(2,'0')).join(':');
 assert.deepEqual(assetLinks(fingerprint),[{relation:['delegate_permission/common.get_login_creds'],target:{namespace:'android_app',package_name:'dev.andyarijs.rig',sha256_cert_fingerprints:[fingerprint.toUpperCase()]}}]);
});
test('reject incomplete fingerprints, private-key material and injected JSON/relations',()=>{
 for(const input of [undefined,'','AB:CD','ab'.repeat(32),'-----BEGIN '+'PRIVATE KEY-----',Array(33).fill('AB').join(':'),Array(32).fill('GG').join(':'),Array(32).fill('AB').join(':')+'\n',Array(32).fill('AB').join(':')+'\",\"relation\":[]'])assert.throws(()=>assetLinks(input));
});
