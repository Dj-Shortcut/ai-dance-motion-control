# RIG-tegoed en Fal-financiering

## Twee afzonderlijke geldstromen

| Stap | Wat er gebeurt |
| --- | --- |
| Klant koopt bijvoorbeeld €25 RIG-tegoed | Mollie verwerkt de betaling. RIG controleert de betaling bij Mollie en boekt het eurotegoed met een unieke ledgerboeking. Dit draait in de cloud; de Mac hoeft niet aan te staan. Een terugkeer naar de website alleen bewijst geen betaling. |
| Klant bevestigt een video | RIG reserveert het getoonde bedrag uit zijn RIG-tegoed. De bevestigde opdracht gebruikt de afzonderlijke Fal-wallet van de eigenaar, in USD. |
| Mollie betaalt de verkoper uit | Dit is een afzonderlijke kasontvangst, volgens de werkelijke uitbetalingsafspraken en kosten. Een betaalde bestelling is niet noodzakelijk al op de bank ontvangen. |

Een aankoop van €25 betekent €25 bruto ontvangen bij Mollie en €25 uitstaand
RIG-tegoed. Het is geen €25 vrije winst en stort niets automatisch op Fal.
De operationele rapportage onderscheidt kasontvangsten, uitstaand tegoed,
verbruikte video-omzet, geschatte kosten en werkelijk ingevoerde kosten;
zie [profit-monitoring.md](profit-monitoring.md).

## Gezien in Fal op 12 november 2026

De opnieuw geladen instelling in **Credits & Tiers → Auto top-up** is
**ingeschakeld: US$20 aanvullen onder US$10**. Een later ingevulde wijziging
is niet opgeslagen. Dit is een gedateerde controle van de opgeslagen instelling,
geen bewijs van een latere automatische afschrijving.

Fal voert de aanvulling uit via zijn eigen betaalinstelling. Mollie-ontvangsten
worden niet automatisch naar Fal overgeboekt. RIG rekent uitsluitend aantoonbaar
aanwezige Fal-dekking mee, nooit een toekomstige automatische aanvulling.

In het bekeken Fal-scherm was geen maandlimiet zichtbaar. Daaruit volgt niet
dat Fal nergens een aanvullende limiet aanbiedt. RIG heeft momenteel een
gedeelde daglimiet voor providerautorisaties, standaard US$10 per UTC-dag.
Dat is geen maandlimiet en geen limiet voor automatische kaartaanvullingen.
Gebruik via de Mac-app, het Fal-dashboard of andere toepassingen valt buiten
de RIG-autorisaties.

Automatisch aanvullen kan de kaart belasten voordat Mollie het klantgeld heeft
uitbetaald. Een storing, geweigerde kaart of lege Fal-wallet kan generatie
blokkeren terwijl klanten nog geldig RIG-tegoed hebben.

## Verkoopcontrole en afzonderlijke activering

`web/funding-coverage.mjs` leest met de **generatiesleutel zelf** uitsluitend
`GET https://api.fal.ai/v1/account/billing?expand=credits`. Vereist zijn
`billing:usage:read`, de juiste USD-valuta en een serverzijdig vastgelegde
Fal-accountnaam. Een ander account, ontbrekend recht, time-out, ongeldige
respons of ontbrekende instelling weigert een nieuwe aankoop vóór Mollie.
Er wordt geen sleutel of accountnaam aan klanten teruggestuurd.

De uitgelezen antwoordbody blijft begrensd tot 16 KiB en tien seconden. Workers
kan gzip/brotli al hebben uitgepakt terwijl `Content-Length` nog de ingepakte
lengte aangeeft; alleen bij `identity` wordt die header daarom exact met de
gelezen bytes vergeleken. Onbekende coderingen en ongeldige antwoorden blijven
geweigerd. De bestaande eigenaarroute geeft bij een fout uitsluitend een vaste
diagnosecategorie en HTTP-status, zonder providertekst of geheime gegevens.
Klant- en kooproutes krijgen deze diagnose niet.

Dezelfde D1-transactie als de nieuwe bestelling controleert opnieuw hoeveel
ruimte over is. Twee klanten kunnen zo niet dezelfde voorraad toegewezen
krijgen. De berekening telt mee:

- Alle positieve klantensaldi. Een negatief saldo bij iemand anders trekt
  geen schuld aan een klant af.
- Niet-afgewikkelde videoreserveringen en open/onzekere betalingen. Een betaald
  en aantoonbaar eenmaal geboekt pakket wordt niet nog eens als open betaling
  gerekend.
- Recente en onzekere providerkosten, inclusief eigen RIG-gebruik en lopende
  verwerkingsketens, plus een afzonderlijke USD-buffer. De kostenraming blijft
  conservatief meetellen nadat de opdracht eindigt om vertraagde saldi op te
  vangen.

