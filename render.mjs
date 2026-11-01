// Gebruik:  node render.mjs [test|vol] [kling|wan|beide]
//   test = 5 seconden (goedkoop proberen), vol = de volledige clip
// Verwacht in deze map: ik_voorkant.jpg, dans_test_5s.mp4 en dans_20s.mp4
import { fal } from "@fal-ai/client";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const lengte = process.argv[2] ?? "test";
const welk = process.argv[3] ?? "beide";

// Key uit omgeving, uit .env, of interactief vragen
let key = process.env.FAL_KEY;
if (!key && existsSync(".env")) {
  const m = (await readFile(".env", "utf8")).match(/^FAL_KEY=(.+)$/m);
  if (m) key = m[1].trim();
}
if (!key) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  key = (await rl.question("Plak je fal.ai API-key: ")).trim();
  rl.close();
}
fal.config({ credentials: key });

const foto = "ik_voorkant.jpg";
const clip = lengte === "vol" ? "dans_20s.mp4" : "dans_test_5s.mp4";
for (const f of [foto, clip]) {
  if (!existsSync(f)) { console.error(`Ontbreekt: ${f} (zie README, stap 3)`); process.exit(1); }
}

const upload = async (pad, type) =>
  fal.storage.upload(new Blob([await readFile(pad)], { type }));

console.log("Bestanden uploaden...");
const imageUrl = await upload(foto, "image/jpeg");
const videoUrl = await upload(clip, "video/mp4");

const prompt =
  "A person dancing in their own living room, filmed on a phone propped on a shelf, natural indoor light, realistic";

const modellen = {
  kling: {
    id: "fal-ai/kling-video/v3/pro/motion-control",
    input: { prompt, image_url: imageUrl, video_url: videoUrl, character_orientation: "video" },
  },
  wan: {
    id: "fal-ai/wan-motion",
    input: { prompt, image_url: imageUrl, video_url: videoUrl },
  },
};

const lijst = welk === "beide" ? ["kling", "wan"] : [welk];

await Promise.all(
  lijst.map(async (naam) => {
    const { id, input } = modellen[naam];
    console.log(`[${naam}] gestart (${id}), dit duurt 5 à 20 minuten`);
    try {
      const res = await fal.subscribe(id, {
        input,
        onQueueUpdate: (u) => u.status === "IN_QUEUE" && console.log(`[${naam}] in de wachtrij...`),
      });
      const url = res.data?.video?.url;
      if (!url) throw new Error("Geen video in antwoord: " + JSON.stringify(res.data));
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const uit = `resultaat_${naam}_${lengte}.mp4`;
      await writeFile(uit, buf);
      console.log(`[${naam}] klaar -> ${uit}`);
    } catch (e) {
      console.error(`[${naam}] mislukt:`, e?.body ? JSON.stringify(e.body, null, 2) : e.message);
    }
  })
);
