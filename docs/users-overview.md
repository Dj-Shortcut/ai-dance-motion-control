# Gebruikersoverzicht

De eigenaar opent **RIG → Financiën → Gebruikers**. De bestaande beheerpop-up
bevat een doorzoekbare lijst met naam/e-mail wanneer het platform die deelt,
een accountreferentie, eerste bezoek en laatst actief. Er verschijnen maximaal
25 accounts per pagina; bladeren en vernieuwen gebruiken de echte eigenaar-API.
De hoofdflow voor klanten krijgt geen extra stap of knop.

## Betekenis van de gegevens

- `rig_sites_identities.created_at` blijft de eerste geauthenticeerde aanvraag.
- `rig_account_profiles` bevat optionele platformmetadata en het laatste moment
  waarop een geverifieerde sessiecontrole werd geregistreerd. Schrijven wordt
  atomair beperkt tot eenmaal per minuut per account.
- Dit is geen historisch logboek van afzonderlijke logins. Een open tabblad kan
  sessiecontroles uitvoeren zonder dat iemand opnieuw zijn wachtwoord invoert.
- Oudere accounts blijven zichtbaar. Ontbrekende namen, e-mails en activiteit
  worden niet verzonnen of achteraf ingevuld; metadata volgt bij een nieuw bezoek.
- Naam en e-mail zijn weergavegegevens, nooit een basis voor toegangsrechten,
  accountkoppeling, tegoed of financiële handelingen.

## Vertrouwensgrenzen

De Sites-server leest alleen de platformheaders en tekent een aparte, begrensde
`POST /api/internal/account-activity`. De publieke browserproxy weigert alle
`/api/internal/*`-paden. De private backend controleert de bestaande Site-HMAC,
oorsprong, nonce, bodydigest, productieomgeving en gekoppelde accountidentiteit.
Een optionele registratiefout mag een geldige aanmelding niet laten mislukken.

`GET /api/owner/users` controleert de vastgelegde eigenaar aan serverzijde. De
zoekopdracht is begrensd en geparametriseerd; paginacursors zijn ondertekend en
gebonden aan Site en zoekopdracht. Antwoorden zijn niet cachebaar. De client
gebruikt tekstnodes en negeert late antwoorden na afmelden of accountwissel.

## Publicatie

Gebruik uitsluitend de toevoegende migratie `0017_account_profiles.sql`; deze
maakt één tabel en één index aan. Pas geen andere migratie impliciet toe.
Controleer de bestaande productievereisten en maak een private back-up vóór
een serverupdate. Publiceer daarna de bijpassende Sites-versie op dezelfde URL.
Betaalde generaties of aankopen zijn geen onderdeel van deze verificatie.
