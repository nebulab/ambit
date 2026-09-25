import { expect, it } from "bun:test";

import { externalLink } from "../src/external-link.js";

it("accepts web and email destinations and rejects executable or local links", () => {
  expect(externalLink("https://example.com/guide#part")).toBe("https://example.com/guide#part");
  expect(externalLink("http://example.com/")).toBe("http://example.com/");
  expect(externalLink("mailto:help@example.com")).toBe("mailto:help@example.com");

  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "../relative.md",
    "#anchor",
    "mailto:",
  ]) {
    expect(externalLink(url)).toBeNull();
  }
});
