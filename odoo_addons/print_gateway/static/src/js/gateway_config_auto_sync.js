/** Automatically verify and reconcile activation-relevant saves.
 *
 * Two flows must converge on screen without a manual browser refresh:
 *  1. A newly saved Gateway API key is verified against the Gateway
 *     (action_test_connection). The same request synchronises Odoo's current
 *     activation state, so a replaced credential is accepted immediately and
 *     the stale pre-replacement snapshot is never shown.
 *  2. An "Enable Gateway Printing" toggle is pushed to the Gateway right away
 *     (action_retry_enabled_sync), so the banner flips to the authoritative
 *     state as soon as the Gateway acknowledges the fenced revision.
 * The transport work therefore remains outside the original database
 * transaction, and the form always reloads from the persisted state.
 */
import { FormController } from "@web/views/form/form_controller";
import { patch } from "@web/core/utils/patch";

patch(FormController.prototype, {
    async onRecordSaved(record, changes) {
        await super.onRecordSaved(record, changes);

        if (this.model.root.resModel !== "print_gateway.gateway_config") {
            return;
        }
        const keyChanged = Object.prototype.hasOwnProperty.call(changes, "gateway_api_key");
        const activationChanged = Object.prototype.hasOwnProperty.call(changes, "enabled");
        if (!keyChanged && !activationChanged) {
            return;
        }
        // Without a stored credential there is nothing to synchronize against;
        // the status row already reports "Setup required" in that case.
        if (!record.id || !record.data.gateway_api_key) {
            return;
        }
        // A key change re-validates the credential (401 becomes an explicit
        // revoked state); a pure activation toggle only pushes the fenced
        // revision without touching connection-test bookkeeping.
        const method = keyChanged ? "action_test_connection" : "action_retry_enabled_sync";

        try {
            const action = await this.orm.call(
                "print_gateway.gateway_config",
                method,
                [[record.id]],
            );

            if (action?.tag === "display_notification") {
                await this.actionService.doAction(action);
            }
        } finally {
            // The RPC above persists the authoritative sync revision/result
            // through a fresh cursor. Always reload the saved record so the
            // form cannot remain stuck on the pre-sync "Syncing" snapshot.
            await this.model.load({ resId: record.id });
        }
    },
});
