import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PDFDocument,PDFName,PDFDict,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {build} from 'esbuild';
import {renderInvoicePDF,supportsInvoiceText,INVOICE_TAX_EXEMPTION} from './invoice-pdf.mjs';
import notoSansRegularBase64 from './fonts/noto-sans-regular.mjs';
const fontBytes=new Uint8Array(await readFile(new URL('./fonts/NotoSans-Regular.ttf',import.meta.url)));
const sourceFont=fontkit.create(fontBytes),order='11111111-1111-4111-8111-111111111111';
const invoice=()=>({number:'RIG-2026-000001',issuedDate:'2026-11-09',issuedAt:Date.parse('2026-11-09T12:02:00Z'),paidAt:'2026-11-09T12:00:00.000Z',orderReference:'RIG-'+order,paymentReference:'tr_PaidExample01',packageId:'five',amountCents:500,creditCents:500,currency:'EUR',quantity:1,vatAmountCents:0,taxExemption:INVOICE_TAX_EXEMPTION,description:'RIG-tegoed voor AI-videogeneratie',buyer:{name:'Zoë de Vries',addressLine1:'Voorbeeldstraat 12',addressLine2:'Bus 3',postalCode:'9000',city:'Gent',country:'BE'},seller:{legalName:'Andy Arys',enterpriseNumber:'1040.495.145',vatNumber:'BE1040.495.145',address:'Savooistraat 50, 9400 Ninove, België',email:'info@andyarijs.dev',phone:'+32 486 25 07 05',country:'BE'}});
const render=(value=invoice(),options={})=>renderInvoicePDF(value,{fontBytes,...options});
function decodeUnicode(hex){let result='';for(let at=0;at<hex.length;at+=4)result+=String.fromCharCode(parseInt(hex.slice(at,at+4),16));return result;}
async function parsed(bytes){
 const document=await PDFDocument.load(bytes),runs=[];
 for(const [pageIndex,page]of document.getPages().entries()){
  const fonts=page.node.Resources().lookup(PDFName.of('Font'),PDFDict),maps=new Map();
  for(const [name,ref]of fonts.entries()){
   const descriptor=document.context.lookup(ref,PDFDict),stream=descriptor.lookup(PDFName.of('ToUnicode'),PDFRawStream),cmap=new TextDecoder().decode(decodePDFRawStream(stream).decode()),map=new Map();
   for(const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const item of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))map.set(item[1].toUpperCase(),decodeUnicode(item[2]));maps.set(name.toString().slice(1),map);
  }
  const contents=page.node.Contents();for(let n=0;n<contents.size();n++){
   const content=new TextDecoder().decode(decodePDFRawStream(document.context.lookup(contents.get(n),PDFRawStream)).decode());
   for(const block of content.split(/\bBT\s/).slice(1)){
    const font=/\/([^\s]+)\s+([\d.]+)\s+Tf/.exec(block),position=/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(block),encoded=/<([0-9A-Fa-f]+)>\s*Tj/.exec(block);assert.ok(font&&position&&encoded,'text run has explicit font, matrix and bytes');const map=maps.get(font[1]);let text='';for(let at=0;at<encoded[1].length;at+=4){const code=encoded[1].slice(at,at+4).toUpperCase();assert.ok(map.has(code),'every glyph has a Unicode mapping');text+=map.get(code);}runs.push({text,size:Number(font[2]),x:Number(position[1]),y:Number(position[2]),page:pageIndex});
   }
  }
 }
 return {document,runs,text:runs.map(x=>x.text).join('\n')};
}
function assertNoActiveContent(document){
 for(const key of ['OpenAction','AA','AcroForm','Names'])assert.equal(document.catalog.has(PDFName.of(key)),false,key);
 for(const page of document.getPages())for(const key of ['Annots','AA'])assert.equal(page.node.has(PDFName.of(key)),false,key);
 for(const [,value]of document.context.enumerateIndirectObjects())if(value instanceof PDFDict)for(const key of ['JS','JavaScript','URI','Launch','RichMediaContent','EmbeddedFiles'])assert.equal(value.has(PDFName.of(key)),false,key);
}

