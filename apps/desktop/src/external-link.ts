/** Returns an external URL only for protocols the desktop preview permits. */
export function externalLink(raw: string): string | null {
  try {
    const url = new URL(raw);

    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }

    if (url.protocol === "mailto:" && url.pathname.length > 0) {
      return url.toString();
    }
  } catch {
    // Relative paths are not external destinations.
  }

  return null;
}
