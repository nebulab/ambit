import type { PersonalSetup } from "./setup.js";
import type { SetupTool } from "../../../src/project/empty-setup.js";
import type { LocalCatalogDraft } from "../../../src/project/empty-setup.js";
import type { LocalSkillBrowser } from "./browser.js";

export const DESKTOP_CHANNELS = {
  inspectPersonal: "desktop:inspect-personal",
  revealPersonal: "desktop:reveal-personal",
  stageTool: "desktop:stage-tool",
  chooseLocalCatalog: "desktop:choose-local-catalog",
  stageLocalCatalog: "desktop:stage-local-catalog",
  reviewEmpty: "desktop:review-empty",
  applyEmpty: "desktop:apply-empty",
  retryEmpty: "desktop:retry-empty",
  cancelPendingAction: "desktop:cancel-pending-action",
  requestReview: "desktop:request-review",
  browseLocalSkills: "desktop:browse-local-skills",
  readLocalSkill: "desktop:read-local-skill",
  openExternal: "desktop:open-external",
} as const;

/** Methods exposed to the sandboxed renderer. */
export interface DesktopApi {
  inspectPersonal(): Promise<PersonalSetup>;
  browseLocalSkills(): Promise<LocalSkillBrowser>;
  readLocalSkill(catalog: string, name: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  revealPersonal(): Promise<void>;
  stageTool(tool: SetupTool | null): Promise<void>;
  chooseLocalCatalog(): Promise<string | null>;
  stageLocalCatalog(folder: string | null, name: string): Promise<LocalCatalogDraft | null>;
  reviewEmpty(): Promise<{
    readonly id: string;
    readonly tool: SetupTool;
    readonly catalog: LocalCatalogDraft | null;
  }>;
  applyEmpty(
    id: string,
  ): Promise<{ readonly status: "installed" | "partial"; readonly message?: string }>;
  retryEmpty(): Promise<void>;
  cancelPendingAction(): Promise<void>;
  onRequestReview(callback: () => void): () => void;
}
