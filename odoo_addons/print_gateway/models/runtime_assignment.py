# -*- coding: utf-8 -*-
"""Odoo-owned association between a native branch and an opaque Gateway agent."""

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, ValidationError


class PrintGatewayRuntimeAgentAssignment(models.Model):
    _name = "print_gateway.runtime_agent_assignment"
    _description = "Print Gateway Runtime Agent Assignment"
    _order = "company_id, branch_id, id"

    company_id = fields.Many2one(
        "res.company", string="Odoo Company", required=True,
        default=lambda self: self.env.company.parent_id or self.env.company, ondelete="restrict", index=True,
        domain="[('parent_id', '=', False)]",
    )
    branch_id = fields.Many2one(
        "res.company", string="Odoo Branch", required=False,
        ondelete="restrict", index=True,
        domain="[('parent_id', '=', company_id)]",
    )
    runtime_agent_id = fields.Char(
        string="Gateway Runtime Agent", required=True, copy=False, index=True,
    )
    enabled = fields.Boolean(default=True)
    name = fields.Char(compute="_compute_name", store=True)

    _agent_unique = models.Constraint(
        "UNIQUE(company_id, branch_id, runtime_agent_id)",
        "The same Gateway Runtime Agent cannot be assigned more than once to the same Odoo branch.",
    )
    _company_wide_agent_unique = models.UniqueIndex(
        "(company_id, runtime_agent_id) WHERE branch_id IS NULL",
        "The same Gateway Runtime Agent cannot be assigned more than once to the company-wide Odoo scope.",
    )

    @api.depends("company_id", "branch_id", "runtime_agent_id")
    def _compute_name(self):
        for record in self:
            record.name = "%s / %s → %s" % (
                record.company_id.display_name if record.company_id else "Company",
                record.branch_id.display_name if record.branch_id else "Branch",
                record.runtime_agent_id or "Agent",
            )

    @api.model
    @api.private
    def assigned_agent_ids(self, company, branch=False):
        """Return enabled Gateway Agent IDs assigned to an Odoo scope.

        Branch scope inherits company-wide assignments (branch_id=False), while
        a root company scope accepts only company-wide assignments. This is the
        single source of truth consumed by the controller, binding validation,
        and print router.
        """
        company = company.exists() if company else company
        if not company or len(company) != 1:
            return set()
        domain = [
            ("company_id", "=", company.id),
            ("enabled", "=", True),
        ]
        if branch:
            branch = branch.exists()
            if not branch or len(branch) != 1:
                return set()
            domain = [
                "|",
                ("branch_id", "=", branch.id),
                ("branch_id", "=", False),
                *domain,
            ]
        else:
            domain.append(("branch_id", "=", False))
        return {
            record.runtime_agent_id.strip()
            for record in self.sudo().search(domain)
            if isinstance(record.runtime_agent_id, str) and record.runtime_agent_id.strip()
        }

    @api.model
    @api.private
    def is_agent_assigned(self, company, branch, runtime_agent_id):
        if not isinstance(runtime_agent_id, str) or not runtime_agent_id.strip():
            return False
        return runtime_agent_id.strip() in self.assigned_agent_ids(company, branch)

    def _check_admin(self):
        if not (self.env.is_superuser or self.env.user.has_group("base.group_system")):
            raise AccessError(_("Only Odoo system administrators can change runtime agent assignments."))

    @api.model_create_multi
    def create(self, vals_list):
        self._check_admin()
        records = super().create(vals_list)
        records._check_assignment()
        return records

    def write(self, vals):
        if set(vals).intersection({"company_id", "branch_id", "runtime_agent_id", "enabled"}):
            self._check_admin()
        result = super().write(vals)
        self._check_assignment()
        return result

    @api.constrains("company_id", "branch_id", "runtime_agent_id")
    def _check_assignment(self):
        for record in self:
            if record.company_id not in self.env.user.company_ids:
                raise ValidationError(_("The selected Odoo Company is not available to the current user."))
            if record.company_id.parent_id:
                raise ValidationError(_("Odoo Company must be a parent Company, not a Branch."))
            # Standalone organizations without child branches leave branch
            # empty (company-wide assignment). Only a DISTINCT, set branch
            # must belong to the selected company.
            if record.branch_id and record.branch_id != record.company_id:
                if record.branch_id not in self.env.user.company_ids:
                    raise ValidationError(_("The selected Odoo Branch is not available to the current user."))
                if not record.branch_id.parent_id or record.branch_id.parent_id != record.company_id:
                    raise ValidationError(_("Odoo Branch must belong directly to the selected Odoo Company."))
            if not isinstance(record.runtime_agent_id, str) or not record.runtime_agent_id.strip():
                raise ValidationError(_("A non-empty Gateway runtime agent ID is required."))
