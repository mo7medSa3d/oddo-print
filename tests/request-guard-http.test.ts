import { createServer, type Server } from "http";
import { connect, type AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardApiRequest, getReservedRequestBytes, isLikelyAuthenticated, isCookieAuthenticatedMutation, MAX_API_BODY_BYTES } from "../src/server/request-guard";
import { parseStrictContentLength } from "../src/lib/request-limits";

/**
 * Real-TCP tests for the API body guard. The P0 that broke every mutating
 * /api/* request in production was invisible to in-process route tests, so
 * the guard must be verified the same way production runs it: a real HTTP
 * server, real request streams, and a handler that consumes the body the
 * framework would (fully reading it).
 */

// undici requires `duplex` for stream bodies; the DOM RequestInit type does
// not declare it, so widen at the single fetch call site.
function post(url: string, init?: { body?: BodyInit | null; headers?: Record<string, string> | null; duplex?: "half" }) {
  return fetch(url, { method: "POST", ...init } as RequestInit);
}

describe("strict Content-Length parser", () => {
  it.each(["1e3", "0x10", " 10", "10 ", "1.5", "9007199254740992"])("rejects %s", (raw) => {
    expect(parseStrictContentLength(raw)).toBeNull();
  });

  it("rejects duplicate values and accepts safe decimal digits", () => {
    expect(parseStrictContentLength(["10", "10"])).toBeNull();
    expect(parseStrictContentLength("0")).toBe(0);
    expect(parseStrictContentLength("4096")).toBe(4096);
  });
});

