from psycopg2 import IntegrityError

from unittest.mock import patch

# Hard imports: this module only runs under the Odoo test runner; a fallback
# previously degraded the whole file into silent skips with a green exit.
from odoo.exceptions import ValidationError
from werkzeug.exceptions import Forbidden
from odoo.tests.common import TransactionCase


class Response:
    def __init__(self, body, status_code=200):
        self.body = body
        self.content = b"ok"
        self.status_code = status_code

    def json(self):
        return self.body


class TestBranchRuntimeBinding(TransactionCase):
    def setUp(self):
        super().setUp()
        self.company = self.env.company
        self.branch = self.env["res.company"].create({"name": "Gateway Branch", "parent_id": self.company.id})
        self.other_company = self.env["res.company"].create({"name": "Other Company"})
        self.other_branch = self.env["res.company"].create({"name": "Other Branch", "parent_id": self.other_company.id})
        self.env = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id, self.branch.id, self.other_company.id, self.other_branch.id]))
        self.agents = [
            {"id": "agent-a", "name": "Agent A", "status": "online", "lifecycle": "active"},
            {"id": "agent-b", "name": "Agent B", "status": "online", "lifecycle": "active"},
            {"id": "agent-old", "name": "Retired", "status": "offline", "lifecycle": "retired"},
        ]
        self.printers = [
            {"id": "printer-a", "name": "Printer A", "status": "online", "lifecycle": "active", "agent": {"id": "agent-a", "name": "Agent A"}},
            {"id": "printer-b", "name": "Printer B", "status": "online", "lifecycle": "active", "agent": {"id": "agent-b", "name": "Agent B"}},
        ]
        with patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            config_model = self.env["print_gateway.gateway_config"]
            self.config = config_model.search([("company_id", "=", self.company.id)], limit=1)
            vals = {"gateway_url": "https://gateway.example.com", "gateway_api_key": "test-key", "enabled": True}
            self.config = self.config or config_model.create({"company_id": self.company.id, **vals})
            if self.config:
                self.config.write(vals)

    def _gets(self):
        return [Response({"agents": self.agents}), Response({"printers": self.printers})]

    def _report(self):
        report = self.env.ref("sale.action_report_saleorder", raise_if_not_found=False)
        self.assertTrue(report)
        return report

    def _ensure_assignment(self, agent_id, branch=None, enabled=True):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        branch_id = branch.id if branch else False
        existing = assignment_model.search([
            ("company_id", "=", self.company.id),
            ("branch_id", "=", branch_id),
            ("runtime_agent_id", "=", agent_id),
        ], limit=1)
        return existing or assignment_model.create({
            "company_id": self.company.id,
            "branch_id": branch_id,
            "runtime_agent_id": agent_id,
            "enabled": enabled,
        })

    def _values(self, **extra):
        report = self._report()
        vals = {
            "company_id": self.company.id, "branch_id": self.branch.id,
            "destination_type": "report", "destination_report_id": report.id, "report_id": report.id,
            "printer_protocol": "escpos",
            "runtime_agent_id": "agent-a", "printer_id": "printer-a", "enabled": True, "priority": 10,
        }
        vals.update(extra)
        if vals.get("runtime_agent_id"):
            branch = self.env["res.company"].browse(vals["branch_id"]).exists() if vals.get("branch_id") else False
            self._ensure_assignment(vals["runtime_agent_id"], branch=branch)
        return vals

    def test_non_root_company_is_rejected(self):
        record = self.env["print_gateway.binding"].new({
            "company_id": self.branch.id,
            "branch_id": False,
            "runtime_agent_id": "agent-a",
            "printer_id": "printer-a",
        })
        with self.assertRaises(ValidationError):
            record._check_company_hierarchy()

    def test_branch_from_another_company_is_rejected(self):
        record = self.env["print_gateway.binding"].new({"company_id": self.company.id, "branch_id": self.other_branch.id, "runtime_agent_id": "agent-a", "printer_id": "printer-a"})
        with self.assertRaises(ValidationError):
            record._check_company_hierarchy()

    def test_unauthorized_company_is_rejected(self):
        restricted = self.env(context=dict(self.env.context, allowed_company_ids=[self.company.id]))
        record = restricted["print_gateway.binding"].new({"company_id": self.other_company.id, "branch_id": self.other_branch.id, "runtime_agent_id": "agent-b", "printer_id": "printer-b"})
        with self.assertRaises(ValidationError):
            record._check_runtime_scope()

    def test_retired_agent_is_rejected_on_hardware_verification(self):
        self.env["print_gateway.runtime_agent_assignment"].create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-old",
            "enabled": True,
        })
        binding = self.env["print_gateway.binding"].create(self._values(runtime_agent_id="agent-old"))
        with patch("odoo.addons.print_gateway.models.binding.requests.get", return_value=Response({"agents": self.agents})), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            with self.assertRaises(ValidationError):
                binding.action_verify_remote_hardware()

    def test_binding_creation_succeeds_without_network_io(self):
        # Database persistence does not block on synchronous network requests
        binding = self.env["print_gateway.binding"].create(self._values(priority=99))
        self.assertTrue(binding.id)

    def test_action_verify_remote_hardware_success(self):
        binding = self.env["print_gateway.binding"].create(self._values(priority=98))
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            res = binding.action_verify_remote_hardware()
            self.assertEqual(res.get("type"), "ir.actions.client")
            self.assertEqual(res.get("params", {}).get("type"), "success")

    def test_printer_from_another_agent_is_rejected(self):
        record = self.env["print_gateway.binding"].new({"company_id": self.company.id, "branch_id": self.branch.id, "runtime_agent_id": "agent-a", "printer_id": "printer-b"})
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            with self.assertRaises(ValidationError):
                record._validate_runtime_target()

    def test_parent_company_destination_is_rejected_for_branch(self):
        picking_type = self.env["stock.picking.type"].search([("company_id", "=", self.company.id)], limit=1)
        report = self.env["ir.actions.report"].search([("model", "=", "stock.picking")], limit=1)
        self.assertTrue(picking_type and report)
        with self.assertRaises(ValidationError):
            self.env["print_gateway.binding"].create(self._values(destination_type="picking_type", destination_picking_type_id=picking_type.id, report_id=report.id))

    def test_valid_full_binding_uses_existing_branch_agent_assignment(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values())
        self.assertEqual((binding.company_id.id, binding.branch_id.id, binding.runtime_agent_id, binding.printer_id), (self.company.id, self.branch.id, "agent-a", "printer-a"))
        assignment = self.env["print_gateway.runtime_agent_assignment"].search([("company_id", "=", self.company.id), ("branch_id", "=", self.branch.id)], limit=1)
        self.assertEqual(assignment.runtime_agent_id, "agent-a")

    def test_persisted_binding_reopens_with_same_context(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=20))
        reopened = self.env["print_gateway.binding"].browse(binding.id)
        self.assertEqual((reopened.company_id.id, reopened.branch_id.id, reopened.runtime_agent_id, reopened.printer_id), (self.company.id, self.branch.id, "agent-a", "printer-a"))

    def test_find_for_prefers_branch_binding(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=30))
        found = self.env["print_gateway.binding"].find_for(self.company, "order", report=self._report(), branch=self.branch)
        self.assertEqual(found.id, binding.id)

    def test_agent_change_clears_printer(self):
        record = self.env["print_gateway.binding"].new(self._values())
        record._onchange_runtime_agent_id()
        self.assertFalse(record.printer_id)

    def test_branch_change_clears_agent_printer_and_destination(self):
        record = self.env["print_gateway.binding"].new(self._values())
        record._onchange_branch_id()
        self.assertFalse(record.runtime_agent_id)
        self.assertFalse(record.printer_id)
        self.assertFalse(record.report_id)

    def test_binding_unlink_does_not_remove_independent_branch_assignment(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=40))
        assignment = self.env["print_gateway.runtime_agent_assignment"].search([
            ("company_id", "=", self.company.id), ("branch_id", "=", self.branch.id), ("runtime_agent_id", "=", "agent-a"),
        ])
        self.assertTrue(assignment)
        binding.unlink()
        self.assertTrue(assignment.exists())

    def test_binding_disable_does_not_remove_independent_branch_assignment(self):
        with patch("odoo.addons.print_gateway.models.binding.requests.get", side_effect=self._gets()), patch("odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host", return_value=None):
            binding = self.env["print_gateway.binding"].create(self._values(priority=50))
        assignment = self.env["print_gateway.runtime_agent_assignment"].search([
            ("company_id", "=", self.company.id), ("branch_id", "=", self.branch.id), ("runtime_agent_id", "=", "agent-a"),
        ])
        self.assertTrue(assignment)
        binding.write({"enabled": False})
        self.assertTrue(assignment.exists())

    def test_effective_company_id_computation(self):
        binding_branch = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
        })
        binding_branch._compute_effective_company_id()
        self.assertEqual(binding_branch.effective_company_id, self.branch)

        binding_root = self.env["print_gateway.binding"].new({
            "company_id": self.company.id,
            "branch_id": False,
        })
        binding_root._compute_effective_company_id()
        self.assertEqual(binding_root.effective_company_id, self.company)


    def test_binding_rejects_agent_assigned_to_another_branch(self):
        second_branch = self.env["res.company"].create({"name": "Gateway Branch 2", "parent_id": self.company.id})
        self.env["print_gateway.runtime_agent_assignment"].create({
            "company_id": self.company.id,
            "branch_id": second_branch.id,
            "runtime_agent_id": "agent-b",
            "enabled": True,
        })
        report = self._report()
        with self.assertRaises(ValidationError):
            self.env["print_gateway.binding"].create({
                "company_id": self.company.id,
                "branch_id": self.branch.id,
                "destination_type": "report",
                "destination_report_id": report.id,
                "report_id": report.id,
                "printer_protocol": "escpos",
                "runtime_agent_id": "agent-b",
                "printer_id": "printer-b",
                "enabled": True,
                "priority": 97,
            })

    def test_runtime_printer_discovery_rejects_agent_assigned_to_another_branch(self):
        second_branch = self.env["res.company"].create({"name": "Gateway Branch 2", "parent_id": self.company.id})
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        branch_agent = "agent-a-%s" % self.branch.id
        other_branch_agent = "agent-b-%s" % second_branch.id
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": branch_agent,
            "enabled": True,
        })
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": second_branch.id,
            "runtime_agent_id": other_branch_agent,
            "enabled": True,
        })

        from odoo.addons.print_gateway.controllers.runtime_printers import PrintGatewayRuntimePrinterController
        controller = PrintGatewayRuntimePrinterController()
        with patch.object(controller, "_require_runtime_admin"), \
             patch.object(controller, "_scope", return_value=(self.company, self.branch)), \
             patch.object(controller, "_get_config", return_value=(self.config, self.company)), \
             patch("odoo.addons.print_gateway.controllers.runtime_printers.request", type("RequestStub", (), {"env": self.env})()), \
             patch("odoo.addons.print_gateway.controllers.runtime_printers.requests.get") as remote_get:
            with self.assertRaises(Forbidden):
                controller.runtime_printers(
                    company_id=self.company.id,
                    branch_id=self.branch.id,
                    agent_id=other_branch_agent,
                )
            remote_get.assert_not_called()

    def test_runtime_agents_filters_available_agents_to_selected_branch(self):
        second_branch = self.env["res.company"].create({"name": "Gateway Branch 2", "parent_id": self.company.id})
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-a",
            "enabled": True,
        })
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": second_branch.id,
            "runtime_agent_id": "agent-b",
            "enabled": True,
        })

        from odoo.addons.print_gateway.controllers.runtime_printers import PrintGatewayRuntimePrinterController
        controller = PrintGatewayRuntimePrinterController()

        with patch.object(controller, "_require_runtime_admin"), \
             patch.object(controller, "_get_config", return_value=(self.config, self.company)), \
             patch("odoo.addons.print_gateway.controllers.runtime_printers.request", type("RequestStub", (), {"env": self.env})()), \
             patch("odoo.addons.print_gateway.controllers.runtime_printers.requests.get", return_value=Response({"agents": self.agents})):
            with patch.object(controller, "_scope", return_value=(self.company, self.branch)):
                result = controller.runtime_agents(
                    company_id=self.company.id,
                    branch_id=self.branch.id,
                    assignment_only=True,
                )
                self.assertEqual([agent["id"] for agent in result["agents"]], ["agent-a"])

            with patch.object(controller, "_scope", return_value=(self.company, second_branch)):
                result = controller.runtime_agents(
                    company_id=self.company.id,
                    branch_id=second_branch.id,
                    assignment_only=True,
                )
                self.assertEqual([agent["id"] for agent in result["agents"]], ["agent-b"])

            # Company-wide assignments are inherited by every child branch.
            self.agents.append({"id": "agent-company-wide", "name": "Company Wide Agent", "status": "online", "lifecycle": "active"})
            assignment_model.create({
                "company_id": self.company.id,
                "branch_id": False,
                "runtime_agent_id": "agent-company-wide",
                "enabled": True,
            })
            with patch.object(controller, "_scope", return_value=(self.company, self.branch)):
                result = controller.runtime_agents(
                    company_id=self.company.id,
                    branch_id=self.branch.id,
                    assignment_only=True,
                )
                self.assertEqual(
                    [agent["id"] for agent in result["agents"]],
                    ["agent-a", "agent-company-wide"],
                )

            with patch.object(controller, "_scope", return_value=(self.company, self.branch)):
                result = controller.runtime_agents(
                    company_id=self.company.id,
                    branch_id=self.branch.id,
                    assignment_only=False,
                )
                self.assertEqual(
                    [agent["id"] for agent in result["agents"]],
                    ["agent-a", "agent-b", "agent-company-wide"],
                )

    def test_runtime_assignment_defaults_to_root_company_from_branch_context(self):
        branch_env = self.env["print_gateway.runtime_agent_assignment"].with_company(self.branch)
        # The default must be derived from the active branch's parent company.
        default_company = branch_env._fields["company_id"].default(branch_env)
        self.assertEqual(default_company, self.company)

    def test_assignment_model_is_single_source_of_truth_for_branch_and_company_wide_scope(self):
        model = self.env["print_gateway.runtime_agent_assignment"]
        model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-branch",
            "enabled": True,
        })
        model.create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-company-wide",
            "enabled": True,
        })
        second_branch = self.env["res.company"].create({
            "name": "Gateway Branch 2",
            "parent_id": self.company.id,
        })
        model.create({
            "company_id": self.company.id,
            "branch_id": second_branch.id,
            "runtime_agent_id": "agent-other-branch",
            "enabled": True,
        })

        self.assertEqual(
            model.assigned_agent_ids(self.company, self.branch),
            {"agent-branch", "agent-company-wide"},
        )
        self.assertEqual(
            model.assigned_agent_ids(self.company, second_branch),
            {"agent-other-branch", "agent-company-wide"},
        )
        self.assertEqual(
            model.assigned_agent_ids(self.company, False),
            {"agent-company-wide"},
        )
        self.assertTrue(model.is_agent_assigned(self.company, self.branch, "agent-company-wide"))
        self.assertTrue(model.is_agent_assigned(self.company, self.branch, "agent-branch"))
        self.assertFalse(model.is_agent_assigned(self.company, self.branch, "agent-other-branch"))
        self.assertTrue(model.is_agent_assigned(self.company, False, "agent-company-wide"))
        self.assertFalse(model.is_agent_assigned(self.company, False, "agent-branch"))

    def test_company_wide_binding_validates_remote_target(self):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        # Use an Agent and Printer already present in the mocked Gateway
        # inventory so this test exercises the company-wide scope itself.
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-a",
            "enabled": True,
        })
        with patch(
            "odoo.addons.print_gateway.models.binding.requests.get",
            side_effect=self._gets(),
        ), patch(
            "odoo.addons.print_gateway.models.gateway_config.PrintGatewayConfig._validate_gateway_host",
            return_value=None,
        ):
            binding = self.env["print_gateway.binding"].create(self._values(
                branch_id=False,
                runtime_agent_id="agent-a",
                printer_id="printer-a",
                priority=99,
            ))
            result = binding.action_verify_remote_hardware()
        self.assertEqual(result.get("params", {}).get("type"), "success")

    def test_root_binding_requires_company_wide_agent_assignment(self):
        binding_model = self.env["print_gateway.binding"]
        with self.assertRaises(ValidationError):
            binding_model.create({
                "company_id": self.company.id,
                "branch_id": False,
                "destination_type": "report",
                "destination_report_id": self._report().id,
                "report_id": self._report().id,
                "runtime_agent_id": "agent-root-unassigned",
                "printer_id": "printer-a",
                "printer_protocol": "escpos",
                "enabled": True,
                "priority": 97,
            })

        self.env["print_gateway.runtime_agent_assignment"].create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-root-assigned",
            "enabled": True,
        })
        binding = binding_model.create(self._values(
            branch_id=False,
            runtime_agent_id="agent-root-assigned",
            printer_id="printer-a",
            priority=97,
        ))
        self.assertEqual(binding.runtime_agent_id, "agent-root-assigned")

    def test_duplicate_company_wide_assignment_is_rejected(self):
        model = self.env["print_gateway.runtime_agent_assignment"]
        model.create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-company-wide-duplicate",
            "enabled": True,
        })
        with self.env.cr.savepoint():
            with self.assertRaises(IntegrityError) as ctx:
                model.create({
                    "company_id": self.company.id,
                    "branch_id": False,
                    "runtime_agent_id": "agent-company-wide-duplicate",
                    "enabled": True,
                })
            self.assertIn("company_wide", str(ctx.exception))

    def test_binding_write_validates_the_new_runtime_agent_not_the_previous_one(self):
        model = self.env["print_gateway.runtime_agent_assignment"]
        model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-write-a",
            "enabled": True,
        })
        model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-write-b",
            "enabled": True,
        })
        binding = self.env["print_gateway.binding"].create(self._values(
            runtime_agent_id="agent-write-a",
            printer_id="printer-a",
            priority=98,
        ))
        binding.write({"runtime_agent_id": "agent-write-b"})
        self.assertEqual(binding.runtime_agent_id, "agent-write-b")

    def test_root_runtime_printer_discovery_requires_company_wide_assignment(self):
        from odoo.addons.print_gateway.controllers.runtime_printers import PrintGatewayRuntimePrinterController
        controller = PrintGatewayRuntimePrinterController()

        with patch.object(controller, "_require_runtime_admin"),              patch.object(controller, "_scope", return_value=(self.company, False)),              patch.object(controller, "_get_config", return_value=(self.config, self.company)),              patch("odoo.addons.print_gateway.controllers.runtime_printers.request", type("RequestStub", (), {"env": self.env})()),              patch("odoo.addons.print_gateway.controllers.runtime_printers.requests.get", side_effect=self._gets()) as remote_get:
            with self.assertRaises(Forbidden):
                controller.runtime_printers(
                    company_id=self.company.id,
                    branch_id=False,
                    agent_id="agent-b",
                )
            remote_get.assert_not_called()

            self.env["print_gateway.runtime_agent_assignment"].create({
                "company_id": self.company.id,
                "branch_id": False,
                "runtime_agent_id": "agent-a",
                "enabled": True,
            })
            result = controller.runtime_printers(
                company_id=self.company.id,
                branch_id=False,
                agent_id="agent-a",
            )
            self.assertEqual([printer["id"] for printer in result["printers"]], ["printer-a"])

    def test_runtime_agent_assignment_scope_is_exact_to_selected_branch(self):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        branch_agent = "agent-a-%s" % self.branch.id
        cross_branch_agent = "agent-b-%s" % self.branch.id
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": branch_agent,
            "enabled": True,
        })
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": cross_branch_agent,
            "enabled": True,
        })
        second_branch = self.env["res.company"].create({"name": "Gateway Branch 2", "parent_id": self.company.id})
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": second_branch.id,
            "runtime_agent_id": "agent-c-%s" % second_branch.id,
            "enabled": True,
        })
        from odoo.addons.print_gateway.controllers.runtime_printers import PrintGatewayRuntimePrinterController
        controller = PrintGatewayRuntimePrinterController()
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-company-wide",
            "enabled": True,
        })
        branch_agents = controller._assigned_runtime_agent_ids(self.company, self.branch, env=self.env)
        other_branch_agents = controller._assigned_runtime_agent_ids(self.company, second_branch, env=self.env)
        self.assertEqual(branch_agents, {branch_agent, cross_branch_agent, "agent-company-wide"})
        self.assertEqual(other_branch_agents, {"agent-c-%s" % second_branch.id, "agent-company-wide"})

        from odoo.addons.print_gateway.models.print_router import PrintGatewayRouter
        router = self.env["print_gateway.print_router"]
        router._assert_branch_agent_assignment(self.company, self.branch, "agent-company-wide")
        with self.assertRaises(ValidationError):
            router._assert_branch_agent_assignment(self.company, self.branch, "agent-not-assigned")
        router._assert_branch_agent_assignment(self.company, False, "agent-company-wide")
        with self.assertRaises(ValidationError):
            router._assert_branch_agent_assignment(self.company, False, "agent-not-assigned")

    def test_binding_accepts_company_wide_agent_assignment_for_branch(self):
        assignment_model = self.env["print_gateway.runtime_agent_assignment"]
        assignment_model.create({
            "company_id": self.company.id,
            "branch_id": False,
            "runtime_agent_id": "agent-company-wide",
            "enabled": True,
        })
        binding = self.env["print_gateway.binding"].create(self._values(
            runtime_agent_id="agent-company-wide",
            printer_id="printer-a",
            priority=96,
        ))
        self.assertEqual(binding.runtime_agent_id, "agent-company-wide")

    def test_branch_accepts_multiple_distinct_agent_assignments(self):
        model = self.env["print_gateway.runtime_agent_assignment"]
        first = model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-extra-a",
            "enabled": True,
        })
        second = model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-extra-b",
            "enabled": True,
        })
        self.assertEqual(
            {first.runtime_agent_id, second.runtime_agent_id},
            {"agent-extra-a", "agent-extra-b"},
        )

    def test_duplicate_same_agent_assignment_is_rejected(self):
        model = self.env["print_gateway.runtime_agent_assignment"]
        model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-duplicate",
            "enabled": True,
        })
        with self.env.cr.savepoint():
            with self.assertRaises(IntegrityError) as ctx:
                model.create({
                    "company_id": self.company.id,
                    "branch_id": self.branch.id,
                    "runtime_agent_id": "agent-duplicate",
                    "enabled": True,
                })
            self.assertIn("print_gateway_runtime_agent_assignment_agent_unique", str(ctx.exception))

        # The expected unique violation was isolated by the savepoint; the
        # outer transaction remains usable and the original row is intact.
        self.assertEqual(
            model.search_count([
                ("company_id", "=", self.company.id),
                ("branch_id", "=", self.branch.id),
                ("runtime_agent_id", "=", "agent-duplicate"),
            ]),
            1,
        )
        recovered = model.create({
            "company_id": self.company.id,
            "branch_id": self.branch.id,
            "runtime_agent_id": "agent-recovered",
            "enabled": True,
        })
        self.assertEqual(recovered.runtime_agent_id, "agent-recovered")
