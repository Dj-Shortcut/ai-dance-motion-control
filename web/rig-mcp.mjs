// Site-hosted MCP only. The caller supplies platform-verified authentication
// and a user-bound API adapter; this module never trusts identity headers,
// downloads arbitrary URLs, holds provider secrets, or calculates credit.
import {rigQuoteWidget} from './rig-mcp-widget.mjs';

const VERSION='2026-07-28', RESOURCE='ui://rig/video-quote.html';
const ID=/^[A-Za-z0-9_-]{1,100}$/, USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE=/^[A-Za-z0-9_-]{43}$/, TOKEN=/^[A-Za-z0-9_-]{43,128}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
const empty=x=>exact(x,[])&&Object.keys(x).length===0;
const uuid=x=>typeof x==='string'&&ID.test(x);
const annotations=(readOnly,destructive=false,openWorld=false)=>({readOnlyHint:readOnly,destructiveHint:destructive,idempotentHint:readOnly,openWorldHint:openWorld});
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const idSchema={type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'};
const outputSchema={type:'object',additionalProperties:true};
const fileSchema={type:'object',properties:{download_url:{type:'string',maxLength:8192},file_id:{type:'string',maxLength:256},mime_type:{type:'string',maxLength:100},file_name:{type:'string',maxLength:256}},required:['download_url','file_id'],additionalProperties:false};
const nullableCents={anyOf:[{type:'integer',minimum:0,maximum:500},{type:'null'}]};
const fundingSchema={enum:['owner','sponsored','credits','owner-provider',null]};
const jobSchema=schema({jobId:idSchema,state:{enum:['submitting','queued','processing','unknown','needs_review','completed','failed']},priceCents:{type:'integer',minimum:1},currency:{const:'EUR'},funding:{const:'owner-provider'},providerCurrency:{const:'USD'},providerEstimateUsdMicros:{type:'integer',minimum:1},finalizationConfirmed:{const:true},videoUrl:{type:'string',format:'uri'},requiresAuthentication:{const:true}},['jobId','state']);
const OUTPUTS={
 rig_get_account:schema({userId:{type:'string',pattern:'^u-[0-9a-f-]{36}$'},currency:{const:'EUR'},freeCredit:schema({state:{enum:['eligible','unavailable']},remainingCents:nullableCents},['state','remainingCents']),videoEnabled:{type:'boolean'},funding:fundingSchema,providerAccountLabel:{const:'Eigen fal-account'},providerCurrency:{const:'USD'},rigCredit:schema({balanceCents:{type:'integer',minimum:0},currency:{const:'EUR'},frozen:{type:'boolean'}},['balanceCents','currency','frozen'])},['userId','currency','freeCredit','videoEnabled','funding']),
 rig_get_capabilities:schema({videoEnabled:{type:'boolean'},funding:fundingSchema,workflows:{type:'array',items:schema({id:idSchema,maxDurationSeconds:{type:'integer',minimum:3,maximum:30},animalSingingVerified:{type:'boolean'}},['id','maxDurationSeconds','animalSingingVerified'])},directFilePreparation:{type:'boolean'},explicitPriceConfirmation:{type:'boolean'}},['videoEnabled','funding','workflows','directFilePreparation','explicitPriceConfirmation']),
 rig_activate_invitation:schema({state:{enum:['owner','unavailable','redeemed']},amountCents:{const:500},currency:{const:'EUR'}},['state']),
 rig_open_studio:schema({studioUrl:{type:'string',format:'uri'},requiresAuthentication:{const:true}},['studioUrl','requiresAuthentication']),
 rig_prepare_files:schema({imageId:idSchema,videoId:idSchema,durationSeconds:{type:'number',minimum:3,maximum:30},quality:{type:'string'},generated:{const:false}},['imageId','videoId','durationSeconds','quality','generated']),
 rig_create_quote:schema({quoteId:idSchema,quality:{type:'string'},durationSeconds:{type:'number',minimum:3,maximum:30},billedSeconds:{type:'integer',minimum:3,maximum:30},priceCents:{type:'integer',minimum:1,maximum:10000},currency:{const:'EUR'},expiresAt:{type:'integer'},funding:fundingSchema,remainingCents:nullableCents,withinFreeCredit:{type:['boolean','null']},confirmationRequired:{const:true},confirmationAvailable:{type:'boolean'}},['quoteId','quality','durationSeconds','billedSeconds','priceCents','currency','expiresAt','funding','remainingCents','withinFreeCredit','confirmationRequired','confirmationAvailable']),
 rig_confirm_generation:jobSchema,
 rig_get_generation:jobSchema,
 rig_get_recent_generation:schema({job:{anyOf:[jobSchema,{type:'null'}]}},['job'])
};

const BASE_TOOLS=[
 {name:'rig_get_account',title:'Bekijk je RIG-tegoed',description:'Bekijk je eigen RIG-account, beschikbaar gratis testtegoed en of je video’s kunt maken. Toont geen saldo van een los fal-account.',inputSchema:schema(),outputSchema,annotations:annotations(true)},
 {name:'rig_get_capabilities',title:'Bekijk wat RIG kan maken',description:'Controleer welke videoroutes werkelijk aangesloten zijn en of generatie voor je account beschikbaar is.',inputSchema:schema(),outputSchema,annotations:annotations(true)},
 {name:'rig_activate_invitation',title:'Activeer gratis RIG-testtegoed',description:'Koppel een eenmalige uitnodiging aan je huidige RIG-account. Gebruik dit als de gebruiker zijn uitnodiging wil activeren. Er wordt niets gekocht.',inputSchema:schema({code:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}},['code']),outputSchema,annotations:annotations(false)},
 {name:'rig_open_studio',title:'Open RIG Studio',description:'Open de RIG-app met dezelfde aangemelde account voor het kiezen en voorbereiden van referenties. Start geen video.',inputSchema:schema(),outputSchema,annotations:annotations(true)},
 {name:'rig_create_quote',title:'Bereken de videoprijs',description:'Maak een prijsopgave voor reeds privé voorbereide RIG-bestanden van deze account. Toont de prijs en gratis budget vóór generatie; deze tool start geen fal-generatie.',inputSchema:schema({imageId:idSchema,videoId:idSchema,faceId:{anyOf:[idSchema,{type:'null'}]},angleIds:{type:'array',items:idSchema,maxItems:3},quality:{type:'string',enum:['standard','pro']},prompt:{type:'string',maxLength:1900},keepSound:{type:'boolean'},steadyCamera:{type:'boolean'}},['imageId','videoId','quality']),outputSchema,annotations:annotations(false),_meta:{ui:{resourceUri:RESOURCE},'openai/outputTemplate':RESOURCE}},
 {name:'rig_get_generation',title:'Bekijk je video-opdracht',description:'Controleer één bestaande eigen video-opdracht zonder een nieuwe generatie te starten. Een klaar resultaat opent via je beveiligde RIG-account.',inputSchema:schema({jobId:idSchema},['jobId']),outputSchema,annotations:annotations(true)},
 {name:'rig_get_recent_generation',title:'Bekijk je laatste video-opdracht',description:'Zoek de laatste opdracht van je huidige RIG-account zodat een bestaande opdracht verder gecontroleerd kan worden.',inputSchema:schema(),outputSchema,annotations:annotations(true)}
];
const PREPARE_TOOL={name:'rig_prepare_files',title:'Bereid je videoreferenties privé voor',description:'Lees uitsluitend de door ChatGPT voor deze plugin gedeelde foto en bewegingsvideo, bereid ze privé in RIG voor en geef de eigen bestand-ID’s terug. Dit kan voorbereidingskosten veroorzaken maar start geen fal-generatie. Gebruik de RIG-app voor uitsnijden of een andere starttijd.',inputSchema:schema({reference_file:fileSchema,motion_file:fileSchema,seconds:{type:'integer',minimum:3,maximum:30},startSeconds:{type:'number',minimum:0,maximum:3600,multipleOf:0.001},quality:{type:'string',enum:['standard','pro'],default:'pro'},prompt:{type:'string',maxLength:1900},steadyCamera:{type:'boolean'},keepSound:{type:'boolean'}},['reference_file','motion_file','seconds']),outputSchema,annotations:annotations(false),_meta:{'openai/fileParams':['reference_file','motion_file']}};
const CONFIRM_TOOL={name:'rig_confirm_generation',title:'Bevestig de getoonde videoprijs',description:'Start de geprijsde video uitsluitend vanuit de expliciete bevestigingsknop met het verborgen, aan deze account en prijsopgave gebonden goedkeuringsbewijs. De server controleert budget en herhaalt dezelfde opdracht bij herstel.',inputSchema:schema({quoteId:idSchema,approvalToken:{type:'string',pattern:'^[A-Za-z0-9_-]{43,128}$'}},['quoteId','approvalToken']),outputSchema,annotations:annotations(false,true,true),_meta:{ui:{visibility:['app']},'openai/widgetAccessible':true}};