describe("request authentication budget classification", () => {
  it("recognizes all current session cookie names for mutation admission", () => {
    for (const cookie of ["mgr_session=token", "cust_session=token", "plt_session=token"]) {
      const req = { headers: { cookie } } as import("http").IncomingMessage;
      expect(isCookieAuthenticatedMutation(req)).toBe(true);
    }
  });
  it("rejects attacker-controlled opaque credential shapes", () => {
    const req = { headers: { authorization: "Bearer odoo_attacker-controlled-key" } } as import("http").IncomingMessage;
    expect(isLikelyAuthenticated(req)).toBe(false);

    const apiKeyReq = { headers: { "x-api-key": "odoo_attacker-controlled-key" } } as unknown as import("http").IncomingMessage;
    expect(isLikelyAuthenticated(apiKeyReq)).toBe(false);
  });

  it("fails closed for JWT-shaped values when the signing secret is unavailable", () => {
    const previous = process.env.GATEWAY_JWT_SECRET;
    delete process.env.GATEWAY_JWT_SECRET;
    try {
      const req = { headers: { authorization: `Bearer ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}` } } as import("http").IncomingMessage;
      expect(isLikelyAuthenticated(req)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GATEWAY_JWT_SECRET;
      else process.env.GATEWAY_JWT_SECRET = previous;
    }
  });
});

describe("request guard (real HTTP)", () => {
  let server: Server;
  let base: string;

  const MAX_TEST_BYTES = 4 * 1024; // small ceiling so overflow tests stay fast

  let port: number;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const guarded = await guardApiRequest(req, res, { maxBytes: MAX_TEST_BYTES });
      if (!guarded) return;
      if (req.url === "/api/echo") {
        const chunks: Buffer[] = [];
        for await (const chunk of guarded) chunks.push(Buffer.from(chunk));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: Buffer.concat(chunks).length, body: Buffer.concat(chunks).toString("base64") }));
        return;
      }
      if (req.url === "/api/print/slow") {
        for await (const _chunk of guarded) { /* upload completed */ }
        await new Promise((resolve) => setTimeout(resolve, 75));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ reservedDuringHandler: getReservedRequestBytes() }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  // Raw-socket helper: undici (fetch) refuses to send a lying or invalid
  // Content-Length, so the declared-size paths must be driven at the wire
  // level, exactly as a misbehaving or malicious client would.
  function rawHttp(request: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      const data: Buffer[] = [];
      socket.on("data", (chunk) => data.push(chunk));
      socket.on("end", () => {
        const raw = Buffer.concat(data).toString("utf8");
        const status = parseInt(raw.split(" ", 2)[1] ?? "0", 10) || 0;
        const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "";
        resolve({ status, body });
      });
      socket.on("error", (err) => resolve({ status: 0, body: `error: ${err.message}` }));
    });
  }

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("declared Content-Length", () => {
    it("passes a small body through untouched", async () => {
      const payload = JSON.stringify({ hello: "world" });
      const res = await post(`${base}/api/echo`, {
        body: payload,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { received: number; body: string };
      expect(data.received).toBe(Buffer.byteLength(payload));
      expect(Buffer.from(data.body, "base64").toString("utf8")).toBe(payload);
    });

    it("holds the reservation after upload completion until the slow response finishes", async () => {
      const payload = "slow-body";
      const res = await post(`${base}/api/print/slow`, { body: payload });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { reservedDuringHandler: number };
      expect(data.reservedDuringHandler).toBe(Buffer.byteLength(payload));
      await new Promise((resolve) => setImmediate(resolve));
      expect(getReservedRequestBytes()).toBe(0);
    });

    it("rejects a declared body over the ceiling with 413", async () => {
      // A lying client declares 99999 bytes; the guard must reject from the
      // header alone, without reading the stream.
      const { status, body } = await rawHttp(
        "POST /api/echo HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${MAX_TEST_BYTES + 5}\r\n` +
          "Connection: close\r\n\r\n" +
          '{"a":"b"}',
      );
      expect(status).toBe(413);
      expect(body).toContain("REQUEST_BODY_TOO_LARGE");
    });

    it("delivers the rejection response before releasing the socket (no RST mid-upload)", async () => {
      // Regression: the guard used to destroy the request socket immediately
      // after writing the rejection, RSTing clients that were still uploading
      // (undici/fetch surfaced ECONNRESET instead of the documented 413).
      // The guard must keep reading the abandoned body for a bounded window
      // (lingering close) so the status line is always delivered even while
      // the client is still flooding the socket.
      const outcome = await new Promise<{ status: number; body: string; uploadError?: string }>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            "POST /api/echo HTTP/1.1\r\n" +
              "Host: 127.0.0.1\r\n" +
              "Content-Type: application/json\r\n" +
              `Content-Length: ${2 * 1024 * 1024}\r\n` +
              "Connection: close\r\n\r\n",
          );
        });
        let uploadError: string | undefined;
        const data: Buffer[] = [];
        socket.on("data", (chunk) => data.push(chunk));
        socket.on("error", (err) => { uploadError = err.message; });
        socket.on("connect", () => {
          // Flood 2 MiB right after the headers; the guard rejects from the
          // declared length before a byte of body is read. The old behavior
          // destroyed the socket here, so these writes hit a reset and the
          // status line could be lost; lingering close accepts and discards
          // them, then responds cleanly.
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          let written = 0;
          const pump = () => {
            while (written < 2 * 1024 * 1024) {
              written += chunk.length;
              const ok = socket.write(chunk, (err) => {
                if (err && !uploadError) uploadError = err.message;
              });
              if (!ok) {
                socket.once("drain", pump);
                return;
              }
            }
          };
          pump();
        });
        socket.on("close", () => {
          const raw = Buffer.concat(data).toString("utf8");
          const status = parseInt(raw.split(" ", 2)[1] ?? "0", 10) || 0;
          const body = raw.includes("\r\n\r\n") ? raw.slice(raw.indexOf("\r\n\r\n") + 4) : "";
          resolve({ status, body, uploadError });
        });
      });
      expect(outcome.status).toBe(413);
      expect(outcome.body).toContain("REQUEST_BODY_TOO_LARGE");
      expect(outcome.uploadError).toBeUndefined();
    });

    it("rejects a malformed content-length (400/413, never 200)", async () => {
      // Node's HTTP parser rejects non-numeric Content-Length itself (400);
      // the guard's defensive NaN branch would answer 413. Either way the
      // request must never be forwarded.
      const { status } = await rawHttp(
        "POST /api/echo HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Length: abc\r\n" +
          "Connection: close\r\n\r\n",
      );
      expect([0, 400, 413]).toContain(status);
    });

    it("leaves GET requests alone", async () => {
      const res = await fetch(`${base}/api/echo`);
      expect(res.status).toBe(200);
    });

    it("leaves non-/api paths alone even when mutating", async () => {
      const res = await fetch(`${base}/page`, { method: "POST", body: "x".repeat(MAX_TEST_BYTES * 2) });
      // The test server only implements /api/echo; any status other than 413
      // proves the guard did not intercept a non-/api path.
      expect(res.status).not.toBe(413);
    });
  });

  describe("chunked / missing Content-Length", () => {
    it("rejects missing Content-Length without consuming the request stream", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("AAAA"));
          stream.close();
        },
      });
      const res = await post(`${base}/api/echo`, { body, duplex: "half" });
      expect(res.status).toBe(411);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("CONTENT_LENGTH_REQUIRED");
    });

    it("rejects chunked bodies on non-payload mutating API routes too", async () => {
      const { status, body } = await rawHttp(
        "POST /api/auth/manager/login HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          "Transfer-Encoding: chunked\r\n" +
          "Connection: close\r\n\r\n" +
          "4\r\nAAAA\r\n0\r\n\r\n",
      );
      expect(status).toBe(411);
      expect(body).toContain("CONTENT_LENGTH_REQUIRED");
    });

    it("admits requests only while the global byte budget has capacity", async () => {
      const { MAX_CONCURRENT_CHUNKED_BYTES, getReservedRequestBytes } = await import(
        "../src/server/request-guard"
      );
      expect(MAX_CONCURRENT_CHUNKED_BYTES).toBe(32 * 1024 * 1024);
      expect(getReservedRequestBytes()).toBe(0);
    });
  });

  it("exposes the 8MB production ceiling", () => {
    expect(MAX_API_BODY_BYTES).toBe(8 * 1024 * 1024);
  });
});
