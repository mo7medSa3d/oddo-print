import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import payloadContract from "../contracts/print-payload-contract.json";
import { printJobPayloadSchema, validatePrintJobPayload } from "../src/lib/payload";

function read(path: string): string {
  return readFileSync(path, "utf8");
}


describe("print payload wire contract", () => {
  it("uses one normative contract for TypeScript, Go and the database guard", () => {
    const ts = read("src/lib/payload.ts");
    const go = read("agent/internal/payload/payload.go");
    const sql = read("drizzle/0024_claim_fencing_and_payload_contract.sql");

    expect(ts).toContain('payloadContract.maxPayloadBytes');
    expect(ts).toContain('payloadContract.wireTypes');
    expect(ts).toContain('payloadContract.rawProtocols');
    expect(ts).toContain('payloadContract.peripherals');

    const tsTypes = (printJobPayloadSchema.shape.type as unknown as { options: string[] }).options;
    expect([...tsTypes].sort()).toEqual([...payloadContract.wireTypes].sort());
    expect((printJobPayloadSchema.shape.protocol as unknown as { unwrap: () => { options: string[] } }).unwrap().options.sort())
      .toEqual([...payloadContract.rawProtocols].sort());

    expect(payloadContract.maxPayloadBytes).toBe(5 * 1024 * 1024);
    expect(go).toContain("const MaxPayloadBytes = 5 * 1024 * 1024");
    const goTypeDecls = {
      raw: 'TypeRaw    Type = "raw"',
      escpos: 'TypeESCPOS Type = "escpos"',
      pdf: 'TypePDF    Type = "pdf"',
      image: 'TypeImage  Type = "image"',
    } as const;
    for (const wireType of payloadContract.wireTypes as Array<keyof typeof goTypeDecls>) {
      expect(go).toContain(goTypeDecls[wireType]);
    }

    expect(go).toContain('case "raw", "escpos", "zpl", "tspl":');
    expect(go).toContain('if protocol != "escpos"');
    expect(go).toContain('if protocol != ""');
    expect(go).toContain('case "pin2", "pin5", "none":');
    expect(go).toContain('case "partial", "full", "none":');
    expect(go).toContain('case "epson_pulse", "star_bel", "none":');

    expect(sql).toContain("IN ('raw', 'escpos', 'zpl', 'tspl')");
    for (const protocol of payloadContract.rawProtocols) {
      expect(sql).toContain(protocol);
    }
  });

  it("enforces the normative byte limit at the Gateway boundary", () => {
    const exact = Buffer.alloc(payloadContract.maxPayloadBytes, 0x41).toString("base64");
    expect(validatePrintJobPayload({
      type: "raw",
      protocol: "raw",
      encoding: payloadContract.encoding,
      data: exact,
    }).data).toBe(exact);

    const over = Buffer.alloc(payloadContract.maxPayloadBytes + 1, 0x41).toString("base64");
    expect(() => validatePrintJobPayload({
      type: "raw",
      protocol: "raw",
      encoding: payloadContract.encoding,
      data: over,
    })).toThrow();
  });

  it("keeps signatures aligned with the normative contract", () => {
    const ts = read("src/lib/payload.ts");
    expect(ts).toContain("const pdfSignature = Buffer.from(payloadContract.signatures.pdfPrefix);");
    expect(ts).toContain('Buffer.from(payloadContract.signatures.jpegHexPrefix, "hex")');
    expect(payloadContract.signatures.pdfPrefix).toBe("%PDF-");
    expect(payloadContract.signatures.jpegHexPrefix).toBe("ffd8ff");
    const go = read("agent/internal/payload/payload.go");
    expect(go).toContain(`[]byte("${payloadContract.signatures.pdfPrefix}")`);
    expect(go).toContain("decoded[0] == 0xff");
    expect(go).toContain("decoded[1] == 0xd8");
    expect(go).toContain("decoded[2] == 0xff");
    expect(go).toContain("EncodingBase64");
  });
});
