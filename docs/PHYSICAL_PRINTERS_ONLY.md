# Physical printers only: release and migration

The Windows Agent, its CLI and desktop UI, Gateway APIs and Odoo integration
accept only actual printing hardware. Microsoft Print to PDF, OneNote, XPS,
FAX, redirected/RDP and software file writers are never supported devices.

## Upgrade safely

1. Stop old Windows Agents and allow in-flight jobs to finish. They must not
   continue sending obsolete virtual printer heartbeats after the cutover.
2. Take a **verified PostgreSQL backup** before applying `0081_physical_printers_only`.
3. The transactional migration fails closed if any virtual job is `claimed`
   or `printing`. Resolve the physical-outcome ambiguity and retry the deploy;
   do **not** force a replay or manually override the claim fence.
4. `0081` deletes only classified virtual/software/redirected printer records,
   their **virtual-only** job history and durable receipts, and the associated
   discovery rows. Hardware printer records and jobs are unchanged. Historic
   audit events are preserved, but virtual-job deletion is irreversible without
   the database backup. Stage and approve this data removal before deployment.
5. Deploy the matching Windows Agent and Gateway from the same release; restart
   the Agent so it rewrites its local printer registry without legacy virtual
   records. Refresh the Gateway/desktop screens.
6. Verify `SELECT COUNT(*) FROM printers WHERE printer_type <> 'physical'`
   is zero and no software-writer names appear in any active list. Execute a
   physical test print; an empty spooler queue alone is not proof of paper.

The classifier logic is retained strictly to reject forged or stale software
printer metadata. Removing the classifier would reintroduce the bug.
