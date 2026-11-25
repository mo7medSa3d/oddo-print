/**
 * Durable pairing evidence for the desktop setup guide.
 *
 * A value is written here ONLY after the authenticated `pair_agent` IPC call
 * succeeds, and is scoped to the Gateway origin used for that pairing. Public
 * Gateway health, a saved URL or a running Windows service are never accepted
 * as proof of pairing. The setup guide is onboarding guidance, not an
 * authorization gate; revoked credentials are still reported by the Agent.
 */
import { normalizeGatewayUrl } from "./ipc";

export const PAIRED_ORIGIN_STORAGE_KEY = "yaseir:pairedOrigin";

function canonical(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeGatewayUrl(value) || null;
  } catch {
    return null;
  }
}

/** Rehydrate the origin of the last authenticated pairing after an app restart. */
export function readPersistedPairedOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return canonical(window.localStorage.getItem(PAIRED_ORIGIN_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persist an authenticated pairing, keyed by the Gateway origin it used. */
export function rememberPairedOrigin(origin: string): void {
  const value = canonical(origin);
  if (!value || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PAIRED_ORIGIN_STORAGE_KEY, value);
  } catch {
    // Storage can be disabled; in-memory state still covers this session.
  }
}

/** A different Gateway origin invalidates the previous pairing's guidance. */
export function forgetPairedOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PAIRED_ORIGIN_STORAGE_KEY);
  } catch {
    // No persistent state to clear.
  }
}

export function pairingConfirmedFor(
  pairedOrigin: string | null | undefined,
  savedGatewayUrl: string,
): boolean {
  const saved = canonical(savedGatewayUrl);
  return Boolean(saved && canonical(pairedOrigin) === saved);
}
