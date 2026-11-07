import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('status refresh updates balance after a payment completed in another session', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent:'', hidden:false, children:[], listeners:{},
      addEventListener(type, handler){this.listeners[type]=handler},
      replaceChildren(){this.children=[]}, appendChild(child){this.children.push(child)},
      showModal(){}
    });
    return elements.get(id);
  }
  let balanceCalls=0;
  const context={
    document:{getElementById:element,createElement:()=>element('unused'),addEventListener(){}},
    location:{href:'https://rig.example/',assign(){}}, URL, Intl,
    sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    fetch:async path=>{
      if(path==='/api/payments/balance')return {ok:true,json:async()=>({balance:balanceCalls++ === 0?0:500,frozen:false})};
      if(path==='/api/payments/orders')return {ok:true,json:async()=>({orders:[{state:'paid',requestId:'request_12345678'}]})};
      throw Error('Unexpected request: '+path);
    }
  };
  runInNewContext(readFileSync(new URL('./frontend/payments.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('creditsButton').textContent,/0,00/);
  await element('refreshPayment').listeners.click();
  assert.match(element('creditsButton').textContent,/5,00/);
  assert.equal(balanceCalls,2);
});

test('generation and returning to the page refresh the visible balance without letting older requests overwrite it', async () => {
  const elements=new Map(), listeners=new Map(), requests=[];
  function element(id) {
    if(!elements.has(id))elements.set(id,{textContent:'',children:[],addEventListener(){},showModal(){},replaceChildren(){}});
    return elements.get(id);
  }
  const document={getElementById:element,createElement:()=>element('new'),visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn)};
  const context={document,location:{href:'https://rig.example/'},URL,Intl,sessionStorage:{getItem:()=>null},fetch:path=>{
    assert.equal(path,'/api/payments/balance');return new Promise(resolve=>requests.push(balance=>resolve({ok:true,json:async()=>({balance})})));
  }};
  runInNewContext(readFileSync(new URL('./frontend/payments.js',import.meta.url),'utf8'),context);
  requests[0](1000);await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('creditsButton').textContent,/10,00/);
  listeners.get('rig-balance-changed')();
  listeners.get('visibilitychange')();
  requests[2](820);await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('creditsButton').textContent,/8,20/);
  requests[1](1000);await new Promise(resolve=>setImmediate(resolve));
  assert.match(element('creditsButton').textContent,/8,20/);
});
