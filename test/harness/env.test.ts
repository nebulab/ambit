/**
 * Environment references, per harness.
 *
 * The design claim these tests hold to account is that ambit never resolves a `${VAR}` into a config
 * file: it translates the reference into the syntax the target harness expands at spawn time. So the
 * assertions are about *which spelling* comes out, and about the two properties that make the choice
 * safe — a value is never consumed, and nothing outside the `${...}` shape is rewritten.
 */
import { describe, expect, it } from "bun:test";

import {
  bracedRef,
  namespacedRef,
  referencedNames,
  shellRef,
  soleReference,
  stdioEnv,
  translateRefs,
} from "../../src/harness/env.js";

describe("the reference styles", () => {
  it("spells one variable the way each family of harnesses does", () => {
    // Claude Code and Codex take plain shell syntax, which is also the spelling a catalog writes —
    // so the common case is a no-op and the catalog reads as what it means.
    expect(shellRef("TOKEN")).toBe("${TOKEN}");
    // Cursor and VS Code.
    expect(namespacedRef("TOKEN")).toBe("${env:TOKEN}");
    // opencode.
    expect(bracedRef("TOKEN")).toBe("{env:TOKEN}");
  });
});

describe("translating a value", () => {
  it("rewrites every reference in a larger string, leaving the rest of it alone", () => {
    expect(translateRefs("Bearer ${TOKEN}", namespacedRef)).toBe("Bearer ${env:TOKEN}");
    expect(translateRefs("${USER}:${PASSWORD}@host", bracedRef)).toBe(
      "{env:USER}:{env:PASSWORD}@host",
    );
  });

  it("is a no-op for a harness whose syntax already is the catalog's", () => {
    expect(translateRefs("Bearer ${TOKEN}", shellRef)).toBe("Bearer ${TOKEN}");
  });

  it("never resolves a variable, whatever the environment holds", () => {
    // The whole point: a credential in `.mcp.json` would be committed by the next `git add -A`, and
    // an installed file that differed per machine would read as drift for everyone else.
    process.env.AMBIT_TEST_TOKEN = "s3cret";
    try {
      expect(translateRefs("Bearer ${AMBIT_TEST_TOKEN}", shellRef)).toBe(
        "Bearer ${AMBIT_TEST_TOKEN}",
      );
    } finally {
      delete process.env.AMBIT_TEST_TOKEN;
    }
  });

  it("leaves a `${...}` that is not a variable name where it found it", () => {
    // Anchored to the shell-variable character set, so `${}` meaning something else in some other
    // syntax is passed through rather than turned into a reference to a variable nobody set.
    for (const value of ["${1}", "${a-b}", "${ TOKEN }", "${}", "${TOKEN", "$TOKEN"]) {
      expect(translateRefs(value, namespacedRef)).toBe(value);
    }
  });

  it("passes a value holding no reference through unchanged", () => {
    expect(translateRefs("https://mcp.invalid/fixture", bracedRef)).toBe(
      "https://mcp.invalid/fixture",
    );
  });
});

describe("the variables a value names", () => {
  it("lists them in first-appearance order, repeats included", () => {
    expect(referencedNames("${B} ${A} ${B}")).toEqual(["B", "A", "B"]);
  });

  it("lists none for a value with no reference", () => {
    expect(referencedNames("Bearer token")).toEqual([]);
    expect(referencedNames("${ TOKEN }")).toEqual([]);
  });
});

/**
 * `soleReference` is what tells Codex's `env_http_headers` apart from its `http_headers`: a header
 * whose value is nothing but a reference can be expressed by naming the variable, and one with a
 * reference embedded in a larger string cannot.
 */
describe("a value that is entirely one reference", () => {
  it("names the variable", () => {
    expect(soleReference("${TOKEN}")).toBe("TOKEN");
    expect(soleReference("${_private_1}")).toBe("_private_1");
  });

  it("names nothing when the reference is only part of the value", () => {
    expect(soleReference("Bearer ${TOKEN}")).toBeUndefined();
    expect(soleReference("${TOKEN} ")).toBeUndefined();
    expect(soleReference("${A}${B}")).toBeUndefined();
    expect(soleReference("token")).toBeUndefined();
  });
});

