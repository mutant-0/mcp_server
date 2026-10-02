/**
 * PRIV-09 manifest conformance.
 *
 * `plugin.json` is the listing metadata submitted for the ChatGPT app. The
 * Agent Plugins 1.0.0 manifest has `additionalProperties: false`, so a single
 * invented key fails store validation. These tests check the checked-in
 * manifest against the vendored schema that was fetched from
 * https://agent-plugins.org/schemas/1.0.0/plugin.schema.json.
 *
 * The published `name` pattern (`^(?!.*(?:--|\\.\\.))a-z0-9?$`) matches no
 * real string: outside a character class `a-z0-9?` is literal, so even
 * `mutantgenomics` is rejected. The schema is treated as intending
 * `^[a-z0-9-]+$` with no `--`/`..` runs; that is asserted here explicitly so a
 * future upstream fix is noticed rather than silently assumed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "../plugin.json"), "utf8")) as Record<
  string,
  unknown
>;
const schema = JSON.parse(readFileSync(resolve(here, "fixtures/plugin.schema.json"), "utf8")) as {
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

const EXPECTED_NAME_PATTERN = /^[a-z0-9-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("plugin.json Agent Plugins 1.0.0 manifest", () => {
  it("declares the schema id the vendored schema targets", () => {
    const schemaProp = schema.properties.$schema as { const: string };
    expect(manifest.$schema).toBe(schemaProp.const);
  });

  it("carries every required top-level field", () => {
    for (const key of schema.required) {
      expect(manifest[key], `missing required field ${key}`).toBeDefined();
    }
  });

  it("declares no top-level keys the schema does not define", () => {
    const allowed = new Set(Object.keys(schema.properties));
    const unexpected = Object.keys(manifest).filter((key) => !allowed.has(key));
    expect(unexpected).toEqual([]);
  });

  it("uses a name the intended schema pattern accepts", () => {
    const name = manifest.name;
    expect(typeof name).toBe("string");
    const value = name as string;
    expect(value.length).toBeGreaterThanOrEqual(1);
    expect(value.length).toBeLessThanOrEqual(64);
    expect(EXPECTED_NAME_PATTERN.test(value), `name ${value} is not a lowercase slug`).toBe(true);
    expect(value).not.toContain("--");
    expect(value).not.toContain("..");
  });

  it("keeps author to the declared fields", () => {
    if (manifest.author === undefined) return;
    expect(isPlainObject(manifest.author)).toBe(true);
    const authorSchema = schema.properties.author as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    const allowed = new Set(Object.keys(authorSchema.properties));
    const unexpected = Object.keys(manifest.author as Record<string, unknown>).filter(
      (key) => !allowed.has(key),
    );
    expect(unexpected).toEqual([]);
  });

  it("exposes a public website reference without inventing a privacy/terms key", () => {
    // The 1.0.0 schema has no privacy/terms/support URL field. Website is
    // `homepage`; support is `author.url`/`author.email`. A privacy or terms key
    // would be rejected by `additionalProperties: false`.
    expect(typeof manifest.homepage).toBe("string");
    expect(manifest.homepage).toMatch(/^https:\/\//);
    expect(manifest).not.toHaveProperty("privacy_policy_url");
    expect(manifest).not.toHaveProperty("terms_of_service_url");
  });
});
