import {test} from 'node:test';import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';import {readFileSync} from 'node:fs';
test('owner chooses file, reviews status and explicitly initiates media test; no generation request',async()=>{
 const files=new Map(),elements=new Map(),calls=[];function el(id){if(!elements.has(id))elements.set(id,{id,files:files.get(id)||[],value:'3',checked:false,disabled:false,textContent:'',addEventListener(n,fn){this[n]=fn}});return elements.get(id)}
 const ctx={document:{getElementById:el},fetch:async(path,init)=>{calls.push(path);assert.equal(init.method,'POST');assert.equal(init.headers['X-Rig-Asset-Kind'],'image');return {ok:true,json:async()=>({status:'verified',cleanup:'ok',width:640,height:480})}}};
 files.set('testFile',[new Blob(['data'],{type:'image/jpeg'})]);runInNewContext(readFileSync(new URL('./frontend/media-test.js',import.meta.url),'utf8'),ctx);assert.equal(calls.length,0);await el('testSubmit').click();assert.deepEqual(calls,['/api/media/test']);assert.match(el('testMessage').textContent,/tijdelijke bestand is verwijderd/);
});
