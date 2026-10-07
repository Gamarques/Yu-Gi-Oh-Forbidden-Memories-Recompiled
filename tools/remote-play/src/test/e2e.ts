// End to end, in real browsers: the fake game, the companion, the host page
// in one browser and the guest page in another. Checks that player 2 sees a
// moving picture over WebRTC, that their keys reach port 2 of the game, and
// that the relay works too.
//
//   npm run test:e2e        (CHROMIUM=/path/to/chrome to pick the browser)
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { startCompanion } from "../server/companion.js";
import { FakeGame } from "../server/fake-game.js";
import { Pad } from "../shared/pad.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      // Plain local addresses in ICE candidates, so two pages on one
      // machine (or container) find each other without mDNS.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  });
}

function logConsole(page: Page, name: string): void {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") console.log(`[${name}] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.log(`[${name}] ${error.message}`));
}

async function main(): Promise<void> {
  const game = new FakeGame();
  const gamePort = await game.listen(0);
  const companion = await startCompanion({ gamePort, hostPort: 0, publicPort: 0, lan: false, iceServers: [], root, log: (line) => console.log(`  companion: ${line}`) });
  const hostBrowser = await launch();
  const guestBrowser = await launch();
  try {
    // --- the host ---
    const host = await hostBrowser.newPage();
    logConsole(host, "host");
    await host.goto(companion.hostUrl);
    await until("the game", async () => (await host.textContent("#game-status")) === "Game: connected");
    await host.click("#start");
    await until("sharing", async () => (await host.textContent("#share-status")) === "Sharing: on");
    const invite = await host.locator("#invites code").last().textContent();
    assert.ok(invite?.includes(`#${companion.token}`), `invite link: ${invite}`);
    console.log("ok: host page shares; invite link shown");

    // --- the guest, over WebRTC ---
    const guest = await guestBrowser.newPage();
    logConsole(guest, "guest");
    await guest.goto(invite!);
    await guest.fill("#name", "Yugi");
    await guest.click("#join");
    await until("a direct connection", async () => (await guest.textContent("#transport")) === "WebRTC (direct)");
    await until("a moving picture", () =>
      guest.evaluate(() => {
        const video = document.querySelector("video")!;
        return video.videoWidth === 640 && video.videoHeight === 480 && video.currentTime > 0.5;
      }),
    );
    // The picture is the game's: the button strip at the bottom turns
    // green while player 2 holds the port (fake-game.ts).
    const strip = await guest.evaluate(() => {
      const video = document.querySelector("video")!;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0);
      return Array.from(context.getImageData(4, 470, 1, 1).data);
    });
    assert.ok(strip[1]! > strip[0]! + 30 && strip[1]! > strip[2]! + 30, `strip colour ${strip}`);
    const audioTracks = await guest.evaluate(() => (document.querySelector("video")!.srcObject as MediaStream).getAudioTracks().length);
    assert.equal(audioTracks, 1);
    assert.ok(game.present[1], "port 2 held");
    console.log("ok: guest sees the game's picture over WebRTC, with a sound track");

    // Keys on the guest page reach port 2, through the data channel.
    await guest.keyboard.down("x");
    await until("Cross on port 2", () => game.bits[1] === Pad.Cross);
    await guest.keyboard.down("ArrowUp");
    await until("Cross+Up on port 2", () => game.bits[1] === (Pad.Cross | Pad.Up));
    await guest.keyboard.up("x");
    await guest.keyboard.up("ArrowUp");
    await until("release", () => game.bits[1] === 0);
    assert.equal(game.bits[0], 0, "port 1 untouched");
    await until("a round trip time", async () => /\d+ ms/.test((await guest.textContent("#rtt")) ?? ""));
    console.log(`ok: keys reach port 2 over the data channel (round trip ${await guest.textContent("#rtt")})`);

    // Leaving lets go of port 2.
    await guest.click("#leave");
    await until("port 2 released", () => !game.present[1]);
    console.log("ok: leaving releases port 2");

    // --- the relay, as when WebRTC cannot connect ---
    const relayGuest = await guestBrowser.newPage();
    logConsole(relayGuest, "relay guest");
    await relayGuest.goto(invite!.replace("/#", "/?relay#"));
    await relayGuest.click("#join");
    await until("relay mode", async () => (await relayGuest.textContent("#transport")) === "Relay (no sound)");
    await until("a relayed picture", () =>
      relayGuest.evaluate(() => {
        const image = document.querySelector<HTMLImageElement>("#relay-view")!;
        return image.complete && image.naturalWidth === 640;
      }),
    );
    await relayGuest.keyboard.down("Enter");
    await until("Start on port 2 via the relay", () => game.bits[1] === Pad.Start);
    await relayGuest.keyboard.up("Enter");
    await until("release via the relay", () => game.bits[1] === 0);
    console.log("ok: the relay carries pictures and keys");

    // The host removes player 2.
    await host.click("#kick");
    await until("player 2 removed", async () => /removed/.test((await relayGuest.textContent("#status")) ?? ""));
    assert.ok(!game.present[1]);
    console.log("ok: the host can remove player 2");
    console.log("\nend to end: ok");
  } finally {
    await hostBrowser.close();
    await guestBrowser.close();
    await companion.close();
    await game.close();
  }
}

main().catch((error: Error) => {
  console.error(`\nend to end: FAILED\n${error.stack ?? error.message}`);
  process.exit(1);
});
