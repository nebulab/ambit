import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopApi } from "./ipc.js";
import type { PersonalSetup } from "./setup.js";
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

function App() {
  const [setup, setSetup] = useState<PersonalSetup | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
  }, [refresh]);

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
            <h1>Personal setup</h1>
            <p className="root-path">{setup?.root ?? "Your home folder"}</p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Retry reading Personal setup"
          >
            {loading ? "Reading…" : "Refresh"}
          </button>
        </header>

        {requestError && (
          <section className="panel error" role="alert">
            <h2>Could not read Personal setup</h2>
            <p>{requestError}</p>
          </section>
        )}
        {loading && !setup && <p role="status">Reading Personal setup…</p>}
        {setup?.status === "unconfigured" && (
          <section className="panel" aria-labelledby="unconfigured-title">
            <p className="badge">Not configured</p>
            <h2 id="unconfigured-title">No Personal setup yet</h2>
            <p>
              Your home folder has no Ambit configuration. You can create one in the next setup
              step.
            </p>
          </section>
        )}
        {setup?.status === "configured" && (
          <section className="panel" aria-labelledby="configured-title">
            <p className="badge success">Configured</p>
            <h2 id="configured-title">Agent tools</h2>
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
            <p className="badge">Needs attention</p>
            <h2 id="config-error-title">Personal setup could not be opened</h2>
            <p>Check the configuration in Finder, correct the issue, then retry.</p>
            <pre className="error-details">{setup.message}</pre>
            <div className="actions">
              <button type="button" onClick={() => void window.ambit.revealPersonal()}>
                Reveal in Finder
              </button>
              <button type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
