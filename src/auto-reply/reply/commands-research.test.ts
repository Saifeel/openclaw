import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands-spawn.test-harness.js";
import { handleCommands } from "./commands.js";

const submitResearchRelayJobMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayResultMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayJobsMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/research-relay-http.js", () => ({
  submitResearchRelayJob: submitResearchRelayJobMock,
  fetchResearchRelayResult: fetchResearchRelayResultMock,
  fetchResearchRelayJobs: fetchResearchRelayJobsMock,
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

  it("fetches research result summary and run info", async () => {
    fetchResearchRelayResultMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_123",
      status: "completed",
      summary: "Premium segment is growing faster than value tier.",
      run: {
        label: "market-scan",
        started_at: "2026-03-07T01:00:00Z",
        completed_at: "2026-03-07T01:20:00Z",
        duration_sec: 1200,
      },
      raw: {},
    });
    const params = buildCommandTestParams("/research-result job_123", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("job_id: job_123");
    expect(result.reply?.text).toContain("status: completed");
    expect(result.reply?.text).toContain("duration_sec: 1200");
    expect(result.reply?.text).toContain("Summary:");
    expect(fetchResearchRelayResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job_123" }),
    );
  });

  it("returns usage for missing /research-result job id", async () => {
    const params = buildCommandTestParams("/research-result", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /research-result <job_id>");
    expect(fetchResearchRelayResultMock).not.toHaveBeenCalled();
  });

  it("lists research jobs with basic run details", async () => {
    fetchResearchRelayJobsMock.mockResolvedValueOnce({
      ok: true,
      jobs: [
        {
          job_id: "job_1",
          status: "completed",
          topic: "portable dog water bottle market",
          label: "market-scan",
          duration_sec: 180,
        },
      ],
      raw: {},
    });
    const params = buildCommandTestParams("/research-jobs 5", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Past research runs:");
    expect(result.reply?.text).toContain("job_1");
    expect(result.reply?.text).toContain("duration_sec=180");
    expect(fetchResearchRelayJobsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it("returns usage when /research-jobs limit is invalid", async () => {
    const params = buildCommandTestParams("/research-jobs 999", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /research-jobs [limit 1-100]");
    expect(fetchResearchRelayJobsMock).not.toHaveBeenCalled();
  });
});
