export const AGENT_LIFECYCLES = ["active", "disabled", "retired"] as const;
export const PRINTER_LIFECYCLES = ["active", "disabled", "retired"] as const;

export type Lifecycle = (typeof AGENT_LIFECYCLES)[number];

export function canTransitionLifecycle(current: string, next: string): boolean {
  if (current === next) return true;
  if (current === "retired") return false;
  if (next === "retired") return current === "active" || current === "disabled";
  if (next === "active" || next === "disabled") return current === "active" || current === "disabled";
  return false;
}

export function lifecycleAllowsNewJobs(lifecycle: string): boolean {
  return lifecycle === "active";
}
