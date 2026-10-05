# Canonical terminology

One term, one translation. This file is the reference for every user-facing
string in the Gateway console, the desktop shell and the Odoo addon. When copy
is added or changed, look the term up here first; if a term is missing, add it
here in the same commit.

Two catalogs carry these terms:

| Surface | File | Checker |
| --- | --- | --- |
| Gateway console + desktop shell | `src/i18n/messages/{en,ar}.ts` | `npm run i18n:check` (`scripts/check-i18n.ts`) |
| Odoo addon `print_gateway` | `odoo_addons/print_gateway/i18n/ar.po` | `npm run i18n:odoo:check` (`scripts/check-odoo-translations.py`) |

## Rule 1 — product and technical terms stay in English

These are product names, protocol names or industry terms. Translating them
makes the Arabic text harder to match against the Gateway docs, the Agent logs
and the Odoo views, so they are written in Latin script inside Arabic
sentences. Arabic grammar still applies to them through the definite article
(`الـ`) and prepositions, e.g. «الـ Agent», «على الـ Gateway».

| Term | Why it stays English |
| --- | --- |
| Gateway | Product component name |
| Yaseir | Company / brand |
| Yaseir Print Manager | Product name |
| Print Manager | Product name |
| Agent | Product component name; «وكيل» reads as a legal or sales agent |
| Odoo | Third-party product |
| POS | Industry acronym (point of sale) |
| API | Industry acronym |
| WebSocket | Protocol name |
| USB, IP, IPP | Protocol/interface names |
| Windows | Operating-system name |
| Spooler | Windows subsystem name; «طابور الطباعة» describes it but loses the reference |
| ESC/POS | Printer command language |
| ZPL, TSPL | Printer command languages |
| PDF, JPEG | File formats |
| QWeb | Odoo's templating engine |
| Stripe | Third-party product |
| Website URL, printer IDs, job IDs, timestamps, API keys | Data, not language — never mirrored or reordered |

## Rule 2 — translatable product vocabulary

| English | Arabic | Notes |
| --- | --- | --- |
Values below are the strings actually shipped in `src/i18n/messages/ar.ts`
(console) and `odoo_addons/print_gateway/i18n/ar.po` (addon). Where the two
surfaces differ, both are listed.

| English | Console | Addon | Notes |
| --- | --- | --- | --- |
| Printer | الطابعة | الطابعة | |
| Print Job | مهمة طباعة | — | Never «وظيفة طباعة» — that reads as a job *vacancy* |
| Print Jobs | مهام الطباعة | — | |
| Workspace | مساحة العمل | — | The customer's tenant |
| Destination | الوجهة | الوجهة | Where a job is routed |
| Payload | البيانات | — | The bytes sent to the printer |
| Reprint | إعادة الطباعة | إعادة الطباعة | |
| Test print | طباعة تجريبية | طباعة تجريبية | |
| Test page | صفحة تجريبية | — | |
| Pairing code | رمز الربط | — | |
| Company | — | الشركة | Odoo `res.company` |
| Branch | — | الفرع | |
| Report | — | التقرير | Odoo `ir.actions.report` |
| Document Type | — | نوع المستند | |
| Binding | — | ربط | Odoo `print_gateway.binding`; the console calls the action «ربط» |
| Automation Rule | — | قاعدة أتمتة | Odoo `print_gateway.print_policy` |
| Print Rule | — | قاعدة طباعة | |
| Protocol | البروتوكول | بروتوكول الطابعة | |
| Connection | الاتصال | الاتصال | |
| Console | لوحة التحكم | — | |
| Team | الفريق | — | |
| Billing | الفوترة | — | |
| Settings | الإعدادات | — | |
| System health | حالة النظام | — | |
| Odoo integration | تكامل Odoo | — | |
| Installation API key | — | مفتاح API للتثبيت | |
| Print Activity | — | نشاط الطباعة | The addon's job log |
| Branch Device | — | جهاز الفرع | |
| Print Agent | Agent طباعة | Agent طباعة | Only where "Agent" needs qualifying; «الـ Agent» elsewhere |

## Rule 3 — status vocabulary

