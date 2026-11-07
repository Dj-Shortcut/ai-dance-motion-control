import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRigMcp,rigMcpTesting} from './rig-mcp.mjs';
import {rigQuoteWidget} from './rig-mcp-widget.mjs';

const origin='https://rig.example',user='u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token='a'.repeat(43),code='b'.repeat(43);
function fixture(options={}){
 const calls=[],approvals=[],consumed=[],uploads=[],dispatches=new Set();let currentUser=user,remaining=500;
 const quote={id:'quote-1',quality:'standard',priceCents:100,currency:'EUR',durationSeconds:3.07,billedSeconds:4,expiresAt:Date.now()+60000,providerEstimateUsdMicros:672000};
 const api=async(path,init)=>{
  calls.push({userId:currentUser,path,init});
  if(path==='/api/video-config')return Response.json({enabled:true,funding:'sponsored'});
  if(path==='/api/sponsor-invitations/status')return Response.json({state:'eligible',remainingCents:remaining});
  if(path==='/api/sponsor-invitations/redeem')return Response.json({state:'redeemed',amountCents:500,secret:'not-for-client'});
  if(path==='/api/generation-quotes')return Response.json(quote,{status:201});
  if(path==='/api/generations'){const args=JSON.parse(init.body);dispatches.add(args.idempotencyKey);return Response.json({id:'job-1',state:'queued',priceCents:100,currency:'EUR',rawProviderKey:'never-expose'});}
  if(path==='/api/generations/job-1')return Response.json({id:'job-1',state:'completed',priceCents:100,currency:'EUR',videoPath:'/api/generations/job-1/video',providerUrl:'https://private-provider.example/result.mp4'});
  if(path==='/api/generations/recent')return Response.json({job:null});
  throw Error('Unexpected API path');
 };
 const authenticate=async()=>currentUser?{userId:currentUser,request:api}:null;
 const prepareFiles=async(ctx,input)=>{uploads.push({ctx,input});return {imageId:'image-1',videoId:'video-1',durationSeconds:4}};
 const issueApproval=async(ctx,q)=>{approvals.push({ctx,q});return {approvalToken:token}};
 const consumeApproval=async(ctx,value)=>{consumed.push({ctx,value});return ctx.userId===user&&value.approvalToken===token&&value.quoteId==='quote-1'?{idempotencyKey:'server-stable-key'}:null};
 const handler=createRigMcp({authenticate,appOrigin:origin,prepareFiles,issueApproval,consumeApproval,...options});
 async function send(method,params={},requestOptions={}){const body=JSON.stringify({jsonrpc:'2.0',id:1,method,params});const response=await handler(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',...requestOptions.headers},body}));return {response,body:await response.json()};}
 const call=(name,args={})=>send('tools/call',{name,arguments:args});
 return {handler,call,send,calls,approvals,consumed,uploads,dispatches,quote,setUser:id=>{currentUser=id},setRemaining:n=>{remaining=n}};
}
const input={imageId:'image-1',videoId:'video-1',quality:'standard'};

test('stateless discovery, legacy initialization and honest conditional tools/resources',async()=>{
 const f=fixture();const discovered=await f.send('server/discover');assert.deepEqual(discovered.body.result.supportedVersions,['2026-07-28']);
 assert.equal((await f.send('initialize')).body.result.serverInfo.name,'RIG');
 const list=(await f.send('tools/list')).body.result.tools;
 assert.ok(list.find(t=>t.name==='rig_confirm_generation').annotations.destructiveHint);
 assert.deepEqual(list.find(t=>t.name==='rig_confirm_generation')._meta.ui.visibility,['app']);
 const prep=list.find(t=>t.name==='rig_prepare_files');assert.deepEqual(prep._meta['openai/fileParams'],['reference_file','motion_file']);
 for(const name of prep._meta['openai/fileParams']){const file=prep.inputSchema.properties[name];assert.deepEqual(Object.keys(file.properties).sort(),['download_url','file_id','file_name','mime_type']);assert.deepEqual(file.required,['download_url','file_id']);}
 const read=await f.send('resources/read',{uri:rigMcpTesting.resourceUri});assert.equal(read.body.result.contents[0].mimeType,'text/html;profile=mcp-app');assert.match(read.body.result.contents[0].text,/Bevestig en genereer/);assert.equal(f.calls.length,0);
 const off=fixture({prepareFiles:undefined,issueApproval:undefined,consumeApproval:undefined});
 const names=(await off.send('tools/list')).body.result.tools.map(t=>t.name);assert.ok(!names.includes('rig_prepare_files'));assert.ok(!names.includes('rig_confirm_generation'));
});

test('every tool call uses injected verified identity; caller cannot supply another identity or path',async()=>{
 const f=fixture();f.setUser(null);const denied=await f.call('rig_get_account');assert.equal(denied.body.result.isError,true);assert.equal(f.calls.length,0);
 f.setUser(user);const injected=await f.call('rig_get_account',{userId:other});assert.equal(injected.body.result.isError,true);assert.equal(f.calls.length,0);
 const bad=await f.call('rig_get_generation',{jobId:'../other/video'});assert.equal(bad.body.result.isError,true);assert.equal(f.calls.length,0);
 const account=(await f.call('rig_get_account')).body.result.structuredContent;assert.equal(account.userId,user);assert.equal(account.freeCredit.remainingCents,500);
 f.setUser(other);assert.equal((await f.call('rig_get_account')).body.result.structuredContent.userId,other);
});

test('account, invitation, preparation and quote never dispatch a generation or leak provider metadata',async()=>{
 const f=fixture();const activated=await f.call('rig_activate_invitation',{code});assert.deepEqual(activated.body.result.structuredContent,{state:'redeemed',amountCents:500,currency:'EUR'});assert.doesNotMatch(JSON.stringify(activated.body.result),/not-for-client/);
 const file={file_id:'file_abc',download_url:'https://files.oaiusercontent.com/private-input',mime_type:'video/mp4',file_name:'input.mp4'};
 const prepared=await f.call('rig_prepare_files',{reference_file:{...file,mime_type:'image/jpeg'},motion_file:file,seconds:4,startSeconds:2.375,quality:'standard',prompt:'same person',steadyCamera:false,keepSound:true});
 assert.equal(prepared.body.result.structuredContent.generated,false);assert.equal(f.uploads[0].input.startSeconds,2.375);assert.equal(f.uploads[0].ctx.userId,user);
 const quoted=(await f.call('rig_create_quote',input)).body.result;
 assert.equal(quoted.structuredContent.priceCents,100);assert.equal(quoted.structuredContent.remainingCents,500);assert.equal(quoted.structuredContent.confirmationAvailable,true);
 assert.equal(quoted._meta.approvalToken,token);assert.doesNotMatch(JSON.stringify(quoted.structuredContent),new RegExp(token));assert.doesNotMatch(JSON.stringify(quoted.content),new RegExp(token));assert.doesNotMatch(JSON.stringify(quoted),/providerEstimateUsdMicros|rawProviderKey/);
 assert.equal(f.approvals.length,1);assert.equal(f.calls.filter(c=>c.path==='/api/generations').length,0);
});

test('insufficient budget never issues an approval and model confirmation claims cannot spend',async()=>{
 const f=fixture();f.setRemaining(50);const quote=(await f.call('rig_create_quote',input)).body.result;
 assert.equal(quote.structuredContent.withinFreeCredit,false);assert.equal(quote.structuredContent.confirmationAvailable,false);assert.equal(quote._meta,undefined);assert.equal(f.approvals.length,0);
 for(const args of [{quoteId:'quote-1',confirmed:true},{quoteId:'quote-1',approvalToken:token,confirmed:true},{quoteId:'quote-1',approvalToken:'invalid'}])assert.equal((await f.call('rig_confirm_generation',args)).body.result.isError,true);
 assert.equal(f.consumed.length,0);assert.equal(f.dispatches.size,0);
});

test('confirmation requires bound approval and uses only the server stable idempotency key',async()=>{
 const f=fixture();f.setUser(other);assert.equal((await f.call('rig_confirm_generation',{quoteId:'quote-1',approvalToken:token})).body.result.isError,true);assert.equal(f.dispatches.size,0);
 f.setUser(user);
 const first=(await f.call('rig_confirm_generation',{quoteId:'quote-1',approvalToken:token})).body.result;
 assert.equal(first.structuredContent.jobId,'job-1');assert.doesNotMatch(JSON.stringify(first),/rawProviderKey/);
 await f.call('rig_confirm_generation',{quoteId:'quote-1',approvalToken:token});assert.equal(f.dispatches.size,1);
 const submitted=f.calls.filter(c=>c.path==='/api/generations');assert.equal(submitted.length,2);for(const c of submitted){const body=JSON.parse(c.init.body);assert.equal(body.idempotencyKey,'server-stable-key');assert.equal(body.approvalToken,token);}
 const completed=(await f.call('rig_get_generation',{jobId:'job-1'})).body.result;
 assert.equal(completed.structuredContent.videoUrl,origin+'/api/generations/job-1/video');assert.equal(completed.structuredContent.requiresAuthentication,true);assert.doesNotMatch(JSON.stringify(completed),/private-provider/);
});

test('file params and configured quality bounds are enforced without an arbitrary fetch implementation',async()=>{
 const f=fixture();const file={file_id:'file_x',download_url:'https://files.oaiusercontent.com/file'};
 for(const patch of [{seconds:31},{startSeconds:0.0001},{quality:'edit-standard'},{motion_file:{...file,download_url:'http://127.0.0.1/internal'}},{reference_file:{...file,file_id:'../secret'}},{userId:other}]){
  const value=await f.call('rig_prepare_files',{reference_file:file,motion_file:file,seconds:3,...patch});assert.equal(value.body.result.isError,true);
 }
 assert.equal(f.uploads.length,0);
 const enabled=fixture({qualities:['standard','pro','edit-standard']});
 const list=(await enabled.send('tools/list')).body.result.tools;assert.ok(list.find(t=>t.name==='rig_create_quote').inputSchema.properties.quality.enum.includes('edit-standard'));
});

test('malformed transport, wrong origin and notifications cannot execute tools',async()=>{
 const f=fixture();
 for(const body of ['{','[]',JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'rig_confirm_generation',arguments:{quoteId:'quote-1',approvalToken:token}}}),'x'.repeat(33000)]){
  const response=await f.handler(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body}));assert.ok(response.status>=400);
 }
 assert.equal((await f.send('tools/call',{name:'rig_get_account'},{headers:{origin:'https://evil.example'}})).response.status,403);
 assert.equal((await f.send('resources/read',{uri:'file:///etc/passwd'})).body.error.code,-32602);
 assert.equal(f.calls.length,0);assert.equal(f.consumed.length,0);
});

