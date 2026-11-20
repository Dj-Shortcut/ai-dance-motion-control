import test from 'node:test';
import assert from 'node:assert/strict';
import {commerceDocument,createCommerceDocuments} from './commerce-documents.mjs';
import {merchant,COMMERCE_VERSION,publicCommerce} from './commerce-profile.mjs';
import {createRigSitesApp} from './rig-sites-app.mjs';

const paths=['/voorwaarden','/privacy','/hulp','/bedrijfsgegevens'];

test('public seller and purchase boundary retain approved legal identity and BE/NL consumers',()=>{
 assert.equal(merchant.legalName,'Andy Arys');
 assert.equal(merchant.enterpriseNumber,'1040.495.145');
 assert.equal(merchant.vatNumber,'BE1040.495.145');
 assert.equal(merchant.address,'Savooistraat 50, 9400 Ninove, België');
 assert.equal(merchant.email,'info@andyarijs.dev');
 assert.equal(merchant.phone,'+32 486 25 07 05');
 assert.equal(merchant.country,'BE');
 assert.deepEqual(publicCommerce(),{version:COMMERCE_VERSION,merchant,customerType:'consumer',countries:['BE','NL'],currency:'EUR',termsPath:'/voorwaarden',privacyPath:'/privacy',supportPath:'/hulp',sellerPath:'/bedrijfsgegevens'});
 assert.throws(()=>merchant.customerCountries.push('US'),TypeError);
 assert.throws(()=>{merchant.legalName='Another seller';},TypeError);
});

