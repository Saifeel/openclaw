import {
  decideResearchRelayExperiment,
  executeResearchRelayExperiment,
  fetchResearchRelayArtifacts,
  fetchResearchRelayExperiments,
  fetchResearchRelayJobs,
  fetchResearchRelayResult,
  sendResearchRelayChat,
  submitResearchRelayJob,
} from "../../gateway/research-relay-http.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const RESEARCH_PREFIX = "/research";
const RESEARCH_RESULT_PREFIX = "/research-result";
const RESEARCH_JOBS_PREFIX = "/research-jobs";
const RESEARCH_ARTIFACTS_PREFIX = "/research-artifacts";
const RESEARCH_EXPERIMENTS_PREFIX = "/research-experiments";
const RESEARCH_APPROVE_PREFIX = "/research-approve";
const RESEARCH_EXECUTE_PREFIX = "/research-execute";
const RESEARCH_CHAT_PREFIX = "/research-chat";
const RESEARCH_NIGHTLY_PREFIX = "/research-nightly";

const TERMINAL_RESEARCH_STATUSES = new Set([
  "done",
  "completed",
  "failed",
  "stopped_by_user",
  "stopped_source_budget",
  "stopped_runtime_budget",
]);
const COMPLETION_LIKE_RESEARCH_STATUSES = new Set([
  "done",
  "completed",
  "stopped_by_user",
  "stopped_source_budget",
  "stopped_runtime_budget",
]);
const SAFE_EXPERIMENT_FIELDS = new Set([
  "research_depth",
  "max_search_results",
  "max_sources_per_question",
  "max_total_sources",
  "max_runtime_minutes",
]);

function parseResearchArgs(commandBodyNormalized: string): {
  topic?: string;
  label?: string;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_PREFIX) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_PREFIX} `)) {
    return {};
  }

  const rawArgs = commandBodyNormalized.slice(RESEARCH_PREFIX.length).trim();
  if (!rawArgs) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }

  if (!rawArgs.toLowerCase().startsWith("--label ")) {
    return { topic: rawArgs };
  }

  const afterLabel = rawArgs.slice("--label ".length).trim();
  if (!afterLabel) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  const firstSpace = afterLabel.search(/\s/);
  if (firstSpace <= 0) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  const label = afterLabel.slice(0, firstSpace).trim();
  const topic = afterLabel.slice(firstSpace).trim();
  if (!label || !topic) {
    return {
      usageError: "Usage: /research [--label <label>] <topic>",
    };
  }
  return { topic, label };
}

function parseResearchResultArgs(commandBodyNormalized: string): {
  jobId?: string;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_RESULT_PREFIX) {
    return {
      usageError: "Usage: /research-result <job_id>",
    };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_RESULT_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_RESULT_PREFIX.length).trim();
  if (!rawArgs) {
    return {
      usageError: "Usage: /research-result <job_id>",
    };
  }
  return { jobId: rawArgs };
}

function parseResearchJobsArgs(commandBodyNormalized: string): {
  limit?: number;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_JOBS_PREFIX) {
    return {};
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_JOBS_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_JOBS_PREFIX.length).trim();
  if (!rawArgs) {
    return {};
  }
  const parsed = Number.parseInt(rawArgs, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return { usageError: "Usage: /research-jobs [limit 1-100]" };
  }
  return { limit: Math.floor(parsed) };
}

function parseSingleIdCommand(
  commandBodyNormalized: string,
  prefix: string,
  usage: string,
): { value?: string; usageError?: string } {
  if (commandBodyNormalized === prefix) {
    return { usageError: usage };
  }
  if (!commandBodyNormalized.startsWith(`${prefix} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(prefix.length).trim();
  if (!rawArgs) {
    return { usageError: usage };
  }
  return { value: rawArgs };
}