test('private API failures are bounded errors without upstream data or automatic retry',async()=>{
 let calls=0;const handler=createRigMcp({appOrigin:origin,authenticate:async()=>({userId:user,request:async()=>{calls++;return new Response('provider-key-secret',{status:500})}})});
 const response=await handler(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'x',method:'tools/call',params:{name:'rig_get_account',arguments:{}}})}));
 const result=await response.json();assert.equal(result.result.isError,true);assert.doesNotMatch(JSON.stringify(result),/provider-key-secret/);assert.equal(calls,1);
});

test('an ambiguous accepted submission preserves its existing recovery handle without retrying',async()=>{
 let submissions=0;
 const handler=createRigMcp({appOrigin:origin,authenticate:async()=>({userId:user,request:async(path)=>{assert.equal(path,'/api/generations');submissions++;return Response.json({id:'job-unknown',state:'unknown',message:'internal'}, {status:202})}}),issueApproval:async()=>({approvalToken:token}),consumeApproval:async()=>({idempotencyKey:'server-key'})});
 const response=await handler(new Request(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'rig_confirm_generation',arguments:{quoteId:'quote-1',approvalToken:token}}})}));
 const result=(await response.json()).result;assert.deepEqual(result.structuredContent,{jobId:'job-unknown',state:'unknown'});assert.match(result.content[0].text,/gecontroleerd/);assert.equal(submissions,1);
});

