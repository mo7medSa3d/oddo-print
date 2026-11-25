# -*- coding: utf-8 -*-
from werkzeug.exceptions import Forbidden

from odoo import http
from odoo.http import request
from odoo.exceptions import ValidationError
from ..models.printer import _parse_json_dict, derive_printer_specs
from ..runtime_policy import is_exact_agent_uid


class PrintGatewayRuntimePrinterController(http.Controller):
    @staticmethod
    def _apply_security_headers():
        future_response = getattr(request, "future_response", None)
        headers = getattr(future_response, "headers", None)
        if headers is not None:
            headers["Cache-Control"] = "no-store"
            headers["X-Content-Type-Options"] = "nosniff"

    @http.route('/print_gateway/setup-context', type='jsonrpc', auth='user', methods=['POST'])
    def setup_context(self):
        """Expose authorized company scopes with unambiguous, stable labels."""
        self._apply_security_headers()
        self._require_runtime_admin()
        scopes = []
        seen_company_ids = set()
        for company in request.env.companies:
            # A repeated allowed_company_ids entry must not render twice in OWL.
            # Never collapse different Odoo company/branch records by name:
            # their IDs and printer assignments are independent.
            if company.id in seen_company_ids:
                continue
            seen_company_ids.add(company.id)
            # Routing/binding schemas intentionally accept only direct child
            # branches. A nested branch must NEVER be presented as a usable
            # printer assignment for its intermediate parent. Still show the
            # full path so the operator can understand why it is unavailable.
            nested = bool(company.parent_id and company.parent_id.parent_id)
            if nested:
                ancestry = []
                ancestor = company
                while ancestor:
                    ancestry.append((ancestor.name or ancestor.display_name or "").strip() or str(ancestor.id))
                    ancestor = ancestor.parent_id
                root = company
                while root.parent_id:
                    root = root.parent_id
                scopes.append({
                    'id': company.id,
                    'name': " / ".join(reversed(ancestry)),
                    'companyId': root.id,
                    'branchId': company.id,
                    'configId': False,
                    'assignable': False,
                })
                continue
            root, branch = self._scope(company.id)
            config, _root = self._get_config(root)
            root_name = (root.name or root.display_name or "").strip() or str(root.id)
            if branch:
                branch_name = (branch.name or branch.display_name or "").strip() or str(branch.id)
                label = "%s / %s" % (root_name, branch_name)
            else:
                label = root_name
            scopes.append({
                'id': company.id,
                'name': label,
                'companyId': root.id,
                'branchId': branch.id if branch else False,
                'configId': config.id if config else False,
            })

        # Distinct stored names may collide after display normalization.
        # Keep all their distinct authorization scopes; suffix only ambiguous
        # labels with the immutable Odoo company ID to prevent misrouting.
        counts = {}
        for scope in scopes:
            key = scope['name'].casefold()
            counts[key] = counts.get(key, 0) + 1
        # A user can literally name a company "My Company (#2)". If another
        # company called "My Company" has ID 2, a one-pass suffix operation
        # creates two identical displayed labels. Resolve collisions across
        # the *final* labels as well, without ever changing or merging IDs.
        used_labels = set()
        for scope in scopes:
            raw_name = scope['name']
            label = raw_name
            if counts[raw_name.casefold()] > 1 or label.casefold() in used_labels:
                label = "%s (#%s)" % (raw_name, scope['id'])
            while label.casefold() in used_labels:
                label = "%s (#%s)" % (label, scope['id'])
            scope['name'] = label
            used_labels.add(label.casefold())
        return {'scopes': scopes, 'currentCompanyId': request.env.company.id}

    @staticmethod
    def _require_runtime_admin():
        if not request.env.user.has_group("base.group_system"):
            raise Forbidden(request.env._("Access Denied: Runtime printer discovery is restricted to Odoo system administrators."))

    def _scope(self, company_id=None, branch_id=None, env=None):
        env = env if env is not None else request.env

        def exact_record_id(value, translated_error):
            # int(True), int(1.9), int(" 1") and int(1.0) all silently select
            # the wrong record. A printer assignment must never be coerced to
            # a different Odoo company/branch, even for an admin RPC caller.
            if type(value) is int:
                record_id = value
            elif (isinstance(value, str) and value.isascii()
                  and value.isdecimal() and len(value) <= 19):
                try:
                    record_id = int(value)
                except ValueError:
                    raise Forbidden(translated_error)
            else:
                raise Forbidden(translated_error)
            if not 0 < record_id <= 2**63 - 1:
                raise Forbidden(translated_error)
            return record_id

        # False is Odoo's standard 'no field value' sentinel. Any *other*
        # explicitly supplied value, including 0/empty strings, must be a
        # valid and exact ID rather than selecting the active company.
        if company_id is not None and company_id is not False:
            record_id = exact_record_id(company_id, env._("Access Denied: Invalid Odoo Company."))
            company = env["res.company"].browse(record_id).exists()
            if not company:
                raise Forbidden(env._("Access Denied: The selected Odoo Company is not available to the current user."))
        else:
            company = env.company
            if not company or company not in env.companies:
                raise Forbidden(env._("Access Denied: The active Odoo Company is not available to the current user."))

        user_companies = getattr(getattr(env, "user", None), "company_ids", None)
        branch = False
        if branch_id is not None and branch_id is not False:
            record_id = exact_record_id(branch_id, env._("Access Denied: Invalid Odoo Branch."))
            branch = env["res.company"].browse(record_id).exists()
            allowed_by_user = user_companies is None or branch in user_companies
            if not branch or not allowed_by_user or (
                branch not in env.companies and branch.parent_id not in env.companies
            ):
                raise Forbidden(env._("Access Denied: The selected Odoo Branch is not available to the current user."))

        # A branch's parent is metadata; authority comes from the exact allowed branch.
        if company not in env.companies and not (branch and branch.parent_id == company):
            raise Forbidden(env._("Access Denied: The selected Odoo Company is not available to the current user."))

        if company.parent_id and company.parent_id.parent_id:
            # A parent-of-parent is not a valid root for direct-child printer
            # bindings. Do not silently promote a nested company and route a
            # document to an unrelated/default printer.
            raise ValidationError(env._("Nested Odoo branches are not supported for printer assignments."))

        if company.parent_id:
            # Tolerate branch-scoped callers (e.g. a branch cashier whose
            # active company is the branch itself): lift to the parent
            # company instead of rejecting.
            if not branch:
                branch = company
            elif branch.id != company.id and branch.parent_id.id != company.id:
                # A branch-scoped caller naming two different branches is rejected fail-closed; the assignment check below stays the authorization boundary.
                raise ValidationError(env._("Odoo Branch must belong directly to the selected Odoo Company."))
            company = company.parent_id

        if branch and branch == company:
            raise ValidationError(env._("Odoo Branch must be a child Branch, not the selected root Company."))

        if branch:
            if not branch.parent_id or branch.parent_id.id != company.id:
                raise ValidationError(env._("Odoo Branch must belong directly to the selected Odoo Company."))

        return company, branch

    def _get_config(self, company, env=None):
        env = env if env is not None else request.env
        root_company = company
        while root_company.parent_id:
            root_company = root_company.parent_id
        config = env["print_gateway.gateway_config"].sudo().search(
            [("company_id", "=", root_company.id)], limit=1,
        )
        return config, root_company

    def _assigned_runtime_agent_ids(self, company, branch, env=None):
        env = env if env is not None else request.env
        return env["print_gateway.runtime_agent_assignment"].assigned_agent_ids(company, branch)

    @http.route('/print_gateway/runtime-agents', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_agents(self, company_id=None, branch_id=None, assignment_only=False):
        self._apply_security_headers()
        self._require_runtime_admin()
        company, branch = self._scope(company_id, branch_id)
        config, root_company = self._get_config(company)
        if not config:
            return {'enabled': False, 'selectedAgentId': False, 'agents': [], 'registeredAgentCount': 0, 'assignedAgentCount': 0}
        agents = request.env['print_gateway.agent'].sudo().search([
            ('company_id', '=', root_company.id), ('active', '=', True),
        ], order='name asc, id asc')
        registered_count = len(agents)
        assigned_ids = self._assigned_runtime_agent_ids(root_company, branch)
        if assignment_only:
            agents = agents.filtered(lambda agent: agent.agent_uid in assigned_ids)
        rows = [{
            'id': agent.agent_uid,
            'recordId': agent.id,
            'name': agent.name or agent.agent_uid,
            'status': agent.status or 'offline',
            'reportedStatus': agent.status or 'offline',
            'freshness': 'fresh' if agent.status == 'online' else 'stale',
            'lastSeenAt': agent.last_seen_at.isoformat() if agent.last_seen_at else False,
        } for agent in agents]
        return {
            'enabled': bool(config.enabled),
            'selectedAgentId': rows[0]['id'] if len(rows) == 1 else False,
            'agents': rows,
            'registeredAgentCount': registered_count,
            'assignedAgentCount': len(assigned_ids) if assignment_only else None,
        }

    @http.route('/print_gateway/runtime-printers', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_printers(self, company_id=None, branch_id=None, agent_id=None):
        self._apply_security_headers()
        self._require_runtime_admin()
        company, branch = self._scope(company_id, branch_id)
        if not isinstance(agent_id, str) or not is_exact_agent_uid(agent_id):
            return {'enabled': True, 'selectedAgentId': False, 'printers': []}
        config, root_company = self._get_config(company)
        if not config:
            return {'enabled': False, 'selectedAgentId': False, 'printers': []}
        allowed_agent_ids = self._assigned_runtime_agent_ids(root_company, branch)
        if agent_id not in allowed_agent_ids:
            raise Forbidden(request.env._('Access Denied: The selected Agent is not assigned to this Odoo scope.'))
        agent = request.env['print_gateway.agent'].sudo().search([
            ('company_id', '=', root_company.id), ('agent_uid', '=', agent_id), ('active', '=', True),
        ], limit=1)
        if not agent:
            return {'enabled': bool(config.enabled), 'selectedAgentId': False, 'printers': []}
        printers = request.env['print_gateway.printer'].sudo().search([
            ('agent_id', '=', agent.id), ('available_to_odoo', '=', True),
        ], order='name asc, id asc')
        rows = []
        for printer in printers:
            capabilities = _parse_json_dict(printer.capabilities_json)
            specs = derive_printer_specs(
                name=printer.name,
                connection_type=printer.connection_type,
                protocol=printer.protocol,
                capabilities=capabilities,
                geometry=printer.geometry_json,
            )
            device_class = (
                capabilities.get('deviceClass')
                or capabilities.get('device_class')
                or ('virtual' if specs['is_virtual'] else 'unknown')
            )
            rows.append({
                'id': printer.printer_key,
                'name': printer.name,
                'status': printer.status or 'unknown',
                'protocol': printer.protocol or specs['recommended_protocol'],
                'connectionType': printer.connection_type or 'unknown',
                'deviceClass': device_class,
                'isVirtual': specs['is_virtual'],
                'paperWidthMm': specs['paper_width_mm'],
                'dotsPerLine': specs['dots_per_line'],
                'dpi': specs['dpi'],
                'recommendedProtocol': specs['recommended_protocol'],
                'capabilitySummary': specs['capability_summary'],
                'availableToOdoo': bool(printer.available_to_odoo),
                'sharedWithGateway': bool(printer.available_to_odoo),
                'freshness': 'fresh' if printer.last_seen_at else 'missing',
                'lastSeenAt': printer.last_seen_at.isoformat() if printer.last_seen_at else False,
                'capabilities': capabilities,
            })
        return {'enabled': bool(config.enabled), 'selectedAgentId': agent_id, 'printers': rows}