describe("the env map a stdio server carries", () => {
  it("maps every expected name to a reference the harness expands", () => {
    expect(stdioEnv(["TOKEN", "API_KEY"], {}, shellRef)).toEqual({
      API_KEY: "${API_KEY}",
      TOKEN: "${TOKEN}",
    });
  });

  it("sorts by name, so the file does not churn when the catalog reorders its list", () => {
    expect(Object.keys(stdioEnv(["TOKEN", "API_KEY", "BASE_URL"], {}, shellRef) ?? {})).toEqual([
      "API_KEY",
      "BASE_URL",
      "TOKEN",
    ]);
  });

  it("does not mutate the list it was handed", () => {
    const expected = ["TOKEN", "API_KEY"];

    stdioEnv(expected, {}, shellRef);

    expect(expected).toEqual(["TOKEN", "API_KEY"]);
  });

  it("returns nothing for an empty list, so the caller can omit the key entirely", () => {
    // A server that declares no variables gets no `env` at all, rather than one carrying nothing.
    expect(stdioEnv([], {}, shellRef)).toBeUndefined();
  });

  it("uses the harness's own spelling", () => {
    expect(stdioEnv(["TOKEN"], {}, namespacedRef)).toEqual({ TOKEN: "${env:TOKEN}" });
    expect(stdioEnv(["TOKEN"], {}, bracedRef)).toEqual({ TOKEN: "{env:TOKEN}" });
  });
});

/**
 * A declared entry is the one place a name can differ on the two sides of the map: the key is what the
 * process reads, and the value says which variable supplies it. Everything else about the map — the
 * spelling, the sorting, the value never being resolved — is the same as for a passed-through name.
 */
describe("an env map that renames a variable", () => {
  it("gives the process the name it reads, from the variable that supplies it", () => {
    expect(
      stdioEnv(["ACME_PLANNER_TOKEN"], { PLANNER_TOKEN: "${ACME_PLANNER_TOKEN}" }, shellRef),
    ).toEqual({ PLANNER_TOKEN: "${ACME_PLANNER_TOKEN}" });
  });

  it("still passes through an expected variable no entry references", () => {
    expect(
      stdioEnv(
        ["ACME_PLANNER_TOKEN", "PLANNER_WORKSPACE"],
        { PLANNER_TOKEN: "${ACME_PLANNER_TOKEN}" },
        shellRef,
      ),
    ).toEqual({
      PLANNER_TOKEN: "${ACME_PLANNER_TOKEN}",
      PLANNER_WORKSPACE: "${PLANNER_WORKSPACE}",
    });
  });

  it("lets an entry override the reference an expected name would have got", () => {
    expect(stdioEnv(["TOKEN"], { TOKEN: "${ACME_TOKEN}" }, shellRef)).toEqual({
      TOKEN: "${ACME_TOKEN}",
    });
  });

  it("translates the value like any other, embedded reference and all", () => {
    expect(stdioEnv([], { PLANNER_AUTH: "Bearer ${ACME_PLANNER_TOKEN}" }, namespacedRef)).toEqual({
      PLANNER_AUTH: "Bearer ${env:ACME_PLANNER_TOKEN}",
    });
    expect(stdioEnv([], { PLANNER_URL: "https://planner.invalid" }, bracedRef)).toEqual({
      PLANNER_URL: "https://planner.invalid",
    });
  });

  it("sorts the two sources together, so a renamed key is not written last", () => {
    expect(
      Object.keys(
        stdioEnv(
          ["PLANNER_WORKSPACE", "ACME_TOKEN"],
          { PLANNER_TOKEN: "${ACME_TOKEN}" },
          shellRef,
        ) ?? {},
      ),
    ).toEqual(["PLANNER_TOKEN", "PLANNER_WORKSPACE"]);
  });
});
