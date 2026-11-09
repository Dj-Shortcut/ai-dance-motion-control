import test from 'node:test';
import assert from 'node:assert/strict';
import {accountableMailReady,createAccountableInvoiceMailer,InvoiceMailError,sendAccountableInvoiceMail} from './invoice-mail.mjs';
const ACCOUNT='123456789',NOW=Date.parse('2026-11-09T18:00:00Z'),MAIL='https://mail.zoho.eu/api/accounts/'+ACCOUNT+'/messages';
const env=()=>({RIG_ACCOUNTABLE_MAIL_ENABLED:'yes',RIG_ACCOUNTABLE_ALIAS_CONFIRMED:'yes',RIG_ACCOUNTABLE_SENDER:'info@andyarijs.dev',ZOHO_CLIENT_ID:'1000.fixtureClient',ZOHO_CLIENT_SECRET:'fixtureSecret123',ZOHO_REFRESH_TOKEN:'1000.fixtureRefresh',ZOHO_MAIL_ACCOUNT_ID:ACCOUNT});
const invoice=(number='RIG-2026-000001')=>({id:crypto.randomUUID(),number});
const pdf=()=>new TextEncoder().encode('%PDF-1.7\n'+'.'.repeat(120)+'\n%%EOF');
const input=(value=invoice())=>({invoice:value,pdf:pdf(),idempotencyKey:'rig-invoice/'+value.id});
const token=()=>Response.json({access_token:'1000.fixtureAccess',expires_in:3600,token_type:'Bearer',api_domain:'https://www.zohoapis.eu'});
function upload(filename,size){return Response.json({status:{code:200,description:'success'},data:{storeName:'53862395',attachmentName:filename,attachmentPath:'/Mail/store-'+filename,attachmentSize:String(size)}});}
const sent=(id='1726208416259127700')=>Response.json({status:{code:200,description:'success'},data:{messageId:id}});
function fixture({timeoutMs=1000,override}={}){
 const calls=[];let clock=NOW;
 const fetchImpl=async(url,options)=>{
  const call={url:String(url),options};calls.push(call);if(override){const value=await override(call,calls.length);if(value!==undefined)return value;}
  if(call.url==='https://accounts.zoho.eu/oauth/v2/token')return token();
  if(call.url.startsWith(MAIL+'/attachments?'))return upload(new URL(call.url).searchParams.get('fileName'),options.body.byteLength);
  if(call.url===MAIL)return sent();throw Error('Unexpected network destination');
 };
 return {calls,send:createAccountableInvoiceMailer({fetchImpl,timeoutMs,now:()=>clock}),advance:ms=>{clock+=ms;}};
}
async function rejected(promise,stage,code='delivery_unconfirmed'){
 await assert.rejects(promise,error=>{assert.ok(error instanceof InvoiceMailError);assert.equal(error.stage,stage);assert.equal(error.code,code);assert.doesNotMatch(error.message,/fixtureSecret|fixtureRefresh|fixtureAccess|sensitive-provider|evil\.test/);assert.equal(Object.hasOwn(error,'cause'),false);return true;});
}

test('setup stays off without both confirmations and exact safe EU account credentials',async()=>{
 assert.equal(accountableMailReady(env()),true);
 for(const patch of [{RIG_ACCOUNTABLE_MAIL_ENABLED:undefined},{RIG_ACCOUNTABLE_MAIL_ENABLED:'true'},{RIG_ACCOUNTABLE_ALIAS_CONFIRMED:'no'},{RIG_ACCOUNTABLE_SENDER:'other@example.test'},{RIG_ACCOUNTABLE_SENDER:'info@andyarijs.dev\r\nBcc:other@example.test'},{ZOHO_CLIENT_ID:''},{ZOHO_CLIENT_SECRET:'bad\nsecret'},{ZOHO_REFRESH_TOKEN:'https://evil.test/token'},{ZOHO_MAIL_ACCOUNT_ID:'1/messages?to=evil'},{ZOHO_MAIL_ACCOUNT_ID:123456789},{ZOHO_MAIL_ACCOUNT_ID:'0'}]){
  const config={...env(),...patch},f=fixture();assert.equal(accountableMailReady(config),false,JSON.stringify(patch));await rejected(f.send(config,input()),'configuration','setup_required');assert.equal(f.calls.length,0);
 }
 await rejected(sendAccountableInvoiceMail({},input()),'configuration','setup_required');
});

