# RIG

RIG maakt video’s met een referentiefoto en een voorbeeldvideo. Deze repository
bevat nu de website, de bestaande Mac-app en de oorspronkelijke Node-CLI.

| Onderdeel | Bron | Controle |
| --- | --- | --- |
| Website en private backend | [web/](web/) | lokale UI-, provider-, betaal- en mediacontroles |
| Mac-app | [macos/](macos/) | volledige build en offline Fal-clienttests |
| Oorspronkelijke CLI | `render.mjs` | syntaxcontrole; renderen is een betaalde handeling |

## Website ontwikkelen

```sh
cd web
npm ci
npm run build -- --out-dir dist/site
npm run test:unit
npm run test:workerd
npm run test:media
```

Gebruik de Node-versie uit `web/.nvmrc`. De mediacontroles vereisen FFmpeg en
FFprobe. Fixtures worden synthetisch aangemaakt; eigen foto’s, video’s en sleutels
zijn niet nodig voor CI. Lees [web/README.md](web/README.md) voor de testgroepen.

## Mac-app bouwen

```sh
./macos/test.sh
./macos/build.sh
```

De build start de app niet en gebruikt geen Fal-tegoed. Zie de
[Mac-bronnotitie](macos/README.md) voor de import en het lokale appgedrag.
De oorspronkelijke CLI-handleiding staat in [docs/legacy-cli.md](docs/legacy-cli.md).

## Review en release

[De launchreview](docs/launch-review.md) beschrijft de gevonden fouten, reeds
aangepaste onderdelen en historische releaseblokkades. De website ondersteunt
een afzonderlijke productieomgeving voor Mollie-aankopen en RIG-tegoed; de code
of CI activeert die omgeving niet. Groene CI bewijst geen echte Wero-betaling,
Accountable-aflevering of visueel geslaagde Fal-generatie.
Deze workflows deployen niets en hebben geen productiegeheimen.

Persoonsvervanging met Recast 1080P en de betaalde tekst-/overlaybewerking zijn
uitsluitend voor validatie door de eigenaar geïmplementeerd, achter servercontroles.
De volledige keten is lokaal getest met providerfixtures; de visuele acceptatie
van een nieuw volledig resultaat blijft open. Zie [de videocontracten](docs/video-workflows.md).

[Herkomst van de broncode](docs/source-provenance.md) ·
[Eenvoudige testerflow en hondenbandprompt](docs/tester-flow.md)

## Geheimen en media

Bewaar sleutels buiten Git. Upload geen `.env`, lokale Cloudflare-status,
privéfoto’s, video’s, appbundels of herstelgegevens. Een extra repositorycheck
weigert een beperkte set herkenbare credentials en runtimebestanden; dit is
geen volledige beveiligingsaudit.

## Licentie

MIT, zie [LICENSE](LICENSE).
