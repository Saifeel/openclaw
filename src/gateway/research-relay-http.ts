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

type ResearchRelayConfig = {
  enabled: boolean;
  upstreamUrl?: URL;
  sharedToken?: string;
  requestTimeoutMs: number;
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
  | { ok: false; statusCode: number; error: string };

export type ResearchRelaySubmitResult =
  | { ok: true; jobId: string; status: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
      reason: "disabled" | "misconfigured" | "invalid_payload" | "upstream_error";
    };

async function submitResearchRelayJobWithConfig(params: {
  topic: string;
  label?: string;
  config: ResearchRelayConfig & { upstreamUrl: URL };
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
  });
  if (!result.ok) {
    return {
      ok: false,
      statusCode: result.statusCode,
      error: result.error,
      reason: "upstream_error",
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
  const requestTimeoutSec = readPositiveIntWithClamp({
    value: env.RESEARCH_REQUEST_TIMEOUT_SEC,
    fallback: DEFAULT_REQUEST_TIMEOUT_SEC,
    min: MIN_TIMEOUT_SEC,
    max: MAX_TIMEOUT_SEC,
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
      requestTimeoutMs: requestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
    };
  }
  if (!upstreamRaw) {
    return {
      enabled: true,
      sharedToken,
      requestTimeoutMs: requestTimeoutSec * 1_000,
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
      requestTimeoutMs: requestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL must be a valid http/https URL.",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      enabled: true,
      sharedToken,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL protocol must be http or https.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      enabled: true,
      sharedToken,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL must not include URL credentials.",
    };
  }
  if (!isAllowedUpstreamHost(parsed.hostname)) {
    return {
      enabled: true,
      sharedToken,
      requestTimeoutMs: requestTimeoutSec * 1_000,
      maxTopicLen,
      maxLabelLen,
      configError: "RESEARCH_UPSTREAM_URL host must be loopback/private IP or a .ts.net hostname.",
    };
  }

  return {
    enabled: true,
    upstreamUrl: parsed,
    sharedToken,
    requestTimeoutMs: requestTimeoutSec * 1_000,
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
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
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

async function requestUpstream(params: {
  target: URL;
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
  sharedToken?: string;
}): Promise<UpstreamRequestResult> {
  const headers = new Headers();
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (params.sharedToken) {
    headers.set("x-openclaw-research-token", params.sharedToken);
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
    const message = error instanceof Error ? error.message : String(error);
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
  let body: unknown = undefined;
  if (textBody.trim().length > 0) {
    try {
      body = JSON.parse(textBody);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
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
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body,
    textBody,
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
  });
  if (!submitResult.ok) {
    if (submitResult.reason === "invalid_payload") {
      sendInvalidRequest(params.res, submitResult.error);
      return true;
    }
    if (submitResult.reason === "misconfigured") {
      sendJson(params.res, 503, { ok: false, error: submitResult.error });
      return true;
    }
    log.warn(`research submit upstream error: ${submitResult.error}`);
    sendJson(params.res, submitResult.statusCode, { ok: false, error: submitResult.error });
    return true;
  }

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
  });
}

async function handleResearchHealthOrStatus(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  config: ResearchRelayConfig & { upstreamUrl: URL };
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
    });
    if (!result.ok) {
      log.warn(`research health upstream error: ${result.error}`);
      sendJson(params.res, result.statusCode, { ok: false, error: result.error });
      return true;
    }
    if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
      sendJson(params.res, 200, result.body);
      return true;
    }
    sendJson(params.res, 200, { ok: true, status: "upstream_ok" });
    return true;
  }

  const statusPrefix = "/research/status/";
  if (!params.requestPath.startsWith(statusPrefix)) {
    return false;
  }
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
  });
  if (!result.ok) {
    log.warn(`research status upstream error: ${result.error}`);
    sendJson(params.res, result.statusCode, { ok: false, error: result.error });
    return true;
  }
  if (result.body && typeof result.body === "object" && !Array.isArray(result.body)) {
    sendJson(params.res, 200, result.body);
    return true;
  }
  sendJson(params.res, 200, { ok: true, job_id: jobId, status: "unknown" });
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
  const requestPath = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  const isSubmit = requestPath === "/research/submit";
  const isHealth = requestPath === "/research/health";
  const isStatus = requestPath.startsWith("/research/status/");
  if (!isSubmit && !isHealth && !isStatus) {
    return false;
  }

  const config = resolveResearchRelayConfig(opts.env ?? process.env);
  if (!ensureEnabledOrReply({ res, config })) {
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
    return true;
  }

  if (isSubmit) {
    return await handleResearchSubmit({ req, res, config: enabledConfig });
  }
  return await handleResearchHealthOrStatus({ req, res, requestPath, config: enabledConfig });
}

export const researchRelayTesting = {
  resolveResearchRelayConfig,
  normalizeSubmitPayload,
  buildUpstreamUrl,
};