function parseResearchExperimentsArgs(commandBodyNormalized: string): {
  status?: string;
  limit?: number;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_EXPERIMENTS_PREFIX) {
    return { status: "queued", limit: 10 };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_EXPERIMENTS_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_EXPERIMENTS_PREFIX.length).trim();
  if (!rawArgs) {
    return { status: "queued", limit: 10 };
  }
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (parts.length === 1 && /^\d+$/.test(first)) {
    const limit = Number.parseInt(first, 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      return { usageError: "Usage: /research-experiments [status] [limit 1-100]" };
    }
    return { status: "queued", limit };
  }
  const limit = second == null || second.trim().length === 0 ? 10 : Number.parseInt(second, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    return { usageError: "Usage: /research-experiments [status] [limit 1-100]" };
  }
  return { status: first, limit };
}

function parseResearchApproveArgs(commandBodyNormalized: string): {
  experimentId?: string;
  notes?: string;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_APPROVE_PREFIX) {
    return { usageError: "Usage: /research-approve <experiment_id> [notes]" };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_APPROVE_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_APPROVE_PREFIX.length).trim();
  if (!rawArgs) {
    return { usageError: "Usage: /research-approve <experiment_id> [notes]" };
  }
  const firstSpace = rawArgs.search(/\s/);
  if (firstSpace < 0) {
    return { experimentId: rawArgs };
  }
  return {
    experimentId: rawArgs.slice(0, firstSpace).trim(),
    notes: rawArgs.slice(firstSpace).trim() || undefined,
  };
}

function parseResearchChatArgs(commandBodyNormalized: string): {
  message?: string;
  model?: string;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_CHAT_PREFIX) {
    return { usageError: "Usage: /research-chat [--model <model>] <message>" };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_CHAT_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_CHAT_PREFIX.length).trim();
  if (!rawArgs) {
    return { usageError: "Usage: /research-chat [--model <model>] <message>" };
  }
  if (!rawArgs.toLowerCase().startsWith("--model ")) {
    return { message: rawArgs };
  }
  const afterModel = rawArgs.slice("--model ".length).trim();
  if (!afterModel) {
    return { usageError: "Usage: /research-chat [--model <model>] <message>" };
  }
  const firstSpace = afterModel.search(/\s/);
  if (firstSpace <= 0) {
    return { usageError: "Usage: /research-chat [--model <model>] <message>" };
  }
  const model = afterModel.slice(0, firstSpace).trim();
  const message = afterModel.slice(firstSpace).trim();
  if (!model || !message) {
    return { usageError: "Usage: /research-chat [--model <model>] <message>" };
  }
  return { model, message };
}

function parseResearchNightlyArgs(commandBodyNormalized: string): {
  limit?: number;
  usageError?: string;
} {
  if (commandBodyNormalized === RESEARCH_NIGHTLY_PREFIX) {
    return { limit: 5 };
  }
  if (!commandBodyNormalized.startsWith(`${RESEARCH_NIGHTLY_PREFIX} `)) {
    return {};
  }
  const rawArgs = commandBodyNormalized.slice(RESEARCH_NIGHTLY_PREFIX.length).trim();
  if (!rawArgs) {
    return { limit: 5 };
  }
  const parsed = Number.parseInt(rawArgs, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
    return { usageError: "Usage: /research-nightly [limit 1-20]" };
  }
  return { limit: Math.floor(parsed) };
}

