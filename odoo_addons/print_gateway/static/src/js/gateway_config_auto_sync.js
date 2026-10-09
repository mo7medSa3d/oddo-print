/** Synchronize only after Odoo has applied the complete saved record snapshot. */
import { FormController } from "@web/views/form/form_controller";
import { Record } from "@web/model/relational_model/record";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
import { withGatewayDeadline } from "./async_control";

// onRecordSaved runs BEFORE Record._save applies web_save's returned fields.
// Capture the operation there, then run it after that final snapshot write.
// Optional connection checks must not make an already-committed native Odoo
// save wait indefinitely. This deadline bounds the *UI wait*; it does not
// cancel the remote connection check or undo the native web_save transaction.
const POST_SAVE_DEADLINE_MS = 8000;
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
        const ownsCurrentForm = () =>
            this.model.root === record && this.model.root.resModel === record.resModel &&
            this.model.root.resId === resId;
        const task = {
            cancelled: false,
            notify(error) {
                console.warn("Optional Gateway synchronization after save did not finish:", error);
                const notification = this.controller.notification || this.controller.env?.services?.notification;
                notification?.add?.(
                    _t("Configuration saved. Gateway connection verification is still pending or failed. Check the connection status before printing."),
                    { type: "warning", sticky: true },
                );
            },
            controller: this,
            async run() {
                try {
                    if (record.data.gateway_api_key && !this.cancelled && ownsCurrentForm()) {
                        const action = await this.controller.orm.call("print_gateway.gateway_config",
                            keyChanged || urlChanged ? "action_test_connection" : "action_retry_enabled_sync", [[resId]]);
                        if (!this.cancelled && ownsCurrentForm() && action?.tag === "display_notification") {
                            await this.controller.actionService.doAction(action);
                        }
                    }
                } finally {
                    // Suppress late UI mutations after navigation or deadline.
                    // If load already started before timeout, Odoo owns its
                    // cancellation; it cannot be retroactively undone here.
                    if (!this.cancelled && ownsCurrentForm()) {
                        await this.controller.model.load({ resId });
                    }
                }
            },
        };
        afterSave.set(record, task);
    },
});
patch(Record.prototype, {
    async _save(...args) {
        let saved;
        try { saved = await super._save(...args); }
        catch (error) { afterSave.delete(this); throw error; }
        const synchronize = afterSave.get(this);
        afterSave.delete(this);
        if (saved && synchronize) {
            try {
                await withGatewayDeadline(() => synchronize.run(), POST_SAVE_DEADLINE_MS,
                    _t("Gateway connection verification timed out after configuration was saved."));
            } catch (error) {
                synchronize.cancelled = true;
                // web_save has already committed. Optional gateway follow-up
                // MUST NOT turn that successful save into an error/false retry.
                try { synchronize.notify(error); }
                catch (notificationError) {
                    // A missing/tearing-down UI notification service is optional too.
                    console.warn("Gateway save notice could not be shown:", notificationError);
                }
            }
        }
        return saved;
    },
});
