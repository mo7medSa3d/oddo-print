"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";

/**
 * React Bits-inspired spotlight with a semantic-token highlight.
 * It does not track pointer state in React, allocate animation frames,
 * intercept clicks/keyboard input, or move anything in document flow.
 */
export function SpotlightSurface({
  children, className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const onMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const rect = event.currentTarget.getBoundingClientRect();
    ref.current?.style.setProperty("--yw-pointer-x", `${event.clientX - rect.left}px`);
    ref.current?.style.setProperty("--yw-pointer-y", `${event.clientY - rect.top}px`);
  };
  return (
    <article ref={ref} data-yw-reveal onPointerMove={onMove}
      className={`yw-spotlight-card relative isolate overflow-hidden ${className}`}>
      {children}
    </article>
  );
}
