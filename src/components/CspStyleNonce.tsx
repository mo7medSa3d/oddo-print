"use client";

import { useInsertionEffect } from "react";
import { setNonce } from "get-nonce";

/**
 * Radix Dialog's react-remove-scroll uses react-style-singleton to inject
 * a temporary <style> while modal scroll-locking is active.
 *
 * The browser enforces the nonce from the ORIGINAL document response.
 * Client-side Next.js refreshes can have a different request nonce without
 * replacing that document CSP, so read the nonce from an existing script
 * in the document before falling back to the server-provided value.
 *
 * useInsertionEffect runs before the modal library's effects create styles.
 * No CSP relaxation and no global HTML/style rewriting are needed.
 */
export function CspStyleNonce({ nonce }: { nonce?: string }) {
  useInsertionEffect(() => {
    const documentNonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    const effectiveNonce = documentNonce || nonce;
    if (effectiveNonce) setNonce(effectiveNonce);
  }, [nonce]);

  return null;
}
