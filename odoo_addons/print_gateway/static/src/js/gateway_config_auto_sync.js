/** Automatically verify and reconcile a newly saved Gateway API key.
 *
 * Odoo commits the credential first. After the save completes, this hook asks
 * the model method to verify the credential and synchronise Odoo's current
 * activation state with the Gateway. The transport work therefore remains
 * outside the original database transaction.
 */
import { FormController } from "@web/views/form/form_controller";
import { patch } from "@web/core/utils/patch";

patch(FormController.prototype, {
    async onRecordSaved(record, changes) {
        await super.onRecordSaved(record, changes);

        if (this.model.root.resModel !== "print_gateway.gateway_config") {
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(changes, "gateway_api_key")) {
            return;
        }
        if (!record.id || !record.data.gateway_api_key) {
            return;
        }

        try {
            const action = await this.orm.call(
                "print_gateway.gateway_config",
                "action_test_connection",
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
