import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

const AUTH_TOKEN = "relay-test-token";
const RELAY_ENV_KEYS = [
  "RESEARCH_RELAY_ENABLED",
  "RESEARCH_UPSTREAM_URL",
  "RESEARCH_SHARED_TOKEN",
  "RESEARCH_REQUEST_TIMEOUT_SEC",
  "RESEARCH_MAX_TOPIC_LEN",
  "RESEARCH_MAX_LABEL_LEN",
] as const;

function applyRelayEnv(values: Partial<Record<(typeof RELAY_ENV_KEYS)[number], string>>) {
  const snapshot = new Map<string, string | undefined>();
  for (const key of RELAY_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    const next = values[key];
    if (next == null) {
      delete process.env[key];
      continue;
    }
    process.env[key] = next;
  }
  return () => {
    for (const key of RELAY_ENV_KEYS) {
      const prev = snapshot.get(key);
      if (prev == null) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    throw new Error("server did not expose a port");
  }
  return address.port;
}

async function startGatewayHttpServer(): Promise<{
  server: ReturnType<typeof createGatewayHttpServer>;
  port: number;
}> {
  const server = createGatewayHttpServer({
    canvasHost: null,
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "token", token: AUTH_TOKEN, allowTailscale: false },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address?.port) {
    throw new Error("gateway server did not expose a port");
  }
  return { server, port: address.port };
}

async function closeServer(server: { close: (cb: () => void) => void }): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function postJson(params: {
  port: number;
  path: string;
  body: unknown;
  headers?: Record<string, string>;
}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${params.port}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`,
      ...params.headers,
    },
    body: JSON.stringify(params.body),
  });
}

async function getJson(params: {
  port: number;
  path: string;
  headers?: Record<string, string>;
}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${params.port}${params.path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      ...params.headers,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("research relay HTTP endpoints", () => {
  it("is disabled by default", async () => {
    const restoreEnv = applyRelayEnv({});
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-disabled-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
            });
            expect(res.status).toBe(404);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
    }
  });

  it("requires gateway auth when enabled", async () => {
    const upstream = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/research/submit") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job_id: "j-auth", status: "submitted" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-auth-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await fetch(`http://127.0.0.1:${port}/research/submit`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ topic: "market scan" }),
            });
            expect(res.status).toBe(401);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("enforces optional shared relay token when configured", async () => {
    const upstream = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/research/submit") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job_id: "j-shared", status: "submitted" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-shared-token-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const noToken = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
            });
            expect(noToken.status).toBe(401);

            const badToken = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
              headers: { "x-openclaw-research-token": "wrong" },
            });
            expect(badToken.status).toBe(401);

            const okToken = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
              headers: { "x-openclaw-research-token": "relay-shared-token" },
            });
            expect(okToken.status).toBe(200);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("validates payload shape and topic length", async () => {
    const upstreamCallCount = { value: 0 };
    const upstream = createServer(async (req, res) => {
      upstreamCallCount.value += 1;
      if (req.method === "POST" && req.url === "/research/submit") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job_id: "ok", status: "submitted" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "1",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_MAX_TOPIC_LEN: "10",
      RESEARCH_MAX_LABEL_LEN: "5",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-validation-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const tooLong = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "this topic is definitely too long" },
            });
            expect(tooLong.status).toBe(400);
            const tooLongBody = (await tooLong.json()) as { error?: { message?: string } };
            expect(tooLongBody.error?.message ?? "").toContain("topic");

            const badLabel = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "short", label: "label-too-long" },
            });
            expect(badLabel.status).toBe(400);

            expect(upstreamCallCount.value).toBe(0);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("forwards submit/status/health/jobs/result to configured upstream path and returns compact receipts", async () => {
    const seen = {
      submitBody: undefined as unknown,
      sharedHeader: "",
    };

    const upstream = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/worker/research/submit") {
        seen.submitBody = await readJsonBody(req);
        seen.sharedHeader = String(req.headers["x-openclaw-research-token"] ?? "");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job_id: "abc123", status: "submitted" }));
        return;
      }
      if (req.method === "GET" && req.url === "/worker/research/status/abc123") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, job_id: "abc123", status: "running" }));
        return;
      }
      if (req.method === "GET" && req.url === "/worker/research/health") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, status: "healthy" }));
        return;
      }
      if (req.method === "GET" && req.url === "/worker/research/jobs?limit=2") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            jobs: [
              {
                job_id: "abc123",
                status: "completed",
                topic: "portable dog water bottle market",
                label: "market-scan",
                duration_sec: 720,
              },
            ],
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/worker/research/result/abc123") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            job_id: "abc123",
            status: "completed",
            summary: "Portable bottle market is growing in the premium segment.",
            started_at: "2026-03-07T01:00:00Z",
            completed_at: "2026-03-07T01:12:00Z",
            duration_sec: 720,
            label: "market-scan",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/worker`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-forwarding-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const headers = { "x-openclaw-research-token": "relay-shared-token" };
            const submit = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "portable dog water bottle market", label: "market-scan" },
              headers,
            });
            expect(submit.status).toBe(200);
            expect(await submit.json()).toEqual({
              ok: true,
              job_id: "abc123",
              status: "submitted",
            });

            const status = await getJson({
              port,
              path: "/research/status/abc123",
              headers,
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toEqual({
              ok: true,
              job_id: "abc123",
              status: "running",
            });

            const health = await getJson({
              port,
              path: "/research/health",
              headers,
            });
            expect(health.status).toBe(200);
            expect(await health.json()).toEqual({ ok: true, status: "healthy" });

            const jobs = await getJson({
              port,
              path: "/research/jobs?limit=2",
              headers,
            });
            expect(jobs.status).toBe(200);
            expect(await jobs.json()).toEqual({
              ok: true,
              jobs: [
                {
                  job_id: "abc123",
                  status: "completed",
                  topic: "portable dog water bottle market",
                  label: "market-scan",
                  duration_sec: 720,
                },
              ],
            });

            const result = await getJson({
              port,
              path: "/research/result/abc123",
              headers,
            });
            expect(result.status).toBe(200);
            expect(await result.json()).toEqual({
              ok: true,
              job_id: "abc123",
              status: "completed",
              summary: "Portable bottle market is growing in the premium segment.",
              started_at: "2026-03-07T01:00:00Z",
              completed_at: "2026-03-07T01:12:00Z",
              duration_sec: 720,
              label: "market-scan",
              run: {
                label: "market-scan",
                started_at: "2026-03-07T01:00:00Z",
                completed_at: "2026-03-07T01:12:00Z",
                duration_sec: 720,
              },
            });

            expect(seen.submitBody).toEqual({
              topic: "portable dog water bottle market",
              label: "market-scan",
            });
            expect(seen.sharedHeader).toBe("relay-shared-token");
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("fails closed for public upstream URLs and handles upstream timeout safely", async () => {
    const hangingUpstream = createServer((req, res) => {
      if (req.url === "/research/submit") {
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const hangingPort = await listen(hangingUpstream);

    const misconfiguredEnvRestore = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: "https://example.com",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-misconfigured-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
            });
            expect(res.status).toBe(503);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      misconfiguredEnvRestore();
    }

    const timeoutRestore = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${hangingPort}`,
      RESEARCH_REQUEST_TIMEOUT_SEC: "1",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-timeout-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await postJson({
              port,
              path: "/research/submit",
              body: { topic: "market scan" },
            });
            expect(res.status).toBe(504);
            expect(await res.json()).toEqual({
              ok: false,
              error: "Research upstream timed out.",
            });
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      timeoutRestore();
      await closeServer(hangingUpstream);
    }
  });

  it("fails closed for unknown /research/* routes", async () => {
    const upstream = createServer((_, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-unknown-route-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await getJson({
              port,
              path: "/research/unknown",
            });
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ ok: false, error: "Not Found" });
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("falls back to upstream /research/status when /research/result is not implemented", async () => {
    const upstream = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/research/result/job_legacy") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (req.method === "GET" && req.url === "/research/status/job_legacy") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            job_id: "job_legacy",
            status: "completed",
            current_question: "What is the TAM?",
            current_source: {
              title: "Industry report",
              url: "https://example.com/report",
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-result-fallback-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const res = await getJson({
              port,
              path: "/research/result/job_legacy",
              headers: { "x-openclaw-research-token": "relay-shared-token" },
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
              ok: true,
              job_id: "job_legacy",
              status: "completed",
              current_question: "What is the TAM?",
              current_source: {
                title: "Industry report",
                url: "https://example.com/report",
              },
              run: {
                current_question: "What is the TAM?",
                current_source: {
                  title: "Industry report",
                  url: "https://example.com/report",
                },
              },
            });
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });

  it("prefers /research/result and falls back to /research/status with summary propagation", async () => {
    let resultCalls = 0;
    let statusCalls = 0;
    const upstream = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/research/result/job_primary") {
        resultCalls += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            job_id: "job_primary",
            status: "completed",
            summary: "Primary summary from /research/result",
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/research/status/job_primary") {
        statusCalls += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            job_id: "job_primary",
            status: "completed",
            summary: "status should not be used for primary",
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url === "/research/result/job_fallback") {
        resultCalls += 1;
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (req.method === "GET" && req.url === "/research/status/job_fallback") {
        statusCalls += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            job_id: "job_fallback",
            status: "done",
            summary: "Fallback summary from /research/status",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    const upstreamPort = await listen(upstream);

    const restoreEnv = applyRelayEnv({
      RESEARCH_RELAY_ENABLED: "true",
      RESEARCH_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      RESEARCH_SHARED_TOKEN: "relay-shared-token",
    });
    try {
      await withTempConfig({
        prefix: "openclaw-research-relay-summary-routing-",
        cfg: { gateway: { trustedProxies: [] } },
        run: async () => {
          const { server, port } = await startGatewayHttpServer();
          try {
            const primary = await getJson({
              port,
              path: "/research/result/job_primary",
              headers: { "x-openclaw-research-token": "relay-shared-token" },
            });
            expect(primary.status).toBe(200);
            expect(await primary.json()).toEqual({
              ok: true,
              job_id: "job_primary",
              status: "completed",
              summary: "Primary summary from /research/result",
            });

            const fallback = await getJson({
              port,
              path: "/research/result/job_fallback",
              headers: { "x-openclaw-research-token": "relay-shared-token" },
            });
            expect(fallback.status).toBe(200);
            expect(await fallback.json()).toEqual({
              ok: true,
              job_id: "job_fallback",
              status: "done",
              summary: "Fallback summary from /research/status",
            });

            expect(resultCalls).toBe(2);
            expect(statusCalls).toBe(1);
          } finally {
            await closeServer(server);
          }
        },
      });
    } finally {
      restoreEnv();
      await closeServer(upstream);
    }
  });
});
