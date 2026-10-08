# -*- coding: utf-8 -*-
import requests
from werkzeug.exceptions import Forbidden

from odoo import http
from odoo.http import request
from odoo.exceptions import ValidationError


def _fetch_runtime_inventory(url, key, headers, params=None):
    """Bounded paging for Odoo picker inventories; never silently truncate.

    The targeted Agent/Printer lookups use id predicates instead. This is
    only for interactive pickers where we need the entire bounded fleet.
    """
    all_rows = []
    offset = 0
    while True:
        query = dict(params or {}, limit=200, offset=offset)
        response = requests.get(url, headers=headers, params=query, timeout=5, allow_redirects=False)
        if response.status_code != 200:
            raise ValidationError(request.env._('Gateway %s discovery failed (HTTP %s).') % (key, response.status_code))
        body = response.json()
        rows = body.get(key) if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise ValidationError(request.env._('Gateway returned an invalid %s discovery response.') % ('agent' if key == 'agents' else 'printer'))
        all_rows.extend(rows)
        if not body.get('hasMore'):
            return {key: all_rows}
        next_offset = body.get('nextOffset')
        if not isinstance(next_offset, int) or next_offset <= offset or next_offset > 10000:
            raise ValidationError(request.env._('Gateway %s discovery exceeded the supported fleet limit.') % key)
        offset = next_offset


