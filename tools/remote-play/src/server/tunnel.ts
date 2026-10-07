// A public https address for the guest port, from Cloudflare's free "quick
// tunnel" (no account): `cloudflared tunnel --url http://127.0.0.1:<port>`
// prints https://<random>.trycloudflare.com once the tunnel is up.
import { spawn, type ChildProcess } from "node:child_process";

const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface Tunnel {
  url: string;
  close(): void;
}

export function startTunnel(port: number, command = "cloudflared", timeoutMs = 30000): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error as Error);
      return;
    }
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve({ url: url!, close: () => child.kill() });
      }
    };
    const timer = setTimeout(() => finish(new Error("cloudflared gave no address in time")), timeoutMs);
    const scan = (chunk: Buffer) => {
      const found = ADDRESS.exec(chunk.toString());
      if (found) finish(null, found[0]);
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT"
          ? new Error(`"${command}" was not found: install cloudflared, or invite on your network with --lan`)
          : error,
      ),
    );
    child.on("exit", (code) => finish(new Error(`cloudflared ended (code ${code})`)));
  });
}
