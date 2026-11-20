# RIG accountverzoeken en videomeldingen

Deze voorziening registreert een verzoek en geeft een ontvangstbewijs. Zij
verwijdert geen account of bestand, wijzigt geen tegoed, trekt geen sessie in
en neemt geen moderatiebeslissing. De productie-uitrol vereist de additieve
migratie `0020_account_service_requests.sql`, de private service, de openbare
relay en de bijbehorende Sites/Android-client. Een ontbrekende migratie geeft
een fout, geen gesimuleerd ontvangstbewijs.

## Klant

- `POST /api/account-deletion-requests` met uitsluitend
  `{ "requestId": "<uuid>" }` registreert een verwijderverzoek voor de
  geauthenticeerde account. `GET` op hetzelfde pad geeft de eigen laatste
  twintig verwijderverzoeken. Betaling of gekocht tegoed is niet vereist.
- `POST /api/generations/<jobId>/reports` met `requestId`, `reason` en optioneel
  `details` meldt een eigen afgeronde video. Redenen: `sexual`, `violence`,
  `hate`, `unsafe`, `other`. Toelichting: maximaal 1000 Unicode-codepunten,
  zonder URL's of onzichtbare besturingstekens. De video-identiteit komt uit
  de eigen RIG-opdracht; de gebruiker kan geen willekeurige externe video
  of andere account aanwijzen.
- De native client gebruikt dezelfde routes onder `/api/native/` met de
  bestaande geauthenticeerde, serverondertekende transportlaag.

Een ontvangstbewijs bevat `id`, `type`, `status`, `createdAt`, `replayed`,
`acknowledgement`, `actionPerformed: false` en bij een videomelding `jobId`.
Nieuwe verzoeken hebben status `pending`; de tekst zegt uitdrukkelijk dat
er nog niets is verwijderd of aan tegoed veranderd.

Bewaar dezelfde `requestId` bij een onzekere ontvangst en probeer daarmee
opnieuw. Een gewijzigde inhoud met dezelfde code geeft `409`. Het opnieuw
openen van een formulier met dezelfde nog openstaande inhoud geeft hetzelfde
ontvangstbewijs. Alle geaccepteerde aanvraagcodes worden atomair aan precies
die oorspronkelijke inhoud gebonden. Afzonderlijke lees- en schrijflimieten
voorkomen dat een foutlus de gebruiker de eigen ontvangstbewijzen ontneemt.

## Opvolging door de eigenaar

`GET /api/owner/account-service-requests` geeft uitsluitend de geverifieerde
productie-eigenaar maximaal vijftig openstaande verzoeken, oudste eerst.
Gebruik de ongewijzigde `nextCursor` uit het antwoord als `?cursor=...` om
volgende verzoeken te laden. De lijst bevat alleen de benodigde bestaande
accountreferentie/contactgegevens, de aanvraaggegevens en eventueel de
eigen RIG-video-identiteit. De native client krijgt deze beheertoegang niet.

De eigenaar controleert deze wachtrij en behandelt verzoeken via het bestaande
supportadres. Verifieer steeds de geregistreerde aanvraagcode en de bijbehorende
RIG-account; een door de klant opgegeven naam of ander e-mailadres is geen
toestemming om gegevens van een andere account te verwijderen. Voor een
daadwerkelijke verwijdering is een afzonderlijk gecontroleerde handeling nodig
die de getroffen persoonsgegevens en bestanden vaststelt, noodzakelijke
financiële/wettelijke bewaring respecteert en de eigenaar de onomkeerbare
verwijdering laat bevestigen. Deze handeling is geen onderdeel van deze API.

Een ontvangstbewijs is daarom geen bewijs van voltooide verwijdering. Markeer
een verzoek niet als afgehandeld voordat de echte opvolging is gecontroleerd.
Deze implementatie verstuurt ook niet ongemerkt e-mail of klantmedia naar een
andere dienst.
