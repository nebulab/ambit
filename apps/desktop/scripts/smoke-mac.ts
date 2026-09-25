import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const architecture = process.arch === "arm64" ? "mac-arm64" : "mac";
const executable = path.join(
  root,
  "release",
  architecture,
  "Ambit.app",
  "Contents",
  "MacOS",
  "Ambit",
);
const home = await mkdtemp(path.join(tmpdir(), "ambit-desktop-ui-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = Bun.spawn([executable, `--remote-debugging-port=${port}`], {
  env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "pipe",
});

type Page = { readonly webSocketDebuggerUrl: string };

async function page(): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = (await response.json()) as Page[];
      if (pages[0]) return pages[0];
    } catch {
      // Electron has not opened its debugging socket yet.
    }
    await Bun.sleep(100);
  }
  throw new Error("Packaged app did not open a renderer");
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not inspect renderer")), {
      once: true,
    });
  });
  return socket;
}

let nextId = 0;
async function evaluate(socket: WebSocket, expression: string): Promise<unknown> {
  const id = ++nextId;
  const result = new Promise<unknown>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
        error?: unknown;
      };
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error || message.result?.exceptionDetails)
        reject(new Error(JSON.stringify(message)));
      else resolve(message.result?.result?.value);
    };
    socket.addEventListener("message", onMessage);
  });
  socket.send(
    JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
  );
  return result;
}

async function waitForText(socket: WebSocket, expected: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = String(await evaluate(socket, "document.body?.innerText ?? ''"));
    if (text.includes(expected)) return text;
    await Bun.sleep(100);
  }
  throw new Error(`Renderer did not show ${expected}`);
}

async function refresh(socket: WebSocket): Promise<void> {
  await evaluate(
    socket,
    "document.querySelector('button[aria-label=\"Retry reading Personal setup\"]').click()",
  );
}

try {
  const socket = await connect((await page()).webSocketDebuggerUrl);
  try {
    await waitForText(socket, "No Personal setup yet");
    assert.equal(await evaluate(socket, "typeof require"), "undefined");
    assert.equal(await evaluate(socket, "typeof process"), "undefined");
    assert.deepEqual(await evaluate(socket, "Object.keys(window.ambit).sort()"), [
      "inspectPersonal",
      "revealPersonal",
    ]);

    const configPath = path.join(home, "ambit.yaml");
    const valid = "version: 1\nharnesses: [codex, cursor]\n";
    await writeFile(configPath, valid);
    await refresh(socket);
    const configured = await waitForText(socket, "Cursor");
    assert.match(configured, /Codex/);
    assert.equal(await readFile(configPath, "utf8"), valid);

    const invalid = "version: 1\nrequires: core\n";
    await writeFile(configPath, invalid);
    await refresh(socket);
    await waitForText(socket, "ambit.yaml line 2");
    assert.equal(await readFile(configPath, "utf8"), invalid);

    await writeFile(path.join(home, "ambit.yml"), "version: 1\n");
    await refresh(socket);
    await waitForText(socket, "ambit.yml and ambit.yaml both exist");
    assert.equal(await readFile(configPath, "utf8"), invalid);
    console.log("Packaged macOS Personal setup UI: pass");
  } finally {
    socket.close();
  }
} finally {
  child.kill();
  await child.exited;
  await rm(home, { recursive: true, force: true });
}
