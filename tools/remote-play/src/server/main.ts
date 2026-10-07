// npm start -- [options]: start the companion for a game running with
// MEMORIES_REMOTE_PLAY=1, open the host page, and print the invite links.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startCompanion } from "./companion.js";
import { DEFAULT_GAME_PORT } from "./game-protocol.js";
import { startTunnel, type Tunnel } from "./tunnel.js";

const USAGE = `Usage: npm start -- [options]

  --tunnel              share over the internet with a free Cloudflare quick
                        tunnel (needs the cloudflared program)
  --lan                 also accept a guest from your local network
  --game-port <n>       the game's MEMORIES_REMOTE_PLAY port (${DEFAULT_GAME_PORT})
  --host-port <n>       the host page's port on 127.0.0.1 (8700)
  --public-port <n>     the guest page's port (8701)
  --stun <url>          a STUN server (repeatable; default: Google's and Cloudflare's)
  --turn <url>          a TURN server, for guests no direct connection reaches
  --turn-user <name>    its user name
  --turn-pass <secret>  its password
  --cloudflared <path>  where cloudflared is, if not on the PATH
  --no-open             do not open the host page in the browser
  -h, --help            this text`;

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tunnel: { type: "boolean", default: false },
      lan: { type: "boolean", default: false },
      "game-port": { type: "string", default: String(DEFAULT_GAME_PORT) },
      "host-port": { type: "string", default: "8700" },
      "public-port": { type: "string", default: "8701" },
      stun: { type: "string", multiple: true },
      turn: { type: "string" },
      "turn-user": { type: "string" },
      "turn-pass": { type: "string" },
      cloudflared: { type: "string", default: "cloudflared" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const port = (name: string, text: string): number => {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`--${name}: not a port: ${text}`);
    return value;
  };
  const iceServers: RTCIceServer[] = [
    { urls: values.stun?.length ? values.stun : ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  ];
  if (values.turn) iceServers.push({ urls: values.turn, username: values["turn-user"], credential: values["turn-pass"] });

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const companion = await startCompanion({
    gamePort: port("game-port", values["game-port"]),
    hostPort: port("host-port", values["host-port"]),
    publicPort: port("public-port", values["public-port"]),
    lan: values.lan,
    iceServers,
    root,
  });
  console.log(`\nRemote play companion
  game:      127.0.0.1:${values["game-port"]} (start it with MEMORIES_REMOTE_PLAY=1)
  host page: ${companion.hostUrl}  <- open this on this computer and press "Start sharing"`);
  for (const invite of companion.invites()) console.log(`  invite:    ${invite.url}  (${invite.label})`);

  let tunnel: Tunnel | null = null;
  if (values.tunnel) {
    companion.setTunnel("starting");
    console.log("  tunnel:    starting cloudflared...");
    startTunnel(companion.publicPort, values.cloudflared)
      .then((started) => {
        tunnel = started;
        companion.setTunnel("ready", started.url);
        console.log(`  invite:    ${started.url}/#${companion.token}  (Internet)`);
      })
      .catch((error: Error) => {
        companion.setTunnel("failed");
        console.error(`  tunnel:    ${error.message}`);
      });
  }
  console.log("");
  if (!values["no-open"]) openBrowser(companion.hostUrl);

  const stop = () => {
    tunnel?.close();
    void companion.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
