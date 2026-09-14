import re

with open('/home/mo7amed_saad/work/odoo github/odoo_addons/print_gateway/models/binding.py', 'r') as f:
    content = f.read()

# Replace _ensure_branch_agent_assignment body
old_body = """            if not existing:
                assignment_model.create({
                    "company_id": record.company_id.id,
                    "branch_id": record.branch_id.id,
                    "runtime_agent_id": agent_id,
                    "enabled": True,
                })"""

new_body = """            if not existing:
                try:
                    with self.env.cr.savepoint():
                        assignment_model.create({
                            "company_id": record.company_id.id,
                            "branch_id": record.branch_id.id,
                            "runtime_agent_id": agent_id,
                            "enabled": True,
                        })
                except IntegrityError:
                    pass"""

content = content.replace(old_body, new_body)

with open('/home/mo7amed_saad/work/odoo github/odoo_addons/print_gateway/models/binding.py', 'w') as f:
    f.write(content)
