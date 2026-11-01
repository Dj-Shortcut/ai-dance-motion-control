# 💃 Jezelf laten dansen met AI

Combineer een foto van jezelf met een bestaande dansvideo, en een AI-model maakt een nieuwe video waarin **jij** die dans doet, in je eigen kamer.

Dit heet *motion control*: het model leest de bewegingen frame per frame uit de dansvideo en zet ze op het personage uit je foto. Het oogt geloofwaardig omdat de beweging van een echte danser komt.

- **Je referentiefoto** levert je uiterlijk, kleding en de achtergrond.
- **De bronvideo** levert de beweging, timing en lichaamstaal.

Reken op ongeveer een uur, waarvan het grootste deel wachten op de render.

## Wat je nodig hebt

| Onderdeel | Waarvoor | Kost |
| --- | --- | --- |
| Smartphone (hoofdcamera) | Jezelf filmen als referentie | gratis |
| [Node.js](https://nodejs.org) 18+ | Het render-script draaien | gratis |
| [ffmpeg](https://ffmpeg.org) | Video knippen, bijsnijden, frames uithalen | gratis |
| [fal.ai](https://fal.ai)-account + API-key | Toegang tot de AI-modellen | tegoed vooraf |
| Kling v3 Pro Motion Control | Het model dat de video maakt | ca. $0,17 per seconde |
| Wan Motion (optioneel) | Tweede model om te vergelijken | goedkoper, lagere resolutie |

Met €10 tegoed kun je twee testrenders van 5 seconden en een volledige render van 20 seconden maken.

macOS: `brew install node ffmpeg`

## Snel aan de slag

```bash
git clone https://github.com/Dj-Shortcut/ai-dance-motion-control.git
cd ai-dance-motion-control
npm install
cp .env.example .env   # en vul je FAL_KEY in
```

Zet daarna je eigen bestanden in de map (zie stap 1 tot 3) en start:

```bash
node render.mjs test          # Kling en Wan, 5 seconden
node render.mjs vol kling     # volledige clip met Kling
```

## Stap 1: jezelf filmen

**Camera**
- Hoofdcamera achteraan, niet de selfiecamera
- 1080p of 4K aan 30 fps, verticaal
- Beautyfilters, portretmodus en AI-verbetering uit

**Ruimte**
- Gelijkmatig licht, geen raam achter je
- Gsm op heuphoogte, 2,5 à 3 meter afstand
- Volledig lichaam in beeld, met marge boven en onder
- Opgeruimde vloer

**Wat je opneemt**
1. Een paar seconden stilstaan, recht naar de camera, armen licht van het lichaam. Dit wordt je hoofdreferentie.
2. Rustig 360° ronddraaien in ongeveer 10 seconden.
3. Een close-up van je gezicht op ongeveer een meter.

Beweeg rustig, en stuur het **originele** bestand naar je computer (kabel, AirDrop, Tailscale), niet via WhatsApp of Messenger.

## Stap 2: de bronvideo van de dans

Kies een clip van een volwassen danser met een lichaamsbouw die op de jouwe lijkt.

- Eén persoon, van hoofd tot voeten in beeld
- Vaste camera, geen zoom of pans
- Rustige achtergrond, contrast met de danser
- Handen en voeten blijven in beeld
- **Geen video's met kinderen**

Neem de video op met de schermrecorder van je gsm, of op macOS met `Cmd + Shift + 5`. Snel voetenwerk (bijvoorbeeld jookin) is het moeilijkst voor de modellen: kies een stuk waarin de voeten scherp zijn.

## Stap 3: voorbereiden met ffmpeg

**Dansclip bijsnijden en knippen** (formaat `breedte:hoogte:x:y`, hier 20 s vanaf seconde 6):

```bash
ffmpeg -ss 6 -t 20 -i schermopname.mov \
  -vf "crop=974:1732:856:34,fps=30,scale=720:-2" \
  -c:v libx264 -crf 18 -c:a aac dans_20s.mp4
```

Hulp bij de uitsnede: `ffmpeg -i schermopname.mov -vf cropdetect -f null -`

**Testclip van 5 seconden:**

```bash
ffmpeg -i dans_20s.mp4 -t 5 -c copy dans_test_5s.mp4
```

**Referentiebeelden uit je eigen video:**

```bash
mkdir -p frames
ffmpeg -i mijn_video.mp4 -vf "fps=1/2" -q:v 2 frames/frame_%02d.jpg
```

Kies het beste frame (recht van voren, volledig lichaam, scherp) en sla het op als `ik_voorkant.jpg`.

## Stap 4: renderen

1. Maak op fal.ai een API-key aan (Dashboard → API Keys) en zet tegoed op je account.
2. Zet de key in `.env` of doe `export FAL_KEY=...`. Zonder key vraagt het script erom.
3. `node render.mjs test` maakt met beide modellen een clip van 5 seconden.
4. Vergelijk op gezicht, voeten, achtergrond en handen.
5. `node render.mjs vol kling` maakt de volledige versie.

In onze test gaf **Kling** duidelijk het beste resultaat (1072×1920, tegenover 720×1280 bij Wan).

## Problemen oplossen

| Probleem | Oplossing |
| --- | --- |
| Fout over tegoed | Tegoed toevoegen onder Billing op fal.ai |
| Fout over videolengte | Clip opsplitsen in stukken van 10 s en achteraf aan elkaar plakken |
| Fout over invoervelden (Wan) | Controleer de API-pagina van het model op fal.ai en pas `input` aan in `render.mjs` |
| Geweigerd door veiligheidsfilter | Andere kleding op de referentiefoto, of het andere model proberen |
| Gezicht lijkt niet op jou | Scherpere, frontale foto met meer licht |
| Voeten zweven of zakken weg | Rustiger fragment met voeten volledig in beeld |
| Vreemde armen of houding | Danser met vergelijkbare lichaamsbouw zoeken |

Stukken aan elkaar plakken met het originele geluid eronder:

```bash
printf "file 'deel1.mp4'\nfile 'deel2.mp4'\n" > lijst.txt
ffmpeg -f concat -safe 0 -i lijst.txt -i dans_20s.mp4 \
  -map 0:v -map 1:a -c:v copy -shortest eindresultaat.mp4
```

## Netjes blijven

- **Toestemming**: gebruik alleen je eigen gezicht of dat van iemand die uitdrukkelijk akkoord gaat. Nooit beelden van kinderen.
- **Credits**: de beweging komt van een echte danser. Tag of vermeld de maker als je het deelt.
- **Rechten**: de bronvideo is van iemand anders; voor publiek of commercieel gebruik heb je toestemming nodig.
- **AI-label**: markeer de video als AI-gemaakt.
- **API-key**: nooit delen of committen. `.env` staat in `.gitignore`. Gelekt? Meteen verwijderen in je fal.ai-dashboard.

## Licentie

MIT
