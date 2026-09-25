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
  stageSkill: "desktop:stage-skill",
  reviewEmpty: "desktop:review-empty",
  applyEmpty: "desktop:apply-empty",
  cancelApply: "desktop:cancel-apply",
  applyProgress: "desktop:apply-progress",
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
  stageSkill(catalog: string | null, name: string | null): Promise<void>;
  reviewEmpty(): Promise<{
    readonly id: string;
    readonly tool: SetupTool;
    readonly catalog: LocalCatalogDraft | null;
    readonly skill?: { readonly catalog: string; readonly name: string };
    readonly paths: readonly string[];
  }>;
  applyEmpty(
    id: string,
  ): Promise<{ readonly status: "installed" | "partial"; readonly message?: string }>;
  cancelApply(): Promise<void>;
  onApplyProgress(callback: (phase: "checking" | "writing" | "installing") => void): () => void;
  retryEmpty(): Promise<void>;
  cancelPendingAction(): Promise<void>;
  onRequestReview(callback: () => void): () => void;
}
