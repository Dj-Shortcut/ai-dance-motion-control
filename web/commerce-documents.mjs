import {merchant,COMMERCE_VERSION} from './commerce-profile.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A factory lets the literal public seller content be tested with hostile text.
// Production always uses the verified, owner-approved commerce profile below.
export function createCommerceDocuments({seller=merchant,version=COMMERCE_VERSION}={}){
 const name=escape(seller.legalName),email=escape(seller.email),phone=escape(seller.phone);
 const contact=`<a href="mailto:${email}">${email}</a> · ${phone}`;
 const sellerDetails=`${name} · ondernemingsnummer ${escape(seller.enterpriseNumber)} · btw ${escape(seller.vatNumber)}<br>${escape(seller.address)}<br>${contact}`;

 const terms=`
<p>RIG maakt een video met jouw foto of video en een bewegingsvoorbeeld. De verkoper is ${name}, een Belgische eenmanszaak.</p>
<h2>Tegoed en prijzen</h2>
<p>Je koopt RIG-tegoed in euro. Het is alleen te gebruiken bij RIG en staat los van een eigen fal.ai-account. Je ziet de totale videoprijs vóór je bevestigt. De aankoop van tegoed en het gebruik ervan zijn afzonderlijke handelingen: gebruik van gekocht tegoed veroorzaakt geen tweede bankbetaling.</p>
<p>Deze versie is beschikbaar voor particuliere klanten in België en Nederland. De pakketprijs en videoprijs zijn totale consumentenprijzen. Betaalmethoden en beschikbaarheid worden op de betaalpagina van Mollie getoond.</p>
<h2>Je factuur</h2>
<p>Na een geslaagde betaling maakt RIG automatisch een factuur. Daarvoor vragen we je naam en volledige adres. Je ontvangt de factuur digitaal als download in je RIG-account; daarmee ga je bij aankoop akkoord. Je kunt je factuurgegevens aanpassen voor volgende aankopen. Reeds uitgereikte facturen blijven onveranderd bewaard. De verkoop valt onder de bijzondere vrijstellingsregeling van belasting; er wordt geen btw aangerekend.</p>
<h2>Genereren en levering</h2>
<p>Pas na je bevestiging wordt een betaalde video-opdracht gestart. Fal.ai verwerkt de geselecteerde media. Bij Video bewerken bevestig je afzonderlijk het gebruik van tijdelijke Fal-bestandslinks, die toegankelijk zijn voor wie de link heeft. Deze uitleg staat bij de videoprijs.</p>
<p>AI-resultaten kunnen afwijken van je voorbeeld. Een specifieke gelijkenis, mondbeweging of artistiek resultaat wordt niet gegarandeerd. Dat beperkt je wettelijke rechten bij een gebrekkige levering niet. Upload alleen materiaal dat je mag gebruiken, met toestemming van de betrokken personen.</p>
<p>Je resultaat komt in je account. Bij vertraging kun je de bestaande opdracht opnieuw controleren. Start een opdracht met onbekende status niet opnieuw: de verkoper onderzoekt eerst of er al een generatie is gestart.</p>
<h2>Mislukte opdrachten</h2>
<p>Bij een bevestigde technische mislukking geeft RIG het gereserveerde RIG-tegoed terug. Wanneer de uitkomst nog onbekend is, blijft het bedrag tijdelijk gereserveerd voor onderzoek. Een terugboeking van RIG-tegoed is geen terugstorting op je bankrekening.</p>
<h2>Herroepen en klachten</h2>
<p>Voor consumenten geldt in beginsel een herroepingstermijn van veertien dagen vanaf de aankoop. Je kunt een ondubbelzinnig verzoek indienen via Tegoed → Aankopen en hulp, of contact opnemen via ${contact}. Vermeld de aankoopdatum en bestelreferentie, als je die hebt. Je hoeft geen reden op te geven voor een herroeping binnen de wettelijke termijn.</p>
<p>Voor een verzoek via RIG krijg je een downloadbare ontvangstbevestiging. Dit bevestigt de ontvangst, en is geen automatische afwijzing of goedkeuring van een terugbetaling. Je mag ook bij eerder gebruikt tegoed of een oudere aankoop een verzoek indienen; de verkoper beoordeelt je wettelijke rechten en de feiten. Deze voorwaarden bevatten geen algemene uitsluiting van herroeping of van wettelijke garanties.</p>
<p>Door een video te bevestigen vraag je om de uitvoering direct te starten. RIG vraagt hier geen algemene afstand van wettelijke rechten voor. Bij betwisting behandelt de verkoper het verzoek inhoudelijk en maakt hij onderscheid tussen ongebruikt tegoed, uitgevoerde diensten en gebrekkige levering.</p>
<p>Je kunt bijvoorbeeld schrijven: “Hierbij herroep ik mijn aankoop van RIG-tegoed van [datum], bestelreferentie [referentie].” Voeg je naam en de datum van je verzoek toe en vermeld hoe we je kunnen bereiken. Dit voorbeeld is niet verplicht; je kunt ook een eigen duidelijke verklaring gebruiken.</p>
<h2>Contact en bewijs</h2>
<p>Bewaar je bestelreferentie. Naast je betalingsbewijs vind je de automatisch aangemaakte factuur bij je aankoop. Neem voor een correctie of administratieve vraag contact op met de verkoper. Voor zakelijke aankopen neem je vooraf contact op; de online verkoopflow is voor particulieren.</p>
<p>${sellerDetails}</p>`;

 const privacy=`
<p>${name} is verantwoordelijk voor de persoonsgegevens die RIG voor jouw account en dienstverlening gebruikt. Contact: ${contact}.</p>
<h2>Wat RIG verwerkt</h2>
<p>RIG gebruikt een accountidentificatie uit je ChatGPT-aanmelding, je gekozen media en omschrijving, technische opdrachtstatussen, betaal- en tegoedreferenties, je opgegeven klantland en factuurnaam en -adres, en berichten die je via de ondersteuning indient. RIG ontvangt geen bankwachtwoord of biometrische vingerafdruk.</p>
<h2>Waarom en met wie</h2>
<p>We gebruiken de noodzakelijke account-, bestel-, betaal- en mediagegevens om de overeenkomst met jou uit te voeren. Voor administratie bewaren we gegevens voor zover dat wettelijk verplicht is. Voor beveiliging, foutonderzoek en misbruikbestrijding gebruiken we noodzakelijke technische gegevens op basis van ons gerechtvaardigd belang bij een veilige dienst.</p>
<p>OpenAI verzorgt de platformaanmelding en sitehosting; Cloudflare levert de private backend en opslag; Mollie verwerkt betalingen; Fal.ai verwerkt media voor de bevestigde generatie. RIG bewaart je facturen en de daarvoor noodzakelijke naam- en adresgegevens. Voor de boekhouding kunnen deze facturen in Accountable worden verwerkt. Bij ingeschakelde automatische overdracht verstuurt RIG de factuur met naam, adres en aankoopbedrag via Zoho Mail naar Accountable. Dit gebeurt pas nadat de verkoper zijn verzendkoppeling heeft ingesteld.</p>
<p>Deze partijen kunnen gegevens buiten de EER verwerken. De private opslag van RIG maakt tijdelijke links bij Fal niet privé; de overdracht wordt apart vóór generatie uitgelegd. Neem voor vragen over gegevensverwerking of internationale doorgifte contact op via ${email}.</p>
<h2>Bewaren en rechten</h2>
<p>Tijdelijke invoerbestanden worden volgens de ingestelde opruimregels verwijderd; resultaten blijven beschikbaar zolang dat voor de dienst nodig is. Betaal-, tegoed- en bewijsgegevens kunnen langer bewaard worden wegens wettelijke verplichtingen. Een verwijderverzoek wist geen gegevens die wettelijk bewaard moeten blijven.</p>
<p>Je kunt inzage, correctie, verwijdering, beperking, overdraagbaarheid of bezwaar vragen via ${email}. Niet elk recht geldt in elke situatie. RIG controleert eerst of het verzoek bij jouw account hoort en legt eventuele beperkingen uit. Voor zover een verwerking op jouw toestemming berust, kun je die intrekken; eerdere rechtmatige verwerking wordt daardoor niet onrechtmatig. Je kunt een klacht indienen bij de <a href="https://www.gegevensbeschermingsautoriteit.be/burger" rel="noopener noreferrer">Belgische Gegevensbeschermingsautoriteit</a>.</p>
<p>Noodzakelijke accountopslag in je browser bewaart onder meer je aanmeldbinding en herstelreferenties; deze versie gebruikt die niet voor reclameprofilering.</p>
<p>${sellerDetails}</p>`;

 const help=`
<p>Vermeld je bestel- of videoreferentie wanneer je hulp vraagt. Stuur geen API-sleutels, wachtwoorden of verificatiecodes.</p>
<h2>Betaling niet zichtbaar?</h2>
<p>Open Tegoed en kies Controleer betaalstatus. Betaal niet nogmaals zolang de eerdere betaling nog wordt onderzocht. Voor een bekende betaling kan RIG de status bij Mollie opnieuw controleren.</p>
<h2>Video nog niet klaar?</h2>
<p>Controleer je bestaande opdracht. Een onbekende uitkomst betekent dat de verkoper eerst nagaat of Fal de opdracht ontvangen heeft. Er wordt geen nieuwe betaalde generatie gestart zonder nieuwe bevestiging.</p>
<h2>Herroepen of terugbetaling vragen</h2>
<p>Open Tegoed → Aankopen en hulp, kies de bestelling en dien je verzoek in. Je ontvangt in RIG een downloadbare ontvangstbevestiging. Je kunt ook rechtstreeks contact opnemen via ${contact}.</p>
<p>Een geregistreerd verzoek verandert niet automatisch je bankbetaling of tegoed. De verkoper onderzoekt het verzoek en handelt een verschuldigde terugbetaling af via de betalingsprovider. Je wettelijke rechten staan in de <a href="/voorwaarden">verkoopvoorwaarden</a>.</p>`;

 const pages=new Map([
  ['/voorwaarden',['Verkoopvoorwaarden',terms]],
  ['/privacy',['Privacy',privacy]],
  ['/hulp',['Hulp en herroepen',help]],
  ['/bedrijfsgegevens',['Wie verkoopt RIG?',`<p>${sellerDetails}</p><p>RIG is de naam van deze videodienst. De verkoper is de hierboven vermelde Belgische eenmanszaak. Officiële registratie: <a href="https://kbopub.economie.fgov.be/kbopub/zoeknummerform.html?nummer=1040495145&amp;actionLu=Zoek" rel="noopener noreferrer">KBO Public Search</a>.</p>`]],
 ]);

 return function commerceDocument(path){
  const page=pages.get(path);if(!page)return null;
  const [title,body]=page;
  return new Response(`<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · RIG</title><style>body{background:#111719;color:#e5ede9;font:16px/1.65 system-ui;margin:0;padding:24px}main{max-width:780px;margin:auto}a{color:#9de5bd}nav{display:flex;flex-wrap:wrap;gap:18px}h1{font-size:32px}h2{font-size:22px;margin-top:30px}.version{color:#9bacaa;font-size:13px}</style></head><body><main><nav aria-label="RIG informatie"><a href="/">RIG openen</a><a href="/voorwaarden">Voorwaarden</a><a href="/privacy">Privacy</a><a href="/hulp">Hulp</a><a href="/bedrijfsgegevens">Bedrijfsgegevens</a></nav><h1>${escape(title)}</h1><p class="version">Versie ${escape(version)} · 9 november 2026</p>${body}</main></body></html>`,{headers:{
   'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer',
   'permissions-policy':'camera=(), microphone=(), geolocation=()',
   'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  }});
 };
}

export const commerceDocument=createCommerceDocuments();
