import {
  GetFunctionConfigurationCommand,
  type GetFunctionConfigurationCommandOutput,
} from "@aws-sdk/client-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBackendPagination } from "../scripts/verify-backend.js";

const ARN = "arn:aws:lambda:us-west-2:123456789012:function:report-generator:live";

const send = vi.hoisted(() =>
  vi.fn<
    (command: GetFunctionConfigurationCommand) => Promise<GetFunctionConfigurationCommandOutput>
  >(),
);
vi.mock("@aws-sdk/client-lambda", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-lambda")>()),
  LambdaClient: class {
    send = send;
    destroy() {}
  },
}));

afterEach(() => vi.resetAllMocks());

const missingSecretEnvironments: Array<GetFunctionConfigurationCommandOutput["Environment"]> = [
  undefined,
  {},
  { Variables: {} },
  { Variables: { MCP_CURSOR_SECRET: "" } },
  { Variables: { MCP_CURSOR_SECRET: " \n " } },
];

describe("backend deployment configuration", () => {
  it("checks the exact backend alias and accepts a configured secret", async () => {
    send.mockResolvedValue({
      $metadata: {},
      Environment: { Variables: { MCP_CURSOR_SECRET: "synthetic-secret" } },
    });
    await expect(verifyBackendPagination(ARN)).resolves.toBeUndefined();
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetFunctionConfigurationCommand);
    expect(command?.input).toEqual({ FunctionName: ARN });
  });

  it.each(missingSecretEnvironments)(
    "blocks a deployment with absent or blank pagination configuration (%j)",
    async (environment) => {
      send.mockResolvedValue({
        $metadata: {},
        Environment: environment,
      });
      await expect(verifyBackendPagination(ARN)).rejects.toThrow("missing MCP_CURSOR_SECRET");
    },
  );

  it("does not expose upstream errors or environment contents", async () => {
    send.mockRejectedValue(new Error("sensitive-upstream-detail"));
    await expect(verifyBackendPagination(ARN)).rejects.toThrow(
      /^Cannot inspect the backend Lambda configuration\./,
    );
    send.mockResolvedValue({
      $metadata: {},
      Environment: { Error: { Message: "sensitive-upstream-detail" } },
    });
    await expect(verifyBackendPagination(ARN)).rejects.toThrow(
      "Cannot read the backend Lambda environment. Check its encryption configuration.",
    );
  });

  it.each([undefined, "", "not-an-arn"])(
    "rejects an unspecified or invalid target (%s)",
    async (arn) => {
      await expect(verifyBackendPagination(arn)).rejects.toThrow("Set MUTANT_SERVICE_LAMBDA_ARN");
      expect(send).not.toHaveBeenCalled();
    },
  );
});
