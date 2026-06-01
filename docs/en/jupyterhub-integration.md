# JupyterHub direct VS Code operations guide

This document explains how to let a JupyterHub user choose a `VS Code` profile, land directly in `code-server`, and run GPU execution Pods with `GPU Pod Runner`.

## Goals

- keep the existing standalone `code-server` flow intact
- provide a VS Code image that satisfies the JupyterHub single-user contract
- reuse the current user server's namespace and PVC context for execution Pods

## Relevant files

- JupyterHub image Dockerfile: `docker/jupyterhub-code-server.Dockerfile`
- launcher script: `docker/start-jupyterhub-code-server.sh`
- profile example: `examples/jupyterhub-profile-values.yaml`
- RBAC example: `examples/jupyterhub-vscode-rbac.yaml`

## Why a dedicated JupyterHub image is required

The standalone image in `docker/code-server.Dockerfile` is meant to launch `code-server` directly.

A JupyterHub single-user server must:

- respond on the service port expected by JupyterHub
- honor the user's base URL and service prefix
- report activity back to JupyterHub

To satisfy that contract, the JupyterHub-specific image wraps `code-server` with `jupyter standaloneproxy`.

## Build the image

```bash
docker build \
  -f docker/jupyterhub-code-server.Dockerfile \
  -t your-registry.example.com/gpu-runner-jupyterhub-code-server:latest \
  .

docker push your-registry.example.com/gpu-runner-jupyterhub-code-server:latest
```

## Wire the JupyterHub profile

Use `examples/jupyterhub-profile-values.yaml` as the starting point.

Important points:

- the VS Code profile image must use the JupyterHub-specific image
- `cmd` must use `/usr/local/bin/start-jupyterhub-code-server.sh`
- the single-user Pod ServiceAccount must be allowed to create, inspect, delete, and read logs from execution Pods

## VSIX installation strategy

JupyterHub commonly mounts a user home PVC at `/home/jovyan`.

If the extension is preinstalled directly under `/home/jovyan` at image build time, that installation can be hidden when the PVC is mounted at runtime.

The current image avoids that by:

- storing the VSIX at `/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix`
- installing it into the user-specific code-server extension directory at container startup
- reinstalling when the installed version does not match
- repairing stale extension cache or missing unpacked extension directories

This keeps the image self-contained even when JupyterHub mounts a persistent home directory.

## PVC mount and execution Pod path consistency

The most important operational point in JupyterHub mode is file path consistency.

Example user Pod:

- PVC: `jupyterhub-singleuser-pvc`
- mount path: `/home/jovyan`
- subPath: `user1`

The user sees `/home/jovyan/test.py`, but at the PVC root that file is really `user1/test.py`.

Because of that, the execution Pod must reuse all three values:

- the same PVC name
- the same mount path
- the same `subPath`

The current implementation inspects PVC-backed mounts on the IDE Pod, reads the `subPath`, and applies it to the execution Pod `volumeMount.subPath`.

## Recommended RBAC model

Apply `examples/jupyterhub-vscode-rbac.yaml` as the baseline.

Required permissions:

- `pods`: `get`, `list`, `watch`, `create`, `delete`
- `pods/log`: `get`
- `selfsubjectaccessreviews`: `create`

Before applying it, confirm:

- the namespace matches the actual Hub namespace
- the ServiceAccount name used by the profile matches the RBAC subject

## Minimum validation flow

1. Build and push the JupyterHub-specific image
2. Point the VS Code profile image at the new image
3. Apply RBAC and the ServiceAccount
4. Log in to JupyterHub as a normal user
5. Select the `VS Code` profile
6. Confirm VS Code opens directly
7. Open [cnn_gpu_smoke_test.py](../../examples/cnn_gpu_smoke_test.py) or a small Python file
8. Run `GPU Runner: Run File`
9. Confirm the execution Pod is created in the same namespace
10. Confirm the execution Pod sees the same file and completes successfully

## Common failure points

- the extension does not appear
  - the user PVC still contains stale extension cache, or the launcher needs to reinstall the extension
- image pull failure
  - registry credentials are missing
- `/api` timeout
  - the single-user launcher is not satisfying the JupyterHub contract
- `python: can't open file '/home/jovyan/test.py'`
  - the execution Pod is not reusing the home PVC `subPath`

See [troubleshooting.md](troubleshooting.md) for detailed resolution steps.
