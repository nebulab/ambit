import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopApi } from "./ipc.js";
import type { PersonalSetup } from "./setup.js";
import type { SetupTool } from "../../../src/project/empty-setup.js";
import type { LocalCatalogDraft } from "../../../src/project/empty-setup.js";
import { Button } from "./catalyst/button.js";
import { Badge } from "./catalyst/badge.js";
import { Heading } from "./catalyst/heading.js";
import { Text } from "./catalyst/text.js";
import { SkillBrowser } from "./skill-browser.js";
import "./style.css";

declare global {
  interface Window {
    ambit: DesktopApi;
  }
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  vscode: "VS Code",
};

const TOOLS: readonly SetupTool[] = ["claude", "codex", "cursor", "opencode", "vscode"];

function App() {
  const [setup, setSetup] = useState<PersonalSetup | null>(null);
  const [setupRevision, setSetupRevision] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<SetupTool | null>(null);
  const [catalog, setCatalog] = useState<LocalCatalogDraft | null>(null);
  const [catalogFolder, setCatalogFolder] = useState<string | null>(null);
  const [catalogName, setCatalogName] = useState("");
  const [step, setStep] = useState<"tools" | "catalogs" | "capabilities" | "review">("tools");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    try {
      setSetup(await window.ambit.inspectPersonal());
      setSetupRevision((value) => value + 1);
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    return window.ambit.onRequestReview(() => {
      setStep("review");
      setReviewId(null);
    });
  }, [refresh]);

  async function chooseTool(value: SetupTool): Promise<void> {
    try {
      await window.ambit.stageTool(value);
      setTool(value);
      setReviewId(null);
      setRequestError(null);
    } catch (error) {
      setRequestError(String(error));
    }
  }

  async function discard(): Promise<void> {
    await window.ambit.stageTool(null);
    await window.ambit.cancelPendingAction();
    setTool(null);
    setCatalog(null);
    setCatalogFolder(null);
    setCatalogName("");
    setReviewId(null);
    setStep("tools");
    setRequestError(null);
  }

  async function chooseCatalog(): Promise<void> {
    try {
      const folder = await window.ambit.chooseLocalCatalog();

      if (folder === null) {
        return;
      }

      await window.ambit.stageLocalCatalog(null, "");
      setCatalogFolder(folder);
      setCatalogName(folder.split("/").filter(Boolean).at(-1) ?? "local");
      setCatalog(null);
      setReviewId(null);
      setRequestError(null);
    } catch (error) {
      setRequestError(String(error));
    }
  }

  async function verifyCatalog(): Promise<void> {
    if (catalogFolder === null) {
      return;
    }

    setLoading(true);
    setRequestError(null);
    try {
      setCatalog(await window.ambit.stageLocalCatalog(catalogFolder, catalogName));
      setReviewId(null);
    } catch (error) {
      setCatalog(null);
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function removeCatalog(): Promise<void> {
    await window.ambit.stageLocalCatalog(null, "");
    setCatalog(null);
    setCatalogFolder(null);
    setCatalogName("");
    setReviewId(null);
    setRequestError(null);
  }

  async function review(): Promise<void> {
    setLoading(true);
    setRequestError(null);
    try {
      const result = await window.ambit.reviewEmpty();

      setReviewId(result.id);
      setStep("review");
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function apply(): Promise<void> {
    if (!reviewId) {
      return;
    }

    setLoading(true);
    setRequestError(null);
    try {
      const result = await window.ambit.applyEmpty(reviewId);

      setTool(null);
      setCatalog(null);
      setReviewId(null);
      setStep("tools");
      setPartial(result.status === "partial" ? (result.message ?? "Installation failed") : null);
      await refresh();
    } catch (error) {
      setReviewId(null);
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }

  async function retry(): Promise<void> {
    setLoading(true);
    setRequestError(null);
    try {
      await window.ambit.retryEmpty();
      setPartial(null);
      await refresh();
    } catch (error) {
      setRequestError(String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-1 bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 min-[681px]:grid-cols-[220px_minmax(0,1fr)]">
      <aside
        className="border-b border-zinc-200 bg-zinc-100 px-5 py-3 dark:border-zinc-700 dark:bg-zinc-800 min-[681px]:border-r min-[681px]:border-b-0 min-[681px]:px-3.5 min-[681px]:py-6"
        aria-label="Setups"
      >
        <div className="mb-2 text-[23px] font-bold tracking-[-0.05em] min-[681px]:mx-3 min-[681px]:mb-8">
          ambit
        </div>
        <nav aria-label="Setup navigation">
          <span
            className="block rounded-lg bg-blue-100 px-3 py-2 font-semibold text-blue-800 dark:bg-blue-900 dark:text-blue-100"
            aria-current="page"
          >
            Personal setup
          </span>
        </nav>
      </aside>
      <main
        id="main-content"
        className="min-w-0 w-full max-w-5xl px-5 py-6 min-[681px]:px-[clamp(24px,5vw,68px)] min-[681px]:py-11"
      >
        <header className="mb-9 flex items-start justify-between gap-5">
          <div>
            <p className="m-0 text-xs font-bold tracking-[0.08em] text-zinc-500 uppercase dark:text-zinc-400">
              Your agent capabilities
            </p>
            <Heading>Personal setup</Heading>
            <Text className="m-0 break-all text-zinc-500 dark:text-zinc-400">
              {setup?.root ?? "Your home folder"}
            </Text>
          </div>
          <Button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Retry reading Personal setup"
          >
            {loading ? "Reading…" : "Refresh"}
          </Button>
        </header>

        {requestError && (
          <section
            className="mb-4 rounded-xl border border-red-300 bg-white p-6 shadow-sm dark:border-red-700 dark:bg-zinc-800"
            role="alert"
          >
            <Heading level={2}>Could not read Personal setup</Heading>
            <p>{requestError}</p>
          </section>
        )}
        {partial && (
          <section
            className="mb-4 rounded-xl border border-red-300 bg-white p-6 shadow-sm dark:border-red-700 dark:bg-zinc-800"
            role="alert"
          >
            <Heading level={2}>Changes not fully installed</Heading>
            <p>{partial}</p>
            <Button type="button" onClick={() => void retry()} disabled={loading}>
              Retry installation
            </Button>
          </section>
        )}
        {loading && !setup && <p role="status">Reading Personal setup…</p>}
        {setup?.status === "unconfigured" && (
          <section
            className="mb-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
            aria-labelledby="unconfigured-title"
          >
            <Badge color="amber">Not configured</Badge>
            <Heading level={2} id="unconfigured-title">
              No Personal setup yet
            </Heading>
            {step === "tools" && (
              <>
                <p>Choose an agent tool for your Personal setup.</p>
                <fieldset aria-label="Agent tools">
                  <legend>Agent tool</legend>
                  {TOOLS.map((value) => (
                    <label className="block py-1.5" key={value}>
                      <input
                        type="radio"
                        className="mr-2.5 accent-blue-600 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                        name="tool"
                        value={value}
                        checked={tool === value}
                        onChange={() => void chooseTool(value)}
                      />
                      {TOOL_NAMES[value]}
                    </label>
                  ))}
                </fieldset>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    disabled={!tool || loading}
                    onClick={() => setStep("catalogs")}
                  >
                    Continue
                  </Button>
                  {tool && (
                    <Button type="button" onClick={() => void discard()}>
                      Cancel
                    </Button>
                  )}
                </div>
              </>
            )}
            {step === "catalogs" && (
              <>
                <p>Connect an existing local catalog, or continue without one.</p>
                <Button type="button" onClick={() => void chooseCatalog()} disabled={loading}>
                  Choose folder…
                </Button>
                <div className="mt-4">
                  <label className="mb-1.5 block" htmlFor="catalog-folder">
                    Local folder
                  </label>
                  <input
                    className="mb-3 block w-full max-w-[360px] rounded-md border border-zinc-400 bg-white px-2.5 py-2 text-zinc-900 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100"
                    id="catalog-folder"
                    value={catalogFolder ?? ""}
                    onChange={(event) => {
                      const folder = event.target.value;

                      void window.ambit.stageLocalCatalog(null, "");
                      setCatalogFolder(folder || null);
                      setCatalogName(folder.split("/").filter(Boolean).at(-1) ?? "");
                      setCatalog(null);
                      setReviewId(null);
                    }}
                    placeholder="/path/to/catalog"
                  />
                </div>
                {catalogFolder && (
                  <div className="mt-4">
                    <p className="break-all text-zinc-500 dark:text-zinc-400">
                      Folder: {catalogFolder}
                    </p>
                    <label className="mb-1.5 block" htmlFor="catalog-name">
                      Catalog name
                    </label>
                    <input
                      className="mb-3 block w-full max-w-[360px] rounded-md border border-zinc-400 bg-white px-2.5 py-2 text-zinc-900 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100"
                      id="catalog-name"
                      value={catalogName}
                      onChange={(event) => {
                        void window.ambit.stageLocalCatalog(null, "");
                        setCatalogName(event.target.value);
                        setCatalog(null);
                        setReviewId(null);
                      }}
                    />
                    <Button type="button" onClick={() => void verifyCatalog()} disabled={loading}>
                      Verify catalog
                    </Button>
                    {catalog && (
                      <p role="status">
                        Loaded {catalog.counts.skills} skills, {catalog.counts.mcps} MCP servers,{" "}
                        {catalog.counts.hooks} hooks, and {catalog.counts.packs} packs.
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    onClick={() => setStep("capabilities")}
                    disabled={catalogFolder !== null && catalog === null}
                  >
                    {catalog ? "Continue" : "Skip catalog"}
                  </Button>
                  {catalogFolder && (
                    <Button type="button" onClick={() => void removeCatalog()}>
                      Remove catalog
                    </Button>
                  )}
                  <Button type="button" onClick={() => setStep("tools")}>
                    Back
                  </Button>
                  <Button type="button" onClick={() => void discard()}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {step === "capabilities" && (
              <>
                <p>
                  {catalog
                    ? "Capability selection comes next. This setup will connect the catalog without selecting capabilities."
                    : "There are no capabilities to select without a catalog."}
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button type="button" onClick={() => void review()} disabled={loading}>
                    Review changes
                  </Button>
                  <Button type="button" onClick={() => setStep("catalogs")}>
                    Back
                  </Button>
                  <Button type="button" onClick={() => void discard()}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {step === "review" && (
              <>
                <Heading level={3}>Review setup</Heading>
                <p>Agent tool: {tool ? TOOL_NAMES[tool] : "None"}</p>
                <p>
                  Catalog: {catalog ? `${catalog.name} (${catalog.folder})` : "none"}. Capabilities:
                  none. Managed installation paths affected: none.
                </p>
                <p>
                  The configuration and installation records will be created in your home folder.
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    onClick={() => void (reviewId ? apply() : review())}
                    disabled={loading}
                  >
                    {reviewId ? "Apply changes" : "Refresh review"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setReviewId(null);
                      setStep("capabilities");
                      void window.ambit.cancelPendingAction();
                    }}
                  >
                    Back
                  </Button>
                  <Button type="button" onClick={() => void discard()}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
        {setup?.status === "configured" && (
          <section
            className="mb-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
            aria-labelledby="configured-title"
          >
            <Badge color={partial ? "amber" : "green"}>
              {partial ? "Not fully installed" : "Configured"}
            </Badge>
            <Heading level={2} id="configured-title">
              Agent tools
            </Heading>
            <p className="break-all text-zinc-500 dark:text-zinc-400">
              Configuration: {setup.configPath}
            </p>
            <ul
              className="mt-5 flex list-none flex-wrap gap-2.5 p-0"
              aria-label="Configured agent tools"
            >
              {setup.tools.map((tool) => (
                <li
                  key={tool}
                  className="rounded-lg border border-zinc-300 px-3 py-2 dark:border-zinc-600"
                >
                  {TOOL_NAMES[tool] ?? tool}
                </li>
              ))}
            </ul>
            {setup.catalogs.length > 0 && (
              <>
                <Heading level={3}>Catalogs</Heading>
                <ul aria-label="Configured catalogs">
                  {setup.catalogs.map((entry) => (
                    <li key={entry.name}>
                      {entry.name}:{" "}
                      {entry.source.startsWith("path:") ? entry.source.slice(5) : entry.source}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {setup.catalogs.length > 0 && <SkillBrowser revision={String(setupRevision)} />}
            {setup.catalogs.length === 0 && step === "tools" && (
              <div className="mt-5 flex flex-wrap gap-2.5">
                <Button type="button" onClick={() => setStep("catalogs")}>
                  Add local catalog
                </Button>
              </div>
            )}
            {step === "catalogs" && setup.catalogs.length === 0 && (
              <div className="mt-4">
                <Heading level={3}>Connect local catalog</Heading>
                <Button type="button" onClick={() => void chooseCatalog()} disabled={loading}>
                  Choose folder…
                </Button>
                <label className="mb-1.5 block" htmlFor="existing-catalog-folder">
                  Local folder
                </label>
                <input
                  className="mb-3 block w-full max-w-[360px] rounded-md border border-zinc-400 bg-white px-2.5 py-2 text-zinc-900 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100"
                  id="existing-catalog-folder"
                  value={catalogFolder ?? ""}
                  onChange={(event) => {
                    const folder = event.target.value;

                    void window.ambit.stageLocalCatalog(null, "");
                    setCatalogFolder(folder || null);
                    setCatalogName(folder.split("/").filter(Boolean).at(-1) ?? "");
                    setCatalog(null);
                    setReviewId(null);
                  }}
                  placeholder="/path/to/catalog"
                />
                {catalogFolder && (
                  <>
                    <label className="mb-1.5 block" htmlFor="existing-catalog-name">
                      Catalog name
                    </label>
                    <input
                      className="mb-3 block w-full max-w-[360px] rounded-md border border-zinc-400 bg-white px-2.5 py-2 text-zinc-900 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100"
                      id="existing-catalog-name"
                      value={catalogName}
                      onChange={(event) => {
                        void window.ambit.stageLocalCatalog(null, "");
                        setCatalogName(event.target.value);
                        setCatalog(null);
                        setReviewId(null);
                      }}
                    />
                    <Button type="button" onClick={() => void verifyCatalog()} disabled={loading}>
                      Verify catalog
                    </Button>
                    {catalog && (
                      <p role="status">
                        Loaded {catalog.counts.skills} skills, {catalog.counts.mcps} MCP servers,{" "}
                        {catalog.counts.hooks} hooks, and {catalog.counts.packs} packs.
                      </p>
                    )}
                  </>
                )}
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    onClick={() => void review()}
                    disabled={!catalog || loading}
                  >
                    Review changes
                  </Button>
                  <Button type="button" onClick={() => void discard()}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
            {step === "review" && setup.catalogs.length === 0 && (
              <div className="mt-4">
                <Heading level={3}>Review catalog connection</Heading>
                <p>
                  Catalog: {catalog?.name} ({catalog?.folder}). Capabilities: none. Managed
                  installation paths affected: none.
                </p>
                <p>The existing configuration will add this catalog.</p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button
                    type="button"
                    onClick={() => void (reviewId ? apply() : review())}
                    disabled={loading}
                  >
                    {reviewId ? "Apply changes" : "Refresh review"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setReviewId(null);
                      setStep("catalogs");
                      void window.ambit.cancelPendingAction();
                    }}
                  >
                    Back
                  </Button>
                  <Button type="button" onClick={() => void discard()}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
        {setup?.status === "error" && (
          <section
            className="mb-4 rounded-xl border border-red-300 bg-white p-6 shadow-sm dark:border-red-700 dark:bg-zinc-800"
            aria-labelledby="config-error-title"
            role="alert"
          >
            <Badge color="red">Needs attention</Badge>
            <Heading level={2} id="config-error-title">
              Personal setup could not be opened
            </Heading>
            <p>Check the configuration in Finder, correct the issue, then retry.</p>
            <pre className="break-all rounded-lg bg-red-50 p-3.5 text-xs whitespace-pre-wrap dark:bg-red-950">
              {setup.message}
            </pre>
            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button type="button" onClick={() => void window.ambit.revealPersonal()}>
                Reveal in Finder
              </Button>
              <Button type="button" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
