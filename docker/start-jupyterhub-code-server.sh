#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-/home/jovyan}"
WORKSPACE_DIR="${CODE_SERVER_WORKSPACE_DIR:-${HOME_DIR}}"
USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-${HOME_DIR}/.local/share/code-server}"
EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-${HOME_DIR}/.local/share/code-server/extensions}"
GPU_POD_RUNNER_VSIX="${GPU_POD_RUNNER_VSIX:-/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix}"
GPU_POD_RUNNER_EXTENSION_ID="${GPU_POD_RUNNER_EXTENSION_ID:-local.gpu-pod-runner}"

mkdir -p "${HOME_DIR}" "${WORKSPACE_DIR}" "${USER_DATA_DIR}" "${EXTENSIONS_DIR}"

# JupyterHub commonly mounts a per-user home PVC at /home/jovyan, which hides
# any extensions baked directly into that path at image build time. Seed the
# extension from an immutable image path so the image stays self-contained.
if [ -f "${GPU_POD_RUNNER_VSIX}" ] \
  && ! code-server --extensions-dir "${EXTENSIONS_DIR}" --list-extensions 2>/dev/null \
    | grep -qx "${GPU_POD_RUNNER_EXTENSION_ID}"; then
  code-server --extensions-dir "${EXTENSIONS_DIR}" --install-extension "${GPU_POD_RUNNER_VSIX}"
fi

exec jupyter standaloneproxy \
  --timeout=30 \
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
