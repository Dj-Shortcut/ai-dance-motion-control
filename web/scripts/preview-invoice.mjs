// Local design preview only. Never inserts invoice numbers, sends mail, changes
// customer records, or contacts Mollie. Output is visibly not an issued invoice.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {renderInvoicePDF} from '../invoice-pdf.mjs';
import {merchant} from '../commerce-profile.mjs';
const fontBytes=new Uint8Array(await readFile(new URL('../fonts/NotoSans-Regular.ttf',import.meta.url)));
const invoice={number:'VOORBEELD',issuedDate:'2026-11-09',paidAt:'2026-11-09T12:00:00.000Z',orderReference:'RIG-00000000-0000-4000-8000-000000000000',paymentReference:'tr_VOORBEELD01',packageId:'five',amountCents:500,creditCents:500,currency:'EUR',quantity:1,buyer:{name:'Zoë de Vries',addressLine1:'Voorbeeldstraat 12',addressLine2:'',postalCode:'9000',city:'Gent',country:'BE'},seller:{...merchant}};
const directory=new URL('../output/pdf/',import.meta.url),target=new URL('RIG-voorbeeldfactuur.pdf',directory);await mkdir(directory,{recursive:true});await writeFile(target,await renderInvoicePDF(invoice,{fontBytes,preview:true}));process.stdout.write(fileURLToPath(target)+'\n');
