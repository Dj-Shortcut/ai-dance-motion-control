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

In **Credits & Tiers** bestaat **Auto top-up**. Bij deze controle stond die uit
en was geen kaart gekoppeld. Dit is een gedateerde waarneming, geen garantie
over de huidige instellingen of het actuele Fal-saldo.

De in de Fal-bediening getoonde combinatie **US$20 aanvullen bij US$10
resterend** is geen bewezen RIG-financieringsbeleid. Het voorstel voor een
beperkte start is **US$20 aanvullen onder US$20**, naast de hieronder beschreven
controle op uitstaand tegoed. De gebruiker heeft gekozen om eerst samen de
bedragen te bekijken. Geen van deze instellingen is goedgekeurd of geactiveerd;
er is hiervoor geen afschrijving toegestaan of uitgevoerd. Bij een saldo onder
de drempel kan inschakelen al tot een aanvulling leiden.

In het bekeken Fal-scherm was geen maandlimiet zichtbaar. Daaruit volgt niet
dat Fal nergens een aanvullende limiet aanbiedt. RIG heeft momenteel een
gedeelde daglimiet voor providerautorisaties, standaard US$10 per UTC-dag.
Dat is geen maandlimiet en geen limiet voor automatische kaartaanvullingen.
Gebruik via de Mac-app, het Fal-dashboard of andere toepassingen valt buiten
de RIG-autorisaties.

Automatisch aanvullen kan de kaart belasten voordat Mollie het klantgeld heeft
uitbetaald. Een storing, geweigerde kaart of lege Fal-wallet kan generatie
blokkeren terwijl klanten nog geldig RIG-tegoed hebben.

## Nieuwe verkoopcontrole: geïmplementeerd, nog niet geactiveerd

`web/funding-coverage.mjs` leest met de **generatiesleutel zelf** uitsluitend
`GET https://api.fal.ai/v1/account/billing?expand=credits`. Vereist zijn
`billing:usage:read`, de juiste USD-valuta en een serverzijdig vastgelegde
Fal-accountnaam. Een ander account, ontbrekend recht, time-out, ongeldige
respons of ontbrekende instelling weigert een nieuwe aankoop vóór Mollie.
Er wordt geen sleutel of accountnaam aan klanten teruggestuurd.

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

## Wat er nog voor activering nodig is

1. Publiceer de geteste server én website, met een vooraf gecontroleerde back-up
   van de bestaande Cloudflare-instellingen en data. De Cloudflare-aanmelding
   moet hiervoor beschikbaar zijn; samenvoegen op GitHub publiceert dit niet.
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
4. Spreek aanvulbedrag, drempel en gewenst budget af. De gebruiker koppelt zelf
   een kaart bij Fal en bevestigt daar de automatische afschrijving. RIG heeft
   geen kaart of bevoegdheid gekregen om zelf geld van Mollie naar Fal te sturen.
5. Controleer de werkelijke verkoopstatus. Een eerste live klantaankoop en de
   administratie blijven afzonderlijke bewijsstappen; lokale tests bewijzen die
   niet. Spreek een echte proefbetaling apart af.

Bij de voorgestelde drempel van US$20 is er zonder andere verplichtingen ruimte
voor één €25-pakket plus buffer. Veel ongebruikt klanttegoed kan de verkoop
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

## Bewijs voor de eerste verkoop

Een volledige eerste **live** klantaankoop met automatische tegoedboeking,
uitgereikte factuur en aantoonbare ontvangst/import in Accountable is nog
niet waargenomen. Lokale rekentests, betaalfixtures en een ingestelde
mailkoppeling bewijzen die eindstap niet. Zie
[accountable-first-sale.md](accountable-first-sale.md) voor de afzonderlijke
controle van de factuur en administratie.
