import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { parseBooleanValue } from "../utils/boolean.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { isPrivateOrLoopbackHost } from "./net.js";

const log = createSubsystemLogger("research-relay");

const DEFAULT_REQUEST_TIMEOUT_SEC = 15;
const DEFAULT_MAX_TOPIC_LEN = 500;
const DEFAULT_MAX_LABEL_LEN = 100;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 120;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_JOB_ID_LEN = 160;
const RESEARCH_PATH_PREFIX = "/research/";
const RESULT_CACHE_TTL_MS = 30_000;
const JOBS_CACHE_TTL_MS = 30_000;

type ResearchRelayConfig = {
  enabled: boolean;
  upstreamUrl?: URL;
  sharedToken?: string;
  actorId?: string;
  requestTimeoutMs: number;
  executeRequestTimeoutMs: number;
  maxTopicLen: number;
  maxLabelLen: number;
  configError?: string;
};

type SubmitPayload = {
  topic: string;
  label?: string;
};

type UpstreamRequestResult =
  | { ok: true; statusCode: number; body: unknown; textBody: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
      upstreamStatusCode?: number;
      retryAfterSec?: number;
    };

type RelayCounterKey = "client.401" | "client.429" | "client.5xx" | "upstream.429" | "upstream.5xx";

const relayCounters: Record<RelayCounterKey, number> = {
  "client.401": 0,
  "client.429": 0,
  "client.5xx": 0,
  "upstream.429": 0,
  "upstream.5xx": 0,
};

type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

const resultCache = new Map<string, CacheEntry<ResearchRelayResultFetchResult>>();
const jobsCache = new Map<string, CacheEntry<ResearchRelayJobsFetchResult>>();

function readCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAtMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  cache.set(key, {
    expiresAtMs: Date.now() + ttlMs,
    value,
  });
}

function resolveRequestId(req: IncomingMessage): string {
  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim().slice(0, 64);
  }
  const fallback = randomUUID();
  return fallback.slice(0, 12);
}

function applyRetryAfterHeader(res: ServerResponse, retryAfterSec: number | undefined): void {
  if (!retryAfterSec || retryAfterSec <= 0) {
    return;
  }
  res.setHeader("Retry-After", String(Math.ceil(retryAfterSec)));
}

