#!/usr/bin/env bash
set -euo pipefail

# Destructive cleanup for the previous Yasser/Odoo server test only.
# Intentionally does NOT touch /opt/containerd.
#
# What it removes:
#   /opt/printer-repo
#   /opt/Odoo Staging
#   their Compose containers/networks/named volumes
#   old custom images and unused build cache
#
# What it keeps:
#   Docker engine/containerd runtime
#   postgres:16.15-alpine
#   caddy:2.11.4-alpine
#   unrelated running containers

PRINTER_REPO="/opt/printer-repo"
ODOO_STAGING="/opt/Odoo Staging"

echo "== 1. Stop/remove old printer-repo Compose stack =="
if [[ -d "$PRINTER_REPO" && -f "$PRINTER_REPO/docker-compose.yml" ]]; then
  (
    cd "$PRINTER_REPO"
    sudo docker compose down --remove-orphans --volumes || true
  )
else
  echo "printer-repo compose file not found; cleaning by known resource names."
fi

echo "== 2. Stop/remove old Odoo Staging Compose stack =="
if [[ -d "$ODOO_STAGING" && -f "$ODOO_STAGING/docker-compose.yml" ]]; then
  (
    cd "$ODOO_STAGING"
    sudo docker compose down --remove-orphans --volumes || true
  )
else
  echo "Odoo Staging compose file not found; cleaning by known resource names."
fi

echo "== 3. Remove any leftover old containers by name =="
for container in \
  printer-repo-caddy-1 \
  printer-repo-gateway-1 \
  printer-repo-migrate-1 \
  printer-repo-postgres-1 \
  odoostaging-odoo-1 \
  odoostaging-db-1
do
  sudo docker rm -f "$container" 2>/dev/null || true
done

echo "== 4. Remove known old project volumes =="
for volume in   printer-repo_postgres_data   printer-repo_caddy_data   printer-repo_caddy_config   odoostaging_odoo_data
do
  sudo docker volume rm "$volume" 2>/dev/null || true
done

echo "== 5. Remove known old project networks =="
for network in   printer-repo_printer_backend   odoostaging_default
do
  sudo docker network rm "$network" 2>/dev/null || true
done

echo "== 6. Remove old project directories =="
sudo rm -rf -- "$PRINTER_REPO" "$ODOO_STAGING"

echo "== 7. Remove known obsolete images =="
for image in   printer-repo-migrate:latest   printer-repo-gateway:latest   odoostaging-odoo:latest   postgres:17   caddy:2.11.3-alpine
do
  sudo docker image rm "$image" 2>/dev/null || true
done

echo "== 8. Reclaim unused Docker build cache =="
sudo docker builder prune -af

echo
echo "== 9. Verify remaining Docker state =="
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo
sudo docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
echo
sudo docker volume ls
echo
sudo docker network ls
echo
echo "IMPORTANT: /opt/containerd was NOT deleted."
echo "Next step: from the Yasser repository root run:"
echo "  bash deploy/http-test/setup-http-test.sh"