De USD-dekking per eurocent volgt uit de actuele prijs- en margeaannames van
RIG en wordt omhoog afgerond. Met het huidige standaardbeleid is dat
**4508 USD-micro per eurocent**: een pakket van €25 vraagt maximaal ongeveer
**US$11,27 geraamde providerdekking**, naast de **US$6 buffer** en bestaande
verplichtingen. Dit zijn planningsaannames, geen garantie op werkelijke
Fal-kosten, btw, wisselkoers of bankkosten. Een beleidswijziging tussen uitlezing
en bestelling maakt de oude toelating ongeldig.

Bij ontbrekende of onvoldoende dekking blijven nieuwe aankopen gepauzeerd.
De klant kan bestaande betalingen nog controleren of hervatten; webhooks,
tegoedboeking en factuurherstel worden niet door deze verkoopcontrole geblokkeerd.
Eigen betaalde opdrachten binnen RIG moeten bij geactiveerde dekking ook langs
dezelfde voorraadcontrole, zodat ze de klantreserve niet opeten. Eigen gebruik
vóór activering blijft langs het bestaande dagbudget en apparaatbevestiging lopen.

In **Financiën → Tegoed verkopen** ziet alleen de eigenaar de geobserveerde
Fal-voorraad, berekende dekking en ruimte voor nieuwe verkoop. De klant ziet
pakketprijzen en beschikbaarheid, zonder interne marge of Fal-saldo.

Een hergebruikte saldo-uitlezing is maximaal tien seconden oud; de toelating
vervalt uiterlijk na zestig seconden en SQL controleert bij invoegen opnieuw.
Het getoonde tijdstip is wanneer RIG de API las. Fal geeft geen tijdstip van het
onderliggende saldo of een gegarandeerde actualiteit. Het conservatieve venster
van negentig minuten is een RIG-aanname, geen Fal-garantie. Buiten RIG gemaakte
kosten en onverwachte prijsafwijkingen kunnen niet volledig worden afgeschermd.

## Activerings- en releasecontrole

1. Werk bij een gewijzigde gedeelde bridge-route alle betrokken deployments bij,
   na een gecontroleerde back-up:
   de native Sites-website (`rig-sites-app.mjs`), de publieke Cloudflare-relay
   (`production-ingress.mjs`) en de private Cloudflare-service
   (`closed-video-worker.mjs`). Bij nieuwe beheerroutes is alleen de website of
   private worker publiceren onvoldoende: ook de relay moet ze doorlaten.
   Een uitsluitend interne backendfix vraagt geen nieuwe publicatie van
   ongewijzigde website- of relaycode.
   Sites-versie 40 en beide Cloudflare-deployments zijn op 12 november bijgewerkt;
   dat bewijst op zichzelf nog geen geactiveerde dekkingspolicy of echte verkoop.
   Samenvoegen op GitHub publiceert deze drie onderdelen niet automatisch.
2. Pas de vereiste additieve migratie
   `web/production-migrations/0015_funding_coverage.sql` toe op de aparte
   productiedatabase, na de bestaande commerciële migraties. Ook een nieuwe
   database met `production-schema.sql` heeft 0015 nodig. Voer de triggers als
   volledige SQL uit. De dekking-view gebruikt geen optionele workflowtabellen;
   migratie 0014 blijft afzonderlijk nodig als verwerkingsketens worden gebruikt.
   De nieuwe policy begint uitgeschakeld; geen bestaande saldi of betalingen
   worden aangepast.
3. Controleer zonder generatie of betaling dat de bestaande Fal-sleutel de
   officiële billing-uitlezing mag uitvoeren. Leg de bevestigde accountnaam en
   buffer vast en schakel zowel de databasepolicy als
   `RIG_FUNDING_COVERAGE_ENABLED=yes` in. Ontbreekt één van deze zaken, dan
   blijven nieuwe aankopen geweigerd. Deel sleutels niet in chat/logs en verruim
   de sleutel niet voordat het ontbreken van het leesrecht werkelijk is bewezen.
4. Controleer de werkelijk opgeslagen automatische Fal-aanvulling, afzonderlijk
   van de RIG-dekkingspolicy. Bij de laatste controle was dat US$20 onder US$10;
   een wijziging vereist daadwerkelijk opslaan in Fal. RIG heeft geen bevoegdheid
   om zelf geld van Mollie naar Fal te sturen.
5. Controleer de werkelijke verkoopstatus. Een eerste live klantaankoop en de
   administratie blijven afzonderlijke bewijsstappen; lokale tests bewijzen die
   niet. Spreek een echte proefbetaling apart af.