function formatRunInfoLines(run: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const orderedKeys = [
    "topic",
    "label",
    "submitted_at",
    "started_at",
    "completed_at",
    "duration_sec",
    "report_path",
    "progress",
    "phase",
    "error",
    "current_question",
  ];
  for (const key of orderedKeys) {
    const value = run[key];
    if (value == null) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  const currentSource = run.current_source;
  if (currentSource && typeof currentSource === "object" && !Array.isArray(currentSource)) {
    const source = currentSource as Record<string, unknown>;
    const sourceParts: string[] = [];
    if (typeof source.title === "string" && source.title.trim()) {
      sourceParts.push(`title: ${source.title.trim()}`);
    }
    if (typeof source.url === "string" && source.url.trim()) {
      sourceParts.push(`url: ${source.url.trim()}`);
    }
    if (typeof source.event === "string" && source.event.trim()) {
      sourceParts.push(`event: ${source.event.trim()}`);
    }
    if (sourceParts.length > 0) {
      lines.push(`current_source: ${sourceParts.join(" | ")}`);
    }
  }
  return lines;
}

function readStringField(root: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function readScalarField(root: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatJobsList(jobs: Array<Record<string, unknown>>): string {
  if (jobs.length === 0) {
    return "No past research runs found.";
  }
  const lines = ["Past research runs:"];
  for (const job of jobs.slice(0, 20)) {
    const run = isRecord(job.run) ? job.run : {};
    const jobId =
      readStringField(job, ["job_id", "jobId", "id"]) ??
      readStringField(run, ["job_id", "jobId", "id"]) ??
      "<unknown>";
    const status = readStringField(job, ["status", "state"]) ?? "unknown";
    const topic = readStringField(job, ["topic"]) ?? readStringField(run, ["topic"]);
    const label = readStringField(job, ["label"]) ?? readStringField(run, ["label"]);
    const submittedAt =
      readScalarField(job, ["submitted_at", "submittedAt", "created_at"]) ??
      readScalarField(run, ["submitted_at", "submittedAt", "created_at"]);
    const completedAt =
      readScalarField(job, ["completed_at", "completedAt", "finished_at"]) ??
      readScalarField(run, ["completed_at", "completedAt", "finished_at"]);
    const durationSec =
      readScalarField(job, ["duration_sec", "durationSeconds"]) ??
      readScalarField(run, ["duration_sec", "durationSeconds"]);

    const details = [
      `status=${status}`,
      topic ? `topic=${topic}` : "",
      label ? `label=${label}` : "",
      submittedAt ? `submitted_at=${submittedAt}` : "",
      completedAt ? `completed_at=${completedAt}` : "",
      durationSec ? `duration_sec=${durationSec}` : "",
    ].filter(Boolean);
    lines.push(`- ${jobId} | ${details.join(" | ")}`);
  }
  lines.push("");
  lines.push("Inspect one run: /research-result <job_id>");
  return lines.join("\n");
}

function truncateText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd()}...`;
}

function getArtifactJson(
  artifacts: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const entry = artifacts[key];
  if (!isRecord(entry)) {
    return undefined;
  }
  const json = entry.json;
  return isRecord(json) ? json : undefined;
}

function formatArtifactsSummary(jobId: string, artifacts: Record<string, unknown>): string {
  const lines = [`Research artifacts`, `job_id: ${jobId}`];
  const report = isRecord(artifacts.report) ? artifacts.report : {};
  const reportPath = readStringField(report, ["path"]);
  if (reportPath) {
    lines.push(`report_path: ${reportPath}`);
  }
  const preview = readStringField(report, ["preview"]);
  const evaluation = getArtifactJson(artifacts, "evaluation");
  const improvements = getArtifactJson(artifacts, "improvement_candidates");
  if (evaluation) {
    const scores = isRecord(evaluation.scores) ? evaluation.scores : {};
    const overall = readScalarField(scores, ["overall"]);
    if (overall) {
      lines.push(`overall_score: ${overall}`);
    }
    const issues = Array.isArray(evaluation.issues) ? evaluation.issues.filter(isRecord) : [];
    if (issues.length > 0) {
      lines.push("");
      lines.push("Top issues:");
      for (const issue of issues.slice(0, 3)) {
        const code = readStringField(issue, ["code"]) ?? "unknown_issue";
        const severity = readStringField(issue, ["severity"]) ?? "unknown";
        lines.push(`- ${code} (${severity})`);
      }
    }
  }
  if (improvements) {
    const candidates = Array.isArray(improvements.candidates)
      ? improvements.candidates.filter(isRecord)
      : [];
    if (candidates.length > 0) {
      lines.push("");
      lines.push("Top improvement candidates:");
      for (const candidate of candidates.slice(0, 3)) {
        const candidateId = readStringField(candidate, ["candidate_id"]) ?? "candidate";
        const problem = readStringField(candidate, ["problem"]) ?? "unspecified";
        const priority = readScalarField(candidate, ["priority_score"]);
        lines.push(
          `- ${candidateId}${priority ? ` | priority=${priority}` : ""} | ${truncateText(problem, 120)}`,
        );
      }
    }
  }
  if (preview) {
    lines.push("");
    lines.push(`Report preview: ${truncateText(preview, 300)}`);
  }
  return lines.join("\n");
}

function assessExperimentEligibility(experiment: Record<string, unknown>): {
  eligible: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const status = readStringField(experiment, ["status"])?.toLowerCase() ?? "";
  if (status !== "queued") {
    reasons.push("status is not queued");
  }
  if (experiment.auto_generated !== true) {
    reasons.push("auto_generated is not true");
  }
  const benchmarkJobs = Array.isArray(experiment.benchmark_jobs)
    ? experiment.benchmark_jobs.filter((value) => typeof value === "string" && value.trim())
    : [];
  if (benchmarkJobs.length === 0) {
    reasons.push("benchmark_jobs missing");
  }
  for (const key of ["hypothesis", "success_metric", "rollback_condition"]) {
    if (!readStringField(experiment, [key])) {
      reasons.push(`${key} missing`);
    }
  }
  const priority = Number.parseFloat(readScalarField(experiment, ["priority"]) ?? "0");
  if (!Number.isFinite(priority) || priority < 0.5) {
    reasons.push("priority below threshold");
  }
  const changeSet = Array.isArray(experiment.change_set)
    ? experiment.change_set.filter((value) => typeof value === "string")
    : [];
  if (changeSet.length === 0) {
    reasons.push("change_set missing");
  }
  for (const item of changeSet) {
    const field = item.split("=", 1)[0]?.trim() ?? "";
    if (!SAFE_EXPERIMENT_FIELDS.has(field)) {
      reasons.push(`unsupported change_set field: ${field || "<empty>"}`);
    }
  }
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function formatExperimentsList(experiments: Array<Record<string, unknown>>): string {
  if (experiments.length === 0) {
    return "No experiments found.";
  }
  const lines = ["Research experiments:"];
  for (const experiment of experiments.slice(0, 20)) {
    const experimentId = readStringField(experiment, ["experiment_id", "id"]) ?? "<unknown>";
    const status = readStringField(experiment, ["status"]) ?? "unknown";
    const priority = readScalarField(experiment, ["priority"]);
    const eligibility = assessExperimentEligibility(experiment);
    const changeSet = Array.isArray(experiment.change_set)
      ? experiment.change_set.filter((value) => typeof value === "string").join(", ")
      : "";
    const benchmarkCount = Array.isArray(experiment.benchmark_jobs)
      ? experiment.benchmark_jobs.length
      : 0;
    const bits = [
      `status=${status}`,
      priority ? `priority=${priority}` : "",
      `auto_generated=${experiment.auto_generated === true ? "yes" : "no"}`,
      `eligible=${eligibility.eligible ? "yes" : "no"}`,
      benchmarkCount > 0 ? `benchmarks=${benchmarkCount}` : "",
      changeSet ? `changes=${changeSet}` : "",
    ].filter(Boolean);
    lines.push(`- ${experimentId} | ${bits.join(" | ")}`);
    if (!eligibility.eligible && eligibility.reasons.length > 0) {
      lines.push(`  review: ${truncateText(eligibility.reasons.join("; "), 160)}`);
    }
  }
  return lines.join("\n");
}

async function formatNightlySummary(limit: number): Promise<string> {
  const jobsResult = await fetchResearchRelayJobs({ limit, env: process.env });
  if (!jobsResult.ok) {
    return `Failed to build nightly summary: ${jobsResult.error}`;
  }
  const experimentsResult = await fetchResearchRelayExperiments({
    status: "queued",
    limit: Math.min(limit, 10),
    env: process.env,
  });
  if (!experimentsResult.ok) {
    return `Failed to build nightly summary: ${experimentsResult.error}`;
  }

  const jobs = jobsResult.jobs;
  const terminalJobs = jobs.filter((job) => {
    const status = readStringField(job, ["status"])?.toLowerCase() ?? "";
    return TERMINAL_RESEARCH_STATUSES.has(status);
  });
  const completedLikeJobs = terminalJobs.filter((job) => {
    const status = readStringField(job, ["status"])?.toLowerCase() ?? "";
    return COMPLETION_LIKE_RESEARCH_STATUSES.has(status);
  });
  const failedJobs = terminalJobs.filter((job) => {
    const status = readStringField(job, ["status"])?.toLowerCase() ?? "";
    return status === "failed";
  });

  const resultPayloads = await Promise.all(
    terminalJobs.slice(0, Math.min(limit, 5)).map(async (job) => {
      const jobId = readStringField(job, ["job_id", "jobId", "id"]);
      if (!jobId) {
        return null;
      }
      const result = await fetchResearchRelayResult({ jobId, env: process.env });
      return result.ok ? result : null;
    }),
  );
  const artifactPayloads = await Promise.all(
    terminalJobs.slice(0, Math.min(limit, 5)).map(async (job) => {
      const jobId = readStringField(job, ["job_id", "jobId", "id"]);
      if (!jobId) {
        return null;
      }
      const artifacts = await fetchResearchRelayArtifacts({
        jobId,
        includeText: false,
        env: process.env,
      });
      return artifacts.ok ? artifacts : null;
    }),
  );

  const lines = [
    "Research nightly summary:",
    `- jobs_reviewed=${jobs.length}`,
    `- terminal_jobs=${terminalJobs.length}`,
    `- completion_like=${completedLikeJobs.length}`,
    `- failed=${failedJobs.length}`,
    `- queued_experiments=${experimentsResult.experiments.length}`,
  ];

  const summaries = resultPayloads.filter((value) => value != null);
  if (summaries.length > 0) {
    lines.push("");
    lines.push("Recent terminal jobs:");
    for (const result of summaries) {
      lines.push(
        `- ${result.jobId} | status=${result.status} | ${truncateText(result.summary ?? "summary unavailable", 180)}`,
      );
    }
  }

  const topCandidates: string[] = [];
  const topIssues: string[] = [];
  for (const artifactPayload of artifactPayloads.filter((value) => value != null)) {
    const evaluation = getArtifactJson(artifactPayload.artifacts, "evaluation");
    const improvements = getArtifactJson(artifactPayload.artifacts, "improvement_candidates");
    const issues = Array.isArray(evaluation?.issues) ? evaluation.issues.filter(isRecord) : [];
    const candidates = Array.isArray(improvements?.candidates)
      ? improvements.candidates.filter(isRecord)
      : [];
    for (const issue of issues.slice(0, 1)) {
      topIssues.push(
        `${artifactPayload.jobId}: ${readStringField(issue, ["code"]) ?? "unknown_issue"}`,
      );
    }
    for (const candidate of candidates.slice(0, 1)) {
      topCandidates.push(
        `${artifactPayload.jobId}: ${readStringField(candidate, ["candidate_id"]) ?? "candidate"} | ${truncateText(readStringField(candidate, ["problem"]) ?? "unspecified", 120)}`,
      );
    }
  }
  if (topIssues.length > 0) {
    lines.push("");
    lines.push("Top evaluation flags:");
    for (const item of topIssues.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
  }
  if (topCandidates.length > 0) {
    lines.push("");
    lines.push("Top improvement candidates:");
    for (const item of topCandidates.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
  }
  if (experimentsResult.experiments.length > 0) {
    lines.push("");
    lines.push("Queued experiments:");
    for (const experiment of experimentsResult.experiments.slice(0, 5)) {
      const experimentId = readStringField(experiment, ["experiment_id"]) ?? "<unknown>";
      const eligibility = assessExperimentEligibility(experiment);
      const priority = readScalarField(experiment, ["priority"]);
      lines.push(
        `- ${experimentId} | auto_generated=${experiment.auto_generated === true ? "yes" : "no"} | eligible=${eligibility.eligible ? "yes" : "no"}${priority ? ` | priority=${priority}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export const handleResearchCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsedArtifacts = parseSingleIdCommand(
    params.command.commandBodyNormalized,
    RESEARCH_ARTIFACTS_PREFIX,
    "Usage: /research-artifacts <job_id>",
  );
  if (parsedArtifacts.value || parsedArtifacts.usageError) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-artifacts from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedArtifacts.usageError || !parsedArtifacts.value) {
      return {
        shouldContinue: false,
        reply: { text: parsedArtifacts.usageError ?? "Usage: /research-artifacts <job_id>" },
      };
    }
    const artifacts = await fetchResearchRelayArtifacts({
      jobId: parsedArtifacts.value,
      includeText: true,
      env: process.env,
    });
    if (!artifacts.ok) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to fetch research artifacts: ${artifacts.error}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatArtifactsSummary(artifacts.jobId, artifacts.artifacts) },
    };
  }

  const parsedExperiments = parseResearchExperimentsArgs(params.command.commandBodyNormalized);
  if (
    params.command.commandBodyNormalized === RESEARCH_EXPERIMENTS_PREFIX ||
    params.command.commandBodyNormalized.startsWith(`${RESEARCH_EXPERIMENTS_PREFIX} `)
  ) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-experiments from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedExperiments.usageError) {
      return {
        shouldContinue: false,
        reply: { text: parsedExperiments.usageError },
      };
    }
    const experiments = await fetchResearchRelayExperiments({
      status: parsedExperiments.status,
      limit: parsedExperiments.limit,
      env: process.env,
    });
    if (!experiments.ok) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to fetch research experiments: ${experiments.error}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatExperimentsList(experiments.experiments) },
    };
  }

  const parsedApprove = parseResearchApproveArgs(params.command.commandBodyNormalized);
  if (parsedApprove.experimentId || parsedApprove.usageError) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedApprove.usageError || !parsedApprove.experimentId) {
      return {
        shouldContinue: false,
        reply: {
          text: parsedApprove.usageError ?? "Usage: /research-approve <experiment_id> [notes]",
        },
      };
    }
    const decision = await decideResearchRelayExperiment({
      experimentId: parsedApprove.experimentId,
      decision: "approve",
      notes: parsedApprove.notes,
      env: process.env,
    });
    if (!decision.ok) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to approve experiment: ${decision.error}` },
      };
    }
    const experimentId =
      (decision.experiment && readStringField(decision.experiment, ["experiment_id"])) ??
      parsedApprove.experimentId;
    const status = decision.experiment
      ? (readStringField(decision.experiment, ["status"]) ?? "approved")
      : "approved";
    return {
      shouldContinue: false,
      reply: { text: `Experiment updated. experiment_id=${experimentId} status=${status}` },
    };
  }

  const parsedExecute = parseSingleIdCommand(
    params.command.commandBodyNormalized,
    RESEARCH_EXECUTE_PREFIX,
    "Usage: /research-execute <experiment_id>",
  );
  if (parsedExecute.value || parsedExecute.usageError) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-execute from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedExecute.usageError || !parsedExecute.value) {
      return {
        shouldContinue: false,
        reply: { text: parsedExecute.usageError ?? "Usage: /research-execute <experiment_id>" },
      };
    }
    const execution = await executeResearchRelayExperiment({
      experimentId: parsedExecute.value,
      env: process.env,
    });
    if (!execution.ok) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to execute experiment: ${execution.error}` },
      };
    }
    const experimentId =
      (execution.experiment && readStringField(execution.experiment, ["experiment_id"])) ??
      parsedExecute.value;
    const status = execution.experiment
      ? (readStringField(execution.experiment, ["status"]) ?? "completed")
      : "completed";
    const suffix = execution.resultPath ? ` result_path=${execution.resultPath}` : "";
    return {
      shouldContinue: false,
      reply: {
        text: `Experiment executed. experiment_id=${experimentId} status=${status}${execution.decision ? ` decision=${execution.decision}` : ""}${suffix}`,
      },
    };
  }

  const parsedChat = parseResearchChatArgs(params.command.commandBodyNormalized);
  if (parsedChat.message || parsedChat.usageError) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-chat from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedChat.usageError || !parsedChat.message) {
      return {
        shouldContinue: false,
        reply: {
          text: parsedChat.usageError ?? "Usage: /research-chat [--model <model>] <message>",
        },
      };
    }
    const chat = await sendResearchRelayChat({
      message: parsedChat.message,
      model: parsedChat.model,
      env: process.env,
    });
    if (!chat.ok) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to reach local worker chat: ${chat.error}` },
      };
    }
    const lines = ["Local worker reply:"];
    if (chat.model) {
      lines.push(`model: ${chat.model}`);
      lines.push("");
    }
    lines.push(chat.reply);
    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  const parsedNightly = parseResearchNightlyArgs(params.command.commandBodyNormalized);
  if (
    params.command.commandBodyNormalized === RESEARCH_NIGHTLY_PREFIX ||
    params.command.commandBodyNormalized.startsWith(`${RESEARCH_NIGHTLY_PREFIX} `)
  ) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-nightly from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedNightly.usageError) {
      return {
        shouldContinue: false,
        reply: { text: parsedNightly.usageError },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: await formatNightlySummary(parsedNightly.limit ?? 5) },
    };
  }

  const parsedJobs = parseResearchJobsArgs(params.command.commandBodyNormalized);
  if (
    params.command.commandBodyNormalized === RESEARCH_JOBS_PREFIX ||
    params.command.commandBodyNormalized.startsWith(`${RESEARCH_JOBS_PREFIX} `)
  ) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-jobs from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedJobs.usageError) {
      return {
        shouldContinue: false,
        reply: { text: parsedJobs.usageError },
      };
    }
    const jobs = await fetchResearchRelayJobs({
      limit: parsedJobs.limit,
      env: process.env,
    });
    if (!jobs.ok) {
      if (jobs.reason === "disabled") {
        return {
          shouldContinue: false,
          reply: { text: "Research relay is disabled on this gateway." },
        };
      }
      if (jobs.reason === "misconfigured") {
        return {
          shouldContinue: false,
          reply: { text: "Research relay is enabled but misconfigured on this gateway." },
        };
      }
      if (jobs.reason === "invalid_limit") {
        return {
          shouldContinue: false,
          reply: { text: "Usage: /research-jobs [limit 1-100]" },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `Failed to fetch research jobs: ${jobs.error}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: formatJobsList(jobs.jobs) },
    };
  }

  const parsedResult = parseResearchResultArgs(params.command.commandBodyNormalized);
  if (parsedResult.jobId || parsedResult.usageError) {
    if (!params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /research-result from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (parsedResult.usageError || !parsedResult.jobId) {
      return {
        shouldContinue: false,
        reply: { text: parsedResult.usageError ?? "Usage: /research-result <job_id>" },
      };
    }

    const result = await fetchResearchRelayResult({
      jobId: parsedResult.jobId,
      env: process.env,
    });
    if (!result.ok) {
      if (result.reason === "disabled") {
        return {
          shouldContinue: false,
          reply: { text: "Research relay is disabled on this gateway." },
        };
      }
      if (result.reason === "misconfigured") {
        return {
          shouldContinue: false,
          reply: { text: "Research relay is enabled but misconfigured on this gateway." },
        };
      }
      if (result.reason === "invalid_job_id") {
        return {
          shouldContinue: false,
          reply: { text: "Invalid job_id. Usage: /research-result <job_id>" },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `Failed to fetch research result: ${result.error}` },
      };
    }

    const lines = [`Research result`, `job_id: ${result.jobId}`, `status: ${result.status}`];
    const runInfoLines = formatRunInfoLines(result.run);
    if (runInfoLines.length > 0) {
      lines.push("");
      lines.push("Run details:");
      for (const line of runInfoLines) {
        lines.push(`- ${line}`);
      }
    }
    lines.push("");
    lines.push(result.summary ? `Summary:\n${result.summary}` : "Summary: not available yet.");
    return {
      shouldContinue: false,
      reply: {
        text: lines.join("\n"),
      },
    };
  }

  const parsed = parseResearchArgs(params.command.commandBodyNormalized);
  if (!parsed.topic && !parsed.usageError) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /research from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (parsed.usageError || !parsed.topic) {
    return {
      shouldContinue: false,
      reply: { text: parsed.usageError ?? "Usage: /research [--label <label>] <topic>" },
    };
  }

  const result = await submitResearchRelayJob({
    topic: parsed.topic,
    label: parsed.label,
    env: process.env,
  });
  if (!result.ok) {
    if (result.reason === "disabled") {
      return {
        shouldContinue: false,
        reply: { text: "Research relay is disabled on this gateway." },
      };
    }
    if (result.reason === "misconfigured") {
      return {
        shouldContinue: false,
        reply: { text: "Research relay is enabled but misconfigured on this gateway." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Failed to submit research job: ${result.error}` },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `Research submitted. job_id=${result.jobId} status=${result.status}`,
    },
  };
};