class PrintGatewayRuntimePrinterController(http.Controller):
    @staticmethod
    def _require_runtime_admin():
        if not request.env.user.has_group("base.group_system"):
            raise Forbidden(request.env._("Access Denied: Runtime printer discovery is restricted to Odoo system administrators."))

    def _scope(self, company_id=None, branch_id=None, env=None):
        env = env if env is not None else request.env
        if company_id:
            try:
                company = env["res.company"].browse(int(company_id)).exists()
            except (TypeError, ValueError):
                raise Forbidden(env._("Access Denied: Invalid Odoo Company."))
            if not company or company not in env.companies:
                raise Forbidden(env._("Access Denied: The selected Odoo Company is not available to the current user."))
        else:
            company = env.company
            if not company or company not in env.companies:
                raise Forbidden(env._("Access Denied: The active Odoo Company is not available to the current user."))

        branch = False
        if branch_id:
            try:
                branch = env["res.company"].browse(int(branch_id)).exists()
            except (TypeError, ValueError):
                raise Forbidden(env._("Access Denied: Invalid Odoo Branch."))
            if not branch or branch not in env.companies:
                raise Forbidden(env._("Access Denied: The selected Odoo Branch is not available to the current user."))

        if company.parent_id:
            # Tolerate branch-scoped callers (e.g. a branch cashier whose
            # active company is the branch itself): lift to the parent
            # company instead of rejecting.
            if not branch:
                branch = company
            elif branch.id != company.id and branch.parent_id.id != company.id:
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
        self._require_runtime_admin()
        company, branch = self._scope(company_id, branch_id)
        config, root_company = self._get_config(company)
        # Agent pairing/discovery must remain available while Odoo printing is
        # disabled. `enabled` controls print dispatch, not whether an admin can
        # choose a runtime agent in the Pair New Agent wizard. Authentication
        # remains inside the server-side Gateway configuration helpers.
        if not config:
            return {'enabled': False, 'selectedAgentId': False, 'agents': []}
        try:
            gateway_base = config._gateway_base(for_request=True)
            gateway_headers = config._gateway_headers()
        except ValidationError:
            raise
        try:
            body = _fetch_runtime_inventory(
                '%s/api/odoo/agents' % gateway_base, 'agents', gateway_headers,
            )
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(request.env._('Gateway agent discovery is unavailable.')) from exc
        agents = body.get('agents') if isinstance(body, dict) else None
        if not isinstance(agents, list):
            raise ValidationError(request.env._('Gateway returned an invalid agent discovery response.'))
        sanitized = []
        for agent in agents:
            if not isinstance(agent, dict):
                continue
            agent_id = agent.get('id')
            lifecycle = agent.get('lifecycle') if isinstance(agent.get('lifecycle'), str) else ''
            if not isinstance(agent_id, str) or not agent_id.strip() or lifecycle != 'active':
                continue
            raw_name = agent.get('name') if isinstance(agent.get('name'), str) and agent.get('name').strip() else agent_id
            status = agent.get('status') if isinstance(agent.get('status'), str) else 'unknown'
            reported_status = agent.get('reportedStatus') if isinstance(agent.get('reportedStatus'), str) else status
            freshness = agent.get('freshness') if agent.get('freshness') in {'fresh', 'stale', 'missing'} else 'missing'
            sanitized.append({
                'id': agent_id,
                'name': raw_name,
                'status': status,
                'reportedStatus': reported_status,
                'freshness': freshness,
                'lastSeenAt': agent.get('lastSeenAt') if isinstance(agent.get('lastSeenAt'), str) else False,
            })
        # Binding pickers must only expose Agents explicitly assigned to the
        # selected Odoo Company + Branch. The Pair Agent wizard deliberately
        # omits assignment_only so it can discover a new Agent before creating
        # that assignment. This is a discovery filter, not the authorization
        # boundary; binding write-time validation remains authoritative.
        if assignment_only:
            allowed_agent_ids = self._assigned_runtime_agent_ids(root_company, branch)
            sanitized = [agent for agent in sanitized if agent["id"] in allowed_agent_ids]
        selected = sanitized[0]['id'] if len(sanitized) == 1 else False
        return {'enabled': True, 'selectedAgentId': selected, 'agents': sanitized}

    @http.route('/print_gateway/runtime-printers', type='jsonrpc', auth='user', methods=['POST'])
    def runtime_printers(self, company_id=None, branch_id=None, agent_id=None):
        self._require_runtime_admin()
        company, branch = self._scope(company_id, branch_id)
        if not isinstance(agent_id, str) or not agent_id.strip():
            return {'enabled': True, 'selectedAgentId': False, 'printers': []}
        config, root_company = self._get_config(company)
        if not config:
            return {'enabled': False, 'selectedAgentId': False, 'printers': []}

        selected_agent_id = agent_id.strip()
        if not selected_agent_id:
            return {'enabled': True, 'selectedAgentId': False, 'printers': []}

        # A printer inventory is an object-level discovery surface: a valid
        # tenant Agent is not automatically authorized for every Odoo scope.
        # Enforce the same explicit Company/Branch -> Agent assignment used
        # by Binding writes, so a crafted RPC call cannot inspect another
        # scope's printer inventory even when the caller is a system
        # administrator. Branch scope is exact; root scope accepts
        # company-wide and child-branch assignments (same single source of
        # truth as the assignment model).
        if branch:
            allowed_agent_ids = self._assigned_runtime_agent_ids(root_company, branch)
            if selected_agent_id not in allowed_agent_ids:
                raise Forbidden(
                    'Access Denied: The selected Gateway Agent is not assigned to this Odoo Branch.'
                )
        else:
            allowed_agent_ids = self._assigned_runtime_agent_ids(root_company, False)
            if selected_agent_id not in allowed_agent_ids:
                raise Forbidden(
                    'Access Denied: The selected Gateway Agent is not assigned to this Odoo Company.'
                )

        # Validate that the selected Agent is active and belongs to the same
        # Gateway tenant before exposing its printer inventory. Branch-scoped
        # callers have already passed the explicit assignment check above.
        try:
            agent_body = _fetch_runtime_inventory(
                '%s/api/odoo/agents' % config._gateway_base(for_request=True),
                'agents', config._gateway_headers(),
                params={'agent_id': selected_agent_id},
            )
            all_agents = agent_body.get('agents')
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(request.env._('Gateway agent discovery is unavailable.')) from exc
        matched_agent = next(
            (a for a in all_agents or [] if isinstance(a, dict) and a.get('id') == selected_agent_id and a.get('lifecycle') == 'active'),
            None,
        )
        if not matched_agent:
            raise Forbidden(request.env._('Access Denied: The selected Gateway Agent is not active in this tenant.'))

        try:
            body = _fetch_runtime_inventory(
                '%s/api/odoo/printers' % config._gateway_base(for_request=True),
                'printers', config._gateway_headers(), params={'agent_id': selected_agent_id},
            )
        except ValidationError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise ValidationError(request.env._('Gateway printer discovery is unavailable.')) from exc
        printers = body.get('printers') if isinstance(body, dict) else None
        if not isinstance(printers, list):
            raise ValidationError(request.env._('Gateway returned an invalid printer discovery response.'))
        sanitized = []
        for printer in printers:
            if not isinstance(printer, dict):
                continue
            printer_id = printer.get('id')
            if not isinstance(printer_id, str) or not printer_id.strip():
                continue
            lifecycle = printer.get('lifecycle') if isinstance(printer.get('lifecycle'), str) else ''
            agent = printer.get('agent') if isinstance(printer.get('agent'), dict) else {}
            returned_agent_id = agent.get('id') if isinstance(agent.get('id'), str) else ''
            if lifecycle != 'active' or returned_agent_id != selected_agent_id:
                continue
            capabilities = printer.get('capabilities') if isinstance(printer.get('capabilities'), dict) else {}
            raw_supported = capabilities.get('supported_protocols')
            supported_protocols = []
            if isinstance(raw_supported, list):
                allowed_protocols = {'pdf', 'image', 'raw', 'escpos', 'zpl', 'tspl', 'spooler', 'ipp', 'ipps'}
                for value in raw_supported:
                    if not isinstance(value, str):
                        continue
                    normalized = value.strip().lower()
                    if normalized in allowed_protocols and normalized not in supported_protocols:
                        supported_protocols.append(normalized)
            sanitized.append({
                'id': printer_id,
                'name': printer.get('name') if isinstance(printer.get('name'), str) else printer_id,
                'status': printer.get('status') if isinstance(printer.get('status'), str) else 'unknown',
                'reportedStatus': printer.get('reportedStatus') if isinstance(printer.get('reportedStatus'), str) else 'unknown',
                'freshness': printer.get('freshness') if printer.get('freshness') in {'fresh', 'stale', 'missing'} else 'missing',
                'lastSeenAt': printer.get('lastSeenAt') if isinstance(printer.get('lastSeenAt'), str) else False,
                'deviceClass': printer.get('deviceClass') if isinstance(printer.get('deviceClass'), str) else 'unknown',
                'connectionType': printer.get('connectionType') if isinstance(printer.get('connectionType'), str) else 'unknown',
                'protocol': printer.get('protocol') if isinstance(printer.get('protocol'), str) else 'unknown',
                'capabilities': {'supported_protocols': supported_protocols},
                'agentId': returned_agent_id,
                'agentName': agent.get('name') if isinstance(agent.get('name'), str) else selected_agent_id,
            })
        return {'enabled': True, 'selectedAgentId': selected_agent_id, 'printers': sanitized}
