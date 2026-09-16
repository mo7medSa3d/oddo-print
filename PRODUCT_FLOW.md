# PRODUCT FLOW

Visitor → Sign Up → email verification → human identity → first tenant/owner membership → onboarding → plan selection.

Paid plan flow: authenticated billing manager → server-side plan lookup → Stripe Checkout → Stripe webhook verification → local subscription state → entitlements.

Trial flow: authenticated billing manager → server-side one-trial-per-tenant check → trial subscription state → entitlements.

Odoo: authorized tenant → encrypted Odoo Gateway credential → connection validation → print intent/outbox.

Agent: authorized tenant → Agent record → short-lived hashed pairing → registration → heartbeat → runtime identity.

Printer: Agent → discovery/manual registration → tenant/Agent ownership → persisted printer → effective availability.

Print: Odoo intent → durable job → Gateway claim → WebSocket/poll fallback → Agent queue → printer protocol → explicit result.

Security-sensitive success is confirmed by server/database state, not by URL parameters, hidden fields, client plan values, or browser success redirects.

EDI is an Odoo business-document path. It is not treated as universal Print Gateway traffic. Odoo reports are intercepted only where an applicable print binding exists.

Failure states are explicit: unauthorized/forbidden, missing subscription, unavailable Agent, unavailable printer, rejected capability, failed delivery, or UNKNOWN physical outcome.
