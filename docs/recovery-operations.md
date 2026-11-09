# RIG: betalingen en video’s onderzoeken

Dit beheerproces onderzoekt een bestaande opdracht. Het maakt geen nieuwe betaling of video aan. Onderzoeksnotities veranderen geen saldo, heffen geen accountblokkade op en geven geen gereserveerd tegoed vrij.

## Open dossiers

De eigenaar ziet onbekende of te beoordelen betalingen, betalingen die langer dan vijf minuten op aanmaken staan, onbekende video-opdrachten en inzendingen die langer dan tien minuten vaststaan. Gewone nieuwe betalingen en normaal lopende video’s verschijnen niet meteen als probleemgeval. Notities zijn nieuwe auditregels; een bestaande notitie wordt niet overschreven. De status **Nagekeken** is een onderzoeksstatus: een onbekende financiële uitkomst blijft zichtbaar en geblokkeerd.

De lijst bevat interne bestel- en verzoeknummers, bedragen en de laatste onderzoeksnotities. Privémedia, prompts, API-sleutels en betaalkaartgegevens horen hier niet in.

## Een ontbrekend Mollie-betalingsnummer terugvinden

1. Open het exacte RIG-dossier. Zoek in het juiste Mollie-profiel de betaling waarvan `metadata.order_id` datzelfde RIG-bestelnummer bevat. De klant hoeft niet nogmaals te betalen. Een screenshot of door de klant opgegeven betaalstatus is op zichzelf geen bewijs.
2. Vul het teruggevonden `tr_…`-nummer in en controleer de getoonde bevestiging op je apparaat.
3. RIG leest bij Mollie het profiel, de live-modus, het betalingsnummer, het bedrag, de valuta en het RIG-bestelnummer. Alles moet overeenkomen. Een betalingsnummer dat al bij een andere bestelling hoort wordt geweigerd.
4. Alleen na die verificatie bewaart RIG de koppeling en controleert het de bestaande betaling opnieuw. De gewone betaalcontrole beoordeelt ook terugbetalingen en chargebacks. Een bevestigde betaling kan het exacte gekochte tegoed slechts eenmaal bijschrijven.

Een open betaling geeft nog geen tegoed. Bij een tijdelijke fout blijft het bekende betalingsnummer bewaard en de uitkomst in onderzoek; dezelfde betaling kan later opnieuw worden gecontroleerd. Er wordt geen tweede betaling aangemaakt. Bij een terugboeking of een eerder geblokkeerd account blijft aparte beoordeling nodig: de koppelfunctie heft die beveiliging niet op.

## Onbekende Fal-inzending

Leg het RIG-opdrachtnummer, de aanmaaktijd, het model, de geraamde kosten en een eventueel bekend Fal-verzoeknummer vast. Onderzoek het verzoek in het eigen Fal-account of vraag de provider om bevestiging. Deel geen publieke media-links of API-sleutels in de onderzoeksnotitie.

Zonder betrouwbare correlatie kan een willekeurig Fal-verzoeknummer niet bewijzen dat dit dezelfde klantopdracht is. Daarom bestaat hier geen knop om zo’n nummer zonder bewijs aan te nemen, de opdracht opnieuw betaald te starten, de video af te schrijven of het gereserveerde tegoed blind terug te geven. Leg de providerreactie en referentie vast als **In onderzoek**, **Wacht op provider** of **Nagekeken**. Een nog onbekende uitkomst blijft geblokkeerd.

Een uiteindelijke handmatige financiële beslissing vereist bewijs buiten deze notitiefunctie en de onafhankelijke beheerprocedure met back-up en audit. Dit scherm beweert niet dat een provider die bewijs niet levert automatisch kan worden opgelost.

## Geld terug en RIG-tegoed zijn verschillend

Een bewezen mislukte video kan volgens de normale videologica RIG-tegoed terugkrijgen. Dat is geen bankterugbetaling. Een echte terugbetaling wordt afzonderlijk bij Mollie onderzocht en uitgevoerd door de bevoegde eigenaar; een tekstnotitie of kostenregistratie verstuurt geen geld. Controleer daarna de daadwerkelijke Mollie-status en de bijbehorende RIG-administratie. Maak geen correctie op basis van uitsluitend een screenshot of een klantredirect.

## Verificatie

De lokale suite `web/owner-recovery-workerd.test.mjs` gebruikt echte ES256-bevestigingen en een lokale D1-database. Ze test accountafscherming, onveranderlijke auditregels via de API, profiel/bedrag/bestelcontrole, gelijktijdigheid, herhaalde meldingen, ontbrekende bevestiging, bevroren accounts, terugboekingen en onderbroken statuscontrole. Alle providerverzoeken in die tests zijn nagebootste GET-verzoeken; er vinden geen echte betalingen, terugbetalingen of videogeneraties plaats.
