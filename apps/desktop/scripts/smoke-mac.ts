import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const catalog = await mkdtemp(path.join(tmpdir(), "ambit-desktop-catalog-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = Bun.spawn([executable, `--remote-debugging-port=${port}`], {
  env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "pipe",
});

type Page = { readonly webSocketDebuggerUrl: string };

async function page(debugPort = port): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const pages = (await response.json()) as Page[];

      if (pages[0]) {
        return pages[0];
      }
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

      if (message.id !== id) {
        return;
      }

      socket.removeEventListener("message", onMessage);
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message)));
      } else {
        resolve(message.result?.result?.value);
      }
    };

    socket.addEventListener("message", onMessage);
  });

  socket.send(
    JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
  );

  return result;
}

async function waitForText(socket: WebSocket, expected: string): Promise<string> {
  let text = "";

  for (let attempt = 0; attempt < 300; attempt++) {
    text = String(await evaluate(socket, "document.body?.innerText ?? ''"));
    if (text.includes(expected)) {
      return text;
    }

    await Bun.sleep(100);
  }

  throw new Error(`Renderer did not show ${expected}. Current text: ${text}`);
}

async function refresh(socket: WebSocket): Promise<void> {
  await evaluate(
    socket,
    "document.querySelector('button[aria-label=\"Retry reading Personal setup\"]').click()",
  );
}

async function clickText(socket: WebSocket, label: string): Promise<void> {
  const escaped = JSON.stringify(label);

  await evaluate(
    socket,
    `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === ${escaped})?.click()`,
  );
}

try {
  const socket = await connect((await page()).webSocketDebuggerUrl);

  try {
    await waitForText(socket, "No Personal setup yet");
    assert.equal(await evaluate(socket, "typeof require"), "undefined");
    assert.equal(await evaluate(socket, "typeof process"), "undefined");
    assert.deepEqual(await evaluate(socket, "Object.keys(window.ambit).sort()"), [
      "applyEmpty",
      "browseLocalSkills",
      "cancelApply",
      "cancelPendingAction",
      "chooseLocalCatalog",
      "inspectPersonal",
      "onApplyProgress",
      "onRequestReview",
      "openExternal",
      "readLocalSkill",
      "retryEmpty",
      "revealPersonal",
      "reviewEmpty",
      "stageLocalCatalog",
      "stageSkill",
      "stageTool",
    ]);

    await evaluate(socket, "document.querySelector('input[value=codex]').click()");
    await clickText(socket, "Cancel");
    assert.deepEqual(await readdir(home), []);

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

    await rm(configPath);
    await rm(path.join(home, "ambit.yml"));
    await refresh(socket);
    await waitForText(socket, "No Personal setup yet");
    await evaluate(socket, "document.querySelector('input[value=codex]').click()");
    await clickText(socket, "Continue");
    await writeFile(path.join(catalog, "README.md"), "Existing local catalog\n");
    await mkdir(path.join(catalog, "skills", "example"), { recursive: true });
    await Bun.write(
      path.join(catalog, "skills", "example", "SKILL.md"),
      '---\nname: example\ndescription: Example skill\n---\n# Example\n**Bold guidance**\n\n[Official](https://example.com/guide) [Unsafe](javascript:alert(1))\n\n![Tracker](https://example.com/tracker.png)\n\n<script id="injected">alert(1)</script>\n',
    );
    await evaluate(
      socket,
      `(() => { const input = document.querySelector('#catalog-folder'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(catalog)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await clickText(socket, "Verify catalog");
    await waitForText(socket, "Loaded 1 skills");
    assert.deepEqual(await readdir(home), []);
    await clickText(socket, "Continue");
    await clickText(socket, "Review changes");
    await waitForText(socket, "Review setup");
    assert.deepEqual(await readdir(home), []);
    await clickText(socket, "Apply changes");
    await waitForText(socket, "Configured");
    assert.match(await readFile(path.join(home, "ambit.yml"), "utf8"), /- codex/);
    assert.match(await readFile(path.join(home, "ambit.yml"), "utf8"), /source:.*path:/);
    assert.deepEqual(await readdir(catalog), ["README.md", "skills"]);
  } finally {
    socket.close();
  }

  child.kill(9);
  await child.exited;
  const reopened = Bun.spawn([executable, `--remote-debugging-port=${port + 1}`], {
    env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    const socket = await connect((await page(port + 1)).webSocketDebuggerUrl);

    try {
      const text = await waitForText(socket, "Configured");

      assert.match(text, /Codex/);
      await waitForText(socket, "Not selected");
      await clickText(socket, "example");
      await waitForText(socket, "Bold guidance");
      assert.equal(
        await evaluate(
          socket,
          "document.querySelector('[aria-label=\"Skill file contents\"] strong')?.textContent",
        ),
        "Bold guidance",
      );
      assert.equal(
        await evaluate(
          socket,
          "document.querySelector('[aria-label=\"Skill file contents\"] a')?.href",
        ),
        "https://example.com/guide",
      );
      assert.equal(
        await evaluate(
          socket,
          "document.querySelectorAll('[aria-label=\"Skill file contents\"] a').length",
        ),
        1,
      );
      assert.equal(
        await evaluate(
          socket,
          "document.querySelectorAll('[aria-label=\"Skill file contents\"] img').length",
        ),
        0,
      );
      assert.equal(await evaluate(socket, "document.querySelector('#injected') === null"), true);
      await clickText(socket, "Select");
      await waitForText(socket, "Review installation");
      await clickText(socket, "Review changes");
      await waitForText(socket, ".agents/skills/example");
      await clickText(socket, "Apply changes");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (/skill:.*\/example/.test(await readFile(path.join(home, "ambit.yml"), "utf8"))) {
          break;
        }

        await Bun.sleep(100);
      }

      assert.match(await readFile(path.join(home, "ambit.yml"), "utf8"), /skill:.*\/example/);
      let selected = false;

      for (let attempt = 0; attempt < 100; attempt++) {
        selected = Boolean(
          await evaluate(
            socket,
            "Array.from(document.querySelectorAll('span')).some((span) => span.textContent?.trim() === 'Selected')",
          ),
        );
        if (selected) {
          break;
        }

        await Bun.sleep(100);
      }

      assert.equal(selected, true);
      assert.equal(
        await readFile(path.join(home, ".agents", "skills", "example", "SKILL.md"), "utf8"),
        await readFile(path.join(catalog, "skills", "example", "SKILL.md"), "utf8"),
      );
    } finally {
      socket.close();
    }
  } finally {
    reopened.kill(9);
    await reopened.exited;
  }

  console.log("Packaged macOS Personal setup UI: pass");
} finally {
  child.kill(9);
  await child.exited;
  await rm(home, { recursive: true, force: true });
  await rm(catalog, { recursive: true, force: true });
}
