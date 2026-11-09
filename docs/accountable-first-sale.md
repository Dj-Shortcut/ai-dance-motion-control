# Eerste RIG-verkoop: Accountable Gratis en Peppol

Dit is de operationele overdracht voor de eerste particuliere koper in Nederland. RIG maakt na een geverifieerde betaalde tegoedaankoop één originele verkoopfactuur. Accountable blijft de plek waar je die verkoop controleert en verwerkt. De overdracht gebruikt je bestaande Zoho-mail; er wordt geen betaald plan of nieuwe Peppol-registratie gestart. Een mailbevestiging is geen bewijs van een geslaagde Accountable-boeking.

## Eerste betaalde aankoop controleren

1. Open in RIG **Financiën → Administratie voor Accountable**. Kies de verkoopmaand. Controleer dat de aankoop **Betaald** is en het bijbehorende bedrag eenmaal als ontvangen en eenmaal als gekocht RIG-tegoed is vastgelegd. Een screenshot van checkout of een terugkeer naar RIG bewijst op zichzelf geen betaling.
2. Vergelijk bestelreferentie, Mollie-betalingsnummer, datum, munt, bruto aankoopbedrag en het toegekende tegoed met Mollie. Controleer ook het door de koper opgegeven land en dat dit een particuliere aankoop is. Een opgegeven land is nog geen volledige fiscale plaatsbepaling.
3. Download **Aankopen** en **Tegoedverloop** voor die maand. Bewaar die samen met Mollies betaalbewijs. Dit zijn generieke CSV-bewijsbestanden, geen bewezen Accountable-importformaat.
4. RIG vraagt vóór checkout de echte factuurnaam, straat/huisnummer, postcode, gemeente en het klantland. Na bewezen betaling en unieke tegoedbijschrijving ontstaat één factuur in de aparte, doorlopende reeks **RIG-JJJJ-000001**. De factuur bevat **Bijzondere vrijstellingsregeling van belasting**, geen aangerekende btw en een betaaldvermelding. De klant downloadt ze privé bij **Tegoed → Aankopen en hulp**. De eigenaar kan de originele PDF of een maand-ZIP downloaden in de administratie.
5. Als Zoho door de eigenaar is ingesteld, stuurt RIG elke originele PDF eenmaal van **info@andyarijs.dev** naar **inkomsten@accountable.eu**. Dat afzenderadres moet ook daadwerkelijk als primair of alternatief adres in Accountable bevestigd zijn. Open het geïmporteerde document in Accountable, controleer de gegevens en valideer het. **Verwerk de bestaande RIG-factuur als externe verkoopfactuur en behoud het RIG-factuurnummer; maak geen tweede verkoopfactuur in Accountable.** E-mailinvoer vervangt het overtikken, niet de controle. Zonder mailinstelling kun je de PDF zelf importeren.
6. De optionele handmatige referentie in RIG dient voor je aansluiting achteraf. Koppel bij documenttype Factuur uitsluitend het bestaande eigen RIG-factuurnummer. Een apart Accountable-boekingsnummer kan bij documenttype Boekingsregistratie. Bevestig zo’n beheerwijziging met je ingestelde apparaatcontrole. Kies pas **Zelf verwerkt in Accountable** nadat het document daar werkelijk is opgeslagen. RIG krijgt geen Accountable-validatie- of Peppol-ontvangstbevestiging. Bij onbekende mailstatus wordt niet blind opnieuw verstuurd: controleer eerst Zoho Verzonden en Accountable om dubbele invoer te voorkomen.
7. Bekijk **Probleemgevallen en klantvragen**. Een ontvangen herroepingsverzoek bevestigt geen bankterugbetaling. Controleer het verzoek inhoudelijk, voer een verschuldigde terugbetaling via Mollie uit en verwerk eventueel een creditnota in Accountable. Een terugboeking van RIG-tegoed en een geldterugbetaling zijn afzonderlijke feiten.

De officiële factuurgegevens moeten aansluiten op de echte verkoper: **Andy Arys**, ondernemingsnummer **1040.495.145**, btw-nummer **BE1040.495.145**, **Savooistraat 50, 9400 Ninove, België**. Gebruik voor contact **info@andyarijs.dev**. RIG is de appnaam; dit document beweert geen aparte handelsnaamregistratie.

## Geld, tegoed en kosten uit elkaar houden

