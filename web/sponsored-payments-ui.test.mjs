import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const script=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI did not settle')};
test('sponsor badge uses only the bounded gift remainder and never opens Mollie packages',async()=>{
 const dom=new JSDOM(html,{url:'https://rig.local/',runScripts:'outside-only'}),w=dom.window,d=w.document,calls=[];let resolveOld;
 try{
  for(const e of d.querySelectorAll('dialog')){e.showModal=function(){this.open=true};e.close=function(){this.open=false};}
  if(!d.getElementById('creditExplanation')){const p=d.createElement('p');p.id='creditExplanation';d.getElementById('creditsDialog').append(p)}
  w.rigVideoFunding='owner';w.rigScopedStorage={getItem:()=>null,setItem(){},removeItem(){}};
  w.rigRequest=async path=>{calls.push(path);if(path==='/api/payments/balance')return await new Promise(resolve=>{resolveOld=()=>resolve({ok:true,json:async()=>({balance:99999})})});if(path==='/api/sponsor-invitations/status')return {ok:true,json:async()=>({state:'eligible',remainingCents:235})};throw Error('unexpected payment request')};
  w.eval(script);await waitFor(()=>typeof resolveOld==='function');w.rigVideoFunding='sponsored';d.dispatchEvent(new w.Event('rig-video-availability'));
  await waitFor(()=>d.getElementById('creditsButton').textContent.includes('2,35'));resolveOld();await new Promise(r=>setTimeout(r,10));
  assert.match(d.getElementById('creditsButton').textContent,/Gratis RIG-tegoed.*2,35/);assert.doesNotMatch(d.getElementById('creditsButton').textContent,/999/);
  d.getElementById('creditsButton').click();await waitFor(()=>d.getElementById('creditsMessage').textContent.includes('2,35'));
  assert.match(d.getElementById('creditExplanation').textContent,/Gratis RIG-tegoed.*betaalt niets.*maker betaalt/);
  assert.equal(d.getElementById('packageList').children.length,0);assert.equal(d.getElementById('refreshPayment').hidden,true);assert.equal(d.getElementById('resumePayment').hidden,true);
  assert.equal(calls.some(path=>path==='/api/payments/packages'||path==='/api/payments/create'),false);
 }finally{dom.window.close()}
});