Status words are short, appear in badges and table cells, and must be
consistent everywhere. They are adjectives describing the *thing*, so the
Arabic forms agree with the noun they modify.

| English | Arabic | Used for |
| --- | --- | --- |
| Online | متصل | Agent, printer |
| Offline | غير متصل | Agent, printer |
| Stale | بيانات قديمة | Agent/printer telemetry whose last observation exceeded the freshness threshold |
| Offline | غير متصل | Explicit Agent connectivity or physical printer evidence; never a synonym for stale telemetry |
| Connected | متصل | Gateway connection |
| Not connected | غير متصل | Gateway connection |
| Queued | قيد الانتظار | Job |
| Printing | جارٍ الطباعة | Job |
| Completed | مكتملة | Job |
| Succeeded | نجحت | Job |
| Failed | فشلت | Job |
| Failed — needs attention | فاشل — يحتاج انتباهًا | Job (addon) |
| Incompatible job | المهمة غير متوافقة | Capability mismatch; printer health is unchanged |
| Unsupported printer protocol | بروتوكول الطابعة غير مدعوم | Job/backend compatibility |
| Needs attention — print may have completed | يحتاج انتباهًا — قد تكون الطباعة اكتملت | Job partial |
| Unknown | غير معروف | Job outcome |
| Expired | منتهية | Job |
| Cancelled | مُلغاة | Job |
| Active | نشط | Plan, key, subscription |
| Archived | مؤرشفة | Plan (console) |
| Archived | — | مؤرشف | Record (addon) |
| Enabled | مفعّل | Setting |
| Disabled | معطّل | Setting |
| In Progress | — | قيد التنفيذ | Job (addon) |
| Not checked | — | لم يُفحص | Setup check (addon) |

## Rule 4 — buttons are named for what they do

No "Submit", "Execute", "Proceed" or bare "OK". A destructive button is named
for the destruction, never "Yes"/"Continue".

| English | Arabic |
| --- | --- |
| Save | حفظ |
| Save changes | حفظ التغييرات |
| Cancel | إلغاء |
| Retry | إعادة المحاولة |
| Remove printer | إزالة الطابعة |
| Retire agent | إيقاف Agent |
| Delete agent | حذف Agent |
| Queue reprint | طلب إعادة الطباعة |
| Revoke key | إلغاء المفتاح |
| Archive plan | أرشفة الخطة |

## Rule 5 — error messages say three things

Every user-facing error answers: **what happened**, **why it matters**, and
**what to do next**. Diagnostics (exception names, JSON, SQL, stack traces,
internal identifiers) never appear in the sentence; they go to the log or to a
separate technical area.

| ✗ Don't | ✓ Do |
| --- | --- |
| `Error: gateway_unavailable` | The Gateway could not be reached. Check the Gateway URL and network connection. |
| `Failed to render raw template: KeyError: 'partner_id'` | The raw template for rule 'Kitchen' uses the placeholder {partner_id}, but this document does not provide it. |
| `HTTP 409` | The Gateway rejected the printing-service setting (HTTP 409). Check the Gateway URL and installation API key, then try again. |

## Rule 6 — loading and empty states

Loading text ends in an ellipsis («…», U+2026) and says what is loading. Empty
states say what is empty, why, and what to do — never just "No data".

| English | Arabic |
| --- | --- |
| Loading printers… | جارٍ تحميل الطابعات… |
| Saving… | جارٍ الحفظ… |
| No printers bound yet | لا توجد طابعات مربوطة بعد |
| No print jobs yet | لا توجد مهام طباعة بعد |

## Rule 7 — numbers, dates and identifiers

Numbers, IDs, IP addresses, timestamps, URLs and API keys are never reversed,
reordered or re-formatted by the RTL layout. They are always rendered through
the locale helpers in `useI18n()`:

- `formatNumber(n)` — digit shaping and separators
- `formatDate(d)`, `formatDateTime(d)`, `formatTime(d)`
- `tc(baseKey, count, { count })` — plural category selection; Arabic has six

`toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` / bare
`Intl.NumberFormat` are banned outside `src/i18n/`. A grep for them returns
nothing.