| Gebeurtenis | Wat controleren | Niet dubbel tellen |
| --- | --- | --- |
| Klant koopt bijvoorbeeld €5 RIG-tegoed | Bruto betaling, Mollie-nummer en eenmaal toegekend tegoed | De latere video is geen tweede bankontvangst van dezelfde €5. De fiscale omzetdatum wordt hier niet vastgesteld. |
| Klant gebruikt tegoed voor een video | Afgeschreven tegoed, opdracht, resultaat of bewezen mislukking | Tel gekocht tegoed en verbruik niet beide als ontvangen geld. Gratis testtegoed is geen verkoopontvangst. |
| Mollie betaalt netto uit naar de bank | Bruto betalingen minus werkelijke kosten, terugbetalingen en andere inhoudingen | De bankuitbetaling is niet opnieuw omzet. Werkelijke Mollie-kosten zijn nog niet automatisch in RIG ingelezen. |
| Fal-account wordt opgeladen | Bankuitgave/vooruitbetaling en leveranciersbewijs | Een opwaardering, een Fal-factuur en een kostenraming van hetzelfde gebruik zijn geen drie werkelijke kosten. |
| Video heeft een geraamde Fal-kost | Operationele marge voor de prijsbewaking | Een raming is geen leveranciersfactuur. Werkelijk factuurbedrag, valutaomrekening en eventueel verschuldigde niet-aftrekbare btw moeten afzonderlijk worden gecontroleerd. |
| Fal, Mollie of hosting factureert | De echte leveranciersfactuur en betaling | Verwerk hetzelfde bewijs niet eenmaal als factuur en nogmaals als geschatte opdrachtkost. |
| Klant krijgt geld terug | Mollie-terugbetalingsbewijs, bankmutatie, eventueel creditnota | Een registratie of een terugboeking van apptegoed bewijst geen geldterugbetaling. |

Koppel voor de maandafsluiting **bruto aankopen → Mollie-kosten en correcties → netto uitbetaling → bank**. Kosten en netto uitbetalingen die RIG als onbekend toont, zijn niet nul. Het operationele margeoverzicht is geen gecertificeerde volledige nettowinst: ontbrekende facturen, belastingen, sociale bijdragen, wisselkoersen en terugbetalingen kunnen het resultaat veranderen.

## Wat het gratis Accountable-plan wel en niet dekt

Volgens de officiële planinformatie op 9 november 2026:

- De gratis mobiele app ondersteunt onbeperkt factureren, Peppol verzenden/ontvangen en één bankkoppeling.
- Er geldt een limiet van **vijf verwerkte uitgavendocumenten per maand**. Controleer hoeveel echte Fal-, Mollie-, hosting- en andere bewijsstukken je totaal hebt. Maak geen kunstmatige verzamelfacturen om die limiet te omzeilen. Bewaar ook bewijs dat niet meer binnen de gratis verwerking past.
- De gratis versie heeft geen desktop/webtoegang of belastingaangiften. **Accountable Connect is niet inbegrepen**.
- Een publieke inkomende facturatie-API of willekeurige CSV-import op Gratis is niet aangetoond. De ondersteunde PDF-invoer per e-mail is de automatische overdracht. Accountable kan nog ontbrekende of onjuist herkende gegevens tonen; controleer bedrag, nummer, koper en vrijstelling voordat je valideert. De CSV-bestanden zijn aanvullend aansluitbewijs, geen boekhoudimport.

Laat de bestaande **Accountable/Storecove-Peppolactivering** behouden. Maak geen tweede registratie en migreer geen toegangspunt zonder eerst de bestaande registratie en de gevolgen te controleren.

## Peppol en btw: afgebakende eerste verkoop

De eerste online verkoopflow is voor **particuliere klanten in België of Nederland**. Voor deze particuliere Nederlandse koper geldt geen Belgische verplichting om de verkoopfactuur als gestructureerde B2B-e-factuur via Peppol te verzenden. De Belgische B2B-verplichting vanaf 2026 geldt in beginsel ook voor kleine vrijgestelde ondernemingen; een latere zakelijke aankoop vraagt dus een aparte flow en controle.

De eigenaar verklaart de Belgische kleineondernemersvrijstelling te gebruiken, geen OSS-registratie te hebben en in **zowel 2025 als 2026 onder €10.000 kwalificerende grensoverschrijdende verkopen** te blijven. Bewaar die verklaring en volg de drempel op. Deze verklaring is geen automatische kwalificatie van RIG-tegoed en bewijst niet op zichzelf dat iedere verkoop of buitenlandse leveranciersfactuur zonder bijkomende btw-verplichtingen kan worden geboekt. De €10.000-regel kent voorwaarden; de fiscale behandeling van tegoed hangt ook af van de concrete levering en van wat bij uitgifte vaststaat.

