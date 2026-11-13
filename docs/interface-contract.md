# RIG interfaceafspraken

Deze afspraken gelden ook wanneer er functies bijkomen. Een zichtbare bediening
moet aan de echte verwerking gekoppeld zijn voordat ze gepubliceerd wordt.

## Ontwerpbron en latere correcties

De visuele bron is het oorspronkelijke Claude-artifact **RIG gsm-schetsen**:
[canvas.json](design-reference/claude-mobile/canvas.json), met vijf mobiele
schermen van 390 × 844. De bijbehorende HTML-bestanden zijn originele
referentieschetsen; ze zijn geen productiepagina's of bewijs van werkende
verwerking. De schermindeling, rustige kaarten, kleuren en korte taal bepalen
het ontwerp, met een bruikbare responsieve indeling op telefoon en desktop.

De expliciete correctie van 12 november 2026 gaat voor op die oorspronkelijke
schets: **geen voorbeelden of ideeën-tegels**. Neem ook geen schetsclaims over
zoals proberen zonder account, een proef van drie seconden, voorbeeldprijzen,
gesimuleerde voortgang, een geschatte wachttijd of de knop om een nepresultaat
te tonen. De actuele aanmelding, mogelijkheden en resultaten komen uit de app.

## Vijf afzonderlijke schermen

| Scherm | Originele referentie | Werkelijke bediening |
| --- | --- | --- |
| Start | [Main.dc.html](design-reference/claude-mobile/Main.dc.html) | Intro met Foto/Video/Resultaat-illustratie; de bestaande hoofdactie begint de flow. Geen voorbeeldtegels, nepvideo of onbevestigde aanmeldclaim. |
| Foto en video · stap 1 van 3 | [Kies.dc.html](design-reference/claude-mobile/Kies.dc.html) | De eigen foto of een gekozen videoframe, de bewegingsvideo en twee echte fragmentregelaars. `Meer opties` bevat uitsnijden, precieze start/duur, close-up/hoeken en de bestaande instellingen. |
| Waar? · stap 2 van 3 | [Waar.dc.html](design-reference/claude-mobile/Waar.dc.html) | Twee keuzes met previews uit de eigen media: `Op je foto` en `In de video`. Toon alleen wat de server aanbiedt; de beschrijving moet overeenkomen met het gekozen verwerkingscontract. |
| Maak · stap 3 van 3 | [Maak.dc.html](design-reference/claude-mobile/Maak.dc.html) | De bestaande `briefDialog` als volledig scherm, met omschrijving en de keuze tussen proefje en volledige selectie. `Bekijk de prijs` bereidt de keuze voor; definitieve prijs en betaalde bevestiging blijven in de bestaande vervolgpop-outs. |
| Klaar | [Klaar.dc.html](design-reference/claude-mobile/Klaar.dc.html) | Echte opdrachtstatus of afspeelbaar resultaat. Bewaren gebruikt het echte bestand; delen verschijnt alleen als de browser het bestand kan delen. Geen verzonnen percentage of resterende tijd. |

In de bron zijn `start`, `files`, `where` en `result` afzonderlijke
`data-flow-screen`-panelen. Het vijfde scherm is de bestaande `briefDialog`.
Toon één scherm tegelijk. Teruggaan bewaart de gekozen bestanden en instellingen;
het verandert het model of de opdracht niet stilzwijgend.

De header houdt merk, tegoed, aanmelden/afmelden, eventueel beheer en
`Mijn video's` bij elkaar. Die laatste naam geeft geen recht op een verzonnen
videobibliotheek: herstel wat de bestaande opdrachtvoorziening werkelijk biedt.

## Hoofdactie, prijs en toestemming

Hergebruik de ene vaste `prepare`-actie voor start, verdergaan en het vervolg op
een proefje. Instellingen staat onder `Meer opties`, niet als los icoon onderaan.
De omschrijving en verdere keuzes blijven in de bestaande pop-out. Gebruik korte
gewone taal en dezelfde namen op het hoofdscherm en in pop-outs.

Een proefkeuzekaart start niets. De actuele duur komt uit het modelcontract:
vijf seconden voor Motion/Edit en zes voor de Recast-kandidaat, zolang een
proefje korter is dan de volledige selectie en in de bron past. De prijs op de
keuzekaart is een opgehaalde raming, geen bindende toezegging. Bij opschonen kan
die pas na maskercontrole beschikbaar zijn. Een ontbrekende prijs krijgt geen
verzonnen bedrag of belofte dat het gratis is.

