import { describe, expect, it } from "vitest";
import { protectedResourceMetadataUrl, wwwAuthenticateHeader } from "../src/responses/errors.js";

describe("protectedResourceMetadataUrl", () => {
  it("places the well-known segment before the resource path", () => {
    expect(protectedResourceMetadataUrl("https://dev-api.mutantbiotech.com/mcp")).toBe(
      "https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("preserves nested resource paths", () => {
    expect(protectedResourceMetadataUrl("https://example.com/api/v2/mcp")).toBe(
      "https://example.com/.well-known/oauth-protected-resource/api/v2/mcp",
    );
  });

  it("omits the path suffix for an origin-only resource", () => {
    expect(protectedResourceMetadataUrl("https://example.com/")).toBe(
      "https://example.com/.well-known/oauth-protected-resource",
    );
  });

  it("never suffixes the well-known segment onto the resource URI", () => {
    const url = protectedResourceMetadataUrl("https://dev-api.mutantbiotech.com/mcp");
    expect(url).not.toContain("/mcp/.well-known/oauth-protected-resource");
  });
});

describe("wwwAuthenticateHeader", () => {
  it("carries the resource metadata URL, error, and canonical URI-form scope", () => {
    const header = wwwAuthenticateHeader({
      resourceMetadataUrl: protectedResourceMetadataUrl(
        "https://dev-api.mutantbiotech.com/mcp",
      ),
      error: "insufficient_scope",
      errorDescription: "missing scope",
      scope: "https://dev-api.mutantbiotech.com/mcp/analysis.read",
    });
    expect(header).toBe(
      'Bearer resource_metadata="https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp", ' +
        'error="insufficient_scope", error_description="missing scope", ' +
        'scope="https://dev-api.mutantbiotech.com/mcp/analysis.read"',
    );
  });
});