De huidige facturatie is begrensd tot deze BE/NL-consumentenflow, de Belgische verkoper en de door de eigenaar bevestigde vrijstelling en drempelverklaring. Er wordt geen OSS-keuze of btw-aangifte ingediend. De veronderstelling is dat de plaats en vrijstelling van de beschikbare RIG-diensten bij de tegoedaankoop vaststaan; er wordt geen algemeen fiscaal oordeel voor andere vouchers of landen geautomatiseerd. Bij wijziging van landen, zakelijke verkoop, vrijwillige bestemmingsheffing, drempeloverschrijding, tegoedvoorwaarden of productaanbod moet de fiscale inrichting opnieuw worden beoordeeld vóór de nieuwe verkoopflow wordt aangezet. De app mag een operationele reserve gebruiken voor prijsbewaking; die reserve is geen vastgestelde belasting.

## Controlelijst vóór een maand als afgewerkt geldt

- Iedere werkelijk betaalde aankoop heeft betaald bewijs, unieke tegoedtoekenning en een passende externe verkoopregistratie.
- De originele RIG-facturen staan in Accountable en zijn gecontroleerd; optionele referenties helpen de aansluiting. Oudere uitgereikte documenten blijven onveranderd, correcties gebeuren met een afzonderlijk document/creditnota met verwijzing naar het origineel.
- Bruto betalingen, correcties, werkelijke Mollie-kosten en netto bankontvangsten zijn afgestemd.
- Echte leveranciersfacturen zijn eenmaal verwerkt; ramingen en opwaarderingen zijn herkenbaar gescheiden.
- Herroepingen, terugbetalingen, negatieve saldi en onbekende opdrachten zijn onderzocht; geen onzekere staat is als opgelost weggeboekt.
- De gratis vijfdocumentenlimiet, klantlanden en omzetdrempels zijn opnieuw bekeken.

Een afgevinkte referentie in RIG maakt de boekhouding niet automatisch volledig. Deze lijst is een werkprocedure voor het verzamelen en aansluiten van bewijs, geen fiscale certificering.

## Officiële bronnen

Geraadpleegd op 9 november 2026:

- [Accountable Gratis: mogelijkheden en limieten](https://www.accountable.eu/nl-be/help-center/accountable-gratis-plan-wat-je-kan-doen-in-de-mobiele-app/)
- [Accountable: verkoopfacturen via e-mail invoeren](https://www.accountable.eu/nl-be/help-center/voeg-facturen-vanaf-je-e-mail-toe/)
- [Accountable: alternatieve afzenderadressen](https://www.accountable.eu/nl-be/help-center/richtlijn-voor-accountable-gebruikers/)
- [Belgisch facturatiebesluit: inhoud, nummering en vrijstellingsvermelding](https://www.ejustice.just.fgov.be/eli/besluit/1992/12/29/1992003823/justel)
- [Accountable: bankrekening koppelen](https://www.accountable.eu/nl-be/help-center/hoe-verbind-ik-mijn-bankrekening-met-accountable/)
- [Accountable Connect en uitgesloten abonnementen](https://www.accountable.eu/nl-be/help-center/accountable-connect-hoe-verbind-je-accountable-met-je-externe-boekhoudsoftware-2/)
- [Accountable: Peppol en facturatie](https://www.accountable.eu/nl-be/help-center/accountable-gebruiken-voor-peppol-en-facturatie-hoe-werkt-het/)
- [Belgische overheid: voor wie e-facturatie verplicht wordt](https://efactuur.belgium.be/nl/article/voor-wie-wordt-e-facturatie-verplicht)
- [Belgische overheid: start van de verplichting](https://efactuur.belgium.be/nl/article/vanaf-wanneer-e-facturering-verplicht)
- [FOD Financiën: elektronische diensten en OSS](https://financien.belgium.be/nl/ondernemingen/btw/e-commerce/oss/diensten)
- [FOD Financiën: kleineondernemersvrijstelling](https://financien.belgium.be/nl/ondernemingen/btw/btw-plicht/vrijstellingsregeling)
- [EU-richtlijn 2016/1065: voucherdefinities en btw-moment](https://eur-lex.europa.eu/eli/dir/2016/1065/oj/eng)
- [KBO: onderneming 1040.495.145](https://kbopub.economie.fgov.be/kbopub/zoeknummerform.html?nummer=1040495145&actionLu=Zoek)
