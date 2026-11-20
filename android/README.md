# RIG voor Android

Zelfstandige Android-app in Kotlin/Jetpack Compose, pakket `dev.andyarijs.rig`,
versie `0.2.0` (code `2`), Android 9 of nieuwer. De schermen, bestandskeuze,
fragmentkeuze, videoweergave, uitsnijden en prijsbevestiging zijn native.
Er is geen WebView of Trusted Web Activity in de actieve app.
iOS is een latere client van dezelfde servercontracten.

## Bouwen

Gebruik JDK 17, Android SDK 36 en de opgenomen Gradle-wrapper:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintRelease :app:bundleRelease
./gradlew :app:assembleDebugAndroidTest
```

Het test-APK staat in `app/build/outputs/apk/debug/`. De releasebundel is zonder
externe ondertekening ongetekend en niet geschikt als bewijs van Play-publicatie.
Sleutels en lokale SDK-instellingen horen buiten Git. De oude vendored
browser-helpermodule is historische bron en wordt niet meer gebouwd of gebruikt.

## Aanmelden en beveiliging

Alleen de externe ChatGPT/Sites-aanmelding opent een browser. Daarna komt de
gebruiker terug in de native app. Een eenmalige code, PKCE en een controle van de
bewaarde state verbinden de aanmelding met precies dat toestelverzoek. De app
verzamelt geen ChatGPT-wachtwoorden en leest geen browsercookies.

De beperkte, intrekbare RIG-sessie wordt versleuteld met Android Keystore.
Provider-, Mollie-, Google-server- en Sites-bruggeheimen blijven op de server.
Native `/api/native/`-routes staan apart van bestaande browserroutes en laten
geen financiële beheerwijzigingen toe. Prijs, bestandsbinding, tegoed, reserves,
expliciete bevestiging en echte passkeycontrole blijven servercontroles.

Native passkeys vereisen de exacte openbare APK-certificaatvingerafdruk in
`RIG_NATIVE_ANDROID_SIGNING_SHA256`, zowel bij de private server als bij Sites.
Sites publiceert uitsluitend voor dat pakket/certificaat de relatie
`delegate_permission/common.get_login_creds` in `/.well-known/assetlinks.json`.
Gebruik voor Google Play het **Play app signing**-certificaat, niet de uploadkey.
Een expliciete sideload-test gebruikt alleen zijn eigen exacte testcertificaat;
deze associatie moet bij een andere distributiesleutel worden vervangen.

## Grote telefoonbestanden

De systeembestandskiezer verleent toegang tot alleen de geselecteerde bestanden.
Er zijn geen brede foto-, opslag-, camera- of microfoonrechten. Een lange eigen
video wordt lokaal afgespeeld; alleen het gekozen beeld wordt JPEG. De gekozen
bewegingsuitsnede wordt lokaal H.264/AAC MP4, maximaal 30 seconden voor Pro of
15 voor videobewerking, en maximaal 16 MiB per voorbereid bestand. Het ruwe
4K-bronbestand wordt niet geüpload. Uploads bevatten een controlehash.

Close-up en maximaal drie hoeken zijn echte optionele Pro-referenties. Native
tekstmaskers en de meervoudige Recast-workflow zijn nog niet geïmplementeerd;
de native serverconfiguratie biedt ze daarom niet aan. Er is geen stille
terugval naar een ander model. De website behoudt zijn eigen mogelijkheden.

## Opdrachten en proefvervolg

Vóór verzending bewaart de app de betaalintentie versleuteld per account. Na
een verloren antwoord, schermvergrendeling of procesherstart controleert hij
precies die opdracht; hij verstuurt niet automatisch een tweede generatie.
Een serverfout meldt de gebruiker niet automatisch af.

Een proefje bewaart vóór bevestiging ook de begrensde volledige selectie en
referenties in de bestaande privéopslag (maximaal 24 uur). Via het resultaat of
Mijn video's opent diezelfde volledige selectie opnieuw bij de beschrijving,
met een nieuwe prijs en bevestiging. Een verlopen bron geeft een gerichte fout.
Bewaren gebruikt de Android-bestandskiezer; delen geeft alleen tijdelijk leesrecht
op het concrete resultaatbestand. Afmelden wist het lokale concept, maar bewaart
versleutelde onzekere betaalintenties voor herstel door hetzelfde account.

## Google Play-tegoed

De native BillingClient `8.3.0` gebruikt uitsluitend de door RIG goedgekeurde
Google-producten/prijzen en het servergebonden accountkenmerk. RIG controleert
het aankoopbewijs, schrijft atomair één keer tegoed bij en verbruikt het bewijs
op de server. Pending aankopen blijven herstelbaar. De app kent zelf geen tegoed
toe en opent geen Mollie-alternatief. De gewone website behoudt Mollie.

Nieuwe Google-aankopen blijven uit totdat Console, producten, prijzen,
servercredentials en echte Play-tests zijn afgerond. Een sideload-APK is geen
werkende Play-winkel. Zie de afzonderlijke release- en betalingsdocumenten.

## Bewijsgrenzen

Unit- en providerfixtures bewijzen geen betaalde Fal-uitvoer of echte Google-
aankoop. Test apart: native emulator, eigen telefoon, echte aanmelding/terugkeer,
passkey, schermvergrendeling, prijs, betaalde generatie en proefvervolg. De
Android-instrumentatietests kunnen de eigen `ik.mp4` lokaal verwerken zonder
netwerk of Fal-kosten. Accountverwijdering, AI-resultaatmeldingen, reviewer access
en Play-formulieren blijven releasepoorten vóór een publieke winkelrelease.
