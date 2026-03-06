import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands-spawn.test-harness.js";
import { handleCommands } from "./commands.js";

const submitResearchRelayJobMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/research-relay-http.js", () => ({
  submitResearchRelayJob: submitResearchRelayJobMock,
}));

function buildCfg(): OpenClawConfig {
  return {
    commands: { text: true },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
}

describe("/research command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits research topic and returns receipt", async () => {
    submitResearchRelayJobMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_123",
      status: "submitted",
    });
    const params = buildCommandTestParams("/research portable dog water bottle market", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("job_id=job_123");
    expect(result.reply?.text).toContain("status=submitted");
    expect(submitResearchRelayJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "portable dog water bottle market",
        label: undefined,
      }),
    );
  });

  it("accepts optional label argument", async () => {
    submitResearchRelayJobMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_labeled",
      status: "submitted",
    });
    const params = buildCommandTestParams(
      "/research --label market-scan portable dog water bottle market",
      buildCfg(),
    );

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(submitResearchRelayJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "portable dog water bottle market",
        label: "market-scan",
      }),
    );
  });

  it("returns usage on missing topic", async () => {
    const params = buildCommandTestParams("/research", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /research");
    expect(submitResearchRelayJobMock).not.toHaveBeenCalled();
  });

  it("returns disabled message when relay is disabled", async () => {
    submitResearchRelayJobMock.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      error: "Research relay is disabled.",
      reason: "disabled",
    });
    const params = buildCommandTestParams("/research market analysis", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("disabled");
  });
});
