import type { ServerResponse } from "node:http";

type Surface = "http" | "websocket" | "manager";
type Details = { permission?: string; role?: string; actorId?: string; tenantId?: string };
type Aggregate = { surface: Surface; status: number; count: number };
type Monitor = {
  windowStarted: number;
  emitted: number;
  aggregates: Map<string, Aggregate>;
  timer?: ReturnType<typeof setTimeout>;
};

const WINDOW_MS = 60_000;
const DETAIL_LIMIT = 120;
const KEY = Symbol.for("yaseir.authorization-denials.v1");
const globals = globalThis as unknown as Record<symbol, Monitor | undefined>;
const surfaces = new Set(["http", "websocket", "manager"]);
const statuses = new Set([400, 401, 403, 405, 429]);

function monitor(): Monitor {
  return globals[KEY] ??= { windowStarted: Date.now(), emitted: 0, aggregates: new Map() };
}

function emit(event: Aggregate & Details, aggregated: boolean): void {
  // This deliberately fixed schema has no request, URL, header, body, error,
  // email or session field, and does not inherit a caller-supplied correlation
  // value. Security denials remain observable at every general LOG_LEVEL.
  try {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn",
      event: "security.access.denied", ...event, aggregated }));
  } catch {
    // A failed operational sink must never turn a denial into authorization or
    // replace its original response. Durable external log custody is separate.
  }
}

/** Flush bounded aggregates at the window boundary or graceful shutdown. */
export function flushAuthorizationDenials(): void {
  const state = globals[KEY];
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  for (const aggregate of state.aggregates.values()) emit(aggregate, true);
  state.aggregates.clear();
  state.emitted = 0;
  state.windowStarted = Date.now();
  state.timer = undefined;
}

function safeField(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** One process-wide budget, including separately bundled Next route modules. */
export function recordAuthorizationDenial(surface: Surface, status: number, details: Details = {}): void {
  if (!surfaces.has(surface) || !statuses.has(status)) return;
  const state = monitor();
  const now = Date.now();
  if (now < state.windowStarted || now - state.windowStarted >= WINDOW_MS) flushAuthorizationDenials();
  if (!state.timer) {
    state.timer = setTimeout(flushAuthorizationDenials, WINDOW_MS);
    state.timer.unref();
  }
  if (state.emitted < DETAIL_LIMIT) {
    state.emitted++;
    emit({ surface, status, count: 1,
      permission: safeField(details.permission, /^[a-z.]{1,40}$/),
      role: safeField(details.role, /^[a-z_]{1,24}$/),
      actorId: safeField(details.actorId, /^[A-Za-z0-9_-]{1,128}$/),
      tenantId: safeField(details.tenantId, /^[A-Za-z0-9_-]{1,128}$/),
    }, false);
    return;
  }
  // Only 3 fixed surfaces × 5 fixed statuses can allocate entries. Every
  // excess denial contributes to a count without retaining attacker input.
  const key = `${surface}:${status}`;
  const aggregate = state.aggregates.get(key) ?? { surface, status, count: 0 };
  aggregate.count = Math.min(Number.MAX_SAFE_INTEGER, aggregate.count + 1);
  state.aggregates.set(key, aggregate);
}

/** Observe actual HTTP decisions once, including early Origin rejections. */
export function observeAuthorizationDenials(res: ServerResponse): void {
  let recorded = false;
  const finished = () => {
    if (recorded) return;
    recorded = true;
    res.off("finish", finished);
    res.off("close", finished);
    if (res.headersSent && [401, 403, 405, 429].includes(res.statusCode)) {
      recordAuthorizationDenial("http", res.statusCode);
    }
  };
  res.once("finish", finished);
  res.once("close", finished);
}
