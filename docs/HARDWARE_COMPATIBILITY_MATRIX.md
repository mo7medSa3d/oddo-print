# Hardware compatibility matrix and physical print certification

Software verification (unit/integration suites, CI, Windows builds) proves the
code does what it claims against simulated devices. It does **not** prove that
a specific physical printer behaves the same way: drivers differ in the status
they report, SNMP/IPP implementations differ per firmware, and paper handling
is mechanical. This document is the field protocol that turns "should work"
into recorded evidence, per printer model.

Rules:

- A matrix cell is filled in only from a physical run on that model. Never
  copy a result from a sibling model, a datasheet, or a software test.
- Record the Agent commit, Windows build, driver name + version, and
  firmware version for every run. A driver update invalidates prior rows
  for the spooler path.
- `PASS` means every step of the certification protocol below passed.
  `PARTIAL` names the failing step. Anything else is `NOT TESTED`.

## What certification can and cannot prove

- Spooler job completion means Windows accepted and finished the job. It is
  **not** proof that paper left the device; only a device status channel
  (SNMP error-state clearing, IPP job-state, ESC/POS response) plus the
  operator's visual confirmation closes that gap. The protocol therefore
  ends each print step with an operator sight check that is signed off in
  the run log.
- A printer that exposes no return channel (write-only RAW/USB) can never
  report paper-out or jam. Its ceiling is connectivity evidence, and the
  matrix records the channel as `none` rather than pretending otherwise.

## Certification protocol (per printer, per connection path)

1. **Discovery.** Run discovery. Record: the identification verdict
   (manufacturer / model / class, `identity_source`) against the expected
   row below; the reported status while the printer is idle, against what
   Windows Settings shows at the same moment — they must agree.
2. **Status truth.** With the printer idle, open the cover / remove paper /
   (laser) remove the toner, one at a time. After each fault, the reported
   status + detail must name that fault through the path's channel
   (spooler bits, SNMP `hrPrinterDetectedErrorState`, IPP
   `printer-state-reasons`, or ESC/POS DLE EOT). Clear the fault and
   confirm recovery to online. A driver that never reports a fault to
   Windows caps the spooler row at `PARTIAL (driver does not report X)`.
3. **Print paths.** Print, and visually verify output quality (margins,
   scaling, no clipping) for each applicable item:
   - A4/Letter multi-page PDF (office path).
   - 80mm and 58mm receipts (ESC/POS path, incl. image/logo raster).
   - Label stock at the model's native size (ZPL/TSPL or spooler path).
   - A PDF whose page size does not match the loaded media (must follow
     the geometry fallback chain, never silently crop to a wrong size).
4. **Interruption.** Pull the network cable / USB cable mid-job. The job
   must end in an honest unknown/partial classification, never a false
   "printed", and must not be re-sent automatically on reconnect.
5. **Sharing/visibility (Windows).** If the queue is shared or added
   per-user, confirm the Agent service inventory matches the expectation:
   per-user-only connections appear in the discovery diagnostic by name,
   not as phantom printable printers.

## Matrix

Fill one row per model + firmware. `ID` = expected identification verdict
(manufacturer / class). `Status channel` = the channel step 2 is verified
through for the fleet path actually used.

| Printer | Class (expected ID) | Paths to certify | Status channel | Paper sizes | Result | Run (date / agent commit / driver / firmware) |
|---|---|---|---|---|---|---|
| Epson TM-T20III | Epson / thermal | spooler, USB, RAW | DLE EOT (ESC/POS), spooler bits | 80mm, 58mm | NOT TESTED | |
| Epson TM-T88VI | Epson / thermal | spooler, network | DLE EOT, SNMP | 80mm | NOT TESTED | |
| Bixolon SRP-350plusIII | Bixolon / thermal | spooler, USB, RAW | DLE EOT, spooler bits | 80mm | NOT TESTED | |
| Xprinter XP-80C | Xprinter / thermal | USB, RAW | DLE EOT | 80mm | NOT TESTED | |
| Star TSP143III | Star Micronics / thermal | USB, network | DLE EOT, SNMP | 80mm | NOT TESTED | |
| Zebra ZD421 | Zebra / label | spooler, USB, RAW (ZPL) | SNMP, spooler bits | 4x6in, 2x1in labels | NOT TESTED | |
| Zebra GK420t | Zebra / label | spooler, USB | spooler bits | 4x6in labels | NOT TESTED | |
| TSC TTP-244 Pro | TSC / label | spooler, USB | spooler bits | label stock | NOT TESTED | |
| Brother QL-820NWB | Brother / label | spooler, network | SNMP | DK rolls | NOT TESTED | |
| HP LaserJet Pro M404dn | HP / laser | spooler, IPP, RAW | SNMP, IPP reasons, spooler bits | A4, Letter | NOT TESTED | |
| Brother HL-L2370DW | Brother / laser | spooler, IPP | SNMP, IPP reasons | A4, Letter | NOT TESTED | |
| Canon PIXMA TS6420 | Canon / inkjet | spooler, IPP | IPP reasons, spooler bits | A4, photo | NOT TESTED | |
| Epson EcoTank ET-2850 | Epson / inkjet | spooler, IPP | IPP reasons | A4 | NOT TESTED | |
| Epson LQ-350 | Epson / (dot matrix, class unknown by design) | spooler | spooler bits | A4 continuous | NOT TESTED | |
| SNBC BTP-R880NP | SNBC / thermal | network, USB | DLE EOT, SNMP | 80mm | NOT TESTED | |
| Citizen CT-S310II | Citizen / thermal | USB, spooler | DLE EOT | 80mm, 58mm | NOT TESTED | |

Add rows freely; the table above is the minimum pilot fleet: at least one
model per class (thermal / label / laser / inkjet) and per path (spooler /
RAW / IPP / USB) must reach `PASS` before compatibility is claimed for
that class or path. A class/path with no `PASS` row is "implemented, not
yet hardware-verified" — say exactly that, never "compatible".

## Run log template

One entry per certification run, appended here or in the issue tracker:

```
Printer:            (make / model / serial)
Firmware:           Driver (name + version):
Windows:            (edition + build)   Agent: (version + commit)
Path certified:     spooler | RAW 9100 | IPP/IPPS | direct USB
Identification:     reported manufacturer/model/class vs expected: match | mismatch (detail)
Status truth:       idle / paper-out / cover-open / toner-out -> reported status+detail each
Prints:             A4 PDF | Letter PDF | 80mm | 58mm | label — output sight-checked: yes/no per item
Interruption:       mid-job disconnect outcome classification:
Visibility:         per-user/shared expectation met: yes/no (detail)
Result:             PASS | PARTIAL (step) | FAIL (step)
Operator:           Date:
```
