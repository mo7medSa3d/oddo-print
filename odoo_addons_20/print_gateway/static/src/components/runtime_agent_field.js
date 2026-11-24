/** @odoo-module */

import { Component, onWillUnmount, proxy, useEffect, useProps, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";
import { _t } from "@web/core/l10n/translation";
import { startRpcWithDeadline } from "../js/async_control";

let runtimeAgentFieldInstance = 0;

function relationalId(value) {
    if (!value) return false;
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value[0] || false;
    if (typeof value === "object") return value.resId || value.id || false;
    return false;
}

export class RuntimeAgentField extends Component {
    static template = xml`
        <div class="o_field_widget o_field_runtime_agent">
            <t t-if="this.props.readonly">
                <t t-set="displayAgent" t-value="this.selectedAgent"/>
                <span>
                    <t t-out="displayAgent?.name || this.props.record.data[this.props.name] || ''"/>
                    <t t-if="displayAgent"> — <t t-out="this.statusLabel(displayAgent)"/><t t-if="displayAgent.freshness === 'stale'"> · <t t-out="this.labels.stale"/></t></t>
                </span>
            </t>
            <t t-else="">
                <select class="o_input" t-att-aria-label="this.labels.printAgent" t-att-value="this.selectedAgentUid" t-att-disabled="this.state.loading || !this.state.companyId" t-att-aria-busy="this.state.loading ? 'true' : undefined" t-att-aria-invalid="this.state.error ? 'true' : undefined" t-att-aria-describedby="this.state.error ? this.errorId : undefined" t-on-change="this.onChange">
                    <option value=""><t t-out="this.placeholderText"/></option>
                    <option t-foreach="this.state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === this.selectedAgentUid">
                        <t t-out="agent.name"/> — <t t-out="this.isolateIdentifier(agent.id)"/> · <t t-out="this.statusLabel(agent)"/><t t-if="agent.freshness === 'stale'"> · <t t-out="this.labels.stale"/></t>
                    </option>
                    <option t-if="!this.state.loading &amp;&amp; !this.state.error &amp;&amp; this.state.companyId &amp;&amp; !this.state.agents.length" value="" disabled="disabled"><t t-out="this.emptyMessage"/></option>
                </select>
                <div t-if="this.state.error" class="o_pg_picker_feedback mt-1 d-flex align-items-center gap-2" role="alert" aria-live="polite">
                    <small t-att-id="this.errorId" class="text-danger"><t t-out="this.labels.loadError"/></small>
                    <button type="button" class="btn btn-link btn-sm p-0" t-on-click="this.retryLoad"><t t-out="this.labels.retry"/></button>
                </div>
            </t>
        </div>`;

    props = useProps();
    state = proxy({ loading: false, agents: [], companyId: false, branchId: false, enabled: true, assignedAgentCount: null, error: null });

    setup() {
        this.rpc = rpc;
        this.errorId = `o_pg_agent_error_${++runtimeAgentFieldInstance}`;
        this.currentRequestId = 0;
        this.activeRequest = null;
        this.loadedScopeKey = null;
        // Inline `xml` templates are not scanned for translations (Odoo only
        // translates templates defined in XML files), so the strings live here
        // where `_t` is in scope and the export can see them.
        this.labels = {
            printAgent: _t("Print Agent"),
            loadingAgents: _t("Loading agents…"),
            selectCompanyFirst: _t("Select a company first"),
            selectPrintAgent: _t("Select Print Agent"),
            loadError: _t("Could not load connected Print Agents. Check the printing service connection, then retry."),
            retry: _t("Retry"),
            statusOnline: _t("online"),
            statusOffline: _t("offline"),
            statusUnknown: _t("unknown"),
            stale: _t("stale"),
        };

        // Company and Branch are NOT the field this widget renders. Odoo only
        // re-renders a field component when a value it actually read changes, so
        // an onWillUpdateProps-based reload never fires when the operator selects
        // a Branch: the widget kept the previous (branch-less, company-wide) list
        // and the Agent assigned to the selected Branch never showed up.
        // Reading the scope inside the effect dependencies subscribes the
        // component to those fields, exactly like web's monetary/datetime
        // widgets do, so the query is re-issued as soon as the scope changes.
        useEffect(
            () => {
                this.load();
            },
            () => [this.companyId, this.branchId, this.assignmentOnly],
        );
        onWillUnmount(() => {
            this.currentRequestId += 1;
            this.activeRequest?.cancel();
            this.activeRequest = null;
        });
    }

    get companyId() {
        return relationalId(this.props.record?.data?.company_id);
    }

    get branchId() {
        return relationalId(this.props.record?.data?.branch_id);
    }

    get assignmentOnly() {
        return Boolean(this.props.assignmentOnly);
    }

    get placeholderText() {
        if (this.state.loading) return this.labels.loadingAgents;
        if (!this.state.companyId) return this.labels.selectCompanyFirst;
        return this.labels.selectPrintAgent;
    }

    get isMany2one() {
        return this.props.record?.fields?.[this.props.name]?.type === "many2one";
    }

    get selectedAgentUid() {
        const raw = this.props.record?.data?.[this.props.name];
        if (!raw) return "";
        if (this.isMany2one) {
            const recId = relationalId(raw);
            const found = this.state.agents.find((agent) => agent.recordId === recId);
            return found ? found.id : "";
        }
        return raw;
    }

    get selectedAgent() {
        const agentId = this.selectedAgentUid;
        return this.state.agents.find((agent) => agent.id === agentId) || null;
    }

    isolateIdentifier(value) {
        return `\u2068${String(value ?? "")}\u2069`;
    }

    statusLabel(agent) {
        const raw = agent?.status || "unknown";
        return String(raw).toLowerCase() === "online"
            ? this.labels.statusOnline
            : String(raw).toLowerCase() === "offline"
                ? this.labels.statusOffline
                : this.labels.statusUnknown;
    }

    get emptyMessage() {
        // The endpoint reports `enabled: False` when the Company has no usable
        // Print Service configuration; saying "assign an agent" in that state would
        // send the operator to the wrong screen. An empty assignment list and a
        // missing print service are two different problems.
        if (!this.state.enabled) {
            return _t("The printing service is not configured or unreachable for this company — check Connection");
        }
        if (this.assignmentOnly) {
            return this.state.assignedAgentCount > 0
                ? _t("Assigned Print Agent is unavailable — check the Agent connection or status in Yaseir")
                : _t("No Print Agent is assigned to this company/branch — assign one under Branch Devices first");
        }
        return _t("No connected Print Agents found — connect one from Connection");
    }

    scopeKey(companyId, branchId, assignmentOnly) {
        return `${companyId || ""}|${branchId || ""}|${assignmentOnly ? 1 : 0}`;
    }

    async load() {
        const props = this.props;
        const companyId = this.companyId;
        const branchId = this.branchId;
        const assignmentOnly = Boolean(props.assignmentOnly);

        this.state.companyId = companyId;
        this.state.branchId = branchId;

        const key = this.scopeKey(companyId, branchId, assignmentOnly);
        if (key === this.loadedScopeKey) {
            return;
        }
        this.loadedScopeKey = key;

        const reqId = ++this.currentRequestId;
        this.activeRequest?.cancel();
        this.activeRequest = null;
        // Never leave agents of a previous scope on screen while the new scope
        // is being fetched (a branch must not offer another branch's agents).
        this.state.agents = [];
        this.state.assignedAgentCount = null;
        this.state.error = null;

        if (!companyId) {
            this.state.loading = false;
            return;
        }

        this.state.loading = true;
        try {
            const request = startRpcWithDeadline(this.rpc, "/print_gateway/runtime-agents", {
                company_id: companyId,
                branch_id: branchId,
                assignment_only: Boolean(props.assignmentOnly),
            }, { timeoutMessage: this.labels.loadError });
            this.activeRequest = request;
            const result = await request.promise;
            if (reqId !== this.currentRequestId) return;
            this.state.enabled = result?.enabled !== false;
            this.state.assignedAgentCount = Number.isSafeInteger(result?.assignedAgentCount) ? result.assignedAgentCount : null;
            this.state.agents = Array.isArray(result?.agents) ? result.agents : [];
            if (result?.selectedAgentId && !props.readonly && !props.record?.data?.[props.name]) {
                const match = this.state.agents.find((a) => a.id === result.selectedAgentId);
                if (match) {
                    const value = this.isMany2one ? (match.recordId ? [match.recordId, match.name] : false) : match.id;
                    if (value) {
                        props.record?.update?.({ [props.name]: value });
                    }
                }
            }
        } catch (error) {
            if (reqId !== this.currentRequestId) return;
            this.state.error = error;
        } finally {
            if (reqId === this.currentRequestId) {
                this.state.loading = false;
                this.activeRequest = null;
            }
        }
    }

    onChange(event) {
        const nextAgentUid = event.target.value || false;
        let nextValue = nextAgentUid;
        if (this.isMany2one) {
            const match = nextAgentUid ? this.state.agents.find((a) => a.id === nextAgentUid) : null;
            nextValue = match && match.recordId ? [match.recordId, match.name] : false;
        }
        const updateData = { [this.props.name]: nextValue };
        // Agent and printer are a coupled runtime target. Clear the printer
        // immediately so the old Agent's printer cannot remain selected while
        // the new Agent's list is loading.
        if (this.props.record?.fields?.printer_id) {
            updateData.printer_id = false;
        }
        // The cached printer name belongs to the old Agent's printer; a
        // stale name must not survive alongside the cleared identity.
        if (this.props.record?.fields?.printer_name) {
            updateData.printer_name = false;
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

const runtimeAgentField = {
    component: RuntimeAgentField,
    supportedTypes: ["char"],
    supportedOptions: [
        {
            label: _t("Restrict agents to explicit Branch assignment"),
            name: "assignment_only",
            type: "boolean",
        },
    ],
    // The scope lives on other fields of the same record: declare them so the
    // widget keeps working even when a view does not render them explicitly.
    fieldDependencies: [
        { name: "company_id", type: "many2one" },
        { name: "branch_id", type: "many2one" },
    ],
    extractProps: ({ options }) => ({
        assignmentOnly: Boolean(options?.assignment_only),
    }),
};

// Binding uses a dedicated descriptor that ALWAYS enables assignment filtering.
// This removes a correctness dependency on view-option parsing: a binding can
// never accidentally render the tenant-wide active-agent inventory. The
// generic field remains intentionally unfiltered for Branch Device / pairing,
// where the admin must be able to discover a new Agent before assigning it.
const runtimeAgentBindingField = {
    ...runtimeAgentField,
    supportedTypes: ["char", "many2one"],
    // Only a print binding has printer_id. Odoo 19 fieldDependencies ensures
    // even a compact form loads the value that onChange must clear.
    // The generic picker stays usable on Branch Devices and the pairing wizard.
    fieldDependencies: [
        ...runtimeAgentField.fieldDependencies,
        { name: "printer_id", type: "char" },
    ],
    supportedOptions: [],
    extractProps: () => ({
        assignmentOnly: true,
    }),
};

registry.category("fields").add("gateway_runtime_agent", runtimeAgentField, { force: true });
registry.category("fields").add("gateway_runtime_agent_picker", runtimeAgentField, { force: true });
registry.category("fields").add("gateway_runtime_agent_binding", runtimeAgentBindingField, { force: true });
