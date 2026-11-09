// Fixed Zoho EU -> Accountable invoice delivery. No client controls recipients,
// hosts, senders or credentials. The durable outbox owns claiming/recovery;
// this adapter performs no send retries and cannot prove Accountable import.
// Setup is deliberately OFF until the owner completes Zoho OAuth consent and
// verifies this sender as an Accountable alias. Store credentials as Secrets.
// Least-privilege runtime scope: ZohoMail.messages.CREATE. Account ID discovery
// may separately require ZohoMail.accounts.READ during the one-time setup.
// Official API contracts:
// https://www.zoho.com/mail/help/api/post-upload-attachments.html
// https://www.zoho.com/mail/help/api/post-send-email-attachment.html
// https://www.zoho.com/mail/help/api/getting-started-with-api.html
// https://www.zoho.com/developer/oauth/web-server-apps/refresh-access-token.html
const FROM='info@andyarijs.dev',TO='inkomsten@accountable.eu';
const TOKEN_URL='https://accounts.zoho.eu/oauth/v2/token',MAIL_ORIGIN='https://mail.zoho.eu';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NUMBER=/^RIG-20\d{2}-\d{6,12}$/;
const secret=value=>typeof value==='string'&&value.length>=8&&value.length<=2048&&/^[A-Za-z0-9._~-]+$/.test(value);
const MAX_JSON=65536,MAX_PDF=3*1024*1024;
export class InvoiceMailError extends Error{
 constructor(code,stage){super(code==='setup_required'?'Factuurmail is nog niet ingesteld.':code==='invalid_invoice'?'De factuur kan niet veilig worden verstuurd.':'De factuurmail kon niet worden bevestigd. Controleer de bestaande verzending voordat je opnieuw verstuurt.');this.name='InvoiceMailError';this.code=code;this.stage=stage;}
}
const fail=(code,stage)=>{throw new InvoiceMailError(code,stage);};
function configuration(env){
 if(env?.RIG_ACCOUNTABLE_MAIL_ENABLED!=='yes'||env.RIG_ACCOUNTABLE_ALIAS_CONFIRMED!=='yes'||env.RIG_ACCOUNTABLE_SENDER!==FROM||!secret(env.ZOHO_CLIENT_ID)||!secret(env.ZOHO_CLIENT_SECRET)||!secret(env.ZOHO_REFRESH_TOKEN)||typeof env.ZOHO_MAIL_ACCOUNT_ID!=='string'||!/^[1-9]\d{0,29}$/.test(env.ZOHO_MAIL_ACCOUNT_ID))return null;
 return {clientId:env.ZOHO_CLIENT_ID,clientSecret:env.ZOHO_CLIENT_SECRET,refreshToken:env.ZOHO_REFRESH_TOKEN,accountId:env.ZOHO_MAIL_ACCOUNT_ID};
}
export const accountableMailReady=env=>configuration(env)!==null;

