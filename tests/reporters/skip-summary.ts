import type { Reporter, TestModule } from "vitest/node";

// J-3: a local `npm test` run skips every DB-backed suite without PostgreSQL.
// Vitest reports those as quiet skips, which reads as a green minority of the
// suite. This reporter restates the skipped files at the end so a reduced run
// can never be mistaken for full coverage.
export default class SkipSummaryReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    const skipped = testModules.filter((m) => {
      try {
        return m.state() === "skipped";
      } catch {
        return false;
      }
    });
    if (skipped.length > 0) {
      const names = skipped.map((m) => {
        try {
          const id = (m as unknown as { relativeModuleId?: unknown }).relativeModuleId;
          return String(id ?? "?").split("/").slice(-1)[0];
        } catch {
          return "?";
        }
      });
      console.log(
        `\n[skip-summary] ${skipped.length} file(s) skipped without DATABASE_URL (DB-backed suites run in CI integration): ${names.join(", ")}`,
      );
    }
  }
}
