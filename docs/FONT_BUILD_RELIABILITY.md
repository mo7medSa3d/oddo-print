# Offline and reproducible IBM Plex font builds

The Gateway root layout uses `next/font/local` with repo-owned font assets.
**No font CSS or font binary is requested from Google during `next build`.**
This resolves the Docker failure after PR #132 at commit `00e51ba`:
`next/font/google` could not parse a remote CSS response (null match in loader).

Sources: pinned public `google/fonts` repo files, redistributed under
the SIL Open Font License (see `src/app/fonts/OFL.txt`).

- Latin: `ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf` (variable normal).
- Arabic: `ofl/ibmplexsansarabic/IBMPlexSansArabic-{Regular,Medium,SemiBold,Bold}.ttf`.
- Copyright and license: `ofl/ibmplexsans/OFL.txt`; the Arabic family carries the exact same
  upstream OFL blob SHA.

Source Git object hashes are asserted by `tests/font-assets.node.test.mjs`.
These are original, unmodified files, not a renamed/repackaged derivative.
Keep the OFL license with any distribution.

CSS variable names, the Latin and Arabic font families, font-display swap,
RTL behavior, and fallback font stacks remain unchanged. Arabic weights are
not preloaded on English pages, reducing unnecessary downloads.
Future asset upgrades must update license/provenance and rerun both
Next.js and Docker image builds; never reintroduce a remote dependency into
the Docker build path.

Reference: https://nextjs.org/docs/app/getting-started/fonts
