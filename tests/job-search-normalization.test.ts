import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { jobDocType, jobId, jobPrinterId } from "../src/desktop/lib/printers";

function memo(file: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0])) {
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error(`Production memo ${name} missing from ${file}`);
  return runInNewContext(`(${callback.getText(source)})()`, context) as { id: string }[];
}

const views = [
  { label: "Gateway", file: "src/app/dashboard/dashboard-client.tsx", name: "filteredJobs", fields: ["id", "printerId", "agentId", "destination", "documentType", "error"] },
  { label: "Desktop", file: "src/desktop/main.tsx", name: "jobsFiltered", fields: ["id", "printerId", "documentType"] },
] as const;

describe.each(views)("$label local job search matches normalized server input", ({ file, name, fields }) => {
  const search = (jobs: Record<string, unknown>[], jobSearch: string) => memo(file, name, {
    jobs, jobSearch, jobPrinterFilter: null, jobTab: "all", printers: [], jobDocType, jobId, jobPrinterId,
  }).map((row) => row.id);

  it("retains every searchable field with pasted whitespace and mixed case", () => {
    for (const field of fields) {
      const match = { id: "wanted", printerId: "printer", agentId: "agent", [field]: "MixedCaseMatch" };
      const other = { id: "other", printerId: "different", agentId: "another" };
      const expected = field === "id" ? "MixedCaseMatch" : "wanted";
      for (const query of ["  MIXEDcaseMATCH  ", "\tMixedCaseMatch\n", "\u00a0MixedCaseMatch\u00a0"]) {
        expect(search([match, other], query), `${field}: ${JSON.stringify(query)}`).toEqual([expected]);
      }
    }
  });

  it("keeps percent underscore and backslash literal after trimming", () => {
    const match = { id: "job_ref%_\\A", printerId: "printer", agentId: "agent" };
    const other = { id: "job_refXYZ_A", printerId: "printer", agentId: "agent" };
    expect(search([match, other], "  JOB_REF%_\\a  ")).toEqual([match.id]);
  });

  it("does not hide loaded jobs for whitespace-only input", () => {
    const rows = [{ id: "first", printerId: "printer", agentId: "agent" }, { id: "second", printerId: "printer", agentId: "agent" }];
    expect(search(rows, " \t\n ")).toEqual(["first", "second"]);
  });
});