test('one fixed EU OAuth refresh, binary PDF upload and fixed-recipient message return only the message ID',async()=>{
 const f=fixture(),data=input();assert.deepEqual(await f.send({...env(),RIG_ACCOUNTABLE_RECIPIENT:'attacker@example.test'},data),{messageId:'1726208416259127700'});assert.equal(f.calls.length,3);
 const [auth,attach,message]=f.calls;
 assert.equal(auth.url,'https://accounts.zoho.eu/oauth/v2/token');assert.equal(auth.options.headers['content-type'],'application/x-www-form-urlencoded');assert.equal(auth.options.body.get('client_secret'),env().ZOHO_CLIENT_SECRET);assert.equal(auth.options.body.get('grant_type'),'refresh_token');assert.equal(auth.options.body.get('refresh_token'),env().ZOHO_REFRESH_TOKEN);assert.equal(auth.url.includes('fixture'),false);
 assert.equal(new URL(attach.url).origin,'https://mail.zoho.eu');assert.equal(new URL(attach.url).pathname,'/api/accounts/'+ACCOUNT+'/messages/attachments');assert.deepEqual([...new URL(attach.url).searchParams], [['fileName',data.invoice.number+'.pdf'],['isInline','false']]);assert.equal(attach.options.headers['content-type'],'application/octet-stream');assert.deepEqual(attach.options.body,data.pdf);
 const body=JSON.parse(message.options.body);assert.equal(message.url,MAIL);assert.equal(body.fromAddress,'info@andyarijs.dev');assert.equal(body.toAddress,'inkomsten@accountable.eu');assert.equal(body.subject,'RIG-factuur '+data.invoice.number);assert.equal(body.mailFormat,'plaintext');assert.equal(body.encoding,'UTF-8');assert.equal(body.askReceipt,'no');assert.equal(Object.hasOwn(body,'ccAddress'),false);assert.equal(Object.hasOwn(body,'bccAddress'),false);assert.deepEqual(body.attachments,[{storeName:'53862395',attachmentPath:'/Mail/store-'+data.invoice.number+'.pdf',attachmentName:data.invoice.number+'.pdf'}]);assert.doesNotMatch(JSON.stringify(body),/fixtureSecret|fixtureRefresh|idempotencyKey/);
 for(const call of f.calls){assert.equal(call.options.method,'POST');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');assert.ok(call.options.signal instanceof AbortSignal);}
 for(const call of [attach,message])assert.equal(call.options.headers.authorization,'Zoho-oauthtoken 1000.fixtureAccess');
});

test('no malformed artifact, invoice reference or idempotency handle starts OAuth or mail work',async()=>{
 const f=fixture(),base=input();
 for(const patch of [{invoice:{...base.invoice,id:'bad'}},{invoice:{...base.invoice,id:[base.invoice.id]}},{invoice:{...base.invoice,number:[base.invoice.number]}},{invoice:{...base.invoice,number:'RIG-2026-000001\r\nBcc:attacker'}},{invoice:{...base.invoice,number:'VOORBEELD'}},{idempotencyKey:'rig-invoice/'+crypto.randomUUID()},{pdf:new Uint8Array()},{pdf:new Uint8Array(4*1024*1024)},{pdf:'%PDF-fake'},{pdf:new TextEncoder().encode('HTML-'+'.'.repeat(200))}])await rejected(f.send(env(),{...base,...patch}),'validation','invalid_invoice');
 assert.equal(f.calls.length,0);
});

test('PDF bytes and number are captured before OAuth awaits so later mutation cannot replace the attachment',async()=>{
 let release,entered;const paused=new Promise(resolve=>{release=resolve;}),seen=new Promise(resolve=>{entered=resolve;});
 const f=fixture({override:async call=>{if(call.url.includes('accounts.zoho.eu')){entered();await paused;}}}),data=input(),original=new Uint8Array(data.pdf),number=data.invoice.number;
 const promise=f.send(env(),data);await seen;data.pdf.fill(42);data.invoice.number='RIG-2026-999999';release();await promise;assert.deepEqual(f.calls[1].options.body,original);assert.equal(JSON.parse(f.calls[2].options.body).subject,'RIG-factuur '+number);
});

test('concurrent messages share only the credential-bound access token refresh and refresh again after expiry or rotation',async()=>{
 const f=fixture();await Promise.all([f.send(env(),input()),f.send(env(),input(invoice('RIG-2026-000002')))]);assert.equal(f.calls.filter(call=>call.url.includes('accounts.zoho.eu')).length,1);assert.equal(f.calls.filter(call=>call.url===MAIL).length,2);
 await f.send(env(),input(invoice('RIG-2026-000003')));assert.equal(f.calls.filter(call=>call.url.includes('accounts.zoho.eu')).length,1);
 f.advance(3600000);await f.send(env(),input(invoice('RIG-2026-000004')));assert.equal(f.calls.filter(call=>call.url.includes('accounts.zoho.eu')).length,2);
 await f.send({...env(),ZOHO_REFRESH_TOKEN:'1000.rotatedFixture'},input(invoice('RIG-2026-000005')));assert.equal(f.calls.filter(call=>call.url.includes('accounts.zoho.eu')).length,3);
});

test('provider suggested hosts and attachment URLs never control a network destination',async()=>{
 const f=fixture({override:call=>{
  if(call.url.includes('accounts.zoho.eu'))return Response.json({access_token:'1000.fixtureAccess',expires_in:3600,token_type:'Bearer',api_domain:'https://evil.test/secrets'});
  if(call.url.includes('/attachments?')){const filename=new URL(call.url).searchParams.get('fileName');return Response.json({status:{code:200},data:{storeName:'53862395',attachmentName:filename,attachmentPath:'/Mail/store-'+filename,url:'https://evil.test/attachment'}});}
 }});await f.send(env(),input());assert.deepEqual([...new Set(f.calls.map(call=>new URL(call.url).hostname))].sort(),['accounts.zoho.eu','mail.zoho.eu']);
});

test('redirect, HTTP failure, invalid token, malformed JSON and oversized JSON are sanitized and never retried',async()=>{
 const responses=[()=>new Response(null,{status:302,headers:{location:'https://evil.test'}}),()=>Response.json({error:'sensitive-provider fixtureSecret123'},{status:401}),()=>Response.json({error:'invalid_grant',error_description:'sensitive-provider fixtureSecret123'}),()=>Response.json({access_token:'bad\r\nheader',expires_in:3600,token_type:'Bearer'}),()=>new Response('{',{headers:{'content-type':'application/json'}}),()=>new Response('not JSON',{headers:{'content-type':'text/plain'}}),()=>Response.json({ignored:'x'.repeat(65537)}),()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'999999'}})];
 for(const response of responses){const f=fixture({override:()=>response()});await rejected(f.send(env(),input()),'refresh');assert.equal(f.calls.length,1);}
});

