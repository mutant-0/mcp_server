import { describe, it, expect } from "vitest";
import {
  AwsMutantLambdaClient,
  createMutantLambdaClient,
  MockMutantLambdaClient,
} from "../src/clients/mutant-lambda-client.js";
import { makeConfig, makeUser } from "./helpers.js";

describe("MutantLambdaClient factory", () => {
  it("returns a mock client when no target ARN is configured", () => {
    expect(createMutantLambdaClient(makeConfig())).toBeInstanceOf(MockMutantLambdaClient);
  });

  it("returns an AWS client when a target ARN is configured", () => {
    const client = createMutantLambdaClient(
      makeConfig({
        MUTANT_SERVICE_LAMBDA_ARN:
          "arn:aws:lambda:us-east-1:123456789012:function:mutant-api:production",
      }),
    );
    expect(client).toBeInstanceOf(AwsMutantLambdaClient);
  });
});

describe("MockMutantLambdaClient", () => {
  it("returns a response carrying the event contract", async () => {
    const client = new MockMutantLambdaClient();
    const result = await client.invoke(
      "get_genomic_overview",
      { analysisId: "a1" },
      makeUser("paid"),
      "req-1",
    );
    expect(result).toMatchObject({
      status: "ok",
      mock: true,
      operation: "get_genomic_overview",
      request_id: "req-1",
      identity: { user_id: "user-1" },
    });
  });
});
