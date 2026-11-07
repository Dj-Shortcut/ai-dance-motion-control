import test from 'node:test';import assert from 'node:assert/strict';import {paymentTesting} from './payment.mjs';
test('bounded body read enforces a wall-clock deadline and cancels stalled stream',async()=>{let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'))},cancel(){cancelled=true}});const req=new Request('https://rig.test',{method:'POST',body,duplex:'half'});await assert.rejects(paymentTesting.boundedText(req,1024,20),/timeout/);assert.equal(cancelled,true)});
test('bounded body read rejects excess bytes and preserves ordinary small text',async()=>{const bad=new Request('https://rig.test',{method:'POST',body:'abcdef'});await assert.rejects(paymentTesting.boundedText(bad,5,100),/large/);const good=new Request('https://rig.test',{method:'POST',body:'ok'});assert.equal(await paymentTesting.boundedText(good,5,100),'ok')});

test('a Mollie redirect is never followed or forwarded credentials',async()=>{
 const original=globalThis.fetch;const requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,redirect:options.redirect});return new Response('',{status:302,headers:{location:'https://attacker.example/collect'}})};
 try{await assert.rejects(paymentTesting.mollie('payments','test_fake'),/Mollie error/);assert.deepEqual(requests,[{url:'https://api.mollie.com/v2/payments',redirect:'manual'}]);}finally{globalThis.fetch=original}
});
