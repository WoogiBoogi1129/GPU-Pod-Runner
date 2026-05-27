# GPU Pod Runner

`GPU Pod Runner` is a VS Code Extension that detects when a Python file needs GPU execution and runs it in a Kubernetes GPU execution Pod.

This repository supports two operating modes:

- standalone `code-server` IDE Pod
- JupyterHub direct VS Code single-user Pod

## Core features

- Run the current Python file with `Run File`
- Inspect managed execution Pods with `Show Status`
- Clean up Pods created by the extension with `Cleanup Managed Pods`
- Prefer in-cluster ServiceAccount auth when `authMode=auto`
- Support kubeconfig-based execution
- Auto-discover the current IDE Pod's namespace, ServiceAccount, and PVC-backed workspace mount
- Use whole GPU allocation by default
- Support fractional GPU sharing only when explicitly enabled

## Quick start

### 1. Start with standalone `code-server`

1. Prepare the namespace, RBAC, and shared PVC used by execution Pods.
2. Build the IDE image with `docker/code-server.Dockerfile`.
3. Apply `k8s/rbac.yaml`, `k8s/shared-pvc.yaml`, and `k8s/code-server-ide.yaml` after adapting them to your environment.
4. Open a Python file in VS Code and run `GPU Runner: Run File`.

See [deployment-guide.md](docs/en/deployment-guide.md) for the detailed procedure.

### 2. Start with JupyterHub direct VS Code

1. Wire a VS Code image into a JupyterHub single-user profile.
2. Apply a ServiceAccount and RBAC based on `examples/jupyterhub-vscode-rbac.yaml`.
3. Build the image with `docker/jupyterhub-code-server.Dockerfile`.
4. Log in to JupyterHub with the `VS Code` profile and run `GPU Runner: Run File`.

See [jupyterhub-integration.md](docs/en/jupyterhub-integration.md) for the detailed procedure.

## Required settings example

The example below is the most common configuration baseline.

```json
{
  "gpuRunner.authMode": "auto",
  "gpuRunner.autoDiscoverClusterContext": true,
  "gpuRunner.namespace": "ml-dev",
  "gpuRunner.image": "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
  "gpuRunner.pvcName": "shared-workspace-pvc",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.executionServiceAccountName": "",
  "gpuRunner.enableFractionalGpuSharing": false,
  "gpuRunner.gpuCount": 1,
  "gpuRunner.podTimeoutSeconds": 600
}
```

Key setting behavior:

- `gpuRunner.authMode`
  - `auto`: use in-cluster auth inside a Pod, otherwise use kubeconfig
  - `in-cluster`: always use the current Pod ServiceAccount
  - `kubeconfig`: always use kubeconfig
- `gpuRunner.autoDiscoverClusterContext`
  - auto-discover the current IDE Pod's namespace, ServiceAccount, and PVC-backed workspace mount
- `gpuRunner.enableFractionalGpuSharing`
  - default is `false`
  - `false` uses whole GPU requests based on `nvidia.com/gpu`
  - `true` uses fractional GPU sharing requests based on `nvidia.com/gpumem`
- `gpuRunner.gpuCount`
  - number of GPUs requested in whole GPU mode
  - default is `1`
- `gpuRunner.useHAMi`
  - deprecated alias
  - use `gpuRunner.enableFractionalGpuSharing` instead
- `gpuRunner.apiServerUrl`
  - reserved in the current version and not used

## Documentation map

- [deployment-guide.md](docs/en/deployment-guide.md)
  - standalone `code-server` deployment and minimum validation steps
- [jupyterhub-integration.md](docs/en/jupyterhub-integration.md)
  - operations guide for JupyterHub direct VS Code
- [architecture.md](docs/en/architecture.md)
  - current extension behavior and Pod spec generation flow
- [cluster-portability.md](docs/en/cluster-portability.md)
  - contracts and checks required to move this extension to another cluster
- [troubleshooting.md](docs/en/troubleshooting.md)
  - common operational issues and resolution guidance

## Examples and validation

- [examples/cnn_gpu_smoke_test.py](examples/cnn_gpu_smoke_test.py)
  - example for GPU detection and real execution Pod validation using PyTorch
- [examples/jupyterhub-profile-values.yaml](examples/jupyterhub-profile-values.yaml)
  - JupyterHub single-user profile example
- [examples/jupyterhub-vscode-rbac.yaml](examples/jupyterhub-vscode-rbac.yaml)
  - ServiceAccount and RBAC example for the JupyterHub VS Code profile

## Current behavior contract

- The current command set only includes `Run File`, `Show Status`, and `Cleanup Managed Pods`.
- `Run Selection` and ConfigMap-based selection execution are no longer supported.
- A shared PVC must already exist, and the IDE Pod and execution Pod must see the same file layout.
- In JupyterHub mode, the extension no longer assumes `/workspace` only and can auto-discover `HOME`-aligned PVC mounts such as `/home/jovyan`.
- If a JupyterHub user home PVC is mounted with a `subPath`, the execution Pod must use the same `subPath` for file paths to match.

## Limitations

- Only single-root workspaces are supported.
- Full workspace upload/sync is not provided.
- The extension reads logs after completion instead of streaming them live.
- If auto-discovery cannot find the expected mount, it may fall back to a `HOME`-aligned PVC mount or the first discovered PVC mount.

## Development

```bash
npm install
npm run compile
npm test
```