const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const rpc=(id,result)=>json({jsonrpc:'2.0',id,result});
const rpcError=(id,code,message,status=200)=>json({jsonrpc:'2.0',id,error:{code,message}},status);
const textResult=(data,message,meta)=>({structuredContent:data,content:[{type:'text',text:message}],...(meta?{_meta:meta}:{})});
const toolError=message=>({isError:true,content:[{type:'text',text:message}]});
class SafeFailure extends Error {}
const fail=message=>{throw new SafeFailure(message)};
async function boundedJson(body,max,timeout=15000){
 if(!body)throw Error('Missing body');const reader=body.getReader(),chunks=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Body deadline')),timeout)});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>max)throw Error('Body limit');chunks.push(value)}const bytes=new Uint8Array(size);let p=0;for(const part of chunks){bytes.set(part,p);p+=part.length}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
 finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}
async function api(context,path,method='GET',value){
 const result=await context.request(path,{method,cache:'no-store',...(value!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});
 if(!(result instanceof Response))throw Error('Invalid adapter response');
 if(!result.ok){if(result.body)void result.body.cancel().catch(()=>{});if(result.status===401)fail('Meld je aan bij RIG om verder te gaan.');if(result.status===402)fail('Je RIG-tegoed is onvoldoende voor deze video.');if(result.status===429)fail('Er zijn te veel aanvragen. Wacht even voordat je de status opnieuw controleert.');if(result.status===403)fail('Deze handeling is voor je account niet beschikbaar of je testtegoed is op.');fail('RIG kon deze aanvraag nog niet afronden. Controleer de app of probeer de status later opnieuw.')}
 return boundedJson(result.body,32768,30000);
}
const money=c=>new Intl.NumberFormat('nl-BE',{style:'currency',currency:'EUR'}).format(c/100);
function safeJob(value){
 if(!object(value)||!uuid(value.id)||!['submitting','queued','processing','unknown','needs_review','completed','failed'].includes(value.state))throw Error('Invalid job');
 if(value.funding==='owner-provider'){
  if(value.providerCurrency!=='USD'||!Number.isSafeInteger(value.providerEstimateUsdMicros)||value.providerEstimateUsdMicros<1||Object.hasOwn(value,'priceCents')||Object.hasOwn(value,'currency'))throw Error('Invalid provider-funded job');
  return {jobId:value.id,state:value.state,funding:'owner-provider',providerCurrency:'USD',providerEstimateUsdMicros:value.providerEstimateUsdMicros,...(value.state==='failed'&&value.finalizationConfirmed===true?{finalizationConfirmed:true}:{})};
 }
 // An ambiguous 202 from the existing generation API deliberately contains
 // only its durable job ID and state. Preserve that recovery handle.
 if(value.state==='unknown'&&value.priceCents===undefined&&value.currency===undefined)return {jobId:value.id,state:value.state};
 if(!Number.isSafeInteger(value.priceCents)||value.priceCents<1||value.currency!=='EUR')throw Error('Invalid job');
 return {jobId:value.id,state:value.state,priceCents:value.priceCents,currency:'EUR'};
}
function file(value){
 if(!exact(value,['download_url','file_id','mime_type','file_name'])||typeof value.file_id!=='string'||!/^file[-_][A-Za-z0-9_-]{1,250}$/.test(value.file_id)||typeof value.download_url!=='string'||value.download_url.length>8192)return false;
 if(value.mime_type!==undefined&&(typeof value.mime_type!=='string'||value.mime_type.length>100))return false;
 if(value.file_name!==undefined&&(typeof value.file_name!=='string'||value.file_name.length>256))return false;
 try{const u=new URL(value.download_url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash}catch{return false}
}
function quoteInput(a,qualities=['standard','pro']){
 if(!exact(a,['imageId','videoId','faceId','angleIds','quality','prompt','keepSound','steadyCamera'])||!uuid(a.imageId)||!uuid(a.videoId)||!qualities.includes(a.quality))return null;
 if(a.faceId!==undefined&&a.faceId!==null&&!uuid(a.faceId)||a.prompt!==undefined&&(typeof a.prompt!=='string'||a.prompt.length>1900)||a.keepSound!==undefined&&typeof a.keepSound!=='boolean'||a.steadyCamera!==undefined&&typeof a.steadyCamera!=='boolean')return null;
 const angles=a.angleIds??[];if(a.quality==='edit-standard'&&(!(a.prompt??'').trim()||a.faceId||angles.length||a.steadyCamera===true))return null;if(!Array.isArray(angles)||angles.length>3||angles.some(x=>!uuid(x))||angles.length&&!a.faceId)return null;
 return {imageId:a.imageId,videoId:a.videoId,faceId:a.faceId??null,angleIds:angles,quality:a.quality,prompt:a.prompt??'',keepSound:a.keepSound??true,steadyCamera:a.steadyCamera??false};
}
async function allowance(context){
 const data=await api(context,'/api/sponsor-invitations/status');
 if(data?.state==='unavailable')return {state:'unavailable',remainingCents:null};
 if(data?.state!=='eligible'||!Number.isSafeInteger(data.remainingCents)||data.remainingCents<0||data.remainingCents>500)throw Error('Invalid allowance');
 return {state:'eligible',remainingCents:data.remainingCents};
}
async function videoConfig(context){
 const value=await api(context,'/api/video-config'),ownerProvider=value?.funding==='owner-provider',websiteOnly=['credits','owner-provider'].includes(value?.funding);
 if(typeof value?.enabled!=='boolean'||value.enabled&&!['owner','sponsored','credits','owner-provider'].includes(value.funding)||value.funding==='credits'&&(value.mode!=='live'||value.currency!=='EUR')||ownerProvider&&(value.mode!=='live'||value.providerCurrency!=='USD'))throw Error('Invalid capability');
 return {enabled:value.enabled,funding:value.enabled?value.funding:null,websiteOnly,ownerProvider};
}
async function pluginGeneration(context){
 const capability=await videoConfig(context);
 if(capability.websiteOnly)fail('Gebruik de RIG-website om je bestanden voor te bereiden, de prijs te bekijken en een video te maken. Genereren vanuit ChatGPT volgt later.');
 return capability;
}

export function createRigMcp({authenticate,appOrigin,prepareFiles,issueApproval,consumeApproval,qualities=['standard','pro'],workflows=[{id:'motion_control',maxDurationSeconds:30,animalSingingVerified:false}]}={}){
 const origin=new URL(appOrigin);if(origin.origin!==appOrigin||origin.protocol!=='https:'||origin.username||origin.password||typeof authenticate!=='function')throw Error('Invalid MCP dependencies');
 if(prepareFiles!==undefined&&typeof prepareFiles!=='function'||issueApproval!==undefined&&typeof issueApproval!=='function'||consumeApproval!==undefined&&typeof consumeApproval!=='function')throw Error('Invalid MCP adapter');
 if(!Array.isArray(qualities)||!qualities.length||qualities.some(x=>!['standard','pro','edit-standard'].includes(x))||new Set(qualities).size!==qualities.length)throw Error('Invalid qualities');
 const confirmation=typeof issueApproval==='function'&&typeof consumeApproval==='function';
 const tools=structuredClone([...BASE_TOOLS,...(prepareFiles?[PREPARE_TOOL]:[]),...(confirmation?[CONFIRM_TOOL]:[])]);
 for(const tool of tools){tool.outputSchema=structuredClone(OUTPUTS[tool.name]);if(tool.inputSchema.properties.quality){tool.inputSchema.properties.quality.enum=[...qualities];if(!qualities.includes('pro'))delete tool.inputSchema.properties.quality.default;}if(tool.outputSchema.properties.quality)tool.outputSchema.properties.quality.enum=[...qualities];}
 const resource={uri:RESOURCE,name:'RIG-videoprijs',mimeType:'text/html;profile=mcp-app',description:'Bekijk de prijs en bevestig je RIG-video met je gratis tegoed.'};
 const workflowData=structuredClone(workflows);
 if(!Array.isArray(workflowData)||workflowData.some(w=>!exact(w,['id','maxDurationSeconds','animalSingingVerified'])||!uuid(w.id)||!Number.isInteger(w.maxDurationSeconds)||w.maxDurationSeconds<3||w.maxDurationSeconds>30||typeof w.animalSingingVerified!=='boolean'))throw Error('Invalid workflows');
 async function call(name,a,context){
  if(name==='rig_get_account'){
   if(!empty(a))fail('Controleer je aanvraag.');const gift=await allowance(context),cap=await videoConfig(context);
   if(cap.ownerProvider){
    const wallet=await api(context,'/api/payments/balance');
    if(wallet?.mode!=='live'||wallet.currency!=='EUR'||!Number.isSafeInteger(wallet.balance)||wallet.balance<0||typeof wallet.frozen!=='boolean')throw Error('Invalid RIG wallet');
    return textResult({userId:context.userId,currency:'EUR',freeCredit:gift,videoEnabled:cap.enabled,funding:cap.funding,providerAccountLabel:'Eigen fal-account',providerCurrency:'USD',rigCredit:{balanceCents:wallet.balance,currency:'EUR',frozen:wallet.frozen}},`Eigen fal-account: maak je video op de RIG-website en bekijk daar eerst de Fal-raming. Je afzonderlijke RIG-tegoed is ${money(wallet.balance)}; dit is geen Fal-saldo. Het werkelijke Fal-saldo lees je op fal.ai.`);
   }
   return textResult({userId:context.userId,currency:'EUR',freeCredit:gift,videoEnabled:cap.enabled,funding:cap.funding},gift.state==='eligible'?`Je hebt ${money(gift.remainingCents)} gratis RIG-testtegoed over.`:cap.websiteOnly?'Je RIG-account is actief. Bekijk je gekochte tegoed en maak een video op de RIG-website.':'Er is nog geen gratis testtegoed aan deze RIG-account gekoppeld.');
  }
  if(name==='rig_get_capabilities'){
   if(!empty(a))fail('Controleer je aanvraag.');const cap=await videoConfig(context);
   return textResult({videoEnabled:cap.enabled,funding:cap.funding,workflows:workflowData,directFilePreparation:!cap.websiteOnly&&Boolean(prepareFiles),explicitPriceConfirmation:!cap.websiteOnly&&confirmation},cap.websiteOnly?'Gebruik de RIG-website om een video te maken en vooraf de prijs te bekijken. Genereren vanuit ChatGPT volgt later.':'Dit zijn de aangesloten RIG-mogelijkheden. De prijs verschijnt vóór generatie.');
  }
  if(name==='rig_activate_invitation'){
   if(!exact(a,['code'])||!CODE.test(a.code||''))fail('Controleer je uitnodiging.');
   const value=await api(context,'/api/sponsor-invitations/redeem','POST',{code:a.code});
   if(value?.state==='owner')return textResult({state:'owner'},'Deze uitnodiging is voor je tester. Deel de uitnodigingslink met hem.');
   if(value?.state==='unavailable')return textResult({state:'unavailable'},'Deze uitnodiging is niet beschikbaar.');
   if(value?.state!=='redeemed'||value.amountCents!==500)throw Error('Invalid redemption');
   return textResult({state:'redeemed',amountCents:500,currency:'EUR'},'Je gratis €5 RIG-testtegoed is actief. Er is niets gekocht of gegenereerd.');
  }
  if(name==='rig_open_studio'){
   if(!empty(a))fail('Controleer je aanvraag.');
   return textResult({studioUrl:appOrigin+'/',requiresAuthentication:true},`Open RIG Studio met dezelfde account: ${appOrigin}/`);
  }
  if(name==='rig_prepare_files'&&prepareFiles){
   if(!exact(a,['reference_file','motion_file','seconds','startSeconds','quality','prompt','steadyCamera','keepSound'])||!file(a.reference_file)||!file(a.motion_file)||!Number.isInteger(a.seconds)||a.seconds<3||a.seconds>30||a.startSeconds!==undefined&&(!Number.isFinite(a.startSeconds)||a.startSeconds<0||a.startSeconds>3600||Math.round(a.startSeconds*1000)/1000!==a.startSeconds)||a.quality!==undefined&&!qualities.includes(a.quality)||a.prompt!==undefined&&(typeof a.prompt!=='string'||a.prompt.length>1900)||a.steadyCamera!==undefined&&typeof a.steadyCamera!=='boolean'||a.keepSound!==undefined&&typeof a.keepSound!=='boolean')fail('Kies een foto, een bewegingsvideo en een fragment van 3 tot 30 seconden.');
   const quality=a.quality??'pro';if(!qualities.includes(quality))fail('Pro is momenteel niet beschikbaar. Kies zelf een beschikbare kwaliteit.');
   if(quality==='edit-standard'&&(!(a.prompt??'').trim()||a.seconds>15))fail('Geef een beschrijving en kies een fragment van 3 tot 15 seconden.');
   const cap=await pluginGeneration(context),gift=await allowance(context);if(!cap.enabled||cap.funding==='sponsored'&&!(gift.remainingCents>0))fail('Er is geen beschikbaar RIG-testtegoed voor deze voorbereiding.');
   const value=await prepareFiles(context,{reference_file:a.reference_file,motion_file:a.motion_file,seconds:a.seconds,startSeconds:a.startSeconds??0,quality,prompt:a.prompt??'',steadyCamera:a.steadyCamera??false,keepSound:a.keepSound??true});
   if(!object(value)||!uuid(value.imageId)||!uuid(value.videoId)||!Number.isFinite(value.durationSeconds)||value.durationSeconds<3||value.durationSeconds>30)throw Error('Invalid prepared files');
   return textResult({imageId:value.imageId,videoId:value.videoId,durationSeconds:value.durationSeconds,quality,generated:false},'Je bestanden zijn privé voorbereid in RIG. Er is nog geen video gegenereerd; vraag nu de prijsopgave op.');
  }
  if(name==='rig_create_quote'){
   const input=quoteInput(a,qualities);if(!input)fail('Controleer je voorbereide bestanden en instellingen.');
   const cap=await pluginGeneration(context);
   const value=await api(context,'/api/generation-quotes','POST',input);
   if(!object(value)||value.quality!==input.quality||!uuid(value.id)||!Number.isSafeInteger(value.priceCents)||value.priceCents<1||value.priceCents>10000||value.currency!=='EUR'||!Number.isFinite(value.durationSeconds)||value.durationSeconds<3||value.durationSeconds>30||!Number.isInteger(value.billedSeconds)||value.billedSeconds!==Math.ceil(value.durationSeconds)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now())throw Error('Invalid quote');
   const gift=await allowance(context),withinFreeCredit=gift.state==='eligible'?gift.remainingCents>=value.priceCents:null;
   const quote={quoteId:value.id,quality:input.quality,durationSeconds:value.durationSeconds,billedSeconds:value.billedSeconds,priceCents:value.priceCents,currency:'EUR',expiresAt:value.expiresAt,funding:cap.funding,remainingCents:gift.remainingCents,withinFreeCredit,confirmationRequired:true,confirmationAvailable:false};
   let meta;
   if(confirmation&&cap.enabled&&(cap.funding==='owner'||withinFreeCredit===true)){
    const approval=await issueApproval(context,quote);if(!object(approval)||!TOKEN.test(approval.approvalToken||''))throw Error('Invalid approval');
    quote.confirmationAvailable=true;meta={approvalToken:approval.approvalToken};
   }
   const message=withinFreeCredit===false?`Deze video kost ${money(quote.priceCents)}. Je gratis testtegoed is hiervoor niet voldoende; kies een korter fragment of een andere kwaliteit.`:`Deze video kost ${money(quote.priceCents)} voor ${quote.durationSeconds.toFixed(2)} seconden. Bevestig de getoonde prijs om de video te maken.`;
   return textResult(quote,message,meta);
  }
  if(name==='rig_confirm_generation'&&confirmation){
   if(!exact(a,['quoteId','approvalToken'])||!uuid(a.quoteId)||!TOKEN.test(a.approvalToken||''))fail('Bevestig eerst de prijs met de knop in RIG.');
   await pluginGeneration(context);
   const approved=await consumeApproval(context,{quoteId:a.quoteId,approvalToken:a.approvalToken});
   if(!object(approved)||!uuid(approved.idempotencyKey))fail('De bevestiging is ongeldig of verlopen. Controleer de prijs opnieuw.');
   const value=await api(context,'/api/generations','POST',{quoteId:a.quoteId,idempotencyKey:approved.idempotencyKey,approvalToken:a.approvalToken});
   const job=safeJob(value);
   return textResult(job,['queued','processing','submitting'].includes(job.state)?'Je video-opdracht is gestart. Controleer dezezelfde opdracht totdat hij klaar is.':job.state==='failed'?'De opdracht is niet gestart of mislukt. Controleer je tegoed.':'De opdrachtstatus moet worden gecontroleerd. Start geen nieuwe opdracht.');
  }
  if(name==='rig_get_recent_generation'){
   if(!empty(a))fail('Controleer je aanvraag.');const value=await api(context,'/api/generations/recent');
   if(value?.job===null)return textResult({job:null},'Je hebt nog geen video-opdracht.');
   const job=safeJob(value?.job);return textResult({job},'Dit is je laatste RIG-opdracht.');
  }
  if(name==='rig_get_generation'){
   if(!exact(a,['jobId'])||!uuid(a.jobId))fail('Controleer je opdracht-ID.');
   const value=await api(context,`/api/generations/${encodeURIComponent(a.jobId)}`),job=safeJob(value);if(job.jobId!==a.jobId)throw Error('Wrong job');
   if(job.state==='completed'){
    if(value.videoPath!==`/api/generations/${a.jobId}/video`)throw Error('Wrong result path');
    return textResult({...job,videoUrl:appOrigin+value.videoPath,requiresAuthentication:true},`Je video is klaar. Open het beveiligde resultaat via RIG: ${appOrigin+value.videoPath}`);
   }
   return textResult(job,'Dit is de huidige status van dezelfde RIG-opdracht. Start niet opnieuw bij een onzekere status.');
  }
  fail('Deze RIG-handeling is niet beschikbaar.');
 }
 return async function handle(req){
  let url;try{url=new URL(req.url)}catch{return json({error:'Ongeldige aanvraag.'},400)}
  if(req.method!=='POST'||url.origin!==appOrigin||url.pathname!=='/mcp'||url.search||url.hash)return json({error:'Niet gevonden.'},404);
  if(req.headers.get('origin')&&req.headers.get('origin')!==appOrigin)return json({error:'Aanvraag geweigerd.'},403);
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return rpcError(null,-32600,'JSON vereist.',415);
  let message;try{message=await boundedJson(req.body,32768)}catch{return rpcError(null,-32700,'Ongeldige JSON.',400)}
  const requestId=typeof message?.id==='string'&&message.id.length<=100||Number.isSafeInteger(message?.id)?message.id:null;
  if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||message.id!==undefined&&requestId===null)return rpcError(null,-32600,'Ongeldige MCP-aanvraag.',400);
  if(message.method==='notifications/initialized'&&message.id===undefined)return new Response(null,{status:204});
  if(message.id===undefined)return rpcError(null,-32600,'Een aanvraag-ID is vereist.',400);
  const params=message.params??{};
  if(message.method==='server/discover')return rpc(requestId,{supportedVersions:[VERSION],capabilities:{tools:{},resources:{}}});
  if(message.method==='initialize')return rpc(requestId,{protocolVersion:VERSION,capabilities:{tools:{},resources:{}},serverInfo:{name:'RIG',version:'0.2.0'}});
  if(message.method==='ping')return rpc(requestId,{});
  if(message.method==='tools/list')return rpc(requestId,{tools});
  if(message.method==='resources/list')return rpc(requestId,{resources:[resource]});
  if(message.method==='resources/read'){
   if(!exact(params,['uri'])||params.uri!==RESOURCE)return rpcError(requestId,-32602,'Onbekende resource.');
   return rpc(requestId,{contents:[{...resource,text:rigQuoteWidget(appOrigin),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/widgetDescription':'Toont de RIG-prijs en laat de gebruiker vóór generatie expliciet bevestigen.'}}]});
  }
  if(message.method!=='tools/call')return rpcError(requestId,-32601,'Onbekende methode.');
  if(!exact(params,['name','arguments','_meta'])||typeof params.name!=='string'||!tools.some(t=>t.name===params.name))return rpcError(requestId,-32602,'Onbekende RIG-tool.');
  let context;try{context=await authenticate(req)}catch{return rpc(requestId,toolError('Meld je aan bij RIG om verder te gaan.'))}
  if(!USER.test(context?.userId||'')||typeof context?.request!=='function')return rpc(requestId,toolError('Meld je aan bij RIG om verder te gaan.'));
  try{return rpc(requestId,await call(params.name,params.arguments??{},context))}catch(error){return rpc(requestId,toolError(error instanceof SafeFailure?error.message:'RIG is tijdelijk niet beschikbaar. Er is geen nieuwe poging gestart; controleer eerst de bestaande opdracht.'))}
 };
}
export const rigMcpTesting={resourceUri:RESOURCE,file,quoteInput};