export type ResearchRelaySubmitResult =
  | { ok: true; jobId: string; status: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_payload" | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayResultFetchResult =
  | {
      ok: true;
      jobId: string;
      status: string;
      summary?: string;
      run: Record<string, unknown>;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_job_id" | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayJobsFetchResult =
  | {
      ok: true;
      jobs: Array<Record<string, unknown>>;
      raw: unknown;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_limit" | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayArtifactsFetchResult =
  | {
      ok: true;
      jobId: string;
      runId?: string;
      status?: string;
      artifacts: Record<string, unknown>;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_job_id" | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayExperimentsFetchResult =
  | {
      ok: true;
      experiments: Array<Record<string, unknown>>;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_limit" | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayExperimentActionResult =
  | {
      ok: true;
      experiment?: Record<string, unknown>;
      decision?: string;
      resultPath?: string;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason:
        | "disabled"
        | "misconfigured"
        | "invalid_experiment_id"
        | "invalid_payload"
        | "upstream_error";
      retryAfterSec?: number;
    };

export type ResearchRelayChatResult =
  | {
      ok: true;
      model?: string;
      reply: string;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_payload" | "upstream_error";
      retryAfterSec?: number;
    };

function incrementRelayCounter(
  key: RelayCounterKey,
  params: { route: string; statusCode: number; detail?: string },
): void {
  relayCounters[key] += 1;
  log.info(
    `research relay counter key=${key} count=${relayCounters[key]} route=${params.route} status=${params.statusCode}${params.detail ? ` detail=${params.detail}` : ""}`,
  );
}

function observeClientStatus(params: { statusCode: number; route: string; detail?: string }): void {
  if (params.statusCode === 401) {
    incrementRelayCounter("client.401", params);
    return;
  }
  if (params.statusCode === 429) {
    incrementRelayCounter("client.429", params);
    return;
  }
  if (params.statusCode >= 500) {
    incrementRelayCounter("client.5xx", params);
  }
}

async function submitResearchRelayJobWithConfig(params: {
  topic: string;
  label?: string;
  config: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelaySubmitResult> {
  const payload = normalizeSubmitPayload({
    body: { topic: params.topic, ...(params.label ? { label: params.label } : {}) },
    maxTopicLen: params.config.maxTopicLen,
    maxLabelLen: params.config.maxLabelLen,
  });
  if (!payload.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: payload.error,
      reason: "invalid_payload",
    };
  }

  const target = buildUpstreamUrl(params.config.upstreamUrl, "/research/submit");
  const result = await requestUpstream({
    target,
    method: "POST",
    body: payload.value,
    timeoutMs: params.config.requestTimeoutMs,
    sharedToken: params.config.sharedToken,
    actorId: params.config.actorId,
    routeTag: "/research/submit",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      error: result.error,
      reason: "upstream_error",
      retryAfterSec: result.retryAfterSec,
    };
  }

  if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
    const upstream = result.body as Record<string, unknown>;
    const jobIdRaw =
      (typeof upstream.job_id === "string" && upstream.job_id) ||
      (typeof upstream.jobId === "string" && upstream.jobId) ||
      (typeof upstream.id === "string" && upstream.id) ||
      "";
    const statusRaw = typeof upstream.status === "string" ? upstream.status.trim() : "";
    return {
      ok: true,
      jobId: jobIdRaw.trim() || "submitted",
      status: statusRaw || "submitted",
    };
  }

  return {
    ok: true,
    jobId: "submitted",
    status: "submitted",
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPositiveIntWithClamp(params: {
  value: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  const parsed = Number.parseInt(params.value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return params.fallback;
  }
  const normalized = Math.floor(parsed);
  return Math.max(params.min, Math.min(params.max, normalized));
}

function normalizeUpstreamBasePath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "";
  }
  return pathname.replace(/\/+$/, "");
}

function buildUpstreamUrl(base: URL, requestPath: string): URL {
  const path = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const next = new URL(base.toString());
  const basePath = normalizeUpstreamBasePath(base.pathname);
  next.pathname = `${basePath}${path}`;
  next.search = "";
  next.hash = "";
  return next;
}

function isAllowedUpstreamHost(hostname: string): boolean {
  if (hostname.endsWith(".ts.net")) {
    return true;
  }
  return isPrivateOrLoopbackHost(hostname);
}

function resolveResearchRelayConfig(env: NodeJS.ProcessEnv = process.env): ResearchRelayConfig {
  const enabled = parseBooleanValue(env.RESEARCH_RELAY_ENABLED) === true;
  const sharedToken = readString(env.RESEARCH_SHARED_TOKEN);
  const actorId = readString(env.RESEARCH_ACTOR_ID) ?? "jarvis.vps";
  const requestTimeoutSec = readPositiveIntWithClamp({
    value: env.RESEARCH_REQUEST_TIMEOUT_SEC,
    fallback: DEFAULT_REQUEST_TIMEOUT_SEC,
    min: MIN_TIMEOUT_SEC,
    max: MAX_TIMEOUT_SEC,
  });
  const executeRequestTimeoutSec = readPositiveIntWithClamp({
    value: env.RESEARCH_EXPERIMENT_EXECUTE_TIMEOUT_SEC,
    fallback: Math.max(requestTimeoutSec, 1800),
    min: MIN_TIMEOUT_SEC,
    max: 7200,
  });
  const maxTopicLen = readPositiveIntWithClamp({
    value: env.RESEARCH_MAX_TOPIC_LEN,
    fallback: DEFAULT_MAX_TOPIC_LEN,
    min: 1,
    max: 10_000,
  });
  const maxLabelLen = readPositiveIntWithClamp({
    value: env.RESEARCH_MAX_LABEL_LEN,
    fallback: DEFAULT_MAX_LABEL_LEN,
    min: 1,
    max: 1_000,
  });

  const upstreamRaw = readString(env.RESEARCH_UPSTREAM_URL);
  if (!enabled) {
    return {
      enabled: false,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
    };
  }
  if (!upstreamRaw) {
    return {
      enabled: true,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL is required when relay is enabled.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(upstreamRaw);
  } catch {
    return {
      enabled: true,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL must be a valid http/https URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      enabled: true,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL protocol must be http or https.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      enabled: true,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL must not include URL credentials.",
    };
  }
  if (!isAllowedUpstreamHost(parsed.hostname)) {
    return {
      enabled: true,
      sharedToken,
      actorId,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL host must be loopback/private IP or a .ts.net hostname.",
    };
  }

  return {
    enabled: true,
    upstreamUrl: parsed,
    sharedToken,
    actorId,
    requestTimeoutMs: requestTimeoutSec * 1_000,
    executeRequestTimeoutMs: executeRequestTimeoutSec * 1_000,
    maxTopicLen,
    maxLabelLen,
  };
}

function resolveSharedTokenFromRequest(req: IncomingMessage): string | undefined {
  const direct = req.headers["x-openclaw-research-token"];
  if (typeof direct === "string") {
    const token = direct.trim();
    if (token) {
      return token;
    }
  }
  const fallback = req.headers["x-research-token"];
  if (typeof fallback === "string") {
    const token = fallback.trim();
    if (token) {
      return token;
    }
  }
  return undefined;
}

function requireSharedToken(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  const requestToken = resolveSharedTokenFromRequest(req);
  if (!requestToken || !safeEqualSecret(requestToken, token)) {
    const statusCode = 401;
    sendJson(res, statusCode, { ok: false, error: "Unauthorized" });
    observeClientStatus({ statusCode, route: "/research/*", detail: "shared_token" });
    return false;
  }
  return true;
}

function normalizeSubmitPayload(params: {
  body: unknown;
  maxTopicLen: number;
  maxLabelLen: number;
}): { ok: true; value: SubmitPayload } | { ok: false; error: string } {
  const body = params.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;

  const topicRaw = readString(record.topic);
  if (!topicRaw) {
    return { ok: false, error: "Field `topic` is required and must be a non-empty string." };
  }
  if (topicRaw.length > params.maxTopicLen) {
    return {
      ok: false,
      error: `Field \`topic\` is too long (max ${params.maxTopicLen} characters).`,
    };
  }

  const labelRaw = record.label;
  if (labelRaw != null && typeof labelRaw !== "string") {
    return { ok: false, error: "Field `label` must be a string when provided." };
  }
  const label = readString(labelRaw);
  if (label && label.length > params.maxLabelLen) {
    return {
      ok: false,
      error: `Field \`label\` is too long (max ${params.maxLabelLen} characters).`,
    };
  }

  return { ok: true, value: { topic: topicRaw, ...(label ? { label } : {}) } };
}

function normalizeJobId(jobId: string): string | undefined {
  const value = jobId.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > MAX_JOB_ID_LEN) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeJobsLimit(limit: number | undefined): number | undefined {
  if (limit == null) {
    return undefined;
  }
  if (!Number.isFinite(limit)) {
    return undefined;
  }
  const normalized = Math.floor(limit);
  if (normalized < 1 || normalized > 100) {
    return undefined;
  }
  return normalized;
}

function normalizeExperimentId(experimentId: string): string | undefined {
  const value = experimentId.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > MAX_JOB_ID_LEN) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isObjectRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function readFirstString(root: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = readString(readPath(root, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstValue(root: Record<string, unknown>, paths: string[][]): unknown {
  for (const path of paths) {
    const value = readPath(root, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function normalizeResultResponse(params: { jobId: string; body: unknown }): {
  body: Record<string, unknown>;
  normalized: {
    jobId: string;
    status: string;
    summary?: string;
    run: Record<string, unknown>;
    raw: Record<string, unknown>;
  };
} {
  const rawBody = isObjectRecord(params.body) ? params.body : {};
  const response: Record<string, unknown> = isObjectRecord(params.body) ? { ...params.body } : {};
  const jobId =
    readFirstString(rawBody, [["job_id"], ["jobId"], ["id"]]) ??
    readFirstString(rawBody, [
      ["run", "job_id"],
      ["run", "jobId"],
      ["run", "id"],
    ]) ??
    params.jobId;
  const status =
    readFirstString(rawBody, [["status"], ["run", "status"], ["state"]])?.trim() || "unknown";
  const summary = readFirstString(rawBody, [
    ["summary"],
    ["report_summary"],
    ["final_summary"],
    ["result", "summary"],
    ["report", "summary"],
    ["output", "summary"],
  ]);

  const run: Record<string, unknown> = {};
  const runFieldPaths: Array<{ key: string; paths: string[][] }> = [
    { key: "topic", paths: [["topic"], ["run", "topic"], ["request", "topic"]] },
    { key: "label", paths: [["label"], ["run", "label"], ["request", "label"]] },
    {
      key: "submitted_at",
      paths: [["submitted_at"], ["submittedAt"], ["created_at"], ["run", "submitted_at"]],
    },
    { key: "started_at", paths: [["started_at"], ["startedAt"], ["run", "started_at"]] },
    {
      key: "completed_at",
      paths: [["completed_at"], ["completedAt"], ["finished_at"], ["run", "completed_at"]],
    },
    {
      key: "duration_sec",
      paths: [["duration_sec"], ["durationSeconds"], ["run", "duration_sec"]],
    },
    { key: "report_path", paths: [["report_path"], ["reportPath"], ["artifact_path"]] },
    { key: "progress", paths: [["progress"], ["run", "progress"]] },
    { key: "phase", paths: [["phase"], ["run", "phase"]] },
    { key: "error", paths: [["error"], ["run", "error"]] },
    { key: "current_question", paths: [["current_question"], ["run", "current_question"]] },
    { key: "current_source", paths: [["current_source"], ["run", "current_source"]] },
  ];
  for (const field of runFieldPaths) {
    const value = readFirstValue(rawBody, field.paths);
    if (value !== undefined) {
      run[field.key] = value;
    }
  }

  response.ok = true;
  if (!("job_id" in response)) {
    response.job_id = jobId;
  }
  if (!("status" in response)) {
    response.status = status;
  }
  if (summary && !("summary" in response)) {
    response.summary = summary;
  }
  if (Object.keys(run).length > 0 && !("run" in response)) {
    response.run = run;
  }

  return {
    body: response,
    normalized: {
      jobId,
      status,
      summary,
      run,
      raw: rawBody,
    },
  };
}

function normalizeJobsResponse(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter(isObjectRecord);
  }
  if (!isObjectRecord(body)) {
    return [];
  }
  const jobs = body.jobs;
  if (!Array.isArray(jobs)) {
    return [];
  }
  return jobs.filter(isObjectRecord);
}

async function requestUpstream(params: {
  target: URL;
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
  sharedToken?: string;
  actorId?: string;
  routeTag: string;
  requestId?: string;
}): Promise<UpstreamRequestResult> {
  const startedAt = Date.now();
  const headers = new Headers();
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (params.sharedToken) {
    headers.set("x-openclaw-research-token", params.sharedToken);
  }
  if (params.actorId && params.method === "POST") {
    headers.set("x-openclaw-actor-id", params.actorId);
  }

  let response: Response;
  try {
    response = await fetch(params.target.toString(), {
      method: params.method,
      headers,
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      `research relay upstream requestId=${params.requestId ?? "-"} route=${params.routeTag} method=${params.method} status=error durationMs=${durationMs} error=${message}`,
    );
    if (
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return { ok: false, statusCode: 504, error: "Research upstream timed out." };
    }
    if (/timeout|aborted|abort/i.test(message)) {
      return { ok: false, statusCode: 504, error: "Research upstream timed out." };
    }
    return { ok: false, statusCode: 502, error: "Research upstream is unavailable." };
  }

  const textBody = await response.text();
  const durationMs = Math.max(0, Date.now() - startedAt);
  log.info(
    `research relay upstream requestId=${params.requestId ?? "-"} route=${params.routeTag} method=${params.method} status=${response.status} durationMs=${durationMs}`,
  );
  let body: unknown = undefined;
  if (textBody.trim().length > 0) {
    try {
      body = JSON.parse(textBody);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    if (response.status === 429) {
      incrementRelayCounter("upstream.429", {
        route: params.routeTag,
        statusCode: response.status,
      });
    } else if (response.status >= 500) {
      incrementRelayCounter("upstream.5xx", {
        route: params.routeTag,
        statusCode: response.status,
      });
    }
    const upstreamMessage =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? ((body as { error: string }).error ?? "").trim()
        : "";
    return {
      ok: false,
      statusCode: 502,
      error: upstreamMessage || `Research upstream returned HTTP ${response.status}.`,
      upstreamStatusCode: response.status,
      retryAfterSec:
        response.status === 429
          ? parseRetryAfterSeconds(response.headers.get("retry-after"))
          : undefined,
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body,
    textBody,
  };
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && asInt > 0) {
    return asInt;
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) {
    return undefined;
  }
  const deltaMs = asDate - Date.now();
  if (deltaMs <= 0) {
    return undefined;
  }
  return Math.ceil(deltaMs / 1000);
}

function resolveEnabledRelayConfig(
  config: ResearchRelayConfig,
):
  | { ok: true; config: ResearchRelayConfig & { upstreamUrl: URL } }
  | { ok: false; statusCode: number; error: string; reason: "disabled" | "misconfigured" } {
  if (!config.enabled) {
    return {
      ok: false,
      statusCode: 404,
      error: "Research relay is disabled.",
      reason: "disabled",
    };
  }
  if (!config.upstreamUrl || config.configError) {
    return {
      ok: false,
      statusCode: 503,
      error: "Research relay is misconfigured.",
      reason: "misconfigured",
    };
  }
  return {
    ok: true,
    config: config as ResearchRelayConfig & { upstreamUrl: URL },
  };
}

function mapUpstreamFailure(result: Extract<UpstreamRequestResult, { ok: false }>): {
  statusCode: number;
  error: string;
  retryAfterSec?: number;
} {
  return {
    statusCode: result.upstreamStatusCode ?? result.statusCode,
    error: result.error,
    retryAfterSec: result.retryAfterSec,
  };
}

function sendRelayDisabled(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "Not Found" });
}

function ensureEnabledOrReply(params: {
  res: ServerResponse;
  config: ResearchRelayConfig;
}): params is { res: ServerResponse; config: ResearchRelayConfig & { upstreamUrl: URL } } {
  if (!params.config.enabled) {
    sendRelayDisabled(params.res);
    return false;
  }
  if (!params.config.upstreamUrl || params.config.configError) {
    log.warn(
      `research relay disabled by config error: ${params.config.configError ?? "missing URL"}`,
    );
    sendJson(params.res, 503, { ok: false, error: "Research relay is misconfigured." });
    return false;
  }
  return true;
}

async function authorizeRelayRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  sharedToken?: string;
}): Promise<boolean> {
  const authed = await authorizeGatewayBearerRequestOrReply({
    req: params.req,
    res: params.res,
    auth: params.auth,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
  });
  if (!authed) {
    return false;
  }
  if (params.sharedToken && !requireSharedToken(params.req, params.res, params.sharedToken)) {
    return false;
  }
  return true;
}

async function handleResearchSubmit(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: ResearchRelayConfig & { upstreamUrl: URL };
  requestId: string;
}) {
  if (params.req.method !== "POST") {
    sendMethodNotAllowed(params.res, "POST");
    return true;
  }

  const bodyUnknown = await readJsonBodyOrError(params.req, params.res, MAX_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const payload = normalizeSubmitPayload({
    body: bodyUnknown,
    maxTopicLen: params.config.maxTopicLen,
    maxLabelLen: params.config.maxLabelLen,
  });
  if (!payload.ok) {
    sendInvalidRequest(params.res, payload.error);
    return true;
  }
  const submitResult = await submitResearchRelayJob({
    topic: payload.value.topic,
    label: payload.value.label,
    config: params.config,
    requestId: params.requestId,
  });
  if (!submitResult.ok) {
    if (submitResult.reason === "invalid_payload") {
      sendInvalidRequest(params.res, submitResult.error);
      return true;
    }
    if (submitResult.reason === "misconfigured") {
      const statusCode = 503;
      sendJson(params.res, statusCode, { ok: false, error: submitResult.error });
      observeClientStatus({
        statusCode,
        route: "/research/submit",
        detail: "misconfigured",
      });
      return true;
    }
    log.warn(`research submit requestId=${params.requestId} upstream error: ${submitResult.error}`);
    applyRetryAfterHeader(params.res, submitResult.retryAfterSec);
    sendJson(params.res, submitResult.statusCode, { ok: false, error: submitResult.error });
    observeClientStatus({
      statusCode: submitResult.statusCode,
      route: "/research/submit",
      detail: "upstream_error",
    });
    return true;
  }

  jobsCache.clear();

  sendJson(params.res, 200, {
    ok: true,
    job_id: submitResult.jobId,
    status: submitResult.status,
  });
  return true;
}

export async function submitResearchRelayJob(params: {
  topic: string;
  label?: string;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelaySubmitResult> {
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  if (!config.enabled) {
    return {
      ok: false,
      statusCode: 404,
      error: "Research relay is disabled.",
      reason: "disabled",
    };
  }
  if (!config.upstreamUrl || config.configError) {
    return {
      ok: false,
      statusCode: 503,
      error: "Research relay is misconfigured.",
      reason: "misconfigured",
    };
  }
  const enabledConfig = config as ResearchRelayConfig & { upstreamUrl: URL };

  return await submitResearchRelayJobWithConfig({
    topic: params.topic,
    label: params.label,
    config: enabledConfig,
    requestId: params.requestId,
  });
}

export async function fetchResearchRelayResult(params: {
  jobId: string;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayResultFetchResult> {
  const jobId = normalizeJobId(params.jobId);
  if (!jobId) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid job_id.",
      reason: "invalid_job_id",
    };
  }

  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  if (!config.enabled) {
    return {
      ok: false,
      statusCode: 404,
      error: "Research relay is disabled.",
      reason: "disabled",
    };
  }
  if (!config.upstreamUrl || config.configError) {
    return {
      ok: false,
      statusCode: 503,
      error: "Research relay is misconfigured.",
      reason: "misconfigured",
    };
  }
  const enabledConfig = config as ResearchRelayConfig & { upstreamUrl: URL };
  const resultCacheKey = `${enabledConfig.upstreamUrl.toString()}::${jobId}`;
  const cachedResult = readCached(resultCache, resultCacheKey);
  if (cachedResult) {
    return cachedResult;
  }
  const fetchFrom = async (
    upstreamPath: string,
    routeTag: string,
  ): Promise<
    | { ok: true; normalized: ReturnType<typeof normalizeResultResponse>["normalized"] }
    | {
        ok: false;
        statusCode: number;
        error: string;
        upstreamStatusCode?: number;
        retryAfterSec?: number;
      }
  > => {
    const target = buildUpstreamUrl(enabledConfig.upstreamUrl, upstreamPath);
    const result = await requestUpstream({
      target,
      method: "GET",
      timeoutMs: enabledConfig.requestTimeoutMs,
      sharedToken: enabledConfig.sharedToken,
      routeTag,
      requestId: params.requestId,
    });
    if (!result.ok) {
      return {
        ok: false,
        statusCode: result.statusCode,
        error: result.error,
        upstreamStatusCode: result.upstreamStatusCode,
        retryAfterSec: result.retryAfterSec,
      };
    }
    return {
      ok: true,
      normalized: normalizeResultResponse({
        jobId,
        body: result.body,
      }).normalized,
    };
  };

  // Preferred path for completed report payloads.
  const primary = await fetchFrom(
    `/research/result/${encodeURIComponent(jobId)}`,
    "/research/result/:job_id",
  );
  if (!primary.ok) {
    // Backward-compatible fallback for workers that only expose /research/status/:job_id.
    if (primary.upstreamStatusCode !== 404) {
      return {
        ok: false,
        statusCode: primary.statusCode,
        error: primary.error,
        reason: "upstream_error",
        retryAfterSec: primary.retryAfterSec,
      };
    }
    const fallback = await fetchFrom(
      `/research/status/${encodeURIComponent(jobId)}`,
      "/research/status/:job_id",
    );
    if (!fallback.ok) {
      return {
        ok: false,
        statusCode: fallback.statusCode,
        error: fallback.error,
        reason: "upstream_error",
        retryAfterSec: fallback.retryAfterSec,
      };
    }
    const response: ResearchRelayResultFetchResult = {
      ok: true,
      jobId: fallback.normalized.jobId,
      status: fallback.normalized.status,
      summary: fallback.normalized.summary,
      run: fallback.normalized.run,
      raw: fallback.normalized.raw,
    };
    writeCached(resultCache, resultCacheKey, response, RESULT_CACHE_TTL_MS);
    return response;
  }

  const response: ResearchRelayResultFetchResult = {
    ok: true,
    jobId: primary.normalized.jobId,
    status: primary.normalized.status,
    summary: primary.normalized.summary,
    run: primary.normalized.run,
    raw: primary.normalized.raw,
  };
  writeCached(resultCache, resultCacheKey, response, RESULT_CACHE_TTL_MS);
  return response;
}

export async function fetchResearchRelayJobs(params: {
  limit?: number;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayJobsFetchResult> {
  const limit = normalizeJobsLimit(params.limit);
  if (params.limit != null && limit == null) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid jobs limit. Use 1-100.",
      reason: "invalid_limit",
    };
  }

  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  if (!config.enabled) {
    return {
      ok: false,
      statusCode: 404,
      error: "Research relay is disabled.",
      reason: "disabled",
    };
  }
  if (!config.upstreamUrl || config.configError) {
    return {
      ok: false,
      statusCode: 503,
      error: "Research relay is misconfigured.",
      reason: "misconfigured",
    };
  }
  const enabledConfig = config as ResearchRelayConfig & { upstreamUrl: URL };
  const jobsLimitKey = limit == null ? "all" : String(limit);
  const jobsCacheKey = `${enabledConfig.upstreamUrl.toString()}::${jobsLimitKey}`;
  const cachedJobs = readCached(jobsCache, jobsCacheKey);
  if (cachedJobs) {
    return cachedJobs;
  }
  const target = buildUpstreamUrl(enabledConfig.upstreamUrl, "/research/jobs");
  if (limit != null) {
    target.searchParams.set("limit", String(limit));
  }
  const result = await requestUpstream({
    target,
    method: "GET",
    timeoutMs: enabledConfig.requestTimeoutMs,
    sharedToken: enabledConfig.sharedToken,
    routeTag: "/research/jobs",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      error: result.error,
      reason: "upstream_error",
      retryAfterSec: result.retryAfterSec,
    };
  }

  const response: ResearchRelayJobsFetchResult = {
    ok: true,
    jobs: normalizeJobsResponse(result.body),
    raw: result.body,
  };
  writeCached(jobsCache, jobsCacheKey, response, JOBS_CACHE_TTL_MS);
  return response;
}

export async function fetchResearchRelayArtifacts(params: {
  jobId: string;
  includeText?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayArtifactsFetchResult> {
  const jobId = normalizeJobId(params.jobId);
  if (!jobId) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid job_id.",
      reason: "invalid_job_id",
    };
  }
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  const enabled = resolveEnabledRelayConfig(config);
  if (!enabled.ok) {
    return enabled;
  }
  const target = buildUpstreamUrl(
    enabled.config.upstreamUrl,
    `/research/artifacts/${encodeURIComponent(jobId)}`,
  );
  target.searchParams.set("include_text", params.includeText === false ? "false" : "true");
  const result = await requestUpstream({
    target,
    method: "GET",
    timeoutMs: enabled.config.requestTimeoutMs,
    sharedToken: enabled.config.sharedToken,
    routeTag: "/research/artifacts/:job_id",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapUpstreamFailure(result),
      reason: "upstream_error",
    };
  }
  const raw = isObjectRecord(result.body) ? result.body : {};
  const artifacts = isObjectRecord(raw.artifacts) ? raw.artifacts : {};
  return {
    ok: true,
    jobId: readFirstString(raw, [["job_id"], ["jobId"], ["id"]]) ?? jobId,
    runId: readFirstString(raw, [["run_id"], ["runId"]]),
    status: readFirstString(raw, [["status"], ["state"]]),
    artifacts,
    raw,
  };
}

export async function fetchResearchRelayExperiments(params: {
  status?: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayExperimentsFetchResult> {
  const limit = normalizeJobsLimit(params.limit);
  if (params.limit != null && limit == null) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid experiments limit. Use 1-100.",
      reason: "invalid_limit",
    };
  }
  const statusFilter = readString(params.status);
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  const enabled = resolveEnabledRelayConfig(config);
  if (!enabled.ok) {
    return enabled;
  }
  const target = buildUpstreamUrl(enabled.config.upstreamUrl, "/research/experiments");
  if (limit != null) {
    target.searchParams.set("limit", String(limit));
  }
  if (statusFilter) {
    target.searchParams.set("status", statusFilter);
  }
  const result = await requestUpstream({
    target,
    method: "GET",
    timeoutMs: enabled.config.requestTimeoutMs,
    sharedToken: enabled.config.sharedToken,
    routeTag: "/research/experiments",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapUpstreamFailure(result),
      reason: "upstream_error",
    };
  }
  const raw = isObjectRecord(result.body) ? result.body : {};
  const experimentsRaw = raw.experiments;
  const experiments = Array.isArray(experimentsRaw) ? experimentsRaw.filter(isObjectRecord) : [];
  return {
    ok: true,
    experiments,
    raw,
  };
}

export async function decideResearchRelayExperiment(params: {
  experimentId: string;
  decision: "approve" | "reject" | "complete";
  notes?: string;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayExperimentActionResult> {
  const experimentId = normalizeExperimentId(params.experimentId);
  if (!experimentId) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid experiment_id.",
      reason: "invalid_experiment_id",
    };
  }
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  const enabled = resolveEnabledRelayConfig(config);
  if (!enabled.ok) {
    return enabled;
  }
  const target = buildUpstreamUrl(
    enabled.config.upstreamUrl,
    `/research/experiments/${encodeURIComponent(experimentId)}/decision`,
  );
  const result = await requestUpstream({
    target,
    method: "POST",
    body: {
      decision: params.decision,
      ...(readString(params.notes) ? { notes: readString(params.notes) } : {}),
    },
    timeoutMs: enabled.config.requestTimeoutMs,
    sharedToken: enabled.config.sharedToken,
    actorId: enabled.config.actorId,
    routeTag: "/research/experiments/:experiment_id/decision",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapUpstreamFailure(result),
      reason: "upstream_error",
    };
  }
  const raw = isObjectRecord(result.body) ? result.body : {};
  return {
    ok: true,
    experiment: isObjectRecord(raw.experiment) ? raw.experiment : undefined,
    raw,
  };
}

export async function executeResearchRelayExperiment(params: {
  experimentId: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayExperimentActionResult> {
  const experimentId = normalizeExperimentId(params.experimentId);
  if (!experimentId) {
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid experiment_id.",
      reason: "invalid_experiment_id",
    };
  }
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  const enabled = resolveEnabledRelayConfig(config);
  if (!enabled.ok) {
    return enabled;
  }
  const target = buildUpstreamUrl(
    enabled.config.upstreamUrl,
    `/research/experiments/${encodeURIComponent(experimentId)}/execute`,
  );
  const result = await requestUpstream({
    target,
    method: "POST",
    body: params.force ? { force: true } : {},
    timeoutMs: enabled.config.executeRequestTimeoutMs,
    sharedToken: enabled.config.sharedToken,
    actorId: enabled.config.actorId,
    routeTag: "/research/experiments/:experiment_id/execute",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapUpstreamFailure(result),
      reason: "upstream_error",
    };
  }
  const raw = isObjectRecord(result.body) ? result.body : {};
  return {
    ok: true,
    experiment: isObjectRecord(raw.experiment) ? raw.experiment : undefined,
    decision: readFirstString(raw, [["decision"]]),
    resultPath: readFirstString(raw, [["result_path"], ["resultPath"]]),
    raw,
  };
}

export async function sendResearchRelayChat(params: {
  message: string;
  model?: string;
  pauseWhenBusy?: boolean;
  env?: NodeJS.ProcessEnv;
  config?: ResearchRelayConfig & { upstreamUrl: URL };
  requestId?: string;
}): Promise<ResearchRelayChatResult> {
  const message = readString(params.message);
  if (!message) {
    return {
      ok: false,
      statusCode: 400,
      error: "Message is required.",
      reason: "invalid_payload",
    };
  }
  const config = params.config ?? resolveResearchRelayConfig(params.env ?? process.env);
  const enabled = resolveEnabledRelayConfig(config);
  if (!enabled.ok) {
    return enabled;
  }
  const target = buildUpstreamUrl(enabled.config.upstreamUrl, "/chat/send");
  const body: Record<string, unknown> = { message };
  if (readString(params.model)) {
    body.model = readString(params.model);
  }
  if (params.pauseWhenBusy != null) {
    body.pause_when_busy = params.pauseWhenBusy;
  }
  const result = await requestUpstream({
    target,
    method: "POST",
    body,
    timeoutMs: enabled.config.requestTimeoutMs,
    sharedToken: enabled.config.sharedToken,
    actorId: enabled.config.actorId,
    routeTag: "/chat/send",
    requestId: params.requestId,
  });
  if (!result.ok) {
    return {
      ok: false,
      ...mapUpstreamFailure(result),
      reason: "upstream_error",
    };
  }
  const raw = isObjectRecord(result.body) ? result.body : {};
  const reply = readFirstString(raw, [["reply"], ["message"]]);
  if (!reply) {
    return {
      ok: false,
      statusCode: 502,
      error: "Research upstream returned an empty chat reply.",
      reason: "upstream_error",
    };
  }
  return {
    ok: true,
    model: readFirstString(raw, [["model"]]),
    reply,
    raw,
  };
}

async function handleResearchHealthOrStatus(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  requestSearch: string;
  config: ResearchRelayConfig & { upstreamUrl: URL };
  requestId: string;
}) {
  if (params.req.method !== "GET") {
    sendMethodNotAllowed(params.res, "GET");
    return true;
  }

  if (params.requestPath === "/research/health") {
    const target = buildUpstreamUrl(params.config.upstreamUrl, "/research/health");
    const result = await requestUpstream({
      target,
      method: "GET",
      timeoutMs: params.config.requestTimeoutMs,
      sharedToken: params.config.sharedToken,
      routeTag: "/research/health",
      requestId: params.requestId,
    });
    if (!result.ok) {
      log.warn(`research health requestId=${params.requestId} upstream error: ${result.error}`);
      applyRetryAfterHeader(params.res, result.retryAfterSec);
      sendJson(params.res, result.statusCode, { ok: false, error: result.error });
      observeClientStatus({
        statusCode: result.statusCode,
        route: "/research/health",
        detail: "upstream_error",
      });
      return true;
    }
    if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
      sendJson(params.res, 200, result.body);
      return true;
    }
    sendJson(params.res, 200, { ok: true, status: "upstream_ok" });
    return true;
  }

  if (params.requestPath === "/research/jobs") {
    const query = new URLSearchParams(params.requestSearch);
    const rawLimit = query.get("limit");
    const parsedLimit =
      rawLimit == null || rawLimit.trim().length === 0 ? undefined : Number.parseInt(rawLimit, 10);
    const limit = normalizeJobsLimit(parsedLimit);
    if (parsedLimit != null && limit == null) {
      sendInvalidRequest(params.res, "Invalid jobs limit. Use 1-100.");
      return true;
    }
    const jobs = await fetchResearchRelayJobs({
      limit,
      config: params.config,
      requestId: params.requestId,
    });
    if (!jobs.ok) {
      log.warn(`research jobs requestId=${params.requestId} upstream error: ${jobs.error}`);
      applyRetryAfterHeader(params.res, jobs.retryAfterSec);
      sendJson(params.res, jobs.statusCode, { ok: false, error: jobs.error });
      observeClientStatus({
        statusCode: jobs.statusCode,
        route: "/research/jobs",
        detail: "upstream_error",
      });
      return true;
    }
    if (isObjectRecord(jobs.raw)) {
      sendJson(params.res, 200, jobs.raw);
      return true;
    }
    sendJson(params.res, 200, { ok: true, jobs: jobs.jobs });
    return true;
  }

  const statusPrefix = "/research/status/";
  if (params.requestPath.startsWith(statusPrefix)) {
    const jobId = normalizeJobId(decodeURIComponent(params.requestPath.slice(statusPrefix.length)));
    if (!jobId) {
      sendInvalidRequest(params.res, "Invalid job_id in path.");
      return true;
    }
    const target = buildUpstreamUrl(
      params.config.upstreamUrl,
      `/research/status/${encodeURIComponent(jobId)}`,
    );
    const result = await requestUpstream({
      target,
      method: "GET",
      timeoutMs: params.config.requestTimeoutMs,
      sharedToken: params.config.sharedToken,
      routeTag: "/research/status/:job_id",
      requestId: params.requestId,
    });
    if (!result.ok) {
      log.warn(`research status requestId=${params.requestId} upstream error: ${result.error}`);
      applyRetryAfterHeader(params.res, result.retryAfterSec);
      sendJson(params.res, result.statusCode, { ok: false, error: result.error });
      observeClientStatus({
        statusCode: result.statusCode,
        route: "/research/status/:job_id",
        detail: "upstream_error",
      });
      return true;
    }
    if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
      sendJson(params.res, 200, result.body);
      return true;
    }
    sendJson(params.res, 200, { ok: true, job_id: jobId, status: "unknown" });
    return true;
  }

  const resultPrefix = "/research/result/";
  if (!params.requestPath.startsWith(resultPrefix)) {
    return false;
  }
  const jobId = normalizeJobId(decodeURIComponent(params.requestPath.slice(resultPrefix.length)));
  if (!jobId) {
    sendInvalidRequest(params.res, "Invalid job_id in path.");
    return true;
  }

  const resultFetch = await fetchResearchRelayResult({
    jobId,
    config: params.config,
    requestId: params.requestId,
  });
  if (!resultFetch.ok) {
    log.warn(`research result requestId=${params.requestId} upstream error: ${resultFetch.error}`);
    applyRetryAfterHeader(params.res, resultFetch.retryAfterSec);
    sendJson(params.res, resultFetch.statusCode, { ok: false, error: resultFetch.error });
    observeClientStatus({
      statusCode: resultFetch.statusCode,
      route: "/research/result/:job_id",
      detail: "upstream_error",
    });
    return true;
  }

  const response = normalizeResultResponse({
    jobId: resultFetch.jobId,
    body: resultFetch.raw,
  }).body;
  sendJson(params.res, 200, response);
  return true;
}

export async function handleResearchRelayHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    env?: NodeJS.ProcessEnv;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestPath = requestUrl.pathname;
  const requestId = resolveRequestId(req);
  res.setHeader("x-openclaw-request-id", requestId);
  const isSubmit = requestPath === "/research/submit";
  const isHealth = requestPath === "/research/health";
  const isJobs = requestPath === "/research/jobs";
  const isStatus = requestPath.startsWith("/research/status/");
  const isResult = requestPath.startsWith("/research/result/");
  const isResearchPrefixed =
    requestPath === "/research" || requestPath.startsWith(RESEARCH_PATH_PREFIX);
  if (!isSubmit && !isHealth && !isJobs && !isStatus && !isResult && isResearchPrefixed) {
    sendJson(res, 404, { ok: false, error: "Not Found" });
    return true;
  }
  if (!isSubmit && !isHealth && !isJobs && !isStatus && !isResult) {
    return false;
  }

  const config = resolveResearchRelayConfig(opts.env ?? process.env);
  if (!ensureEnabledOrReply({ res, config })) {
    log.warn(`research relay requestId=${requestId} rejected: disabled or misconfigured`);
    return true;
  }
  const enabledConfig = config as ResearchRelayConfig & { upstreamUrl: URL };

  const authorized = await authorizeRelayRequest({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    sharedToken: enabledConfig.sharedToken,
  });
  if (!authorized) {
    log.warn(`research relay requestId=${requestId} rejected: unauthorized`);
    return true;
  }

  if (isSubmit) {
    return await handleResearchSubmit({ req, res, config: enabledConfig, requestId });
  }
  return await handleResearchHealthOrStatus({
    req,
    res,
    requestPath,
    requestSearch: requestUrl.search,
    config: enabledConfig,
    requestId,
  });
}

export const researchRelayTesting = {
  resolveResearchRelayConfig,
  normalizeSubmitPayload,
  buildUpstreamUrl,
};