Bij een Fal-voorraad van US$20 is er zonder andere verplichtingen ruimte voor
één €25-pakket plus buffer. Dat is een dekkingsvoorbeeld, niet de opgeslagen
Fal-aanvuldrempel. Veel ongebruikt klanttegoed kan de verkoop
echter pauzeren terwijl Fal nog boven zijn aanvuldrempel staat. Dat is bewust:
een vast aanvulbedrag kan geen onbeperkte voorverkoop dekken. Er wordt nooit een
onbewezen kaartaanvulling als al aanwezig budget meegeteld.

Een toekomstig maandplafond voor RIG-verbruik is niet hetzelfde als een
maandplafond op kaartafschrijvingen: aanvulbedragen, resterende buffers en
verbruik buiten RIG tellen anders. Reserveer dekking voor al verkocht tegoed
en pauzeer nieuwe verkopen voordat die dekking tekortschiet. Een nieuw plafond
mag niet zonder die reservering de levering aan bestaande betalende klanten
blokkeren. Een afzonderlijk Fal-team voor RIG kan verbruik van andere apps
scheiden, maar ook daarvan moeten financiering en accountbinding bewezen zijn.

Bij een onzekere eerdere inzending mag deze controle geen automatische nieuwe
opdracht of onbewezen terugboeking veroorzaken. De bestaande quote-,
bevestigings-, dagbudget- en accountcontroles blijven gelden.

## Blijvende grenzen voor klantgebruik

Voor klantaccounts reserveert RIG het providerbudget voordat bestanden naar Fal
worden geëxporteerd. Die toelating blijft in het kostenregister staan na een
mislukte poging of terugbetaling van RIG-tegoed. Een dagwissel opent dit budget
niet opnieuw. Eigen gebruik blijft langs de afzonderlijke eigenaarscontroles
en het gedeelde dagbudget lopen.

De blijvende klantgrens wordt uitsluitend gedekt door exact eenmaal geboekt,
aantoonbaar betaald aankooptegoed en de geverifieerde eenmalige promotie van
€5. Terugbetalingen van videoreserveringen en andere positieve boekingen voegen
geen nieuwe financiering toe. De USD-ramingsgrens gebruikt de laagste van de
huidige dekkingsfactor en de factor bij de eerste toelating. Daarnaast gelden
maximaal twintig providerpogingen per €5 geverifieerd toegekend tegoed en blijvende
grenzen voor het aantal en de bytes van bestandsvoorbereidingen. De bestaande
dag- en globale voorbereidingsgrenzen blijven ook gelden.

Bij overschrijding stopt RIG nieuw werk. Correcte terugbetalingen naar het
RIG-saldo blijven behouden; het extra kostenbudget wordt daardoor niet heropend.
Een conservatief gereserveerde maar onbenutte poging kan daarom onderzoek door
de eigenaar vereisen. Deze grenzen bewaken RIG-toelatingen en ramingen: zij zijn
geen bank- of kaartlimiet en dekken geen gebruik buiten RIG of onverwachte
afwijkingen in de externe facturatie.

## Begrensde uitnodiging voor de eerste tester

De eenmalige productie-uitnodiging kent nog steeds precies **€5 RIG-tegoed**
toe. Voor die ontvanger geldt daarnaast een afzonderlijk afnamecontract,
`first-tester-bounded-v1`, geen herbruikbare algemene klantenraming:

- Maximaal **twee blijvende toelatingen**, vóór de eerste bestandsuitvoer naar
  Fal atomair vastgelegd in `rig_generation_costs`. Ook een voorbereiding die
  daarna faalt verbruikt zo'n toelating. Een refund, nieuwe UTC-dag, lagere
  prijs of bijkomende creditboeking heropent deze twee plaatsen niet.
- Alleen de exacte Kling V3 Standard/Pro Motion Control-endpoints, één foto
  en een geverifieerd fragment van **3–10 seconden**. De daadwerkelijke
  providerinvoer gebruikt `character_orientation: image`; extra gezichts- of
  hoekreferenties, Edit en verwerkingsketens zijn niet toegestaan.
- Fal documenteert voor die stand maximaal tien uitvoerseconden. Per toelating
  reserveert het afnamecontract conservatief **elf hele seconden tegen maximaal
  US$0,168/seconde**: US$1,848, onafhankelijk van de kortere gekozen duur.
  Over twee toelatingen is dat **US$3,696 netto modelverbruik**. Standard mag
  maximaal US$0,126/seconde kosten, Pro US$0,168; actuele uitlezing boven die
  plafonds weigert werk, ook bij de hercontrole na uploads vóór verzending.
  Automatische providerherhaling en fallback blijven uitgeschakeld.
- De vereiste beleidsreserve is maximaal €1 per US$1, maximaal 21% btw en
  aanvullend 3% voor omrekening/kaartkosten. Dit geeft afgerond **€4,61**.
  Een hogere geconfigureerde omreken- of btwreserve blokkeert de test.

