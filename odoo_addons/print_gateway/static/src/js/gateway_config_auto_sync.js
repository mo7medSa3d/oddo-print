/** Synchronize only after Odoo has applied the complete saved record snapshot. */
import { FormController } from "@web/views/form/form_controller";
import { Record } from "@web/model/relational_model/record";
import { patch } from "@web/core/utils/patch";

// onRecordSaved runs BEFORE Record._save applies web_save's returned fields.
// Capture the operation there, then run it after that final snapshot write.
const afterSave = new WeakMap();
patch(FormController.prototype, {
    async onRecordSaved(record, changes) {
        await super.onRecordSaved(record, changes);
        if (record.resModel !== "print_gateway.gateway_config") return;
        const keyChanged = Object.prototype.hasOwnProperty.call(changes, "gateway_api_key");
        const urlChanged = Object.prototype.hasOwnProperty.call(changes, "gateway_url");
        const activationChanged = Object.prototype.hasOwnProperty.call(changes, "enabled");
        if (!keyChanged && !urlChanged && !activationChanged) return;
        const resId = record.resId;
        if (!resId) return;
        afterSave.set(record, async () => {
            try {
                if (record.data.gateway_api_key) {
                    const action = await this.orm.call("print_gateway.gateway_config",
                        keyChanged || urlChanged ? "action_test_connection" : "action_retry_enabled_sync", [[resId]]);
                    if (action?.tag === "display_notification") await this.actionService.doAction(action);
                }
            } finally {
                // Never reload a different form after navigation during the RPC.
                if (this.model.root === record && this.model.root.resModel === record.resModel && this.model.root.resId === resId) {
                    await this.model.load({ resId });
                }
            }
        });
    },
});
patch(Record.prototype, {
    async _save(...args) {
        let saved;
        try { saved = await super._save(...args); }
        catch (error) { afterSave.delete(this); throw error; }
        const synchronize = afterSave.get(this);
        afterSave.delete(this);
        if (saved && synchronize) await synchronize();
        return saved;
    },
});
