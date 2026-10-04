"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CornerDownLeft, Search } from "lucide-react";
import { Kbd, useDialog } from "./ui";
import { useI18n } from "../i18n/react";

export type CommandItem = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  href?: string;
  onSelect?: () => void;
};

/**
 * ⌘K / Ctrl-K command surface.
 *
 * Deliberately scoped to navigation and shell actions that already exist —
 * it adds zero new data access and never runs a mutation without the operator
 * explicitly choosing the item. No third-party command library: the whole
 * surface is ~5 kB of local state.
 */
export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sessionOpen, setSessionOpen] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(open, onClose, panelRef);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? items.filter((item) =>
          `${item.label} ${item.group} ${item.keywords ?? ""} ${item.hint ?? ""}`
            .toLowerCase()
            .includes(needle),
        )
      : items;
    return pool.slice(0, 24);
  }, [items, query]);

  // Every opening is a new session: clear the previous search and highlight.
  // Adjusting state during render keeps the first painted frame correct.
  if (sessionOpen !== open) {
    setSessionOpen(open);
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }

  const focusInput = useCallback(() => {
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(focusTimer);
  }, []);

  useEffect(() => {
    if (!open) return;
    return focusInput();
  }, [open, focusInput]);

  // Arrow-key navigation must keep the active option in view: with up to 24
  // results inside a 52vh list the highlight used to leave the viewport, so
  // Enter would run an item the operator could no longer see.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>('[data-option-index="' + cursor + '"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [open, cursor, results.length]);

  // Options are not focusable (focus stays in the search field for typing), so
  // the active option is exposed through aria-activedescendant instead.
  const activeOptionId = results.length > 0 ? `command-option-${cursor}` : undefined;


  if (!open) return null;

  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.onSelect) item.onSelect();
    else if (item.href) router.push(item.href);
  };

  const grouped = results.reduce<Record<string, CommandItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  let flatIndex = -1;

  return (
    <div
      data-dialog-root
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
    >
      <div
        className="pg-fade-in fixed inset-0 backdrop-blur-[3px]"
        style={{ backgroundColor: "var(--overlay)" }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("command.ariaLabel")}
        className="pg-scale-in relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-edge-strong bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-edge-subtle px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((value) => (value + 1) % Math.max(1, results.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((value) => (value - 1 + results.length) % Math.max(1, results.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(results[cursor]);
              }
            }}
            placeholder={t("command.placeholder")}
            aria-label={t("command.searchAria")}
            aria-controls="command-results"
            aria-activedescendant={activeOptionId}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            className="w-full bg-transparent text-base text-ink placeholder:text-ink-4 focus:outline-none"
          />
          <Kbd>{t("command.esc")}</Kbd>
        </div>

        <div ref={listRef} id="command-results" role="listbox" aria-label={t("command.resultsAria")} className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-3">
              {t("command.empty")}
            </p>
          ) : (
            Object.entries(grouped).map(([group, groupItems]) => (
              <div key={group} className="mb-1">
                <div className="label-caps px-3 pb-1 pt-2">{group}</div>
                {groupItems.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const selected = index === cursor;
                  return (
                    <button
                      key={item.id}
                      id={`command-option-${index}`}
                      data-option-index={index}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => run(item)}
                      className={`flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-start text-sm transition-colors duration-100 ${
                        selected ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate font-[550]">{item.label}</span>
                      {item.hint && <span className="shrink-0 text-xs text-ink-4">{item.hint}</span>}
                      {selected ? (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-4 opacity-0 rtl:-scale-x-100" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function CommandHint({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-sm border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-ink-3 transition-colors duration-150 hover:border-edge-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
    >
      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1 truncate text-start">{t("command.hint")}</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}
