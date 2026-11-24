/**
 * Cross-tab session sync over BroadcastChannel — EVENTS ONLY, NEVER secrets.
 *
 * A broadcast carries only an event kind, a workspace/platform scope, a
 * sender-local monotonic generation counter, and a timestamp. It never
 * carries tokens, cookies, user data, or URLs (which could embed secrets).
 * The server remains the only authority on whether a session is alive: a
 * receiving tab never trusts a broadcast alone. On visibility/focus return
 * it revalidates through its normal ensure/refresh path instead.
 *
 * Loop guards (all enforced by the call sites, documented here so a future
 * subscriber does not reintroduce a storm):
 * - Broadcast only on a LOCAL cause: a successful logout in this tab, or a
 *   successful revalidation in this tab ("session-renewed"). Never broadcast
 *   from inside a subscribe handler.
 * - "session-renewed" receivers only clear stale "expired" UI state. They
 *   must NOT post a refresh and must NOT log out; the next scheduled
 *   timer, navigation, or interaction revalidates lazily as before.
 * - "session-logged-out"/"session-revoked" receivers redirect to login
 *   once (guarded by component state), and never re-broadcast.
 * - `kind` scopes every event: workspace events never trigger platform
 *   handlers and vice versa. Subscribers filter on it.
 *
 * Safe no-op when BroadcastChannel is unavailable (SSR, old browsers, or a
 * channel that failed to open): subscribe returns a no-op unsubscribe and
 * broadcast silently drops the event. LocalStorage/sessionStorage are
 * deliberately not used: session state must never be persisted by this
 * module, and a storage fallback would reintroduce cross-tab write races.
 */

export type SessionSyncEventType = "session-renewed" | "session-logged-out" | "session-revoked";
type SessionSyncKind = "workspace" | "platform";

export type SessionSyncEvent = {
  type: SessionSyncEventType;
  kind: SessionSyncKind;
  generation: number;
  at: number;
};

export type SessionSyncListener = (event: SessionSyncEvent) => void;

const CHANNEL_NAME = "yaseir:session-sync";

const EVENT_TYPES: ReadonlySet<string> = new Set(["session-renewed", "session-logged-out", "session-revoked"]);
const EVENT_KINDS: ReadonlySet<string> = new Set(["workspace", "platform"]);

let channel: BroadcastChannel | null = null;
let channelUnavailable = false;
/** Sender-local monotonic counter. Receivers treat events idempotently, so
 * no cross-tab ordering is inferred from it. */
let generation = 0;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined" || channelUnavailable) return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channelUnavailable = true;
      return null;
    }
  }
  return channel;
}

function isSessionSyncEvent(value: unknown): value is SessionSyncEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === "string" &&
    EVENT_TYPES.has(record.type) &&
    typeof record.kind === "string" &&
    EVENT_KINDS.has(record.kind) &&
    typeof record.generation === "number" &&
    Number.isFinite(record.generation) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at)
  );
}

/** Broadcast a local session event to other tabs. No-op without BroadcastChannel. */
export function broadcastSessionSync(type: SessionSyncEventType, kind: SessionSyncKind): void {
  const target = getChannel();
  if (!target) return;
  generation += 1;
  const event: SessionSyncEvent = { type, kind, generation, at: Date.now() };
  try {
    target.postMessage(event);
  } catch {
    /* A closed channel must never break logout or revalidation. */
  }
}

/**
 * Subscribe to events of one kind only. The listener must never broadcast:
 * that is what keeps a logout from echoing between tabs. Returns an
 * unsubscribe function; without BroadcastChannel it is a no-op.
 */
export function subscribeSessionSync(kind: SessionSyncKind, listener: SessionSyncListener): () => void {
  const target = getChannel();
  if (!target) return () => undefined;
  const onMessage = (message: MessageEvent): void => {
    if (!isSessionSyncEvent(message.data) || message.data.kind !== kind) return;
    listener(message.data);
  };
  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}
