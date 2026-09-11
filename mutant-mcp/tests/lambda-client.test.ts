import { describe, expect, it } from "vitest";
import {
  buildBackendEvent,
  MockMutantBackendClient,
  parseBackendPayload,
  serviceUnavailable,
} from "../src/clients/mutant-lambda-client.js";
import { CONTRACT_VERSION } from "../src/contract.js";
import { makeErrorResponse, makeSuccessResponse, makeUser } from "./helpers.js";

describe("buildBackendEvent", () => {
  it("emits the versioned internal contract with token-derived identity", () => {
    const event = buildBackendEvent(
      "get_hypothesis_details",
      { hypothesis_id: "RC_A" },
      makeUser({ userId: "sub-123" }),
      "req-1",
    );
    expect(event).toEqual({
      source: "mutant-mcp",
      contract_version: CONTRACT_VERSION,
      operation: "get_hypothesis_details",
      identity: { user_id: "sub-123" },
      arguments: { hypothesis_id: "RC_A" },
      request_context: { request_id: "req-1" },
    });
  });
});

describe("parseBackendPayload", () => {
  it("accepts a well-formed success envelope", () => {
    const response = makeSuccessResponse();
    expect(parseBackendPayload(response)).toEqual(response);
  });

  it("accepts a well-formed error envelope", () => {
    const response = makeErrorResponse("PLAN_ACCESS_REQUIRED");
    expect(parseBackendPayload(response)).toEqual(response);
  });

  it("maps a non-envelope payload to DATA_INCOMPATIBLE", () => {
    const parsed = parseBackendPayload({ status: "ok" });
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("DATA_INCOMPATIBLE");
  });

  it("rejects a mismatched contract version", () => {
    const parsed = parseBackendPayload({ ...makeSuccessResponse(), contract_version: "0.9.0" });
    expect(parsed.error?.code).toBe("DATA_INCOMPATIBLE");
  });
});

describe("serviceUnavailable", () => {
  it("is retryable and never an empty success", () => {
    const response = serviceUnavailable("down");
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(response.error?.retryable).toBe(true);
  });
});

describe("MockMutantBackendClient", () => {
  it("returns a contract-shaped envelope for local development", async () => {
    const client = new MockMutantBackendClient();
    const response = await client.invoke(
      "get_analysis_status",
      {},
      makeUser(),
      "req-1",
    );
    expect(response.contract_version).toBe(CONTRACT_VERSION);
    expect(response.ok).toBe(true);
  });
});
