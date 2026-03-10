import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandTestParams } from "./commands-spawn.test-harness.js";
import { handleCommands } from "./commands.js";

const submitResearchRelayJobMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayResultMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayJobsMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayArtifactsMock = vi.hoisted(() => vi.fn());
const fetchResearchRelayExperimentsMock = vi.hoisted(() => vi.fn());
const decideResearchRelayExperimentMock = vi.hoisted(() => vi.fn());
const executeResearchRelayExperimentMock = vi.hoisted(() => vi.fn());
const sendResearchRelayChatMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/research-relay-http.js", () => ({
  submitResearchRelayJob: submitResearchRelayJobMock,
  fetchResearchRelayResult: fetchResearchRelayResultMock,
  fetchResearchRelayJobs: fetchResearchRelayJobsMock,
  fetchResearchRelayArtifacts: fetchResearchRelayArtifactsMock,
  fetchResearchRelayExperiments: fetchResearchRelayExperimentsMock,
  decideResearchRelayExperiment: decideResearchRelayExperimentMock,
  executeResearchRelayExperiment: executeResearchRelayExperimentMock,
  sendResearchRelayChat: sendResearchRelayChatMock,
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

  it("summarizes research artifacts", async () => {
    fetchResearchRelayArtifactsMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_art_1",
      artifacts: {
        report: {
          path: "reports/job_art_1/dossier.md",
          preview: "Artifact preview text.",
        },
        evaluation: {
          json: {
            scores: { overall: 0.82 },
            issues: [{ code: "LOW_PRIMARY_SOURCE_RATIO", severity: "medium" }],
          },
        },
        improvement_candidates: {
          json: {
            candidates: [{ candidate_id: "imp_001", problem: "High failed URL ratio" }],
          },
        },
      },
      raw: {},
    });
    const params = buildCommandTestParams("/research-artifacts job_art_1", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("job_id: job_art_1");
    expect(result.reply?.text).toContain("overall_score: 0.82");
    expect(result.reply?.text).toContain("imp_001");
  });

  it("lists research experiments with eligibility details", async () => {
    fetchResearchRelayExperimentsMock.mockResolvedValueOnce({
      ok: true,
      experiments: [
        {
          experiment_id: "exp_safe_01",
          status: "queued",
          priority: 0.9,
          auto_generated: true,
          benchmark_jobs: ["portable dog water bottle market"],
          hypothesis: "test",
          success_metric: "improve overall",
          rollback_condition: "grounding drop",
          change_set: ["max_total_sources=8"],
        },
      ],
      raw: {},
    });
    const params = buildCommandTestParams("/research-experiments queued 5", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("exp_safe_01");
    expect(result.reply?.text).toContain("auto_generated=yes");
    expect(result.reply?.text).toContain("eligible=yes");
    expect(fetchResearchRelayExperimentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", limit: 5 }),
    );
  });

  it("approves a research experiment", async () => {
    decideResearchRelayExperimentMock.mockResolvedValueOnce({
      ok: true,
      experiment: {
        experiment_id: "exp_safe_01",
        status: "approved",
      },
      raw: {},
    });
    const params = buildCommandTestParams(
      "/research-approve exp_safe_01 approved by operator",
      buildCfg(),
    );

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("experiment_id=exp_safe_01");
    expect(result.reply?.text).toContain("status=approved");
    expect(decideResearchRelayExperimentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        experimentId: "exp_safe_01",
        decision: "approve",
        notes: "approved by operator",
      }),
    );
  });

  it("executes an approved research experiment", async () => {
    executeResearchRelayExperimentMock.mockResolvedValueOnce({
      ok: true,
      experiment: {
        experiment_id: "exp_safe_01",
        status: "completed",
      },
      decision: "adopt",
      resultPath: "reports/experiments/exp_safe_01/experiment_result.json",
      raw: {},
    });
    const params = buildCommandTestParams("/research-execute exp_safe_01", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("decision=adopt");
    expect(result.reply?.text).toContain(
      "result_path=reports/experiments/exp_safe_01/experiment_result.json",
    );
  });

  it("sends research chat to local worker", async () => {
    sendResearchRelayChatMock.mockResolvedValueOnce({
      ok: true,
      model: "qwen2.5:7b-instruct",
      reply: "Local worker reply text.",
      raw: {},
    });
    const params = buildCommandTestParams(
      "/research-chat --model qwen2.5:7b-instruct summarize the queued experiments",
      buildCfg(),
    );

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Local worker reply:");
    expect(result.reply?.text).toContain("qwen2.5:7b-instruct");
    expect(result.reply?.text).toContain("Local worker reply text.");
  });

  it("builds a nightly summary from recent jobs and experiments", async () => {
    fetchResearchRelayJobsMock.mockResolvedValueOnce({
      ok: true,
      jobs: [
        {
          job_id: "job_1",
          status: "stopped_source_budget",
          topic: "portable dog water bottle market",
        },
      ],
      raw: {},
    });
    fetchResearchRelayExperimentsMock.mockResolvedValueOnce({
      ok: true,
      experiments: [
        {
          experiment_id: "exp_safe_01",
          status: "queued",
          priority: 0.9,
          auto_generated: true,
          benchmark_jobs: ["portable dog water bottle market"],
          hypothesis: "test",
          success_metric: "improve overall",
          rollback_condition: "grounding drop",
          change_set: ["max_total_sources=8"],
        },
      ],
      raw: {},
    });
    fetchResearchRelayResultMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_1",
      status: "stopped_source_budget",
      summary: "Portable dog water bottles are growing.",
      run: {},
      raw: {},
    });
    fetchResearchRelayArtifactsMock.mockResolvedValueOnce({
      ok: true,
      jobId: "job_1",
      artifacts: {
        evaluation: {
          json: {
            issues: [{ code: "LOW_PRIMARY_SOURCE_RATIO" }],
          },
        },
        improvement_candidates: {
          json: {
            candidates: [{ candidate_id: "imp_001", problem: "High failed URL ratio" }],
          },
        },
      },
      raw: {},
    });
    const params = buildCommandTestParams("/research-nightly 3", buildCfg());

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Research nightly summary:");
    expect(result.reply?.text).toContain("completion_like=1");
    expect(result.reply?.text).toContain("auto_generated=yes");
    expect(result.reply?.text).toContain("imp_001");
    expect(result.reply?.text).toContain("exp_safe_01");
  });
});
