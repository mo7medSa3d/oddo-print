/** @odoo-module */

import { Component, onWillStart, onWillUpdateProps, useState, xml } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { rpc } from "@web/core/network/rpc";

function relationalId(value) {
    if (!value) return false;
    if (typeof value === "number") return value;
    if (Array.isArray(value)) return value[0] || false;
    if (typeof value === "object") return value.resId || value.id || false;
    return false;
}

export class RuntimeAgentField extends Component {
    static props = ["*"];
    static template = xml`
        <div class="o_field_widget o_field_runtime_agent">
            <t t-if="props.readonly">
                <t t-set="selectedAgent" t-value="this.selectedAgent"/>
                <span>
                    <t t-esc="selectedAgent?.name || props.record.data[props.name] || ''"/>
                    <t t-if="selectedAgent"> — <t t-esc="selectedAgent.status || 'offline'"/></t>
                </span>
            </t>
            <t t-else="">
                <select class="o_input" aria-label="Print Agent" t-att-value="props.record.data[props.name] || ''" t-att-disabled="state.loading || !state.companyId" t-att-aria-invalid="state.error ? 'true' : undefined" t-att-aria-describedby="state.error ? 'o_pg_agent_error' : undefined" t-on-change="onChange">
                    <option value=""><t t-esc="state.loading ? 'Loading agents…' : (!state.companyId ? 'Select a company first' : 'Select Print Agent')"/></option>
                    <option t-foreach="state.agents" t-as="agent" t-key="agent.id" t-att-value="agent.id" t-att-selected="agent.id === props.record.data[props.name]">
                        <t t-esc="agent.name"/> — <t t-esc="agent.id"/> · <t t-esc="agent.status || 'offline'"/>
                    </option>
                    <option t-if="!state.loading &amp;&amp; !state.error &amp;&amp; state.companyId &amp;&amp; !state.agents.length" value="" disabled="disabled">No connected Print Agents found — connect one from Connection &amp; Printing</option>
                </select>
                <div t-if="state.error" class="mt-1 d-flex align-items-center gap-2">
                    <small id="o_pg_agent_error" class="text-danger">Could not load connected Print Agents. Check the printing service connection, then retry.</small>
                    <button type="button" class="btn btn-link btn-sm p-0" t-on-click="retryLoad">Retry</button>
                </div>
            </t>
        </div>`;

    setup() {
        this.rpc = rpc;
        this.currentRequestId = 0;
        this.state = useState({ loading: false, agents: [], companyId: false, branchId: false, error: null });
        onWillStart(() => this.load(this.props));
        onWillUpdateProps((nextProps) => {
            const before = this.scope(this.props);
            const after = this.scope(nextProps);
            if (
                before.companyId !== after.companyId ||
                before.branchId !== after.branchId ||
                before.assignmentOnly !== after.assignmentOnly
            ) {
                this.load(nextProps);
            }
        });
    }

    get selectedAgent() {
        const agentId = this.props.record?.data?.[this.props.name];
        return this.state.agents.find((agent) => agent.id === agentId) || null;
    }

    scope(props) {
        return {
            companyId: relationalId(props.record?.data?.company_id),
            branchId: relationalId(props.record?.data?.branch_id),
            assignmentOnly: Boolean(props.assignmentOnly),
        };
    }

    async load(props) {
        const reqId = ++this.currentRequestId;
        this.state.agents = [];
        this.state.error = null;

        const { companyId, branchId } = this.scope(props);
        this.state.companyId = companyId;
        this.state.branchId = branchId;

        if (!companyId) {
            this.state.loading = false;
            return;
        }

        this.state.loading = true;
        try {
            const result = await this.rpc("/print_gateway/runtime-agents", {
                company_id: companyId,
                branch_id: branchId,
                assignment_only: Boolean(props.assignmentOnly),
            });
            if (reqId !== this.currentRequestId) return;
            this.state.agents = Array.isArray(result?.agents) ? result.agents : [];
            if (result?.selectedAgentId && !props.readonly && !props.record?.data?.[props.name]) {
                if (this.state.agents.some((a) => a.id === result.selectedAgentId)) {
                    props.record?.update?.({ [props.name]: result.selectedAgentId });
                }
            }
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
        const nextAgentId = event.target.value || false;
        const updateData = { [this.props.name]: nextAgentId };
        // Agent and printer are a coupled runtime target. Clear the printer
        // immediately so the old Agent's printer cannot remain selected while
        // the new Agent's list is loading.
        if (this.props.record?.fields?.printer_id) {
            updateData.printer_id = false;
        }
        this.props.record.update(updateData);
    }

    retryLoad() {
        this.load(this.props);
    }
}

const runtimeAgentField = {
    component: RuntimeAgentField,
    supportedTypes: ["char"],
    supportedOptions: [
        {
            label: "Restrict agents to explicit Branch assignment",
            name: "assignment_only",
            type: "boolean",
        },
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
    supportedOptions: [],
    extractProps: () => ({
        assignmentOnly: true,
    }),
};

registry.category("fields").add("gateway_runtime_agent", runtimeAgentField, { force: true });
registry.category("fields").add("gateway_runtime_agent_picker", runtimeAgentField, { force: true });
registry.category("fields").add("gateway_runtime_agent_binding", runtimeAgentBindingField, { force: true });
