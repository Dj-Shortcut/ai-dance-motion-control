import test from 'node:test';
import assert from 'node:assert/strict';
import {createRigSitesApp} from './rig-sites-app.mjs';
const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site';
const bridge='https://rig-chatgpt-ingress.shortcut-computerguy.workers.dev';
const owner='u-63e2e668-eeb1-43af-a35c-6998a1de7879';
const env={RIG_SITES_PRODUCER_ORIGIN:origin,RIG_SITES_BRIDGE_ORIGIN:bridge,RIG_SITES_PROJECT_ID:'appgprj_6aeec13b50448191b88da670dac8aa98',RIG_SITES_BRIDGE_KEY:'a'.repeat(64),RIG_EDIT_ENABLED:'yes'};
function fixture(){const calls=[];let approvalStatus=201;const app=createRigSitesApp({uiFiles:{'/multiuser/index.html':'<h1>RIG</h1>'},fetchImpl:async req=>{calls.push(req);assert.equal(new URL(req.url).origin,bridge);assert.equal(req.headers.get('authorization'),null);assert.equal(req.headers.get('cookie'),null);assert.equal(req.headers.get('oai-authenticated-user-id'),null);assert.match(req.headers.get('x-rig-sites-signature'),/^[a-f0-9]{64}$/);const path=new URL(req.url).pathname;if(path==='/api/session')return Response.json({userId:owner,balanceCents:500,frozen:false});if(path==='/api/generation-quotes')return Response.json({id:'abc',priceCents:100,currency:'EUR'},{status:201});if(path==='/api/chatgpt/quote-approvals')return Response.json(approvalStatus===201?{approvalToken:'A'.repeat(43),idempotencyKey:'rigchatgpt_abc'}:{error:'Insufficient'},{status:approvalStatus});return Response.json({enabled:true,funding:'owner'})}});return {app,calls,setApprovalStatus:value=>{approvalStatus=value}};}
const request=(path,options={})=>new Request(origin+path,options);
const identity={'oai-authenticated-user-id':'native-subject','x-rig-expected-user':owner};
test('native API refuses anonymous callers and account changes before write dispatch',async()=>{
 const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/video-config'),env)).status,401);assert.equal(calls.length,0);
 const headers={...identity,origin,'content-type':'application/json','x-rig-expected-user':'u-00000000-0000-4000-8000-000000000000'};
 assert.equal((await app.fetch(request('/api/generations',{method:'POST',headers,body:'{}'}),env)).status,403);assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).pathname,'/api/session');
});
test('browser writes require same origin and bound account, and cannot mint approvals directly',async()=>{
 for(const headers of [identity,{...identity,origin:'https://evil.invalid'},{'oai-authenticated-user-id':'native-subject',origin}]){const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/generations',{method:'POST',headers,body:'{}'}),env)).status,403);assert.ok(calls.length<=1)}
 const {app,calls}=fixture();assert.equal((await app.fetch(request('/api/chatgpt/quote-approvals',{method:'POST',headers:{...identity,origin},body:'{}'}),env)).status,404);assert.equal(calls.length,0);
});
test('native quotes receive an account-bound confirmation and never leak client credentials to relay',async()=>{
 const {app,calls}=fixture();const response=await app.fetch(request('/api/generation-quotes',{method:'POST',headers:{...identity,origin,'content-type':'application/json',authorization:'Bearer browser-value',cookie:'secret=value'},body:'{}'}),env);
 assert.equal(response.status,201);assert.deepEqual(await response.json(),{id:'abc',priceCents:100,currency:'EUR',approvalToken:'A'.repeat(43),idempotencyKey:'rigchatgpt_abc'});assert.equal(calls.length,3);
});
test('over-budget quote remains visible without a generation capability',async()=>{
 const {app,setApprovalStatus}=fixture();setApprovalStatus(409);const response=await app.fetch(request('/api/generation-quotes',{method:'POST',headers:{...identity,origin},body:'{}'}),env);assert.equal(response.status,201);assert.deepEqual(await response.json(),{id:'abc',priceCents:100,currency:'EUR'});
});
test('native Site reuses central balance but exposes no checkout path',async()=>{
 const {app}=fixture();const response=await app.fetch(request('/api/payments/balance',{headers:identity}),env);assert.deepEqual(await response.json(),{balance:500,frozen:false});assert.equal((await app.fetch(request('/api/payments/create',{method:'POST',headers:{...identity,origin},body:'{}'}),env)).status,404);
});
test('MCP discovery exposes real confirmation and editing only when configured',async()=>{
 const {app,calls}=fixture();const response=await app.fetch(request('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);const value=await response.json();assert.ok(value.result.tools.some(t=>t.name==='rig_confirm_generation'));assert.ok(value.result.tools.find(t=>t.name==='rig_create_quote').inputSchema.properties.quality.enum.includes('edit-standard'));assert.equal(calls.length,0);
});
