# standalone `code-server` deployment guide

This document describes the baseline operational flow for deploying a standalone `code-server` IDE Pod together with the `GPU Pod Runner` extension.

## Prerequisites

- Kubernetes cluster access
- `kubectl` available
- ability to build images and push to a registry
- ability to prepare a shared PVC for execution Pods
- GPU nodes exposing `nvidia.com/gpu` or `nvidia.com/gpumem`

## Deployment artifacts

- IDE image Dockerfile: `docker/code-server.Dockerfile`
- RBAC example: `k8s/rbac.yaml`
- shared PVC example: `k8s/shared-pvc.yaml`
- standalone IDE Pod example: `k8s/code-server-ide.yaml`

## 1. Build the IDE image

```bash
docker build \
  -f docker/code-server.Dockerfile \
  -t your-registry.example.com/gpu-runner-code-server:latest \
  .

docker push your-registry.example.com/gpu-runner-code-server:latest
```

This image packages both `code-server` and the `GPU Pod Runner` extension.

## 2. Prepare namespace, RBAC, and PVC

Adapt the manifests to your environment, then apply them:

```bash
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/shared-pvc.yaml
```

Required conditions:

- the execution namespace must already exist
- the PVC name must match `gpuRunner.pvcName`
- the file layout inside the PVC must match what both the IDE Pod and execution Pod expect

## 3. Deploy the IDE Pod

In `k8s/code-server-ide.yaml`, update these values as needed:

- IDE image reference
- namespace
- PVC name
- ServiceAccount name, if required

Apply it:

```bash
kubectl apply -f k8s/code-server-ide.yaml
```

## 4. Verify VS Code settings

A minimal baseline configuration looks like this:

```json
{
  "gpuRunner.authMode": "auto",
  "gpuRunner.autoDiscoverClusterContext": true,
  "gpuRunner.namespace": "ml-dev",
  "gpuRunner.image": "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
  "gpuRunner.pvcName": "shared-workspace-pvc",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.enableFractionalGpuSharing": false,
  "gpuRunner.gpuCount": 1
}
```

Operational defaults:

- `enableFractionalGpuSharing=false`
- `gpuCount=1`

Only enable fractional GPU sharing when the cluster actually supports it.

## 5. Minimum validation flow

1. Confirm the IDE Pod is running
2. Confirm the workspace PVC is mounted into the IDE Pod
3. Confirm the `GPU Pod Runner` extension is installed
4. Open [cnn_gpu_smoke_test.py](../../examples/cnn_gpu_smoke_test.py)
5. Run `GPU Runner: Run File`
6. Confirm an execution Pod is created and logs are returned successfully

## Three conditions that must all hold

Execution succeeds only when all of the following are true:

- the current identity can create execution Pods
- the execution image already contains Python and required libraries
- the PVC file layout is identical between the IDE Pod and the execution Pod

If the file layout differs, Python will fail with `No such file or directory`.

## Next documents

- For JupyterHub, see [jupyterhub-integration.md](jupyterhub-integration.md)
- For another cluster, see [cluster-portability.md](cluster-portability.md)
- For operational issues, see [troubleshooting.md](troubleshooting.md)
