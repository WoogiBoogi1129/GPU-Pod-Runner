# Moving to another cluster

This document explains the contracts that must hold when using `GPU Pod Runner` against another Kubernetes cluster.

## Contracts assumed by the current implementation

The current version does not upload the full workspace.

Instead, the following must all be true:

1. the extension can authenticate to the target cluster
2. the target namespace and permissions required to create execution Pods are already prepared
3. execution Pods can mount a shared workspace PVC
4. the IDE Pod and execution Pod see the same file layout
5. the cluster exposes either `nvidia.com/gpu` or `nvidia.com/gpumem`

## Authentication

The current implementation supports:

- in-cluster ServiceAccount auth
- kubeconfig auth

Runtime behavior:

- `authMode=auto`
  - use in-cluster auth inside a Pod
  - otherwise use kubeconfig
- `authMode=in-cluster`
  - always use the current Pod ServiceAccount
- `authMode=kubeconfig`
  - always use kubeconfig

## Namespace and RBAC

The target cluster must provide at least:

- a namespace where execution Pods are created
- permission to create, inspect, and delete Pods
- permission to read Pod logs
- permission to create `SelfSubjectAccessReview`

In practice that means you need `k8s/rbac.yaml` or an environment-specific variant of it.

## Workspace PVC

The most important contract is that the same file must appear at the same relative path.

Example:

- file opened in the IDE Pod: `/workspace/examples/train.py`
- path expected inside the execution Pod: `/workspace/examples/train.py`

If the PVC layout does not match that expectation, execution fails.

In JupyterHub-style environments where a home PVC is mounted at `/home/jovyan` with a `subPath`, the execution Pod must reuse the same `subPath`.

## GPU resource model

The current implementation supports these resource request models:

- whole GPU
  - `nvidia.com/gpu`
- fractional GPU sharing
  - `nvidia.com/gpumem`

If the cluster uses a different resource key, a code change is required.

Recommended defaults:

- `enableFractionalGpuSharing=false`
- `gpuCount=1`

Only enable fractional GPU sharing when VRAM-based partitioning is actually available.

## Recommended migration sequence

1. Verify kubeconfig or in-cluster auth really works
2. Prepare the target namespace
3. Apply RBAC
4. Prepare the shared PVC
5. Ensure the execution image contains the required Python runtime
6. Validate with a small Python file or [cnn_gpu_smoke_test.py](../../examples/cnn_gpu_smoke_test.py)

## Cases that require code changes

The current implementation may not be sufficient if you need:

- workspace upload/sync without a shared PVC
- different GPU resource keys
- extra Pod spec fields such as:
  - `nodeSelector`
  - `tolerations`
  - `affinity`
  - `imagePullSecrets`
- multi-root workspace support
- live log streaming

## Checklist

- Is kubeconfig or ServiceAccount auth ready?
- Is the namespace correct?
- Does the execution image contain Python and required libraries?
- Is the PVC name correct?
- Is the mount path correct?
- If needed, is the `subPath` also correct?
- Does the cluster expose a GPU resource key supported by the current implementation?
