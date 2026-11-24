import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

/** Execute the real authorization policy and its bounded denial monitor. */
export async function authorizationFixture(context) {
  context.setTimeout ??= setTimeout;
  context.clearTimeout ??= clearTimeout;
  const load = (path) => new vm.SourceTextModule(
    stripTypeScriptTypes(readFileSync(path, "utf8"), { mode: "transform" }),
    { context, identifier: path },
  );
  const monitor = load("src/server/authorization-monitor.ts");
  await monitor.link((name) => { throw new Error(`Unexpected authorization monitor import: ${name}`); });
  const policy = load("src/lib/authorization.ts");
  await policy.link((name) => {
    if (name === "../server/authorization-monitor") return monitor;
    throw new Error(`Unexpected authorization policy import: ${name}`);
  });
  await policy.evaluate();
  return policy;
}
