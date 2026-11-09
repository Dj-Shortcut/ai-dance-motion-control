// Pure invoice renderer. It draws text/vector marks only: no HTML, network,
// filesystem, links, scripts, forms or external resources enter the PDF.
import {PDFDocument,PDFName,rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export const INVOICE_TAX_EXEMPTION='Bijzondere vrijstellingsregeling van belasting';
const PAGE=[595.28,841.89],MARGIN=48,WIDTH=PAGE[0]-2*MARGIN,FLOOR=68;
const palette={paper:rgb(.985,.981,.966),ink:rgb(.08,.11,.10),muted:rgb(.36,.41,.39),line:rgb(.82,.86,.83),mint:rgb(.42,.73,.62),softMint:rgb(.86,.94,.89),white:rgb(1,1,1)};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONTROL=/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const COUNTRY={BE:'België',NL:'Nederland'};
export class InvoicePDFError extends Error{constructor(code,message){super(message);this.name='InvoicePDFError';this.code=code;}}
const fail=(code,message)=>{throw new InvoicePDFError(code,message);};
function bytes(value){if(!(value instanceof Uint8Array)||value.length<10000||value.length>4*1024*1024)fail('INVOICE_FONT_REQUIRED','Het factuurlettertype ontbreekt of is ongeldig.');return value;}
function fontCoverage(fontBytes){try{const font=fontkit.create(bytes(fontBytes));if(!Array.isArray(font.characterSet)||!font.characterSet.length)throw Error();return new Set(font.characterSet);}catch(error){if(error instanceof InvoicePDFError)throw error;fail('INVOICE_FONT_REQUIRED','Het factuurlettertype kon niet worden gelezen.');}}
export function supportsInvoiceText(text,fontBytes){if(typeof text!=='string'||CONTROL.test(text))return false;const coverage=fontCoverage(fontBytes);return Array.from(text.normalize('NFC')).every(char=>coverage.has(char.codePointAt(0)));}
function text(value,label,max,{empty=false}={}){if(typeof value!=='string'||CONTROL.test(value)||Array.from(value).length>max||(!empty&&!value.trim()))fail('INVOICE_INVALID_FIELD','Controleer '+label+'.');return value.trim().normalize('NFC');}
function realDate(value){return typeof value==='string'&&/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
const brusselsDate=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const displayDate=value=>value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4);
const displayPaid=value=>new Intl.DateTimeFormat('nl-BE',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value))+' (Brussel)';
const euros=value=>'€ '+new Intl.NumberFormat('nl-BE',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value/100);
function validated(invoice,preview){
 if(!invoice||typeof invoice!=='object'||Array.isArray(invoice)||typeof preview!=='boolean')fail('INVOICE_INVALID_FIELD','De factuurgegevens ontbreken.');
 const number=text(invoice.number,'het factuurnummer',32);if(!/^RIG-20\d{2}-\d{6,12}$/.test(number)&&!(preview&&number==='VOORBEELD'))fail('INVOICE_INVALID_FIELD','Het factuurnummer is ongeldig.');
 if(!realDate(invoice.issuedDate)||(!preview&&number.slice(4,8)!==invoice.issuedDate.slice(0,4)))fail('INVOICE_INVALID_DATE','De factuurdatum is ongeldig.');
 const paidAt=invoice.paidAt;if(typeof paidAt!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(paidAt)||!Number.isFinite(Date.parse(paidAt))||brusselsDate(paidAt)>invoice.issuedDate)fail('INVOICE_INVALID_DATE','Controleer de bevestigde betaaldatum.');
 const paid=new Date(paidAt);if(paid.toISOString().slice(0,19)!==paidAt.slice(0,19))fail('INVOICE_INVALID_DATE','De betaaldatum bestaat niet.');
 if(invoice.issuedAt!==undefined){const at=typeof invoice.issuedAt==='string'&&/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(invoice.issuedAt)?Date.parse(invoice.issuedAt):invoice.issuedAt;if(!Number.isSafeInteger(at)||at<=0||at>8640000000000000||typeof invoice.issuedAt==='string'&&new Date(at).toISOString().slice(0,19)!==invoice.issuedAt.slice(0,19)||brusselsDate(at)!==invoice.issuedDate||Date.parse(paidAt)>at)fail('INVOICE_INVALID_DATE','De uitgiftedatum en betaalbevestiging komen niet overeen.');}
 if(!Number.isSafeInteger(invoice.amountCents)||invoice.amountCents<1||invoice.amountCents>1000000||!Number.isSafeInteger(invoice.creditCents)||invoice.creditCents<1||invoice.creditCents>100000000)fail('INVOICE_INVALID_AMOUNT','Het factuurbedrag of tegoed is ongeldig.');
 if(invoice.currency!==undefined&&invoice.currency!=='EUR'||invoice.quantity!==undefined&&invoice.quantity!==1||invoice.vatAmountCents!==undefined&&invoice.vatAmountCents!==0||invoice.taxExemption!==undefined&&invoice.taxExemption!==INVOICE_TAX_EXEMPTION||invoice.description!==undefined&&invoice.description!=='RIG-tegoed voor AI-videogeneratie')fail('INVOICE_INVALID_AMOUNT','De factuur moet het bevestigde RIG-tegoed in euro en de kleineondernemersvrijstelling gebruiken.');
 const orderReference=text(invoice.orderReference,'de bestelreferentie',40);if(!orderReference.startsWith('RIG-')||!UUID.test(orderReference.slice(4)))fail('INVOICE_INVALID_FIELD','De bestelreferentie is ongeldig.');
 const paymentReference=text(invoice.paymentReference,'de Mollie-betaalreferentie',83);if(!/^tr_[A-Za-z0-9]{6,80}$/.test(paymentReference))fail('INVOICE_INVALID_FIELD','De Mollie-betaalreferentie is ongeldig.');
 const packageId=text(invoice.packageId,'het tegoedpakket',40);if(!/^[a-z0-9_-]{1,40}$/.test(packageId))fail('INVOICE_INVALID_FIELD','Het tegoedpakket is ongeldig.');
 const buyer=invoice.buyer,seller=invoice.seller;if(!buyer||typeof buyer!=='object'||Array.isArray(buyer)||!seller||typeof seller!=='object'||Array.isArray(seller))fail('INVOICE_INVALID_FIELD','De koper- of verkopersgegevens ontbreken.');
 if(!Object.hasOwn(COUNTRY,buyer.country)||seller.country!=='BE')fail('INVOICE_INVALID_FIELD','Controleer het land van koper en verkoper.');
 const b={name:text(buyer.name,'de naam van de koper',200),addressLine1:text(buyer.addressLine1,'het adres van de koper',240),addressLine2:text(buyer.addressLine2??'','de tweede adresregel',160,{empty:true}),postalCode:text(buyer.postalCode,'de postcode',32),city:text(buyer.city,'de woonplaats',120),country:buyer.country};
 const s={legalName:text(seller.legalName,'de wettelijke verkopersnaam',200),address:text(seller.address,'het verkopersadres',500),enterpriseNumber:text(seller.enterpriseNumber,'het ondernemingsnummer',40),vatNumber:text(seller.vatNumber,'het btw-nummer',40),email:text(seller.email,'het contactadres',254),phone:text(seller.phone,'het telefoonnummer',48),country:seller.country};
 return {number:preview?'VOORBEELD':number,issuedDate:invoice.issuedDate,paidAt,orderReference,paymentReference,packageId,amountCents:invoice.amountCents,creditCents:invoice.creditCents,buyer:b,seller:s};
}

