# Remote play

A friend plays as **player 2** from a web browser while the game runs on your
PC: the duels and trades the game offers when a second pad is connected. You
send them a link; they open it, and they see the game's picture, hear its
sound and send their pad.

This is a study project and is meant for playing with your own copy and
friends you invite. It changes nothing about how the game gets its data: the
disc is still yours, on your PC, and only the picture and sound leave it.
Nothing here makes the game a public service.

## The parts

```
 your PC                                                       friend's PC
┌──────────────────────────────────────────────────────────┐  ┌──────────────┐
│ memories-pc (MEMORIES_REMOTE_PLAY=1)                     │  │ guest page   │
│   remote_play.c ── TCP 127.0.0.1:47811 ──┐               │  │ (browser)    │
│                                          │               │  │              │
│ companion (tools/remote-play, Node)  ◄───┘               │  │  <video>     │
│   host side  127.0.0.1:8700 ─ WebSocket ─┐               │  │  keyboard /  │
│   guest side :8701 ──────────────────────┼── signalling ─┼──┤  controller  │
│                                          │  (tunnel/LAN) │  │              │
│ host page (your browser, 127.0.0.1)  ◄───┘               │  │              │
│   canvas + AudioWorklet ── WebRTC: picture, sound ───────┼─►│              │
│                         ◄─ data channel: pad bits ───────┼──┤              │
└──────────────────────────────────────────────────────────┘  └──────────────┘
```

1. **The game** (`src/pc/platform/remote_play.c`). Only with
   `MEMORIES_REMOTE_PLAY` set, it listens on the loopback address for one
   companion. Each presented frame (`Memories_PresentDisplay`), it sends the
   display area of VRAM as the GPU keeps it (15-bit, at the console's own
   resolution, so 320x240 is 150 KiB), and the sound mixed since (the SPU's
   mix, tapped in `libspu.c` through a lock-free ring). It takes pad bits for
   either port. Those bits join the port's own in the VBlank pad driver
   (`libetc.c`), in the same place as the keyboard and controllers, so the
   game cannot tell them apart. A port the companion "holds" counts as a
   connected pad, which is what the game checks before it offers its
   two-player modes. The socket is non-blocking. A picture that does not fit
   is dropped, so a slow companion costs pictures and never stalls the game.
   The wire format is in `remote_play.h`.
2. **The companion** (`tools/remote-play`, Node and TypeScript). It runs two
   web servers. The host side is bound to `127.0.0.1`. It serves the host
   page, and a WebSocket passes it the game's pictures and sound. The guest
   side is the only part a friend can reach: the guest page, and a WebSocket
   for WebRTC signalling. It does not carry the stream, except in the relay
   below.
3. **The host page**, in your own browser. It draws each picture on a
   canvas, scaled to 640x480 with sharp pixels. It plays the sound into an
   `AudioWorklet` that feeds a `MediaStreamAudioDestinationNode`, not your
   speakers, which already have the game. It then sends
   `canvas.captureStream()` and that audio track to the guest over WebRTC.
   The browser does the hard part: VP8/H.264 and Opus encoding, congestion
   control, and NAT traversal with STUN.
4. **The guest page**, in your friend's browser. It plays the stream. It
   reads the keyboard (the PC port's own default keys) and controllers (the
   Gamepad API's standard layout), and sends the pad over a WebRTC data
   channel.

### Which player

By default the guest holds port 2. The game reads that pad only in its
two-player duels and trades, so on the title, in the campaign and in duels
against the CPU, the guest's buttons do nothing. The host page can make the
guest player 1 instead. The guest's bits then join the host's own on port 1,
which reaches every screen. Port 2 is let go when that happens.

### Input: why an unreliable channel

The data channel is `ordered: false, maxRetransmits: 0`, like UDP. A late
button press is worse than a lost one, because a retransmission would hold
back every newer state behind it. So every message carries the **whole pad
state** and a 16-bit sequence number (`src/shared/pad.ts`). The host drops
anything older than what it has. The guest repeats its state every 100 ms, so
a lost release is corrected within a tenth of a second. The same channel
carries a ping, which the guest page shows as its round trip.

### The relay

WebRTC needs a direct path between the two browsers. STUN finds one through
most home routers, but not when both sides are behind strict (symmetric)
NATs. The cure is a TURN server, which `--turn` accepts. Without one, the
guest page falls back to the **relay** after 12 seconds without a connection
(or at once with `?relay` in the link). The host page then sends JPEG
pictures at 15 a second over its WebSocket. The companion passes them to the
guest's WebSocket, and the pad goes back the same way. It is slower, uses
more bandwidth and has no sound, but it always works where the page loads.

### Reaching the friend

* `--lan`: the guest side also listens on your local network, and the host
  page lists `http://<your address>:8701/#<token>`.
* `--tunnel`: Cloudflare's free quick tunnel (`cloudflared`, no account)
  gives the guest side a public `https://<random>.trycloudflare.com` address.
  The WebSocket goes through it, and WebRTC goes directly between the
  browsers once connected.

## Security

The game's port, the host page and the host WebSocket are reachable from
this machine only. The friend reaches the guest side and nothing else:

* **The invite token** is 144 random bits. It sits after the `#` in the link,
  so the browser never sends it in a request and no proxy or tunnel log
  records it. The page sends it in its first WebSocket message, and the
  companion compares it in constant time. One guest at a time, and the host
  can remove them.
* **The host WebSocket** checks the `Host` header (against DNS rebinding) and
  the `Origin` header (against cross-site WebSocket hijacking). Another site
  open in your browser cannot drive the game through it.
* **The guest WebSocket** accepts only same-origin connections, limits its
  message size and rate, and only ever sets **port 2**. The name a guest
  types is reduced to letters, digits and a little punctuation.
* **The pages** are served with a strict Content-Security-Policy (scripts
  from the companion only, no inline code), `nosniff` and `no-referrer`.
  Only the pages' own files are served, by an allow-list.
* **Code mods** still have no network access (`src/pc/mods/modapi.h`): the
  bridge is port code, off unless the player sets the environment variable.

## Testing without the game

`npm run fake-game` stands in for the game. It sends the same messages on the
same port: a moving test picture with player 2's sixteen buttons along the
bottom, lit while held, and a tone while one is held. `npm test` runs the
companion's unit and integration tests against it. `npm run test:e2e` runs
the whole chain in two real Chromium browsers: the host page shares, the
guest joins over WebRTC, its picture and sound track are checked, its keys
reach port 2 of the fake game, then the relay and the host's "remove" are
checked too. On the game's side, `tests/pc/remote_play_test.c` (CTest
`pc_remote_play`) plays the companion against `remote_play.c`. It covers
the greeting, wrapping pictures, 24-bit movie frames, sound, pad bits,
presence, the picture rate, and a companion that leaves.

## Limits and next steps

* One guest, as player 2. Spectators would be more peers on the same stream.
* The picture is the 4:3 one at the console's resolution, not the PC port's
  4x picture or widescreen. Those are bigger than needed for a video stream,
  and the browser's encoder would blur them anyway.
* No TURN server is bundled. For guests behind strict NATs, run one (coturn)
  or use the relay.
* While the game is paused, no frames are presented, so the stream freezes.
  That is what the player sees too.
