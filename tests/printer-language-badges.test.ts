// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getPrinterLanguageBadges, getSupportedDocumentTypes } from "../src/lib/printer-capability";
import ApiKeysPage from "../src/app/api-keys/page";

/**
 * Locks two audit fixes:
 *  1. Printer language chips must come from the declared protocol/connection —
 *     device class must never invent a language the printer does not speak
 *     (a `laser` device declared `raw` 9100 cannot receive PDF; a `label`
 *     device declared `escpos` does not speak ZPL).
 *  2. The API Keys page must not crash when the keys fetch does not return
 *     `200` (e.g. an expired session returning `{error}` instead of an array).
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("getPrinterLanguageBadges", () => {
  it("derives chips from declared protocol, not device class", () => {
    // laser declared raw 9100 → byte sink, NOT PDF
    expect(getPrinterLanguageBadges("raw", "network")).toEqual(["Raw 9100"]);
    // label printer declared escpos → ESC/POS, NOT ZPL
    expect(getPrinterLanguageBadges("escpos", "network")).toEqual(["ESC/POS"]);
    expect(getPrinterLanguageBadges("zpl", "network")).toEqual(["ZPL"]);
    expect(getPrinterLanguageBadges("tspl", "network")).toEqual(["TSPL"]);
  });

  it("reports spooler and IPP document classes only for those transports", () => {
    expect(getPrinterLanguageBadges("spooler", "spooler")).toEqual(["Spooler · PDF"]);
    expect(getPrinterLanguageBadges("windows_spooler", "spooler")).toEqual(["Spooler · PDF"]);
    expect(getPrinterLanguageBadges("ipp", "ipp")).toEqual(["IPP · PDF"]);
    // A RAW 9100 network printer is a byte sink: it receives no PDF, so no
    // spooler/IPP document badge can appear on a network connection.
    expect(getPrinterLanguageBadges("raw", "network")).toEqual(["Raw 9100"]);
    expect(getPrinterLanguageBadges("raw", "network")).not.toContain("Spooler · PDF");
    expect(getPrinterLanguageBadges("raw", "network")).not.toContain("IPP · PDF");
  });

  it("never invents languages for an undeclared protocol", () => {
    expect(getPrinterLanguageBadges("unknown", "network")).toEqual([]);
    expect(getPrinterLanguageBadges("", "")).toEqual([]);
  });
});

describe("ApiKeysPage resilience", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    vi.restoreAllMocks();
  });

  it("renders without crashing when the keys endpoint does not return an array", async () => {
    // An expired session returns 401 with `{error}` — the page must render an
    // error state instead of calling `keys.filter` on a non-array.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(ApiKeysPage));
    });

    // No render crash; the page shows its error banner for the keys load.
    expect(host.textContent ?? "").toMatch(/Failed to load keys|Unauthorized/i);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("ApiKeysPage API-key authoring", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountWith(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    return act(async () => {
      root!.render(React.createElement(ApiKeysPage));
    });
  }

  it("uses one full read/write credential model without scope or document-type controls", async () => {
    const posted: Record<string, unknown>[] = [];
    let list: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/odoo/keys" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/billing/status") {
        return new Response(JSON.stringify({ hasSubscription: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/odoo/keys" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        list = [{
          id: "k2",
          name: "Receipt Kitchen",
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
          odooEnabled: true,
          odooEnabledRevision: 1,
          odooEnabledUpdatedAt: new Date().toISOString(),
        }];
        return new Response(JSON.stringify({ apiKey: "sk_live_secret" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    await mountWith(fetchMock);

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click();
      await vi.waitFor(() => expect(posted.length).toBe(1));
    });

    expect(posted[0]).toEqual({ name: "Odoo Production" });
    expect(host!.textContent ?? "").toContain("Read / write · All documents");
    expect(host!.textContent ?? "").not.toContain("Read only");
    expect(host!.textContent ?? "").not.toContain("Document types");
  });
});


describe("getSupportedDocumentTypes", () => {
  it("matches the real routing contract for document transports and byte protocols", () => {
    expect(getSupportedDocumentTypes("ipp", "ipp")).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("ipps", "ipps")).toEqual(["pdf"]);
    expect(getSupportedDocumentTypes("spooler", "spooler")).toEqual(["pdf", "image", "raw", "escpos"]);
    expect(getSupportedDocumentTypes("raw", "network")).toEqual(["raw"]);
    expect(getSupportedDocumentTypes("zpl", "network")).toEqual(["zpl", "raw"]);
    expect(getSupportedDocumentTypes("tspl", "network")).toEqual(["tspl", "raw"]);
    expect(getSupportedDocumentTypes("unknown", "network")).toEqual([]);
  });
});