test('paid invoice is a readable A4 PDF with legal seller/buyer, invoice number, exempt total and no second payment request',async()=>{
 const original=invoice(),bytes=await render(original),result=await parsed(bytes);assert.ok(bytes instanceof Uint8Array);assert.equal(result.document.getPageCount(),1);assert.equal(result.document.getPages()[0].getWidth(),595.28);assert.equal(result.document.getPages()[0].getHeight(),841.89);assert.equal(result.document.getTitle(),original.number);
 for(const text of [original.number,original.buyer.name,original.buyer.addressLine1,original.buyer.addressLine2,original.seller.legalName,original.seller.vatNumber,original.seller.enterpriseNumber,original.paymentReference,original.orderReference,INVOICE_TAX_EXEMPTION,'Vrijgesteld','Nog te betalen','€ 0,00','€ 5,00','13:00 (Brussel)','Deze aankoop is voldaan via Mollie.'])assert.ok(result.text.includes(text),text);
 assert.doesNotMatch(result.text,/21\s*%|bankoverschrijving|scan.*QR|Te betalen op|VOORBEELD/);assertNoActiveContent(result.document);assert.equal(original.number,'RIG-2026-000001');
});

test('all offered packages preserve the integer amount, and preview cannot look like a real issued invoice',async()=>{
 for(const amount of [500,1000,2500]){const value=invoice();value.amountCents=value.creditCents=amount;const {text}=await parsed(await render(value));assert.match(text,new RegExp('€ '+(amount/100).toFixed(2).replace('.',',')));assert.ok(text.includes('1'));}
 const value=invoice(),result=await parsed(await render(value,{preview:true}));assert.match(result.text,/VOORBEELD - NIET UITGEREIKT/);assert.match(result.text.replace(/\s+/g,' '),/geen echte factuur of betaalbevestiging/);assert.doesNotMatch(result.text,/RIG-2026-000001/);assert.match(result.document.getTitle(),/voorbeeldfactuur/);assertNoActiveContent(result.document);
});

test('embedded Noto preserves Latin, Greek and Cyrillic names without replacement glyphs',async()=>{
 const value=invoice();value.buyer.name='Zoë Łukasz Nguyễn - Ελένη Παπαδοπούλου - Владимир Иванов';value.buyer.city='Αθήνα - Москва';const result=await parsed(await render(value));assert.equal(supportsInvoiceText(value.buyer.name,fontBytes),true);const right=result.runs.filter(r=>r.x>=300&&r.y<740&&r.y>47).map(r=>r.text).join('').replace(/\s/g,'');assert.ok(right.includes(value.buyer.name.replace(/\s/g,'')));assert.ok(right.includes(value.buyer.city.replace(/\s/g,'')));assert.doesNotMatch(result.text,/\uFFFD|\u0000/);
 assert.deepEqual(Buffer.from(notoSansRegularBase64,'base64'),Buffer.from(fontBytes));assert.match(await readFile(new URL('./fonts/LICENSE-NotoSans.txt',import.meta.url),'utf8'),/SIL OPEN FONT LICENSE Version 1\.1/);
});

test('unsupported characters fail before a document is returned, rather than silently changing a legal name',async()=>{
 for(const name of ['Test 😀','李明']){const value=invoice();value.buyer.name=name;assert.equal(supportsInvoiceText(name,fontBytes),false);await assert.rejects(render(value),error=>error.code==='INVOICE_UNSUPPORTED_GLYPH'&&/U\+/.test(error.message));}
 for(const bytes of [undefined,new Uint8Array(2),new Uint8Array(11000)])await assert.rejects(renderInvoicePDF(invoice(),{fontBytes:bytes}),error=>error.code==='INVOICE_FONT_REQUIRED');
 assert.equal(supportsInvoiceText('Naam\nander',fontBytes),false);assert.equal(supportsInvoiceText('Naam\u202eander',fontBytes),false);
});

