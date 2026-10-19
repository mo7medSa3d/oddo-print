"""Gateway printer permissions, independent of local device health."""


def is_gateway_shared_printer(printer):
    """Accept legacy inventory; explicit/malformed sharing metadata fails closed."""
    return isinstance(printer, dict) and printer.get("sharedWithGateway", True) is True


def inventory_has_shared_printer(body, printer_id):
    """Fresh authenticated inventory must prove the exact primary identity."""
    printers = body.get("printers") if isinstance(body, dict) else None
    if not isinstance(printers, list):
        return False
    for printer in printers:
        if not isinstance(printer, dict) or printer.get("id") != printer_id:
            continue
        agent = printer.get("agent")
        if (printer.get("lifecycle") == "active" and is_gateway_shared_printer(printer)
                and isinstance(agent, dict) and isinstance(agent.get("id"), str) and agent["id"].strip()):
            return True
    return False