test('unexpected upload identities or paths cannot become outgoing attachments',async()=>{
 const variants=[{attachmentName:'other.pdf'},{attachmentPath:'https://evil.test/pdf'},{attachmentPath:'/Mail/../secret.pdf'},{attachmentPath:'/Mail/x\r\nheader'},{attachmentPath:'/Mail/path?url=evil'},{storeName:'bad\nstore'},{attachmentSize:'999999'}];
 for(const patch of variants){const f=fixture({override:call=>{if(!call.url.includes('/attachments?'))return;const filename=new URL(call.url).searchParams.get('fileName');return Response.json({status:{code:200},data:{storeName:'53862395',attachmentName:filename,attachmentPath:'/Mail/store-'+filename,...patch}});}});await rejected(f.send(env(),input()),'upload');assert.equal(f.calls.length,2);}
 const array=fixture({override:call=>{if(!call.url.includes('/attachments?'))return;const filename=new URL(call.url).searchParams.get('fileName');return Response.json({status:{code:200},data:[{storeName:'53862395',attachmentName:filename,attachmentPath:'/Mail/store-'+filename}]});}});assert.deepEqual(await array.send(env(),input()),{messageId:'1726208416259127700'});
});

test('send acknowledgement must contain one safe provider message ID and never claims Accountable accepted the invoice',async()=>{
 for(const response of [()=>Response.json({status:{code:500},data:{messageId:'1726208416259127700',error:'sensitive-provider'}}),()=>sent(1726208416259127700),()=>sent(''),()=>sent('sensitive-provider fixtureSecret123'),()=>Response.json({status:{code:200},data:{}})]){
  const f=fixture({override:call=>call.url===MAIL?response():undefined});await rejected(f.send(env(),input()),'send');assert.equal(f.calls.length,3);
 }
 const f=fixture(),receipt=await f.send(env(),input());assert.deepEqual(Object.keys(receipt),['messageId']);assert.equal(Object.hasOwn(receipt,'accountableValidated'),false);
});

test('a stalled fetch or streamed body times out, aborts, and makes no automatic second send',async()=>{
 for(const stage of ['refresh','upload','send']){
  const f=fixture({timeoutMs:20,override:call=>{const actual=call.url.includes('accounts.zoho.eu')?'refresh':call.url.includes('/attachments?')?'upload':'send';if(actual===stage)return new Promise(()=>{});}});await rejected(f.send(env(),input()),stage);assert.equal(f.calls.length,{refresh:1,upload:2,send:3}[stage]);assert.equal(f.calls.at(-1).options.signal.aborted,true);
 }
 const f=fixture({timeoutMs:20,override:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}})});await rejected(f.send(env(),input()),'refresh');assert.equal(f.calls.length,1);
});
