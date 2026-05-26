# JupyterHub direct VS Code integration

This repository now supports a JupyterHub deployment mode where a user can choose a VS Code profile and land directly in `code-server`.

## Goals

- Keep the existing standalone `code-server` deployment mode intact
- Add a JupyterHub-native image and launcher path
- Reuse the JupyterHub user server namespace and PVC for GPU execution Pods

## Files added for JupyterHub mode

- `docker/jupyterhub-code-server.Dockerfile`
- `docker/start-jupyterhub-code-server.sh`
- `examples/jupyterhub-profile-values.yaml`
- `examples/jupyterhub-vscode-rbac.yaml`

## Build the JupyterHub image

```bash
docker build \
  -f docker/jupyterhub-code-server.Dockerfile \
  -t your-registry.example.com/gpu-runner-jupyterhub-code-server:latest \
  .
docker push your-registry.example.com/gpu-runner-jupyterhub-code-server:latest
```

## JupyterHub profile wiring

Use `examples/jupyterhub-profile-values.yaml` as the starting point for the VS Code profile.

Important details:

- The profile image must point to the JupyterHub-specific image, not the standalone `code-server` image.
- The profile command must use `/usr/local/bin/start-jupyterhub-code-server.sh`.
- The single-user ServiceAccount must have permission to create, list, get, and delete Pods in the user namespace.
- The extension should run in the same namespace and use the same PVC mount path as the JupyterHub user server.
- No extra hostPath mount is required just to make the extension visible in JupyterHub.

## Why the standalone image is not enough

The original `docker/code-server.Dockerfile` starts `code-server` directly on port `8080`.

JupyterHub expects a single-user server contract that:

- binds to the port provided by JupyterHub
- integrates with JupyterHub authentication and activity updates
- responds through the user service URL and prefix

The JupyterHub image solves that by wrapping `code-server` with `jupyter standaloneproxy`.

## Image behavior

The JupyterHub image intentionally stores the packaged VSIX at `/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix` instead of baking it into `/home/jovyan`.

That matters because many JupyterHub deployments mount a per-user PVC on `/home/jovyan`, which would otherwise hide extensions installed there during the image build.

At container startup the launcher script:

- creates the user-scoped code-server directories if needed
- checks whether `local.gpu-pod-runner` is already installed
- installs the bundled VSIX into the active user extension directory only when it is missing
- starts `code-server` through `jupyter standaloneproxy`

This keeps the image self-contained while remaining compatible with JupyterHub home-directory mounts.

## Runtime expectations inside JupyterHub

The extension no longer assumes `/workspace` is the only valid shared mount.

At runtime it will:

- discover the current Pod namespace
- inspect PVC-backed mounts on the current user server
- prefer an explicit `workspaceMountPath` if it exists
- otherwise prefer `HOME`-aligned mounts such as `/home/jovyan`
- reuse the discovered PVC and ServiceAccount for GPU execution Pods unless the user explicitly overrides them

The bundled launcher script is also compatible with the current `jupyter-server-proxy` standalone CLI and does not rely on unsupported options such as `--ready-check-path`.

## Recommended RBAC model

Apply `examples/jupyterhub-vscode-rbac.yaml` and point the VS Code profile at the `gpu-runner-ide` ServiceAccount.

If your Hub runs in a different namespace, update the namespace fields before applying it.

## Local environment mapping

For the workspace in `/home/ubuntu/taeuk`:

- source checkout: `/home/ubuntu/taeuk/GPU-Pod-Runner`
- active JupyterHub config: `/home/ubuntu/taeuk/jupyterhub/config/values.yaml`

This layout keeps development artifacts and cluster deployment files separated while still being easy to trace.
