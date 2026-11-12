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

De getoonde combinatie **US$20 aanvullen bij US$10 resterend** is een
voorstel/default in de bediening. De gebruiker heeft gekozen om eerst samen
de bedragen te bekijken. Deze bedragen zijn niet goedgekeurd of geactiveerd;
er is hiervoor geen afschrijving toegestaan of uitgevoerd.

In het bekeken Fal-scherm was geen maandlimiet zichtbaar. Daaruit volgt niet
dat Fal nergens een aanvullende limiet aanbiedt. RIG heeft momenteel een
gedeelde daglimiet voor providerautorisaties, standaard US$10 per UTC-dag.
Dat is geen maandlimiet en geen limiet voor automatische kaartaanvullingen.
Gebruik via de Mac-app, het Fal-dashboard of andere toepassingen valt buiten
de RIG-autorisaties.

Automatisch aanvullen kan de kaart belasten voordat Mollie het klantgeld heeft
uitbetaald. Een storing, geweigerde kaart of lege Fal-wallet kan generatie
blokkeren terwijl klanten nog geldig RIG-tegoed hebben.

## Nog ontbrekend: bewaking van dekking en liquiditeit

Auto top-up is geen volledige winst- of liquiditeitsbewaking. De aanvullende
RIG-controle is nog niet gebouwd. Die moet ten minste:

- Vlak vóór verzending atomisch bestedingsruimte reserveren, zodat gelijktijdige
  opdrachten niet elk hetzelfde beschikbare budget kunnen uitgeven. Ook reeds
  verzonden en onzekere opdrachten blijven meetellen.
- Verplichtingen uit verkocht tegoed, lopende reserveringen, terugbetalingen,
  kosten en nog niet uitbetaald Mollie-geld meenemen. Eurotegoed is niet gelijk
  aan USD bij Fal; werkelijke kosten en wisselkoersen mogen niet worden verzonnen.
- Het saldo en de verbruiksgegevens van **hetzelfde Fal-account als de
  generatiesleutel** controleren, via passende serverzijdige billing-leesrechten.
  Die uitlezing is nog geen ingerichte of bewezen koppeling.
- Rekening houden met gegevens die tot een uur achterlopen: toon de ouderdom,
  trek eigen nog niet verwerkte reserveringen af en behandel onzekerheid
  voorzichtig. Een saldo-uitlezing alleen voorkomt geen gelijktijdige uitgaven.
- Kaart-/aanvulstoringen en verbruik buiten RIG kunnen opvangen. Een eigen
  RIG-limiet beheerst niet automatisch andere Fal-toepassingen of alle
  kaartafschrijvingen.

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