test('every public page works without an account and has restrictive document headers',async()=>{
 for(const path of paths){
  const response=commerceDocument(path);
  assert.equal(response.status,200,path);
  assert.equal(response.headers.get('content-type'),'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  assert.equal(response.headers.has('set-cookie'),false);
  const html=await response.text();
  assert.match(html,/^<!doctype html><html lang="nl">/);
  assert.match(html,/<meta name="viewport"/);
  assert.match(html,path==='/privacy'?/Versie rig-privacy-2026-11-20-v1 · 20 november 2026/:/Versie rig-commerce-2026-11-09-v2/);
  for(const link of ['/',...paths])assert.ok(html.includes('href="'+link+'"'),path+' links '+link);
  assert.doesNotMatch(html,/<script|<iframe|<form|on(?:load|error|click)=/i);
  assert.match(html,/info@andyarijs\.dev/);
 }
});

test('account visibility disclosure has its own version without changing purchase terms',async()=>{
 const privacy=await commerceDocument('/privacy').text(),terms=await commerceDocument('/voorwaarden').text();
 assert.match(privacy,/aanmeldplatform je naam en e-mailadres/);assert.match(privacy,/eerste bezoek/);assert.match(privacy,/laatst actief/);
 assert.match(privacy,/Alleen de beheerder/);assert.match(privacy,/Een sessiecontrole geldt niet als een nieuwe login/);
 assert.match(terms,new RegExp('Versie '+COMMERCE_VERSION));assert.doesNotMatch(terms,/rig-privacy-2026-11-20-v1/);
});

test('Android privacy describes actual account storage, Play proof and manual data requests separately from website payments',async()=>{
 const privacy=await commerceDocument('/privacy').text(),terms=await commerceDocument('/voorwaarden').text();
 for(const text of ['Android Keystore','Google Play','aankoopbewijs','afgeschermde accountkoppeling','Mollie op de website','RIG ontvangt geen vingerafdruk','/account/verwijderen','bevoegde beheerder','geen automatische verwijdering'])assert.ok(privacy.includes(text),text);
 assert.match(terms,new RegExp('Versie '+COMMERCE_VERSION));assert.doesNotMatch(terms,/<h2>Android en Google Play/);
});

test('public account deletion resource explains scope and retention and starts only an authenticated explicit request',async()=>{
 const response=commerceDocument('/account/verwijderen'),html=await response.text();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('content-security-policy'),"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 for(const text of ['Accountverwijdering · RIG','RIG-account','bijbehorende persoonsgegevens','Android-app van je telefoon hebt verwijderd','ChatGPT-account wordt niet verwijderd','Wettelijk noodzakelijke financiële','info@andyarijs.dev','/signin-with-chatgpt?return_to=%2Faccount%2Fverwijderen','/multiuser/account-deletion.js'])assert.ok(html.includes(text),text);
 assert.match(html,/<form id="deletionForm" hidden>/);assert.match(html,/<input id="deletionConfirm" type="checkbox" disabled>/);assert.match(html,/<button id="deletionSubmit" type="submit" disabled>/);
 assert.doesNotMatch(html,/<script(?! src="\/multiuser\/account-deletion\.js" defer>)/);
 const app=createRigSitesApp({uiFiles:{},fetchImpl:async()=>{throw Error('Public resource must not contact a provider');}});
 const env={RIG_SITES_PRODUCER_ORIGIN:'https://rig.test'};
 assert.equal((await app.fetch(new Request('https://rig.test/account/verwijderen'),env)).status,200);
 for(const suffix of ['?userId=someone','?fbclid=track','/'])assert.equal((await app.fetch(new Request('https://rig.test/account/verwijderen'+suffix),env)).status,404);
 assert.equal((await app.fetch(new Request('https://rig.test/account/verwijderen',{method:'POST'}),env)).status,404);
});

test('Sites serves seller documents before authenticated account and provider work',async()=>{
 let providerCalls=0;
 const app=createRigSitesApp({uiFiles:{},fetchImpl:async()=>{providerCalls++;throw Error('Unexpected account/provider call');},prepareFiles:async()=>{throw Error('Unexpected media preparation');}});
 const env={RIG_SITES_PRODUCER_ORIGIN:'https://rig.test',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes'};
 for(const path of paths){
  const response=await app.fetch(new Request('https://rig.test'+path),env);
  assert.equal(response.status,200,path);
  assert.match(await response.text(),/<nav aria-label="RIG informatie">/);
 }
 assert.equal(providerCalls,0);
 assert.equal((await app.fetch(new Request('https://other.test/voorwaarden'),env)).status,403);
 assert.equal((await app.fetch(new Request('https://rig.test/voorwaarden?fbclid=tracking'),env)).status,404);
 assert.equal((await app.fetch(new Request('https://rig.test/voorwaarden',{method:'POST'}),env)).status,404);
 assert.equal(providerCalls,0);
});

test('unknown and prototype-shaped page keys do not throw or expose a document',()=>{
 for(const path of ['/', '/voorwaarden?x=1','/voorwaarden/','__proto__','constructor','toString','/privacy#fragment','/PRIVATE',null,undefined,{},new String('/privacy')])assert.equal(commerceDocument(path),null);
});

test('seller fields and version cannot inject tags or attributes into public pages',async()=>{
 const attack=`<img src=x onerror="alert('x')">&`;
 const escaped='&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;';
 const hostile={...merchant,legalName:attack,enterpriseNumber:attack,vatNumber:attack,address:attack,email:attack,phone:attack};
 const render=createCommerceDocuments({seller:hostile,version:attack});
 for(const path of paths){
  const html=await render(path).text();
  assert.ok(html.includes(escaped),path);
  assert.doesNotMatch(html,/<img|<script|href="mailto:[^"]*"\s+on/i);
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('href="mailto:'+escaped+'"'));
 }
 assert.match(await commerceDocument('/bedrijfsgegevens').text(),/Andy Arys/,'test overrides never mutate the production renderer');
});

test('terms distinguish bank payments, reservations and refund requests without waiving consumer rights',async()=>{
 const terms=await commerceDocument('/voorwaarden').text();
 assert.match(terms,/totale videoprijs vóór je bevestigt/);
 assert.match(terms,/particuliere klanten in België en Nederland/);
 assert.match(terms,/geen tweede bankbetaling/);
 assert.match(terms,/veertien dagen vanaf de aankoop/);
 assert.match(terms,/geen reden op te geven/);
 assert.match(terms,/downloadbare ontvangstbevestiging/);
 assert.match(terms,/geen automatische afwijzing of goedkeuring/);
 assert.match(terms,/eerder gebruikt tegoed of een oudere aankoop/);
 assert.match(terms,/geen algemene afstand van wettelijke rechten/);
 assert.match(terms,/geen terugstorting op je bankrekening/);
 assert.match(terms,/automatisch een factuur/);
 assert.match(terms,/naam en volledige adres/);
 assert.match(terms,/factuur digitaal als download/);
 assert.doesNotMatch(terms,/btw-vrij|OSS|voucher|automatisch.*boekhoud|aanbevolen prijs|30%|Accountable Connect/i);
 const seller=await commerceDocument('/bedrijfsgegevens').text();
 assert.match(seller,/ondernemingsnummer 1040\.495\.145/);
 assert.match(seller,/KBO Public Search/);
 assert.doesNotMatch(seller,/handelsnaam|geregistreerd merk/i);
});

test('privacy and help describe actual providers, temporary link access and manual request review',async()=>{
 const privacy=await commerceDocument('/privacy').text(),help=await commerceDocument('/hulp').text();
 for(const provider of ['OpenAI','Cloudflare','Mollie','Fal.ai','Accountable','Zoho Mail'])assert.ok(privacy.includes(provider));
 assert.match(privacy,/accountidentificatie uit je ChatGPT-aanmelding/);
 assert.match(privacy,/buiten de EER/);
 assert.match(privacy,/tijdelijke links bij Fal niet privé/);
 assert.match(privacy,/overeenkomst met jou uit te voeren/);
 assert.match(privacy,/gerechtvaardigd belang/);
 assert.match(privacy,/Gegevensbeschermingsautoriteit/);
 assert.match(privacy,/overdraagbaarheid of bezwaar/);
 assert.match(help,/Betaal niet nogmaals/);
 assert.match(help,/downloadbare ontvangstbevestiging/);
 assert.match(help,/verandert niet automatisch je bankbetaling of tegoed/);
 assert.doesNotMatch(help,/terugbetaling is goedgekeurd|geld is teruggestort/i);
});
