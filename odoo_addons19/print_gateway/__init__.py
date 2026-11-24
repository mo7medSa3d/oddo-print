# -*- coding: utf-8 -*-
import logging

from . import models
from . import controllers

_logger = logging.getLogger(__name__)

DEFAULT_LICENSE_SERVER_URL = "https://print.yaseir.cloud"
_CONFIG_PARAM_PREFIX = "print_gateway."


def post_init_hook(env):
    """Initialize clean module defaults on Odoo 19 installation.

    Per Odoo 19 official docs, post_init_hook takes ``(env)`` as its sole argument.
    """
    icp = env["ir.config_parameter"].sudo()
    if not (icp.get_param("print_gateway.license_server_url") or "").strip():
        icp.set_param("print_gateway.license_server_url", DEFAULT_LICENSE_SERVER_URL)

    try:
        root_companies = env["res.company"].sudo().search([("parent_id", "=", False)])
        config_model = env["print_gateway.gateway_config"].sudo()
        existing_company_ids = set(config_model.search([]).mapped("company_id").ids)
        vals_list = [
            {"company_id": company.id, "enabled": False}
            for company in root_companies
            if company.id not in existing_company_ids
        ]
        if vals_list:
            config_model.create(vals_list)
    except Exception:
        _logger.warning("print_gateway post_init_hook skipped default config creation", exc_info=True)


def uninstall_hook(env):
    """Clean up module config parameters and runtime state safely on uninstall.

    Per Odoo 19 official docs, uninstall_hook takes ``(env)`` as its sole argument.
    """
    try:
        icp = env["ir.config_parameter"].sudo()
        params = icp.search([("key", "=like", f"{_CONFIG_PARAM_PREFIX}%")])
        if params:
            params.unlink()
    except Exception:
        _logger.warning("print_gateway uninstall_hook failed to clean ir.config_parameter", exc_info=True)

    try:
        if "print_gateway.agent" in env:
            agents = env["print_gateway.agent"].sudo().with_context(active_test=False).search([])
            if agents:
                agents.write({
                    "token_hash": False,
                    "pairing_code_hash": False,
                    "pairing_expires_at": False,
                    "status": "offline",
                    "active": False,
                })
    except Exception:
        _logger.debug("print_gateway uninstall_hook agent cleanup skipped", exc_info=True)

    try:
        from .models import print_config

        with print_config._VERIFIED_SIG_CACHE_LOCK:
            print_config._VERIFIED_SIG_CACHE.clear()
    except Exception:
        _logger.debug("print_gateway uninstall_hook cache clear skipped", exc_info=True)

    try:
        with env.cr.savepoint():
            env.cr.execute(
                "SELECT pg_notify('print_gateway_license_updated', %s)",
                ("uninstalled",),
            )
    except Exception:
        _logger.debug("print_gateway uninstall_hook pg_notify skipped", exc_info=True)
