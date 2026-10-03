import type { MessageKey } from "../i18n/messages/en";
import type { Translator } from "../i18n/translate";

/**
 * Human labels for the `lifecycle` column.
 *
 * `agents.lifecycle` and `printers.lifecycle` are stored as the raw enum
 * `active | disabled | retired` (see the CHECK constraints in `src/db/schema.ts`).
 * Those strings are database identifiers, not copy: they must never be printed
 * into a sentence, because they cannot be translated and they read as jargon.
 * Everything user-facing goes through `lifecycleLabel`, which resolves the
 * enum to a message key and falls back to a safe generic label for any value
 * the schema gains later.
 */
const LIFECYCLE_KEYS: Record<string, MessageKey> = {
  active: "lifecycle.active",
  disabled: "lifecycle.disabled",
  retired: "lifecycle.retired",
};

/** Translate a stored `lifecycle` value for display. */
export function lifecycleLabel(t: Translator, lifecycle: string | null | undefined): string {
  const key = LIFECYCLE_KEYS[lifecycle ?? "active"];
  return t(key ?? "lifecycle.active");
}
