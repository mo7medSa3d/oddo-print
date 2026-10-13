"use client";

import { useEffect } from "react";

/**
 * GSAP is loaded only for the public landing. It never runs on the Gateway
 * dashboard or inside the Windows Agent (which must retain native scrolling).
 * No JS is needed to see or use any of the content.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-yw-marketing]");
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cancelled = false;
    let revert: (() => void) | undefined;
    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([module, triggers]) => {
      if (cancelled) return;
      const gsap = module.gsap;
      gsap.registerPlugin(triggers.ScrollTrigger);
      // shortcut: one mirrored offset only; full bidirectional choreography waits for a real RTL motion spec.
      const introX = document.documentElement.dir === "rtl" ? 14 : -14;
      // Context owns the entire timeline + every ScrollTrigger for unmount.
      const context = gsap.context(() => {
        gsap.timeline({ defaults: { duration: 0.75, ease: "power3.out" } })
          .from("[data-yw-intro]", { opacity: 0, y: 22, stagger: 0.105, clearProps: "all" })
          .from("[data-yw-flow-item]", { opacity: 0, x: introX, stagger: 0.085, duration: 0.45, clearProps: "all" }, "-=0.45");
        gsap.utils.toArray<HTMLElement>("[data-yw-reveal]", root).forEach((element) => {
          gsap.from(element, {
            opacity: 0,
            y: 24,
            duration: 0.65,
            ease: "power2.out",
            clearProps: "all",
            scrollTrigger: { trigger: element, start: "top 93%", once: true },
          });
        });
      }, root);
      revert = () => context.revert();
    }).catch(() => {
      // Animation is progressively enhanced; never hide functional content
      // or surface a loading/error UI just because motion is unavailable.
    });
    return () => {
      cancelled = true;
      revert?.();
    };
  }, []);
  return null;
}
