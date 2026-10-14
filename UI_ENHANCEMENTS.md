# UI readability enhancements — 2026-10-14

Agent Desktop, Gateway customer console, Platform administration and the Odoo addon now use larger readable text, roomier controls and wrapping layouts. Existing brand, bundled fonts, permissions, printer states, print outcomes and receipt/paper output are preserved. No packages installed, downloaded, added or updated.

The verification and rendered-source snapshots below record this UI pass before the later local printer-sharing implementation. Current lifecycle verification and integration totals are in `AUDIT_FINDINGS.md` and `STACK_NOTES.md`:19 flows,3 wired/12 fixed/4 live acceptance gates unverified. Raw local `.audit/` logs, screenshots and generated binaries are retained on the audit workstation and excluded from Git exports.

| Component | Improvement |
| --- | --- |
| Agent Desktop | Primary values18px, supporting copy16px, metadata14px at the default root; larger metrics/buttons; paired sidebar geometry; wrapping names, paths, notices and settings details; corrected native-control font cascade. |
| Gateway / Platform | Shared relative font roles and Arabic font inheritance, larger navigation/fields/actions, wrapping mobile footer and headings. Chart captions keep readable sizing and exact coordinates; density follows the card's own width and font size. Every point/time/count title remains. |
| Odoo addon | Scoped body18px/help16px/captions15px, larger controls/focus targets, wrapping widgets/feedback and logical RTL switches. Print-intent list and capture-wizard scopes corrected. Host-wide and printed-document typography unchanged. |

Verification:57 unique Vitest,22 Node and2 affected Python cases pass. Final changed UI/chart checks rerun after visual corrections pass. Scoped lint has0 errors; real shared PostCSS/Tailwind and ordered addon SassC compilation succeed.11 addon XML files parse; Gateway EN/AR2622keys each andOdoo786terms are consistent.22 addon text contrast pairs pass, minimum5.232:1. Full TypeScript check retains15 pre-existing diagnostics caused by locally absent declared Radix/GSAP, with no new diagnostics.

Browser evidence:16 isolated actual-source SSR scenarios cover EN/AR, light/dark, actual CSS widths320/768/1280 and200% text sizing. No measured page/leaf overflow or chart caption overlap/clipping; bundled Arabic fonts load correctly. Synthetic data and inert actions make this a typography/layout check, not full application or physical-printer acceptance. Seven rendered-source hashes match final production files;29 UI source/test fingerprints and12 addon/protected fingerprints are retained.

![Isolated actual Platform components with synthetic data](</home/mo7amed_saad/work/odoo github/.audit/ui-polish-20261014/platform-ar-dark.jpg>)

Details: [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md), [FIX_LOG.md](FIX_LOG.md), [STACK_NOTES.md](STACK_NOTES.md), and local `.audit/ui-polish-20261014/final-summary.json`. At this UI pass's closure, the integration map had3 wired/11 fixed/4 live unverified gates; the later sharing pass supersedes those totals above.

UNVERIFIED: complete Gateway/Desktop build/runtime until the existing declared Radix1.1.15/GSAP3.15.0 packages are available; real Windows/Tauri WebView2 and printers; running Odoo19/OWL/POS/native controls; live Stripe/deployed services. A generated browser error-page URL restriction blocked later optional focus/capture/cleanup after the successful matrix; preview-tab cleanup is unconfirmed, and the temporary server was stopped. No restriction bypassed. No new-library recommendation or global configuration change is required by this UI pass.