De uiteindelijke quote bindt de daadwerkelijk voorbereide media, het model,
de opties en het bedrag. Alleen de bestaande expliciete generatiebevestiging
mag de betaalde opdracht starten. Account-, tegoed-, toestemmings- en
apparaatcontroles blijven van toepassing. Interne Fal-kosten en voorstellen
voor de verkoopprijs horen niet in de klantweergave; het eigen Fal-account
van de eigenaar heeft een afzonderlijke kostweergave. Onderaan blijft ruimte
voor echte status- en foutmeldingen, zonder een tweede prijsblok.

## Proefje vervolgen en resultaat

Na een voltooid proefje staat het afspeelbare resultaat centraal. Bewaren is
een bestandsactie. `Volledige versie maken` hergebruikt de bestaande
`prepare`-actie als rustige tekstlink; voeg geen tweede generatieknop bij het
resultaat toe. Het vervolg opent dezelfde stap 3/3 met de bewaarde volledige
selectie en doorloopt opnieuw voorbereiding, prijs en expliciete bevestiging.
Het proefje en de volledige video zijn afzonderlijk betaald. Bekijken,
bewaren, delen of een plan kiezen start geen nieuwe betaalde generatie.

Alleen een bij het resultaat passend bewaard proefconcept mag dit volledige
proefvervolg aanbieden. Een onbekende eerdere video wordt niet als proefje
voorgesteld. Die krijgt via dezelfde hoofdactie `Verder met deze video`: vraag
gericht de oorspronkelijke bestanden en de gewenste lengte, sla het
startscherm over en toon daarna de volledige keuze met een nieuwe prijs.
Verzin daarbij geen oorspronkelijke duur, prompt of referenties.
Een nieuwe selectie blijft leidend; een oud resultaat mag die niet vervangen.
Een nieuw proefje bewaart vóór de betaalde bevestiging ook het volledige
gekozen, genormaliseerde fragment met het hoofdbeeld en de gebruikte referenties
in de bestaande privéopslag. Bewaar nooit de volledige ruwe telefoonopname om
een kort gekozen fragment te vervolgen. Bind het bewaarde concept onveranderlijk
aan de eigen proefquote; alleen de eigenaar van het bijbehorende voltooide
proefje kan het openen. Ook na verversen of via `Mijn video's` gaat
`Volledige versie maken` rechtstreeks naar stap 3/3, met dezelfde media,
omschrijving en opties. Een verse volledige quote, toestemming en bevestiging
blijven verplicht. Een masker voor een proefje wordt nooit voor een langere
video hergebruikt: controleer een nieuw masker voor dat volledige fragment.
Een oud proefje waarvoor de langere bron nooit is bewaard kan ontbrekende
beelden niet terughalen; leg dat eerlijk uit zonder een nieuw proefje te starten.
`Nog eentje` begint bewust een nieuw concept en mag een
lopende of onzekere opdracht niet laten verdwijnen.

Bewaar alleen de begrensde proefinstellingen per aangemeld account, maximaal
24 uur, zodat een nieuw tabblad hetzelfde proefje kan vervolgen. Foto-, video-
en referentiebytes, bestandstoegangslinks en aanmeldgegevens horen niet in die
browseropslag. De aanvullende bronmedia blijven maximaal 24 uur in de bestaande
privé-invoeropslag; een verlopen of ontbrekende bron geeft een gerichte melding.
Afmelden wist het eigen lokaal bewaarde proefconcept. Geschiedenis bekijken
controleert uitsluitend bestaande opdrachten en start geen betaalde vervolgstap.

## Controle voor publicatie

Controleer de echte bediening achter iedere zichtbare keuze, inclusief terug,
fragmentkeuze, referenties, prijs, toestemming, opdrachtstatus en proefvervolg.
Bekijk telefoon en desktop. Houd implementatie, lokale providerfixtures,
publicatie en acceptatie van echte betaalde uitvoer afzonderlijk bij. Een knop,
geslaagde codecontrole of gesimuleerd resultaat bewijst geen geslaagde
Fal-bewerking.
