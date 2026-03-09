import {
  fetchResearchRelayJobs,
  fetchResearchRelayResult,
  submitResearchRelayJob,
} from "../../gateway/research-relay-http.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const RESEARCH_PREFIX = "/research";
const RESEARCH_RESULT_PREFIX = "/research-result";
const RESEARCH_JOBS_PREFIX = "/research-jobs";

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

export const handleResearchCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
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