Dit is een afgedwongen grens op bestelde hoeveelheden onder Fals gepubliceerde
model- en tariefcontract. Fal biedt hiermee geen afzonderlijke vaste
eurofactuurlimiet of valutatermijncontract. Onverwachte afwijkingen van externe
facturatie of omrekening zijn niet door software in RIG af te dwingen. Het
gehele gedeelde Fal-account en automatische kaartaanvullingen zijn evenmin op
€5 gezet; ander gebruik blijft buiten deze uitnodiging.

Bronnen, gecontroleerd op 17 november 2026:
[Pro-contract](https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control/api),
[Pro-tarief](https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control),
[Standard-tarief](https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control).

De klant ziet de werkelijke resterende pogingen en duurgrens, zonder interne
Fal-bedragen. Een proefje en het vervolg tellen ieder als één poging. Bij nul
blijft herstel, afspelen en downloaden van een bestaande video beschikbaar.
Nieuwe aankopen voor dit begrensde testaccount zijn vóór checkout geweigerd,
zodat geen nieuw tegoed wordt verkocht dat de testlimiet niet kan leveren.
Bestaande betalingen, webhooks en reconciliatie blijven bereikbaar.

Vóór heractivering van een ingehouden uitnodiging: test zowel de normale
renderroute met de begrensde providerinvoer als derde-pogingweigering,
parallelle verzending, prijsstijging, refund/dagwissel en de klantweergave.
Publiceer private backend én bijbehorende Site-weergave. Verander daarna alleen
de exacte nog ongeclaimde uitnodiging; claim of crediteer nooit namens de tester.
Lokale providerfixtures zijn geen nieuwe betaalde Fal-render.

## Klantbevestiging vóór ieder videodebet

Alle nieuwe productie-opdrachten met `funding_kind='credits'` vereisen een
verse WebAuthn-passkeybevestiging met gebruikersverificatie. De eerste
klantregistratie wordt pas actief na een echte, voor de aangemelde
productie-identiteit gecontroleerde registratieceremonie. Zij verleent geen
eigenaarrechten. De server bewaart alleen de publieke sleutel; een ingetrokken
of bestaande klantpasskey kan niet met alleen een ingelogde sessie worden
vervangen. Sleutelverlies vereist de afzonderlijke hulpprocedure.

De bevestiging bindt klant, quote-ID, aanvraagcode, model, media-/optie-JSON,
bedrag, duur, prijsversie, vervaldatum en eventuele overdrachtstoestemming.
Challengeverbruik, sleutelteller, audit, tegoedreservering en nieuwe job staan
in dezelfde D1-transactie. Annuleren of een ontbrekende/gewijzigde/verlopen
bevestiging start geen Fal-werk. Instellen van een passkey start evenmin een
video; de klant bevestigt daarna uitdrukkelijk de video opnieuw. Herstel van
een reeds aanvaarde opdracht is een uitlezing en vraagt geen tweede betaalde
inzending. De eigenaar behoudt zijn bestaande afzonderlijke verificatiepad.

Pas eerst de additieve migratie `0016_customer_security.sql` toe, met beleid
`enabled=0`. Zij maakt alleen aparte klantbeveiligingstabellen, indexen en de
rollbacktrigger; bestaande geld-, klant- en eigenaarsregistraties blijven
behouden. Publiceer daarna private backend, publieke relay en de bijbehorende
Sites-client. Schakel pas na verificatie `rig_customer_security_policy.enabled`
op 1: de trigger verhindert dan ook jobcreatie met oudere servercode zonder
de exacte verbruikte klantbevestiging. Nieuwe code vereist de klantbevestiging
zelfstandig, ook tijdens die uitrol vóór triggeractivering. Verse schema's
vereisen naast `production-schema.sql` ook migratie 0016 voor de trigger.

Dit beveiligt het verbruiken van RIG-tegoed. Een bank-/kaartbetaling voor nieuw
tegoed blijft de afzonderlijke Mollie-checkout en bankbevestiging doorlopen.
WebAuthn-cryptografietests met een softwareauthenticator bewijzen de
servercontroles, niet een uitgevoerde Face ID- of Windows Hello-handeling door
de echte tester. Die handeling gebeurt op zijn eigen apparaat.

## Bewijs voor de eerste verkoop

Een volledige eerste **live** klantaankoop met automatische tegoedboeking,
uitgereikte factuur en aantoonbare ontvangst/import in Accountable is nog
niet waargenomen. Lokale rekentests, betaalfixtures en een ingestelde
mailkoppeling bewijzen die eindstap niet. Zie
[accountable-first-sale.md](accountable-first-sale.md) voor de afzonderlijke
controle van de factuur en administratie.
