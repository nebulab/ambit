import type { PersonalSetup } from "./setup.js";

export const DESKTOP_CHANNELS = {
  inspectPersonal: "desktop:inspect-personal",
  revealPersonal: "desktop:reveal-personal",
} as const;

/** Methods exposed to the sandboxed renderer. */
export interface DesktopApi {
  inspectPersonal(): Promise<PersonalSetup>;
  revealPersonal(): Promise<void>;
}
