#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-/home/jovyan}"
WORKSPACE_DIR="${CODE_SERVER_WORKSPACE_DIR:-${HOME_DIR}}"
USER_DATA_DIR="${CODE_SERVER_USER_DATA_DIR:-${HOME_DIR}/.local/share/code-server}"
EXTENSIONS_DIR="${CODE_SERVER_EXTENSIONS_DIR:-${HOME_DIR}/.local/share/code-server/extensions}"
GPU_POD_RUNNER_VSIX="${GPU_POD_RUNNER_VSIX:-/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix}"
GPU_POD_RUNNER_EXTENSION_ID="${GPU_POD_RUNNER_EXTENSION_ID:-local.gpu-pod-runner}"

mkdir -p "${HOME_DIR}" "${WORKSPACE_DIR}" "${USER_DATA_DIR}" "${EXTENSIONS_DIR}"

gpu_pod_runner_vsix_version() {
  python3 - "${GPU_POD_RUNNER_VSIX}" <<'PY'
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as vsix:
    print(json.loads(vsix.read("extension/package.json"))["version"])
PY
}

gpu_pod_runner_installed_version() {
  local listed_version
  listed_version="$(
    code-server --extensions-dir "${EXTENSIONS_DIR}" --list-extensions --show-versions 2>/dev/null \
      | awk -F@ -v id="${GPU_POD_RUNNER_EXTENSION_ID}" '$1 == id { print $2; exit }'
  )"
  if [ -n "${listed_version}" ]; then
    printf '%s\n' "${listed_version}"
    return
  fi

  find "${EXTENSIONS_DIR}" \
    -mindepth 2 \
    -maxdepth 2 \
    -path "${EXTENSIONS_DIR}/${GPU_POD_RUNNER_EXTENSION_ID}-*/package.json" \
    -print \
    | sort -V \
    | tail -n 1 \
    | xargs -r python3 -c 'import json, pathlib, sys; print(json.loads(pathlib.Path(sys.argv[1]).read_text()).get("version", ""))'
}

gpu_pod_runner_extension_dir_exists() {
  find "${EXTENSIONS_DIR}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name "${GPU_POD_RUNNER_EXTENSION_ID}-*" \
    | grep -q .
}

gpu_pod_runner_extension_listed() {
  code-server --extensions-dir "${EXTENSIONS_DIR}" --list-extensions 2>/dev/null \
    | grep -qx "${GPU_POD_RUNNER_EXTENSION_ID}"
}

# JupyterHub commonly mounts a per-user home PVC at /home/jovyan, which hides
# any extensions baked directly into that path at image build time. Seed the
# extension from an immutable image path so the image stays self-contained. The
# directory and version checks repair stale entries left on persistent homes.
if [ -f "${GPU_POD_RUNNER_VSIX}" ] \
  && { ! gpu_pod_runner_extension_listed \
    || ! gpu_pod_runner_extension_dir_exists \
    || [ "$(gpu_pod_runner_installed_version)" != "$(gpu_pod_runner_vsix_version)" ]; }; then
  code-server --extensions-dir "${EXTENSIONS_DIR}" --uninstall-extension "${GPU_POD_RUNNER_EXTENSION_ID}" || true
  code-server --extensions-dir "${EXTENSIONS_DIR}" --install-extension "${GPU_POD_RUNNER_VSIX}" --force
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
