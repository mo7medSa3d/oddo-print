# Troubleshooting: interactive virtual writers and outdated Server Actions

## Microsoft Print to PDF / OneNote via a Windows Service

`ERR_PRINTER_NOT_READY: spooler session lock ... timed out after 15s` means
another native print worker has not released the per-printer session.
`PDF print on "OneNote (Desktop)" failed: context deadline exceeded` means the
virtual software writer timed out; it does **not** prove physical output.

A Windows Agent Service runs without the interactive desktop, while Microsoft
Print to PDF and OneNote can require a Save As / notebook UI. First inspect the
Windows spooler job list and any generated output. A timed-out native thread can
still own the session; never force-unlock or blindly replay a possibly printed
job. Software, redirected and file-output printers are not supported. Use a real physical printer for end-to-end tests.
Only a physical print acceptance check can establish paper output.

## Next.js `Server Action ... was not found`

A browser tab opened on a previous release may send an old action ID after
Gateway has been rebuilt. Do a full browser reload and check whether the
previous operation finished before retrying. Do **not** automatically reissue
a mutation based on a failed client response; its server outcome may be unknown.

For controlled **new** Docker releases:

1. Choose an immutable **nonsecret** release ID such as a commit SHA. Set
   `YASEIR_DEPLOYMENT_ID` to that same ID before `docker compose build gateway`.
2. Use the same resulting Docker image for all Gateway instances. The bundled
   Compose stack has only one Gateway service, but browser tabs can still be
   stale after a redeploy. Next's deployment ID lets compatible clients detect
   version skew on navigation and refresh stale prefetches; it does not promise
   to recover an already-submitted mutation.
3. Verify the same ID was embedded at build time and used at runtime. Apply
   only through a reviewed deployment/rollback plan. Do not log or bake any
   Server Actions encryption key into Docker build arguments; multi-instance
   encryption-key consistency requires a separate secret handling design.
4. Run smoke tests from both a fresh tab and a tab left open before rollout.
   Confirm stale tabs show a localized refresh instruction, and that no
   print or administrative action is silently retried.

Next.js guide: https://nextjs.org/docs/app/guides/self-hosting
Windows Services: https://learn.microsoft.com/windows/win32/services/interactive-services
