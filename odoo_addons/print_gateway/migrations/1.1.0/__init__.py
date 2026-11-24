"""Migration 1.1.0 for print_gateway.

Canonical migration entrypoint for upgrading pre-1.1.0 databases:
- Enforces PCL deprecation safety guard
- Backfills agent_id, device_class, and lifecycle fields
- Establishes unique constraints and cleans up obsolete schema columns
"""
