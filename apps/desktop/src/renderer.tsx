import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopApi } from "./ipc.js";
import type { PersonalSetup } from "./setup.js";
import type { SetupTool } from "../../../src/project/empty-setup.js";
import { Button } from "./catalyst/button.js";
import { Badge } from "./catalyst/badge.js";
import { Heading } from "./catalyst/heading.js";
import { Text } from "./catalyst/text.js";
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
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<SetupTool | null>(null);
  const [step, setStep] = useState<"tools" | "catalogs" | "capabilities" | "review">("tools");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    try {
      setSetup(await window.ambit.inspectPersonal());
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
    setReviewId(null);
    setStep("tools");
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
      setReviewId(null);
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
    <div className="app-shell">
      <aside className="sidebar" aria-label="Setups">
        <div className="brand">ambit</div>
        <nav aria-label="Setup navigation">
          <span className="nav-item active" aria-current="page">
            Personal setup
          </span>
        </nav>
      </aside>
      <main id="main-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Your agent capabilities</p>
            <Heading>Personal setup</Heading>
            <Text className="root-path">{setup?.root ?? "Your home folder"}</Text>
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
          <section className="panel error" role="alert">
            <Heading level={2}>Could not read Personal setup</Heading>
            <p>{requestError}</p>
          </section>
        )}
        {partial && (
          <section className="panel error" role="alert">
            <Heading level={2}>Changes not fully installed</Heading>
            <p>{partial}</p>
            <Button type="button" onClick={() => void retry()} disabled={loading}>
              Retry installation
            </Button>
          </section>
        )}
        {loading && !setup && <p role="status">Reading Personal setup…</p>}
        {setup?.status === "unconfigured" && (
          <section className="panel" aria-labelledby="unconfigured-title">
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
                    <label className="tool-choice" key={value}>
                      <input
                        type="radio"
                        name="tool"
                        value={value}
                        checked={tool === value}
                        onChange={() => void chooseTool(value)}
                      />
                      {TOOL_NAMES[value]}
                    </label>
                  ))}
                </fieldset>
                <div className="actions">
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
                <p>Catalogs can be added later. Create an empty setup for now.</p>
                <div className="actions">
                  <Button type="button" onClick={() => setStep("capabilities")}>
                    Skip catalog
                  </Button>
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
                <p>There are no capabilities to select without a catalog.</p>
                <div className="actions">
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
                <Heading level={3}>Review empty setup</Heading>
                <p>Agent tool: {tool ? TOOL_NAMES[tool] : "None"}</p>
                <p>
                  Catalogs: none. Capabilities: none. Managed installation paths affected: none.
                </p>
                <p>
                  The configuration and installation records will be created in your home folder.
                </p>
                <div className="actions">
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
          <section className="panel" aria-labelledby="configured-title">
            <Badge color={partial ? "amber" : "green"}>
              {partial ? "Not fully installed" : "Configured"}
            </Badge>
            <Heading level={2} id="configured-title">
              Agent tools
            </Heading>
            <p className="file-path">Configuration: {setup.configPath}</p>
            <ul className="tool-list" aria-label="Configured agent tools">
              {setup.tools.map((tool) => (
                <li key={tool}>{TOOL_NAMES[tool] ?? tool}</li>
              ))}
            </ul>
          </section>
        )}
        {setup?.status === "error" && (
          <section className="panel error" aria-labelledby="config-error-title" role="alert">
            <Badge color="red">Needs attention</Badge>
            <Heading level={2} id="config-error-title">
              Personal setup could not be opened
            </Heading>
            <p>Check the configuration in Finder, correct the issue, then retry.</p>
            <pre className="error-details">{setup.message}</pre>
            <div className="actions">
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