test('amount, date, exemption and complete legal identity checks reject inconsistent invoice data',async()=>{
 for(const amountCents of [0,-1,1.1,Infinity,NaN,Number.MAX_SAFE_INTEGER,1000001,'500'])await assert.rejects(render({...invoice(),amountCents}),error=>error.code==='INVOICE_INVALID_AMOUNT');
 for(const creditCents of [0,1.1,100000001,'500'])await assert.rejects(render({...invoice(),creditCents}),error=>error.code==='INVOICE_INVALID_AMOUNT');
 for(const patch of [{currency:'USD'},{quantity:2},{vatAmountCents:105},{taxExemption:'Article 44'},{description:'Andere dienst'}])await assert.rejects(render({...invoice(),...patch}),error=>error.code==='INVOICE_INVALID_AMOUNT');
 for(const patch of [{issuedDate:'2026-02-30'},{issuedDate:'2026-11-08'},{number:'RIG-2025-000001'},{number:'1'},{paidAt:'2026-02-30T12:00:00.000Z'},{paidAt:'2026-11-09'},{issuedAt:Date.parse('2026-11-09T11:00:00Z')}])await assert.rejects(render({...invoice(),...patch}));
 for(const field of ['name','addressLine1','postalCode','city','country']){const value=invoice();value.buyer[field]='';await assert.rejects(render(value));}
 for(const field of ['legalName','address','enterpriseNumber','vatNumber','email','phone','country']){const value=invoice();value.seller[field]='';await assert.rejects(render(value));}
 const malicious=invoice();malicious.buyer.name='Test\nInjected';await assert.rejects(render(malicious),error=>error.code==='INVOICE_INVALID_FIELD');
});

test('Brussels local issue date handles a payment close to UTC midnight',async()=>{
 const value=invoice();value.paidAt='2026-11-08T23:30:00.000Z';value.issuedAt=Date.parse('2026-11-08T23:45:00Z');value.issuedAt=new Date(value.issuedAt).toISOString();const result=await parsed(await render(value));assert.ok(result.text.includes('09/11/2026, 00:30 (Brussel)'));
 value.issuedDate='2026-11-08';await assert.rejects(render(value),error=>error.code==='INVOICE_INVALID_DATE');
});

test('long names, addresses and references wrap and paginate without clipping or dropping legal fields',async()=>{
 const value=invoice();value.buyer.name=('Lange officiële naam ').repeat(9).trim();value.buyer.addressLine1=('Lange straatnaam ').repeat(13).trim();value.buyer.addressLine2=('Tweede adresregel ').repeat(8).trim();value.buyer.city=('Lange woonplaats ').repeat(7).trim();value.seller.legalName=('Lange wettelijke verkopersnaam ').repeat(6).trim();value.seller.address=('Groot administratief adres ').repeat(18).trim();value.seller.email='x'.repeat(220)+'@example.invalid';value.paymentReference='tr_'+'X'.repeat(80);value.amountCents=1000000;value.creditCents=100000000;
 const result=await parsed(await render(value));assert.ok(result.document.getPageCount()>=2);const packed=[result.text,...[false,true].map(right=>result.runs.filter(r=>(r.x>=300)===right&&r.y<740&&r.y>47).map(r=>r.text).join(''))].map(x=>x.replace(/\s/g,''));for(const field of [value.buyer.name,value.buyer.addressLine1,value.buyer.addressLine2,value.buyer.city,value.seller.legalName,value.seller.address,value.seller.email,value.paymentReference])assert.ok(packed.some(text=>text.includes(field.replace(/\s/g,''))),field);
 for(const run of result.runs){const width=sourceFont.layout(run.text).glyphs.reduce((sum,glyph)=>sum+glyph.advanceWidth,0)*run.size/sourceFont.unitsPerEm;assert.ok(run.x>=47.9,run.text);assert.ok(run.x+width<=547.4,run.text);assert.ok(run.y>=26&&run.y+run.size<=801,run.text);}
 assertNoActiveContent(result.document);
});

test('PDF-looking source text stays printable content and cannot create actions, links or script objects',async()=>{
 const value=invoice();value.buyer.name='Test ) /OpenAction << /S /JavaScript /JS (alert(1)) >>';value.buyer.addressLine1='https://example.invalid/ 12';const result=await parsed(await render(value));assert.ok(result.runs.filter(r=>r.x>=300&&r.y<740&&r.y>47).map(r=>r.text).join('').replace(/\s/g,'').includes(value.buyer.name.replace(/\s/g,'')));assertNoActiveContent(result.document);
});


test('renderer bundles for a Worker without Node filesystem, network or font-loading dependencies',async()=>{
 const bundled=await build({entryPoints:[new URL('./invoice-pdf.mjs',import.meta.url).pathname],bundle:true,platform:'browser',format:'esm',target:'es2022',write:false,logLevel:'silent'});assert.equal(bundled.outputFiles.length,1);const source=bundled.outputFiles[0].text;assert.match(source,/renderInvoicePDF/);assert.doesNotMatch(source,/(?:from|require\()[ \"']*node:(?:fs|http|https)|readFileSync|fetch\(/);
});
