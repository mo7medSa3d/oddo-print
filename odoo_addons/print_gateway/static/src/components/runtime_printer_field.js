/** @odoo-module */

import { Component, onWillStart, useEffect, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";

function relationalId(value) {
    if (!value) return false;
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value[0] || false;
    if (typeof value === "object") return value.resId || value.id || false;
    return false;
}

export class RuntimePrinterField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_printer">
            <t t-if="props.readonly">
                <span t-esc="props.record.data[props.name] || ''"/>
            </t>
            <t t-else="">
                <select class="o_input" t-att-aria-label="labels.printer" t-att-value="props.record.data[props.name] || ''" t-att-disabled="state.loading || !state.agentId" t-att-aria-invalid="state.error ? 'true' : undefined" t-att-aria-describedby="state.error ? 'o_pg_printer_error' : undefined" t-on-change="onChange">
                    <option value=""><t t-esc="placeholderText"/></option>
                    <option t-if="configuredPrinterMissing" t-att-value="props.record.data[props.name]" selected="selected">
                        <t t-esc="props.record.data[props.name]"/> (<t t-esc="labels.savedUnavailable"/>)
                    </option>
                    <option t-foreach="filteredPrinters" t-as="printer" t-key="printer.id" t-att-value="printer.id" t-att-selected="printer.id === props.record.data[props.name]">
                        <t t-esc="printer.name"/> [<t t-esc="printer.deviceClass || labels.genericClass"/>] — <t t-esc="printer.status"/>
                    </option>
                    <option t-if="!state.loading &amp;&amp; !state.error &amp;&amp; state.agentId &amp;&amp; !filteredPrinters.length &amp;&amp; !configuredPrinterMissing" value="" disabled="disabled"><t t-esc="emptyMessage"/></option>
                </select>
                <div t-if="state.error" class="mt-1 d-flex align-items-center gap-2">
                    <small id="o_pg_printer_error" class="text-danger"><t t-esc="labels.loadError"/></small>
                    <button type="button" class="btn btn-link btn-sm p-0" t-on-click="retryLoad"><t t-esc="labels.retry"/></button>
                </div>
            </t>
        </div>`;

    setup() {
        this.rpc = rpc;
        this.currentRequestId = 0;
        this.loadedScopeKey = null;
        this.loadedAgentId = null;
        this.state = useState({ loading: false, printers: [], agentId: false, destinationType: false, enabled: true, error: null });
        // Inline `xml` templates are not scanned for translations (Odoo only
        // translates templates defined in XML files), so the strings live here
        // where `_t` is in scope and the export can see them.
        this.labels = {
            printer: _t("Printer"),
            loadingPrinters: _t("Loading printers…"),
            selectPrintAgentFirst: _t("Select Print Agent first"),
            selectPrinter: _t("Select Printer"),
            loadError: _t("Could not load printers. Check the Print Agent connection, then retry."),
            retry: _t("Retry"),
            savedUnavailable: _t("saved / currently unavailable"),
            genericClass: _t("generic"),
        };

        // Print Agent is not the field this widget renders: a prop-based reload
        // never fires when the operator picks another Agent, so the printer list
        // kept showing the previous Agent's printers (or stayed empty). Reading
        // the scope inside the effect dependencies subscribes this component to
        // those fields and re-issues the query as soon as they change.
        useEffect(
            () => {
                this.load();
            },
            () => [this.companyId, this.branchId, this.agentId, this.destinationType],
        );
        onWillStart(() => this.load());
    }

    get companyId() {
        return relationalId(this.props.record?.data?.company_id);
    }

    get branchId() {
        return relationalId(this.props.record?.data?.branch_id);
    }

    get agentId() {
        return this.props.record?.data?.runtime_agent_id || false;
    }

    get destinationType() {
        return this.props.record?.data?.destination_type || false;
    }

    get filteredPrinters() {
        const dest = this.state.destinationType;
        if (!dest || !Array.isArray(this.state.printers)) {
            return this.state.printers;
        }
        if (dest === "pos" || dest === "pos_printer") {
            // No fallback to the full list: laser/inkjet rows would be
            // selectable here but rejected by the server binding scope
            // (binding.py), so an empty filter must stay empty and show
            // the empty message instead.
            return this.state.printers.filter(p => !["laser", "inkjet"].includes((p.deviceClass || "").toLowerCase()));
        }
        if (dest === "picking_type") {
            return this.state.printers.filter(p => ["label", "thermal", "unknown", "other"].includes((p.deviceClass || "").toLowerCase()));
        }
        return this.state.printers;
    }

    get placeholderText() {
        if (this.state.loading) return this.labels.loadingPrinters;
        if (!this.state.agentId) return this.labels.selectPrintAgentFirst;
        return this.labels.selectPrinter;
    }

    get emptyMessage() {
        return this.state.enabled
            ? _t("No printers found for this Print Agent — check the printer or workstation")
            : _t("The printing service is disabled or unreachable for this company — check Connection & Printing");
    }

    get configuredPrinterMissing() {
        const val = this.props.record?.data?.[this.props.name];
        if (!val || typeof val !== "string" || !val.trim()) return false;
        return !this.filteredPrinters.some((p) => p.id === val);
    }

    scopeKey(companyId, branchId, agentId) {
        return `${companyId || ""}|${branchId || ""}|${agentId || ""}`;
    }

    async load() {
        const companyId = this.companyId;
        const branchId = this.branchId;
        const agentId = this.agentId;
        const destinationType = this.destinationType;

        this.state.agentId = agentId;
        this.state.destinationType = destinationType;

        const key = this.scopeKey(companyId, branchId, agentId);
        if (key === this.loadedScopeKey) {
            return;
        }
        this.loadedScopeKey = key;

        const reqId = ++this.currentRequestId;
        if (this.loadedAgentId !== agentId) {
            // Another Agent's printers must never stay selectable.
            this.loadedAgentId = agentId;
            this.state.printers = [];
        }
        this.state.error = null;

        if (!companyId || !agentId) {
            this.state.loading = false;
            return;
        }

        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-printers", {
                company_id: companyId,
                branch_id: branchId,
                agent_id: agentId,
            });
            if (reqId !== this.currentRequestId) return;
            this.state.enabled = result?.enabled !== false;
            this.state.printers = Array.isArray(result?.printers) ? result.printers : [];
        } catch (error) {
            if (reqId !== this.currentRequestId) return;
            this.state.error = error;
        } finally {
            if (reqId === this.currentRequestId) {
                this.state.loading = false;
            }
        }
    }

    onChange(event) {
        const selectedId = event.target.value || false;
        const updateData = { [this.props.name]: selectedId };
        if (selectedId) {
            const found = this.state.printers.find((p) => p.id === selectedId);
            if (found && found.protocol && found.protocol !== "unknown" && this.props.record?.fields?.printer_protocol) {
                updateData.printer_protocol = found.protocol;
            }
        }
        this.props.record.update(updateData);
    }

    retryLoad() {
        // Drop the memoized scope so the query is re-issued even when the scope
        // key did not change (the previous attempt may have failed transiently).
        this.loadedScopeKey = null;
        this.load();
    }
}

if (!registry.category("fields").contains("gateway_runtime_printer")) {
    // The widget is bound exclusively to print_gateway.binding.printer_id,
    // an opaque Gateway runtime identifier stored as Char (see models/binding.py).
    // Declaring ["char"] keeps the descriptor truthful so Odoo 19 does not log
    // a misleading "don't support the type" warning on every form open.
    registry.category("fields").add("gateway_runtime_printer", {
        component: RuntimePrinterField,
        supportedTypes: ["char"],
        // The runtime target is described by other fields of the same record;
        // declare them so the picker also works from a compact form view.
        fieldDependencies: [
            { name: "company_id", type: "many2one" },
            { name: "branch_id", type: "many2one" },
            { name: "runtime_agent_id", type: "char" },
            { name: "destination_type", type: "selection" },
        ],
    });
}
