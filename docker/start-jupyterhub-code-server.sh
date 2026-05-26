#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-/home/jovyan}"
WORKSPACE_DIR="${CODE_SERVER_WORKSPACE_DIR:-${HOME_DIR}}"
USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-${HOME_DIR}/.local/share/code-server}"
EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-${HOME_DIR}/.local/share/code-server/extensions}"

mkdir -p "${HOME_DIR}" "${WORKSPACE_DIR}" "${USER_DATA_DIR}" "${EXTENSIONS_DIR}"

exec jupyter standaloneproxy \
  --destport 0 \
  --ready-check-path=/healthz \
  -- \
  code-server \
  --auth none \
  --disable-telemetry \
  --disable-update-check \
  --user-data-dir "${USER_DATA_DIR}" \
  --extensions-dir "${EXTENSIONS_DIR}" \
  --bind-addr "127.0.0.1:{port}" \
  --abs-proxy-base-path "{base_url}" \
  "${WORKSPACE_DIR}"
