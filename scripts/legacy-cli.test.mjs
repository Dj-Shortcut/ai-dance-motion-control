import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promptForFalKey, saveFalVideo } from "./legacy-cli.mjs";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let displayed = "";
  input.isTTY = output.isTTY = true;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  output.on("data", (chunk) => { displayed += chunk; });
  return { input, output, displayed: () => displayed };
}

test("interactive key entry hides input and restores terminal mode", async () => {
  const { input, output, displayed } = terminal();
  const key = promptForFalKey(input, output);
  assert.equal(input.isRaw, true);
  input.write("fixture-key\r");
  assert.equal(await key, "fixture-key");
  assert.equal(input.isRaw, false);
  assert.equal(displayed(), "Plak je fal.ai API-key (invoer is verborgen): \n");
});

test("key entry handles cancellation and noninteractive execution", async () => {
  const { input, output, displayed } = terminal();
  const key = promptForFalKey(input, output);
  input.write("partial-fixture");
  input.write("\x03");
  await assert.rejects(key, { name: "AbortError" });
  assert.equal(input.isRaw, false);
  assert.ok(!displayed().includes("partial-fixture"));
  input.isTTY = false;
  await assert.rejects(promptForFalKey(input, output), /FAL_KEY/);
});

const mediaURL = "https://v3b.fal.media/files/b/fixture/video.mp4";
async function existingVideo(t) {
  const directory = await mkdtemp(join(tmpdir(), "rig-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, "resultaat_kling_test.mp4");
  await writeFile(destination, "previous");
  return { directory, destination };
}

test("completed bounded download replaces the previous result", async (t) => {
  const { directory, destination } = await existingVideo(t);
  const body = new Uint8Array([1, 2, 3]);
  await saveFalVideo(mediaURL, destination, { maxBytes: 3, fetchImpl(url, init) {
    assert.equal(url.href, mediaURL);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(body, { headers: { "content-length": "3", "content-type": "video/mp4" } });
  } });
  assert.deepEqual(await readFile(destination), Buffer.from(body));
  assert.deepEqual(await readdir(directory), ["resultaat_kling_test.mp4"]);
});

test("a URL outside the approved media locations never reaches the transport", async () => {
  let calls = 0;
  for (const url of ["https://example.invalid/files/video.mp4", "http://fal.media/files/video.mp4"]) {
    await assert.rejects(saveFalVideo(url, "unused", { fetchImpl() { calls++; } }), /downloadlocatie/);
  }
  assert.equal(calls, 0);
});

test("redirects, invalid responses and incomplete or oversized bodies preserve prior results", async (t) => {
  const { directory, destination } = await existingVideo(t);
  const body = new Uint8Array([1, 2, 3]);
  for (const response of [
    new Response(null, { status: 302 }),
    new Response(null, { status: 404 }),
    new Response(body, { headers: { "content-type": "text/plain" } }),
    new Response(body, { headers: { "content-length": "4" } }),
    new Response(body.subarray(0, 1), { headers: { "content-length": "2" } }),
    new Response(new Uint8Array(4)),
  ]) {
    await assert.rejects(saveFalVideo(mediaURL, destination, { maxBytes: 3, fetchImpl: () => response }));
    assert.equal(await readFile(destination, "utf8"), "previous");
    assert.deepEqual(await readdir(directory), ["resultaat_kling_test.mp4"]);
  }
});

test("the deadline covers a stalled body and cleans up the partial download", async (t) => {
  const { directory, destination } = await existingVideo(t);
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1]));
  } }));
  await assert.rejects(saveFalVideo(mediaURL, destination, { timeoutMs: 50, fetchImpl: () => response }), { name: "AbortError" });
  assert.equal(await readFile(destination, "utf8"), "previous");
  assert.deepEqual(await readdir(directory), ["resultaat_kling_test.mp4"]);
});
