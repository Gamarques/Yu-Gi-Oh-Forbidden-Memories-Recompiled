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
import { loadArena } from "../server/cards.js";
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
      // A fake camera and microphone, allowed without asking.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
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
  const arena = await loadArena(path.resolve(root, "../../notes/card-catalog.csv"), path.join(root, "decks"), () => {});
  const companion = await startCompanion({ arena, gamePort, hostPort: 0, publicPort: 0, lan: false, iceServers: [], root, log: (line) => console.log(`  companion: ${line}`) });
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

    // Camera and voice. The guest's camera reaches the game's window (the
    // host page sends it to the companion as small 15-bit pictures), and
    // their voice plays on the host page.
    await guest.click("#camera-toggle");
    await guest.click("#mic-toggle");
    await until("the host sees the guest's media", async () =>
      (await host.textContent("#peer-media")) === "Your friend: camera on, microphone on",
    );
    await until("the guest's camera in the game", () => game.cameraFrames > 3);
    assert.deepEqual(game.camera, { width: 160, height: 120 });
    await until("the guest's voice at the host", () =>
      host.evaluate(() => {
        const track = (document.querySelector<HTMLAudioElement>("#peer-voice")!.srcObject as MediaStream | null)?.getAudioTracks()[0];
        return !!track && track.readyState === "live" && !track.muted;
      }),
    );
    await host.selectOption("#overlay", "always");
    await until("the overlay setting in the game", () => game.overlayMode === 2);
    await host.selectOption("#overlay", "my-turn");
    await until("back to my turn", () => game.overlayMode === 1);
    console.log("ok: the guest's camera reaches the game, their voice the host");

    // The host's camera, over the opponent's field on the guest page during
    // the guest's own turn (player 2's), and their voice.
    await host.click("#camera-toggle");
    await host.click("#mic-toggle");
    const peerCamShown = () =>
      guest.evaluate(() => {
        const cam = document.querySelector<HTMLVideoElement>("#peer-cam")!;
        return !cam.hidden && cam.videoWidth > 0;
      });
    game.setDuel(true, 0); // the host's turn: the guest does not see it
    await until("the host's camera arrives", () =>
      guest.evaluate(() => document.querySelector<HTMLVideoElement>("#peer-cam")!.videoWidth > 0),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await peerCamShown(), false, "hidden during the host's turn");
    game.setDuel(true, 1); // the guest's turn
    await until("the host's camera on the guest's turn", peerCamShown);
    game.setDuel(false, 1); // out of the duel
    await until("hidden out of a duel", async () => !(await peerCamShown()));
    game.setDuel(true, 0);
    await guest.selectOption("#overlay", "always");
    await until("always shown in a duel", peerCamShown);
    await until("the host's voice at the guest", () =>
      guest.evaluate(() => {
        const track = (document.querySelector<HTMLAudioElement>("#peer-voice")!.srcObject as MediaStream | null)?.getAudioTracks()[0];
        return !!track && track.readyState === "live" && !track.muted;
      }),
    );
    // The guest turns their camera off: the game's window lets it go.
    await guest.click("#camera-toggle");
    await until("the camera gone from the game", () => game.camera.width === 0);
    console.log("ok: the host's camera shows over the field on the guest's turn, and their voice plays");

    // Duel Arena: the host plays a premade deck as player 1; the guest builds
    // one (a card from the search, then a whole deck from a code) as player 2.
    const dragons = arena.decks.find((deck) => deck.name === "Dragões")!;
    const spellcasters = arena.decks.find((deck) => deck.name === "Magos")!;
    await until("the premade decks", () => host.evaluate(() => document.querySelectorAll("#arena-premade option").length >= 4));
    const dragonsIndex = await host.evaluate(() =>
      [...document.querySelectorAll<HTMLOptionElement>("#arena-premade option")].findIndex((option) => option.text.startsWith("Dragões")),
    );
    await host.selectOption("#arena-premade", String(dragonsIndex));
    await host.click("#arena-play-premade");
    await until("player 1's deck in the game", () => game.arenaDecks[0]?.join() === dragons.cards.join());
    await guest.click(".arena-builder summary");
    await guest.fill("#arena-search", "Blue-eyes White");
    await guest.click('#arena-results button[title="Add Blue-eyes White Dragon"]');
    assert.equal(await guest.textContent("#arena-count"), "1/40");
    await guest.fill("#arena-code", spellcasters.cards.join(","));
    await guest.click("text=Use code");
    assert.equal(await guest.textContent("#arena-count"), "40/40");
    await guest.fill("#arena-name", "Meu deck");
    await guest.click("#arena-play");
    await until("player 2's deck in the game", () => game.arenaDecks[1]?.join() === spellcasters.cards.join());
    await until("the host sees player 2 ready", async () =>
      ((await host.textContent("#arena")) ?? "").includes("Player 2: Meu deck"),
    );
    console.log("ok: Duel Arena decks from both pages reach the game");

    // The on-screen pad (phones) presses buttons too.
    const pressed: number[] = [];
    game.on("pad", (port, bits) => port === 1 && pressed.push(bits));
    if (await guest.isHidden("#touch-pad")) await guest.click("#touch-toggle");
    await guest.click('#touch-pad button[aria-label="Circle"]');
    await until("Circle from the on-screen pad", () => pressed.includes(Pad.Circle));
    await until("release", () => game.bits[1] === 0);
    console.log("ok: the on-screen pad reaches port 2");

    // The host makes the guest player 1: their keys reach port 1, which
    // the game reads on every screen.
    await host.selectOption("#guest-port", "0");
    await until("the guest told", async () => (await guest.textContent("#player")) === "player 1");
    await until("port 2 let go", () => !game.present[1]);
    await guest.keyboard.down("Enter");
    await until("Start on port 1", () => game.bits[0] === Pad.Start);
    await guest.keyboard.up("Enter");
    await until("release on port 1", () => game.bits[0] === 0);
    await host.selectOption("#guest-port", "1");
    await until("port 2 held again", () => game.present[1]);
    console.log("ok: the host can make the guest player 1");

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
