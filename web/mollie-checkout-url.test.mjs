import test from 'node:test';
import assert from 'node:assert/strict';
import {isMollieCheckoutURL} from './mollie-checkout-url.mjs';
const token='eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJ0ZXN0In0.c2lnbmF0dXJl';
const ppro='https://redirect.ppro.com/v0/pages/?redirection_token='+token;

test('verified Mollie checkout links and the exact processor redirect remain usable',()=>{
 for(const value of ['https://www.mollie.com/checkout/select-method/example','https://checkout.mollie.com/example','https://mollie.com/checkout/example',ppro])assert.equal(isMollieCheckoutURL(value),true,value);
});

test('checkout validation rejects spoofed hosts, unsafe schemes and alternate processor routes',()=>{
 const values=[null,{},42,'',new URL(ppro),' '+ppro,ppro+'\n',ppro.replace('https:','http:'),ppro.replace('https:','javascript:'),ppro.replace('redirect.ppro.com','redirect.ppro.com.evil.test'),ppro.replace('redirect.ppro.com','fake.ppro.com'),ppro.replace('redirect.ppro.com','redirect.ppro.com@evil.test'),ppro.replace('redirect.ppro.com','name:pass@redirect.ppro.com'),ppro.replace('redirect.ppro.com','redirect.ppro.com:444'),ppro.replace('/v0/pages/','/untrusted/'),ppro.replace('/v0/pages/','/v0/pages/../untrusted/'),ppro+'#untrusted',ppro+'&returnUrl=https://evil.test',ppro+'&redirection_token='+token,'https://redirect.ppro.com/v0/pages/','https://redirect.ppro.com/v0/pages/?redirection_token=','https://redirect.ppro.com/v0/pages/?redirection_token=opaque','https://redirect.ppro.com/v0/pages/?redirection_token='+token+'.extra','https://redirect.ppro.com/v0/pages/?redirection_token='+('a'.repeat(8192)+'.b.c'),'https://www.mollie.com.evil.test/checkout','https://www.mollie.com/checkout#untrusted'];
 for(const value of values)assert.equal(isMollieCheckoutURL(value),false,typeof value==='string'?value.slice(0,180):String(value));
});