export async function renderInvoicePDF(invoice,{fontBytes,preview=false}={}){
 const value=validated(invoice,preview),coverage=fontCoverage(fontBytes);
 for(const valueText of [value.number,value.orderReference,value.paymentReference,...Object.values(value.buyer),...Object.values(value.seller)])for(const char of Array.from(valueText))if(!coverage.has(char.codePointAt(0)))fail('INVOICE_UNSUPPORTED_GLYPH','Het factuurlettertype ondersteunt teken U+'+char.codePointAt(0).toString(16).toUpperCase()+'. Controleer de naam en het adres; er is geen factuur gemaakt.');
 const document=await PDFDocument.create();document.registerFontkit(fontkit);const font=await document.embedFont(fontBytes,{subset:true});
 const stamp=new Date(value.issuedDate+'T12:00:00.000Z');document.setCreationDate(stamp);document.setModificationDate(stamp);document.setCreator('RIG');document.setProducer('RIG');document.setTitle(preview?'RIG - voorbeeldfactuur':value.number);document.setSubject(preview?'Voorbeeld, geen echte factuur of betalingsbevestiging':'Betaalde aankoop van RIG-tegoed');
 let page,y;const pages=[];
 const draw=(content,x,top,size=10,color=palette.ink)=>page.drawText(content,{x,y:top-size,font,size,color});
 const right=(content,x,top,size=10,color=palette.ink)=>draw(content,x-font.widthOfTextAtSize(content,size),top,size,color);
 function newPage(){
  if(pages.length>=12)fail('INVOICE_LAYOUT_LIMIT','De factuurgegevens zijn te lang om veilig af te drukken.');
  page=document.addPage(PAGE);pages.push(page);page.drawRectangle({x:0,y:0,width:PAGE[0],height:PAGE[1],color:palette.paper});draw('RIG',MARGIN,799,29);draw('.',MARGIN+52.5,799,29,palette.mint);
  const label=preview?'VOORBEELD':'BETAALD',pillWidth=preview?104:88;page.drawRectangle({x:PAGE[0]-MARGIN-pillWidth,y:770,width:pillWidth,height:27,color:palette.softMint});right(label,PAGE[0]-MARGIN-14,789,9,palette.ink);page.drawLine({start:{x:MARGIN,y:753},end:{x:PAGE[0]-MARGIN,y:753},thickness:.6,color:palette.line});y=733;
 }
 function room(height){if(y-height<FLOOR)newPage();}
 function wrap(content,width,size){
  const words=content.split(/\s+/u),lines=[];let line='';
  for(const word of words){const candidate=line?line+' '+word:word;if(font.widthOfTextAtSize(candidate,size)<=width){line=candidate;continue;}if(line){lines.push(line);line='';}if(font.widthOfTextAtSize(word,size)<=width){line=word;continue;}
   const pieces=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('nl',{granularity:'grapheme'}).segment(word)].map(x=>x.segment):Array.from(word);
   for(const piece of pieces){if(font.widthOfTextAtSize(line+piece,size)>width&&line){lines.push(line);line='';}if(font.widthOfTextAtSize(piece,size)>width)fail('INVOICE_LAYOUT_LIMIT','Een teken past niet op de factuur.');line+=piece;}
  }
  if(line)lines.push(line);return lines;
 }
 function paragraph(content,{x=MARGIN,width=WIDTH,size=10,leading=size*1.45,color=palette.ink,gap=0}={}){for(const line of wrap(content,width,size)){room(leading);draw(line,x,y,size,color);y-=leading;}y-=gap;}
 function labelValue(label,content){const lines=wrap(content,WIDTH-112,9.5);for(let n=0;n<lines.length;n++){room(15);if(n===0)draw(label,MARGIN,y,8.5,palette.muted);draw(lines[n],MARGIN+112,y,9.5);y-=15;}y-=3;}
 function partyLines(title,name,address,other){const width=(WIDTH-28)/2,parts=[{text:title,size:8.5,color:palette.muted,leading:17},...wrap(name,width,12).map(text=>({text,size:12,leading:17})),...address.flatMap(line=>wrap(line,width,10).map(text=>({text,size:10,leading:14}))),...other.flatMap(line=>wrap(line,width,9).map(text=>({text,size:9,color:palette.muted,leading:13})))];return parts;}
 newPage();paragraph(preview?'Voorbeeldfactuur':'Factuur',{size:25,leading:35});
 room(26);draw(value.number,MARGIN,y,11);right('Factuurdatum  '+displayDate(value.issuedDate),PAGE[0]-MARGIN,y,9.5,palette.muted);y-=33;
 const left=partyLines('VERKOPER',value.seller.legalName,[value.seller.address],['Onderneming '+value.seller.enterpriseNumber,'Btw '+value.seller.vatNumber,value.seller.email,value.seller.phone]);
 const buyerAddress=[value.buyer.addressLine1,...(value.buyer.addressLine2?[value.buyer.addressLine2]:[]),value.buyer.postalCode+' '+value.buyer.city,COUNTRY[value.buyer.country]],rightLines=partyLines('KLANT',value.buyer.name,buyerAddress,[]);
 for(let n=0;n<Math.max(left.length,rightLines.length);n++){const l=left[n],r=rightLines[n],height=Math.max(l?.leading??0,r?.leading??0);room(height);if(l)draw(l.text,MARGIN,y,l.size,l.color);if(r)draw(r.text,MARGIN+(WIDTH+28)/2,y,r.size,r.color);y-=height;}
 y-=19;room(70);page.drawLine({start:{x:MARGIN,y:y+8},end:{x:PAGE[0]-MARGIN,y:y+8},thickness:.6,color:palette.line});
 labelValue('Bestelling',value.orderReference);labelValue('Mollie-betaling',value.paymentReference);labelValue('Betaald op',displayPaid(value.paidAt));y-=17;
 room(94);draw('OMSCHRIJVING',MARGIN,y,8.5,palette.muted);right('AANTAL',PAGE[0]-MARGIN-110,y,8.5,palette.muted);right('BEDRAG',PAGE[0]-MARGIN,y,8.5,palette.muted);y-=21;page.drawLine({start:{x:MARGIN,y:y+6},end:{x:PAGE[0]-MARGIN,y:y+6},thickness:.6,color:palette.line});
 const descriptionLines=wrap('RIG-tegoed voor AI-videogeneratie',WIDTH-155,11);for(let n=0;n<descriptionLines.length;n++){draw(descriptionLines[n],MARGIN,y,11);if(n===0){right('1',PAGE[0]-MARGIN-122,y,11);right(euros(value.amountCents),PAGE[0]-MARGIN,y,11);}y-=16;}paragraph('Bijgeschreven RIG-tegoed: '+euros(value.creditCents),{size:9,leading:14,color:palette.muted});y-=24;
 const cardHeight=132;room(cardHeight+17);const top=y;page.drawRectangle({x:MARGIN,y:top-cardHeight,width:WIDTH,height:cardHeight,color:palette.white});
 draw(preview?'VOORBEELD':'AL BETAALD',MARGIN+17,top-18,9,palette.muted);for(const [n,line]of wrap(preview?'Dit document is een voorbeeld. Het is geen echte factuur of betaalbevestiging.':'Deze aankoop is voldaan via Mollie. Je hoeft niets meer te betalen.',204,10).entries())draw(line,MARGIN+17,top-40-n*15,10);
 const totalsLeft=MARGIN+267,totalsRight=PAGE[0]-MARGIN-17;draw('Subtotaal',totalsLeft,top-18,9.5,palette.muted);right(euros(value.amountCents),totalsRight,top-18,9.5);draw('Btw',totalsLeft,top-39,9.5,palette.muted);right('Vrijgesteld',totalsRight,top-39,9.5);page.drawLine({start:{x:totalsLeft,y:top-62},end:{x:totalsRight,y:top-62},thickness:.6,color:palette.line});draw('Totaal',totalsLeft,top-71,12);right(euros(value.amountCents),totalsRight,top-66,21);draw('Nog te betalen',totalsLeft,top-105,9.5,palette.muted);right(euros(0),totalsRight,top-105,9.5);y=top-cardHeight-19;
 paragraph(INVOICE_TAX_EXEMPTION,{size:9,leading:14,color:palette.muted,gap:6});
 paragraph(preview?'VOORBEELD - NIET UITGEREIKT. Er is geen betaling of factuur aangemaakt.':'Het tegoed is uitsluitend te gebruiken bij RIG. De prijs van een video zie je voordat je de generatie bevestigt.',{size:8.5,leading:13,color:palette.muted});
 for(const [index,p]of pages.entries()){
  page=p;page.drawLine({start:{x:MARGIN,y:46},end:{x:PAGE[0]-MARGIN,y:46},thickness:.6,color:palette.line});draw(preview?'VOORBEELD - geen geldige factuur':value.number,MARGIN,35,8,palette.muted);right((index+1)+' / '+pages.length,PAGE[0]-MARGIN,35,8,palette.muted);page.node.delete(PDFName.of('Annots'));
 }
 return document.save({useObjectStreams:false,addDefaultPage:false});
}
