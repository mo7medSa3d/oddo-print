// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getPrinterLanguageBadges } from "../src/lib/printer-capability";
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
    expect(host.textContent ?? "").toMatch(/Failed to load API keys|Unauthorized/i);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("ApiKeysPage scope and document-type authoring", () => {
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

  it("shows scope and document-type allowance badges for a read-only key", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/api/odoo/configuration") {
        return new Response(JSON.stringify({ enabled: true, revision: 1, updatedAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/odoo/keys") {
        return new Response(
          JSON.stringify([
            {
              id: "k1",
              name: "Kitchen POS",
              scope: "read_only",
              allowedDocumentTypes: ["receipt", "kitchen"],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    await mountWith(fetchMock);

    // The row must disclose "Read only" and the restricted type count, not
    // render a full-scope key as indistinguishable from standard.
    expect(host!.textContent ?? "").toMatch(/Read only/);
    expect(host!.textContent ?? "").toMatch(/2 types/);
  });

  it("posts scope and normalized document types when generating a key", async () => {
    const posted: Record<string, unknown>[] = [];
    let list: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/odoo/configuration") {
        return new Response(JSON.stringify({ enabled: true, revision: 1, updatedAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/odoo/keys" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/odoo/keys" && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        list = [
          {
            id: "k2",
            name: "Receipt Kitchen",
            scope: "read_only",
            allowedDocumentTypes: ["receipt", "kitchen"],
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
          },
        ];
        return new Response(JSON.stringify({ apiKey: "sk_live_secret" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    await mountWith(fetchMock);

    act(() => {
      const select = host!.querySelector<HTMLSelectElement>("#key-scope");
      const types = host!.querySelector<HTMLInputElement>("#key-types");
      const selectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      selectSetter.call(select!, "read_only");
      select!.dispatchEvent(new Event("change", { bubbles: true }));

      const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      inputSetter.call(types!, " receipt, KITCHEN ");
      types!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('form button[type="submit"]')!.click();
      await vi.waitFor(() => expect(posted.length).toBe(1));
    });
    expect(posted[0].scope).toBe("read_only");
    // Comma list is trimmed + lowercased, empty entries dropped.
    expect(posted[0].allowedDocumentTypes).toEqual(["receipt", "kitchen"]);

    // The refreshed list reflects the new key's scope.
    await act(async () => {
      await vi.waitFor(() => expect(host!.textContent ?? "").toMatch(/Read only/));
    });
  });
});