test('an enabled edit route rejects unsupported duration or identity controls before file preparation',async()=>{
 const f=fixture({qualities:['standard','pro','edit-standard']});const file={file_id:'file_x',download_url:'https://files.oaiusercontent.com/input'};
 assert.equal((await f.call('rig_prepare_files',{reference_file:file,motion_file:file,seconds:30,quality:'edit-standard'})).body.result.isError,true);assert.equal(f.uploads.length,0);
 assert.equal((await f.call('rig_create_quote',{...input,quality:'edit-standard',faceId:'face'})).body.result.isError,true);
 assert.equal((await f.call('rig_create_quote',{...input,quality:'edit-standard',steadyCamera:true})).body.result.isError,true);
 assert.equal(f.calls.length,0);
});

test('widget shows price and allowance, waits for a user click, and keeps the approval out of DOM and model messages',async()=>{
 const dom=new JSDOM(rigQuoteWidget(origin),{url:origin,runScripts:'outside-only'}),calls=[],w=dom.window;
 try{
  w.openai={toolOutput:{quoteId:'quote-1',priceCents:100,currency:'EUR',durationSeconds:3.07,expiresAt:Date.now()+60000,remainingCents:500,withinFreeCredit:true,confirmationAvailable:true},toolResponseMetadata:{mcp_tool_result:{_meta:{approvalToken:token}}},callTool:async(name,args)=>{calls.push({name,args});return {structuredContent:{jobId:'job-1'}}}};
  w.eval(w.document.querySelector('script').textContent);
  assert.match(w.document.getElementById('price').textContent,/1,00/);assert.match(w.document.getElementById('budget').textContent,/5,00/);assert.equal(calls.length,0);assert.equal(w.document.getElementById('confirm').disabled,false);assert.doesNotMatch(w.document.documentElement.outerHTML,new RegExp(token));
  w.document.getElementById('confirm').click();await new Promise(r=>setTimeout(r,0));assert.equal(calls.length,1);assert.deepEqual(calls[0].name,'rig_confirm_generation');assert.equal(calls[0].args.approvalToken,token);assert.equal(calls[0].args.quoteId,'quote-1');assert.equal(w.document.getElementById('confirm').disabled,true);
 }finally{w.close()}
});