// Limits include headers/fetch AND the complete response body; credentials and
// provider error bodies never escape through errors, URLs, logs or return data.
async function requestJSON(fetchImpl,url,options,stage,timeoutMs){
 let timer,reader;const controller=new AbortController();
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new InvoiceMailError('delivery_unconfirmed',stage));},timeoutMs);});
 try{
  const response=await Promise.race([fetchImpl(url,{...options,method:'POST',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal}),deadline]);
  if(!response||response.status!==200||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))fail('delivery_unconfirmed',stage);
  if(response.url&&new URL(response.url).origin!==new URL(url).origin)fail('delivery_unconfirmed',stage);
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_JSON))fail('delivery_unconfirmed',stage);
  reader=response.body?.getReader();if(!reader)fail('delivery_unconfirmed',stage);const chunks=[];let size=0;
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))fail('delivery_unconfirmed',stage);size+=value.length;if(size>MAX_JSON)fail('delivery_unconfirmed',stage);chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))fail('delivery_unconfirmed',stage);return data;
 }catch{fail('delivery_unconfirmed',stage);}finally{clearTimeout(timer);controller.abort();try{void reader?.cancel().catch(()=>{});}catch{}}
}
function attachmentMetadata(data,filename,size){
 if(data.status?.code!==200)return null;const row=Array.isArray(data.data)?data.data.length===1?data.data[0]:null:data.data;
 if(!row||typeof row!=='object'||row.attachmentName!==filename||typeof row.storeName!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(row.storeName)||typeof row.attachmentPath!=='string'||row.attachmentPath.length>1024||!/^\/(?:Mail|compose)\/[A-Za-z0-9_./-]+$/.test(row.attachmentPath)||row.attachmentPath.split('/').some(part=>part==='.'||part==='..'))return null;
 if(row.attachmentSize!==undefined&&((typeof row.attachmentSize!=='string'&&typeof row.attachmentSize!=='number')||!/^\d+$/.test(String(row.attachmentSize))||Number(row.attachmentSize)!==size))return null;
 return {storeName:row.storeName,attachmentPath:row.attachmentPath,attachmentName:filename};
}
export function createAccountableInvoiceMailer({fetchImpl=fetch,timeoutMs=15000,now=Date.now}={}){
 if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||typeof now!=='function')throw new TypeError('Invalid invoice mail transport');
 // One private in-memory access-token cache, bound to the exact credentials.
 // Sharing the in-flight refresh also stays below Zoho's refresh rate limit.
 let cached=null,pending=null;
 async function accessToken(config){
  const key=config.clientId+'\0'+config.clientSecret+'\0'+config.refreshToken,at=now();
  if(!Number.isSafeInteger(at)||at<1)fail('delivery_unconfirmed','refresh');
  if(cached?.key===key&&cached.expiresAt>at+60000)return cached.token;
  if(pending?.key===key)return pending.promise;
  const promise=(async()=>{
   const body=new URLSearchParams({grant_type:'refresh_token',client_id:config.clientId,client_secret:config.clientSecret,refresh_token:config.refreshToken});
   const response=await requestJSON(fetchImpl,TOKEN_URL,{headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body},'refresh',timeoutMs);
   if(response.error||!secret(response.access_token)||typeof response.token_type!=='string'||response.token_type.toLowerCase()!=='bearer'||!Number.isInteger(response.expires_in)||response.expires_in<1||response.expires_in>86400)fail('delivery_unconfirmed','refresh');
   // api_domain is not a routing instruction. Only the pinned Zoho EU Mail URL
   // below is ever contacted, even if a token response contains another host.
   cached={key,token:response.access_token,expiresAt:at+response.expires_in*1000};return response.access_token;
  })();pending={key,promise};try{return await promise;}finally{if(pending?.promise===promise)pending=null;}
 }
 return async function sendAccountableInvoiceMail(env,{invoice,pdf,idempotencyKey}={}){
  const config=configuration(env);if(!config)fail('setup_required','configuration');
  if(!invoice||typeof invoice.id!=='string'||!UUID.test(invoice.id)||typeof invoice.number!=='string'||!NUMBER.test(invoice.number)||!(pdf instanceof Uint8Array)||pdf.length<100||pdf.length>MAX_PDF||new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-'||idempotencyKey!=='rig-invoice/'+invoice.id)fail('invalid_invoice','validation');
  // Capture the artifact and identifiers before yielding to OAuth/network work.
  const bytes=new Uint8Array(pdf),filename=invoice.number+'.pdf',number=invoice.number,token=await accessToken(config);
  const headers={accept:'application/json',authorization:'Zoho-oauthtoken '+token},base=MAIL_ORIGIN+'/api/accounts/'+config.accountId+'/messages';
  const uploadURL=base+'/attachments?'+new URLSearchParams({fileName:filename,isInline:'false'});
  const uploaded=await requestJSON(fetchImpl,uploadURL,{headers:{...headers,'content-type':'application/octet-stream'},body:bytes},'upload',timeoutMs),attachment=attachmentMetadata(uploaded,filename,bytes.length);
  if(!attachment)fail('delivery_unconfirmed','upload');
  const sent=await requestJSON(fetchImpl,base,{headers:{...headers,'content-type':'application/json'},body:JSON.stringify({fromAddress:FROM,toAddress:TO,subject:'RIG-factuur '+number,content:'Bijgevoegd de reeds betaalde RIG-verkoopfactuur. Verwerk dit document als externe factuur; maak geen tweede verkoopfactuur. Controleer de invoer in Accountable.',mailFormat:'plaintext',encoding:'UTF-8',askReceipt:'no',attachments:[attachment]})},'send',timeoutMs);
  if(sent.status?.code!==200||typeof sent.data?.messageId!=='string'||!/^[1-9]\d{0,79}$/.test(sent.data.messageId))fail('delivery_unconfirmed','send');
  return {messageId:sent.data.messageId};
 };
}
export const sendAccountableInvoiceMail=createAccountableInvoiceMailer();
