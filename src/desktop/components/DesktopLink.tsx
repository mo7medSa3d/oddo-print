import React, { forwardRef } from "react";

/** The desktop target has no Next router. Shared UI links retain native
 * anchor semantics, including accessible names, refs and click cancellation.
 * Only the desktop Vite configuration resolves next/link to this adapter. */
const DesktopLink = forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
  function DesktopLink({ rel, target, ...props }, ref) {
    const safeRel = target === "_blank"
      ? Array.from(new Set([...(rel ? rel.split(/\s+/).filter(Boolean) : []), "noopener", "noreferrer"])).join(" ")
      : rel;
    return <a {...props} target={target} rel={safeRel} ref={ref} />;
  },
);

export default DesktopLink;