test('widget is safe before approved arguments arrive and without a widget runtime or enough budget',()=>{
 for(const mode of ['missing','budget','token']){
  const dom=new JSDOM(rigQuoteWidget(origin),{url:origin,runScripts:'outside-only'}),w=dom.window;
  try{if(mode!=='missing')w.openai={toolOutput:{quoteId:'quote-1',priceCents:100,currency:'EUR',durationSeconds:3,expiresAt:Date.now()+60000,remainingCents:50,withinFreeCredit:mode==='budget'?false:true,confirmationAvailable:true},toolResponseMetadata:{},callTool(){throw Error('must not call')}};w.eval(w.document.querySelector('script').textContent);assert.equal(w.document.getElementById('confirm').disabled,true);}finally{w.close()}
 }
});

test('O3 requires a nonblank prompt before file preparation or quote; motion still allows none',async()=>{
 const f=fixture({qualities:['standard','pro','edit-standard']}),file={file_id:'file_x',download_url:'https://files.oaiusercontent.com/input'};
 for(const prompt of [undefined,'','  \t\n','\u00a0\u2003']){
  const prep=await f.call('rig_prepare_files',{reference_file:file,motion_file:file,seconds:5,quality:'edit-standard',prompt});assert.equal(prep.body.result.isError,true);
  const quote=await f.call('rig_create_quote',{...input,quality:'edit-standard',prompt});assert.equal(quote.body.result.isError,true);
 }
 assert.equal(f.uploads.length,0);assert.equal(f.calls.length,0);
 const motion=await f.call('rig_prepare_files',{reference_file:file,motion_file:file,seconds:5,quality:'standard'});assert.equal(motion.body.result.structuredContent.generated,false);
 const edit=await f.call('rig_prepare_files',{reference_file:file,motion_file:file,seconds:5,quality:'edit-standard',prompt:'  voeg een hond toe  '});assert.equal(edit.body.result.structuredContent.generated,false);
 f.quote.quality='edit-standard';const q=await f.call('rig_create_quote',{...input,quality:'edit-standard',prompt:'voeg een hond toe'});assert.equal(q.body.result.structuredContent.quality,'edit-standard');
});
