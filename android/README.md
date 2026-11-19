# RIG voor Android

Android-project voor `dev.andyarijs.rig`, versie `0.1.0` (code `1`). De app
opent uitsluitend de bestaande RIG-website op `/android/`, via Android Browser
Helper. De website levert de echte interface, aanmelding, prijzen, tegoeden en
video-opdrachten. Deze app bevat geen Fal-, Mollie- of Google-serversleutels.

## Bouwen

Gebruik JDK 17, Android SDK 36 en de opgenomen Gradle-wrapper:

```sh
./gradlew :rigPlayBilling:testDebugUnitTest :app:assembleDebug :app:lintRelease :app:bundleRelease
```

`assembleDebug` levert een lokaal installeerbare test-APK. `bundleRelease`
levert zonder externe ondertekeningsconfiguratie een ongetekende appbundel;
dat is geen gepubliceerde of door Google goedgekeurde release. Bewaar
ondertekeningssleutels buiten de repository. Bouwuitvoer en lokale SDK-paden
worden niet ingecheckt.

## Aanmelding en media

De bestaande ChatGPT/Sites-aanmelding blijft in de browser. De app leest geen
cookies, wachtwoorden of aanmeldtokens en heeft geen JavaScript-bridge.
Bestandskiezer, videoweergave, bewaren en delen blijven echte browserfuncties.
Er worden geen opslag-, camera-, microfoon- of fotobibliotheekrechten aan de
Android-app gevraagd.

Bij een geldige Digital Asset Links-koppeling kan de browser RIG als Trusted
Web Activity tonen. Zolang die koppeling ontbreekt of de browser dit niet
ondersteunt, blijft de browserbalk zichtbaar in een Custom Tab. De app omzeilt
die controle niet en gebruikt geen WebView als uitweg.

Het startadres is vast. Inkomende URL's, extra's, gedeelde bestanden, ClipData,
URI-toestemmingen en opgegeven browserpakketten worden niet aan de browser
doorgegeven. De launcher verwerkt geen externe deep links of share-targets.
De Google-bibliotheek verzorgt de expliciet benodigde, geverifieerde
browserinterfaces voor betalingen; overige dependency-launchers zijn verwijderd
uit het appmanifest.

## Google Play-tegoed

De app bevat de lokaal opgenomen Android Browser Helper-billingmodule `1.2.0`,
met Google Play Billing `8.3.0`. De twee gedocumenteerde RIG-aanpassingen vereisen
en sturen het door de server uitgegeven accountkenmerk mee naar Google; de
officiële module doet dit zelf niet. Bron, licentie en exacte wijzigingen staan
in `third_party/android-browser-helper-playbilling`.
`RigBillingDelegationService` registreert de Digital
Goods API-handler voor de geverifieerde browser. De Android-webflow gebruikt
`https://play.google.com/billing`; een aankoopbewijs moet op de server met
Google worden gecontroleerd voordat RIG één keer tegoed bijschrijft.

De aanwezigheid van deze bibliotheek maakt een gewone losse APK nog geen
werkende Google Play-winkel. Echte tests vereisen de Play Console-inrichting,
product-ID's, de juiste ondertekening, een bereikbare Digital Asset Links-file
en de bijbehorende serverconfiguratie. Als Play Billing niet beschikbaar is,
mag de Android-webflow geen alternatieve Mollie-checkout voorstellen.

## Voor publicatie controleren

- Verifieer de Digital Asset Links-koppeling met de werkelijke Play
  app-signing-certificaatvingerafdruk. Vertrouw geen voorbeeldvingerafdruk.
- Test aanmelding, bestandkeuze, videobewaring/delen, teruggaan, schermvergrendeling
  en het terugvinden van een lopende opdracht op een echte Android-telefoon.
- Test aankopen met Google-testaccounts, inclusief annulering, herhaalde
  aflevering van hetzelfde aankoopbewijs en herstel na een onderbroken sessie.
- Rond de inhoudsmelding, accountverwijdering, gegevensveiligheidsverklaring,
  leeftijdsclassificatie, winkelvermelding en Google-beoordeling af.

Een geslaagde bouw of lintcontrole bewijst geen betaalde video-uitvoer,
geslaagde aankoop, Android-telefoontest of toelating tot Google Play.

De launcher- en billing-API's zijn gecontroleerd tegen de officiële
[Android Browser Helper 2.7.4-bron](https://github.com/GoogleChrome/android-browser-helper/tree/android-browser-helper-2.7.4),
inclusief de bijbehorende `playbilling`-integratie en voorbeeldapp.

De server levert `/android/manifest.webmanifest` en een vaste
`/.well-known/assetlinks.json`. Zonder ingestelde
`RIG_ANDROID_APP_SIGNING_SHA256` blijft de associatie leeg. Gebruik daar alleen
het publieke app-signing-certificaat uit Play Console; dit is geen geheime
sleutel. `scripts/assetlinks.mjs` kan een afzonderlijk document lokaal maken,
maar publiceert niets.
