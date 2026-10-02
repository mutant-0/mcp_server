/**
 * MCP log-group retention.
 *
 * PRIV-06 requires retention to be applied to the log group whether CDK creates
 * it or adopts an existing one. Creation sets `RetentionInDays` inline; adoption
 * must not recreate or delete the group, so it attaches a dedicated
 * `LogRetention` resource that only calls `PutRetentionPolicy`. An adopted group
 * that never expires -- the state that motivated the ticket -- is the regression
 * these tests cover.
 */
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { MutantMcpStack } from "../infrastructure/lib/mutant-mcp-stack.js";

function synth(adoptLogGroup: boolean, logRetentionDays?: number) {
  const app = new App();
  const stack = new MutantMcpStack(app, "TestStack", {
    functionName: "mutant-mcp-test",
    adoptLogGroup,
    logRetentionDays,
  });
  return Template.fromStack(stack as Stack);
}

// Synthesizing the stack hashes the Docker image asset, which is slow under the
// full suite's parallel load.
describe("MCP log-group retention", { timeout: 30000 }, () => {
  it("sets retention on a created log group", () => {
    const template = synth(false);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/mutant-mcp-test",
      RetentionInDays: 30,
    });
  });

  it("honours an explicit retention override on a created group", () => {
    const template = synth(false, 90);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/mutant-mcp-test",
      RetentionInDays: 90,
    });
  });

  it("does not create a log group when adopting an existing one", () => {
    const template = synth(true);
    template.resourceCountIs("AWS::Logs::LogGroup", 0);
  });

  it("still applies retention to an adopted log group", () => {
    const template = synth(true);
    // `LogRetention` synthesizes a custom resource that calls
    // PutRetentionPolicy on the existing group; it never replaces the group.
    const custom = Object.values(
      template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>,
    ).filter((resource) => resource.Type === "Custom::LogRetention");
    expect(custom.length).toBeGreaterThan(0);
    expect(JSON.stringify(custom)).toContain("/aws/lambda/mutant-mcp-test");
    expect(JSON.stringify(custom)).toContain("30");
  });

  it("rejects a retention value CloudWatch does not support", () => {
    expect(() => synth(false, 45)).toThrow(/Unsupported log-group retention/);
  });
});
