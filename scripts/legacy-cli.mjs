import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function promptForFalKey(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Stel FAL_KEY in via de omgeving of .env.");
  }
  // Readline handles editing in raw mode. Keep all of its redisplays off the terminal.
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input, output: silent, terminal: true, historySize: 0 });
  const cancel = new AbortController();
  rl.once("SIGINT", () => cancel.abort());
  rl.once("close", () => cancel.abort());
  try {
    output.write("Plak je fal.ai API-key (invoer is verborgen): ");
    const key = (await rl.question("", { signal: cancel.signal })).trim();
    if (!key) throw new Error("Geen fal.ai API-key ingevoerd.");
    return key;
  } finally {
    rl.close();
    output.write("\n");
  }
}

// The generated files for Kling and Wan are served by the Fal media CDN.
const mediaHosts = new Set(["fal.media", "v3.fal.media", "v3b.fal.media"]);

export async function saveFalVideo(value, destination, {
  fetchImpl = fetch, maxBytes = 64 * 1024 * 1024, timeoutMs = 60_000,
} = {}) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !mediaHosts.has(url.hostname) || url.username ||
      url.password || url.port || url.hash || !url.pathname.startsWith("/files/")) {
    throw new Error("Onverwachte Fal-downloadlocatie.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const temporary = `${destination}.${randomUUID()}.part`;
  let file;
  try {
    const response = await fetchImpl(url, {
      redirect: "error", signal: controller.signal, headers: { "Accept-Encoding": "identity" },
    });
    if (response.status !== 200 || !response.body) throw new Error("Videodownload geweigerd.");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > maxBytes)) {
      throw new Error("Ongeldige bestandsgrootte voor de video.");
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type && type !== "video/mp4" && type !== "application/octet-stream") {
      throw new Error("Onverwacht bestandstype voor de video.");
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > maxBytes) return done(new Error("De video is te groot."));
        done(null, chunk);
      },
    });
    file = await open(temporary, "wx", 0o600);
    await pipeline(Readable.fromWeb(response.body), limit, file.createWriteStream(), { signal: controller.signal });
    if (received === 0 || (declared !== null && received !== Number(declared))) {
      throw new Error("Onvolledige videodownload.");
    }
    await rename(temporary, destination);
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (file) {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
}
