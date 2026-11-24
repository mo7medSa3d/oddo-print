"use client";

import { useEffect } from "react";

/**
 * GSAP ScrollTrigger motion orchestrator for Yaseir landing page.
 * Respects prefers-reduced-motion, supports RTL/LTR,
 * and clears inline styles cleanly after execution.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-yw-marketing]");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!root || reducedMotion.matches) return;

    let cancelled = false;
    let revert: (() => void) | undefined;

    const onReducedMotionChange = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      cancelled = true;
      revert?.();
      revert = undefined;
    };
    reducedMotion.addEventListener("change", onReducedMotionChange);

    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([module, triggers]) => {
      if (cancelled) return;
      const gsap = module.gsap;
      gsap.registerPlugin(triggers.ScrollTrigger);

      const context = gsap.context(() => {
        // 1. Hero Staggered Intro: Text column + Video column alongside it
        const heroTimeline = gsap.timeline({ defaults: { duration: 0.75, ease: "power3.out" } });

        const introElements = root.querySelectorAll("[data-yw-intro]");
        if (introElements.length > 0) {
          heroTimeline.from(introElements, {
            opacity: 0,
            y: 22,
            stagger: 0.09,
            clearProps: "all",
          });
        }

        const heroVideo = root.querySelector("[data-yw-hero-video]");
        if (heroVideo) {
          heroTimeline.from(
            heroVideo,
            {
              opacity: 0,
              y: 28,
              duration: 0.85,
              ease: "power3.out",
              clearProps: "all",
            },
            "-=0.5"
          );
        }

        // 2. Flow step progression
        const flowSteps = root.querySelectorAll("[data-yw-flow-step]");
        if (flowSteps.length > 0) {
          gsap.from(flowSteps, {
            opacity: 0,
            y: 20,
            stagger: 0.1,
            duration: 0.55,
            ease: "power2.out",
            clearProps: "all",
            scrollTrigger: {
              trigger: flowSteps[0]?.parentElement || root,
              start: "top 88%",
              once: true,
            },
          });
        }

        // 3. Scroll Reveals for sections and media
        const revealElements = gsap.utils.toArray<HTMLElement>("[data-yw-reveal]", root);
        revealElements.forEach((element) => {
          gsap.from(element, {
            opacity: 0,
            y: 22,
            duration: 0.65,
            ease: "power2.out",
            clearProps: "all",
            scrollTrigger: {
              trigger: element,
              start: "top 90%",
              once: true,
            },
          });
        });
      }, root);

      revert = () => context.revert();
    }).catch(() => {
      // Animation is progressively enhanced; functional content remains visible
    });

    return () => {
      cancelled = true;
      reducedMotion.removeEventListener("change", onReducedMotionChange);
      revert?.();
    };
  }, []);

  return null;
}
