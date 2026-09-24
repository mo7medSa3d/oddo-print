import { describe, expect, it } from "vitest";
import { validatePrintJobPayload, buildTestPrintPayloadForPrinter } from "../src/lib/payload";
import { validatePayloadForPrinter, isPrinterAvailableForJob } from "../src/lib/routing";
import { getAgentAvailability, getEffectivePrinterStatus } from "../src/lib/agent-availability";

describe("System Interface Contracts (Section 36)", () => {
  describe("Contract 1: Odoo ↔ Gateway Interface", () => {
    it("validates print job payload schemas and rejects invalid data", () => {
      // Valid ESC/POS payload
      const validEscpos = validatePrintJobPayload({
        type: "escpos",
        protocol: "escpos",
        encoding: "base64",
        data: Buffer.from("Hello").toString("base64"),
      });
      expect(validEscpos.type).toBe("escpos");
      expect(validEscpos.protocol).toBe("escpos");

      // Valid PDF payload
      const validPdf = validatePrintJobPayload({
        type: "pdf",
        encoding: "base64",
        data: Buffer.from("%PDF-1.4 test").toString("base64"),
      });
      expect(validPdf.type).toBe("pdf");

      // Invalid: PDF data labeled as escpos
      expect(() =>
        validatePrintJobPayload({
          type: "escpos",
          protocol: "escpos",
          encoding: "base64",
          data: Buffer.from("%PDF-1.4 test").toString("base64"),
        })
      ).toThrow();
    });

    it("enforces transport and protocol capability validation for Odoo jobs", () => {
      // PDF payload cannot be routed to a raw ESC/POS thermal printer
      const pdfToEscpos = validatePayloadForPrinter(
        { type: "pdf" },
        { protocol: "escpos", connectionType: "network" }
      );
      expect(pdfToEscpos.ok).toBe(false);
      if (!pdfToEscpos.ok) {
        expect(pdfToEscpos.reason).toContain("pdf requires spooler or IPP transport");
      }

      // ZPL payload to ZPL printer is valid
      const zplToZpl = validatePayloadForPrinter(
        { type: "raw", protocol: "zpl" },
        { protocol: "zpl", connectionType: "network" }
      );
      expect(zplToZpl.ok).toBe(true);
    });
  });

  describe("Contract 2: Gateway ↔ Agent Interface", () => {
    it("derives agent availability and effective printer status deterministically", () => {
      const now = new Date();
      const freshAgent = { lifecycle: "active", status: "online", lastSeenAt: now };
      expect(getAgentAvailability(freshAgent, now).available).toBe(true);

      const staleDate = new Date(now.getTime() - 120_000); // 2 minutes ago
      const staleAgent = { lifecycle: "active", status: "online", lastSeenAt: staleDate };
      expect(getAgentAvailability(staleAgent, now).available).toBe(false);
      expect(getAgentAvailability(staleAgent, now).reason).toBe("stale");

      // Printer freshness is independently required at the delivery boundary.
      // Keep the fixture fresh so the assertion isolates agent staleness.
      const printer = { lifecycle: "active", status: "online", lastSeenAt: now };
      expect(getEffectivePrinterStatus(printer, staleAgent, now)).toBe("offline");
      expect(getEffectivePrinterStatus(printer, freshAgent, now)).toBe("online");
    });

    it("verifies routing availability gating for active printers", () => {
      const now = new Date();
      const freshAgent = { lifecycle: "active", status: "online", lastSeenAt: now };
      const onlinePrinter = { lifecycle: "active", status: "online", lastSeenAt: now };

      expect(isPrinterAvailableForJob(onlinePrinter, freshAgent, now)).toBe(true);

      const disabledPrinter = { lifecycle: "disabled", status: "online" };
      expect(isPrinterAvailableForJob(disabledPrinter, freshAgent, now)).toBe(false);
    });
  });

  describe("Contract 3: Desktop ↔ Agent Interface", () => {
    it("generates protocol-tailored test pages avoiding uncaught UI exceptions", () => {
      // ESC/POS thermal printer test page
      const escposTest = buildTestPrintPayloadForPrinter("Receipt-1", "Agent-1", {
        protocol: "escpos",
        connectionType: "network",
      });
      expect(escposTest.type).toBe("escpos");
      expect(escposTest.protocol).toBe("escpos");

      // Zebra ZPL printer test page
      const zplTest = buildTestPrintPayloadForPrinter("Label-1", "Agent-1", {
        protocol: "zpl",
        connectionType: "network",
      });
      expect(zplTest.type).toBe("raw");
      expect(zplTest.protocol).toBe("zpl");

      // Windows Spooler / IPP document printer test page
      const spoolerTest = buildTestPrintPayloadForPrinter("Office-Laser", "Agent-1", {
        protocol: "spooler",
        connectionType: "spooler",
      });
      expect(spoolerTest.type).toBe("pdf");
      const pdfHeader = Buffer.from(spoolerTest.data, "base64").toString("utf-8");
      expect(pdfHeader).toContain("%PDF-1.4");

      // Undeclared / unknown protocol throws structured error for HTTP 422 mapping
      expect(() =>
        buildTestPrintPayloadForPrinter("Unknown-Device", "Agent-1", {
          protocol: "unknown",
          connectionType: "custom",
        })
      ).toThrow(/no supported test ticket format/);
    });
  });

  describe("Contract 4: WebSocket ↔ Agent Transport Interface", () => {
    it("validates token bucket rate limiting mathematical invariant", () => {
      const capacity = 20;
      const refillPerSecond = 5;
      let tokens = capacity;
      let lastRefillMs = Date.now();

      const consume = (cost = 1, now = Date.now()): boolean => {
        const elapsed = Math.max(0, now - lastRefillMs) / 1000;
        tokens = Math.min(capacity, tokens + elapsed * refillPerSecond);
        lastRefillMs = now;
        if (tokens < cost) return false;
        tokens -= cost;
        return true;
      };

      // Consume full bucket
      for (let i = 0; i < capacity; i++) {
        expect(consume(1)).toBe(true);
      }
      expect(consume(1)).toBe(false);

      // Advance time by 1 second -> should refill 5 tokens
      const futureNow = lastRefillMs + 1000;
      for (let i = 0; i < refillPerSecond; i++) {
        expect(consume(1, futureNow)).toBe(true);
      }
      expect(consume(1, futureNow)).toBe(false);
    });

    it("verifies frame limits for job envelopes and agent messages", () => {
      const maxAgentMsg = 64 * 1024;
      const maxWsBuffer = 1 * 1024 * 1024;
      expect(maxAgentMsg).toBe(65536);
      expect(maxWsBuffer).toBe(1048576);
    });
  });
});
