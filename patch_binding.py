import re

with open('/home/mo7amed_saad/work/odoo github/odoo_addons/print_gateway/models/binding.py', 'r') as f:
    content = f.read()

reconcile_code = """
    def _reconcile_assignments(self, company_branch_pairs):
        \"\"\"Reconcile assignments after bindings are updated or deleted.\"\"\"
        assignment_model = self.env["print_gateway.runtime_agent_assignment"].sudo()
        for company_id, branch_id in company_branch_pairs:
            assignments = assignment_model.search([("company_id", "=", company_id), ("branch_id", "=", branch_id)])
            for assignment in assignments:
                bindings = self.with_context(active_test=False).search_count([
                    ("company_id", "=", company_id),
                    ("branch_id", "=", branch_id),
                    ("runtime_agent_id", "=", assignment.runtime_agent_id)
                ])
                if not bindings:
                    assignment.unlink()
"""

# add after _ensure_branch_agent_assignment
content = re.sub(
    r'(    def _ensure_branch_agent_assignment\(self\):.*?                    "enabled": True,\n                \}\)\n)',
    r'\1' + reconcile_code,
    content,
    flags=re.DOTALL
)

# update write
new_write = """    def write(self, vals):
        trigger_fields = {"company_id", "branch_id", "runtime_agent_id", "enabled"}
        old_pairs = set()
        if trigger_fields.intersection(vals):
            for record in self:
                record._check_runtime_scope()
                if record.branch_id:
                    old_pairs.add((record.company_id.id, record.branch_id.id))
        result = super().write(vals)
        if trigger_fields.intersection(vals):
            self._ensure_branch_agent_assignment()
            new_pairs = set((r.company_id.id, r.branch_id.id) for r in self if r.branch_id)
            self._reconcile_assignments(old_pairs | new_pairs)
        return result"""

content = re.sub(
    r'    def write\(self, vals\):.*?return result',
    new_write,
    content,
    flags=re.DOTALL
)

# update unlink
new_unlink = """    def unlink(self):
        pairs = set((r.company_id.id, r.branch_id.id) for r in self if r.branch_id)
        result = super().unlink()
        self._reconcile_assignments(pairs)
        return result"""

content = re.sub(
    r'    def unlink\(self\):\n        return super\(\)\.unlink\(\)',
    new_unlink,
    content
)

with open('/home/mo7amed_saad/work/odoo github/odoo_addons/print_gateway/models/binding.py', 'w') as f:
    f.write(content)

