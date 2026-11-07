import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerText,providerJSON} from './provider-response.mjs';

test('provider metadata enforces a streaming byte limit and does not trust content-length',async()=>{
 assert.deepEqual(await providerJSON(Response.json({request_id:'ok'}),{limit:128}),{request_id:'ok'});
 let canceled=false;
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(129));},cancel(){canceled=true}});
 await assert.rejects(providerText(new Response(stream,{headers:{'content-length':'1'}}),{limit:128}));
 assert.equal(canceled,true);
 await assert.rejects(providerText(new Response('x',{headers:{'content-length':'129'}}),{limit:128}));
 await assert.rejects(providerText(new Response(new Uint8Array([255])),{limit:128}));
});
test('a stalled provider body is canceled on the request deadline',async()=>{
 let canceled=false;
 const stream=new ReadableStream({pull(){return new Promise(()=>{})},cancel(){canceled=true}});
 const controller=new AbortController();const read=providerText(new Response(stream),{signal:controller.signal});
 controller.abort();await assert.rejects(read,/timeout/);assert.equal(canceled,true);
});

test('an already expired signal rejects even when the full body is immediately readable',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(providerText(new Response('{"request_id":"ok"}'),{signal:controller.signal}),/timeout/);
});
test('expiration while the final chunk is delivered cannot produce a successful result',async()=>{
 const controller=new AbortController();
 const stream=new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode('{"request_id":"ok"}'));controller.abort();c.close()}});
 await assert.rejects(providerText(new Response(stream),{signal:controller.signal}),/timeout/);
});
