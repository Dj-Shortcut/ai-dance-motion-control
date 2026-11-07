import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const html=await readFile('frontend/multiuser/index.html','utf8'),script=await readFile('frontend/multiuser/payments.js','utf8');
const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle')};
async function screen(checkoutUrl){
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),w=dom.window,values=new Map();let redirected=null;
 for(const dialog of w.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
 w.rigScopedStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 w.rigCheckout=url=>{redirected=url};
 w.rigRequest=async(path)=>Response.json(path==='/api/payments/packages'?{packages:[{id:'test-5',credits:500,amountCents:500}]}:path==='/api/payments/orders'?{orders:[]}:path==='/api/payments/create'?{checkoutUrl}:{balance:0});
 w.eval(script);w.document.getElementById('creditsButton').click();
 await waitFor(()=>w.document.getElementById('packageList').children.length===1&&!w.document.getElementById('packageList').children[0].disabled);
 w.document.getElementById('packageList').children[0].click();
 return {dom,w,redirected:()=>redirected};
}
test('Mollie checkout opens only after validated URL; foreign URL is refused',async()=>{
 const good=await screen('https://www.mollie.com/checkout/test-fixture');await waitFor(()=>good.redirected()!==null);
 assert.equal(good.redirected(),'https://www.mollie.com/checkout/test-fixture');
 assert.doesNotMatch(good.w.document.getElementById('creditsMessage').textContent,/betaling verwerkt/i);
 const bad=await screen('https://mollie.com.evil.invalid/checkout');await waitFor(()=>bad.w.document.getElementById('creditsMessage').textContent.includes('kon niet worden gecontroleerd'));
 assert.equal(bad.redirected(),null);good.dom.window.close();bad.dom.window.close();
});
