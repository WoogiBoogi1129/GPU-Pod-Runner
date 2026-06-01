# GPU Pod Runner architecture

This document explains, based on the current implementation, how `GPU Pod Runner` turns editor input into a Kubernetes execution Pod spec.

## Components

The core modules are:

- `src/extension.ts`
  - command registration, orchestration, output channel logging
- `src/config.ts`
  - loading `gpuRunner.*` settings
- `src/gpuDetector.ts`
  - detecting GPU-oriented patterns in Python code
- `src/runnerDecisions.ts`
  - deciding between local execution, GPU execution, or prompting
- `src/podManager.ts`
  - Kubernetes auth, current IDE Pod context discovery, execution Pod creation/wait/log/delete
- `src/statusBar.ts`
  - status bar and status panel UI

## High-level flow

```text
User runs a command
  -> extension.ts checks the active file and settings
  -> gpuDetector.ts detects GPU-related patterns
  -> runnerDecisions.ts decides the execution mode
  -> if GPU execution is selected, podManager.ts prepares Kubernetes context
  -> namespace / PVC / ServiceAccount are auto-discovered from the current IDE Pod
  -> an execution Pod manifest is created
  -> the extension waits for Pod completion
  -> logs are collected
  -> the Pod is deleted
```

## Contract from settings to Pod spec

These settings directly affect execution Pod creation:

- `gpuRunner.namespace`
  - namespace where the Pod is created
- `gpuRunner.image`
  - execution container image
- `gpuRunner.pvcName`
  - workspace PVC name mounted into the execution Pod
- `gpuRunner.workspaceMountPath`
  - mount path inside the execution Pod
- `gpuRunner.executionServiceAccountName`
  - ServiceAccount used by the execution Pod
- `gpuRunner.enableFractionalGpuSharing`
  - selects the GPU resource key
- `gpuRunner.gpuCount`
  - number of GPUs requested in whole GPU mode
- `gpuRunner.gpuMemoryMB`
  - memory requested in fractional GPU sharing mode

## `Run File` path mapping

`Run File` does not copy an absolute local path directly into the Pod.

It works like this:

1. Check that the active file is inside the current workspace
2. Compute the relative path from the workspace root
3. Join that relative path under `workspaceMountPath` to create the Pod-side execution path

Example:

- workspace root: `/home/jovyan`
- file path: `/home/jovyan/examples/train.py`
- execution Pod path: `/home/jovyan/examples/train.py`

Because of this contract, the IDE Pod and the execution Pod must share the same file layout.

## Kubernetes authentication

`podManager.ts` chooses an auth strategy with this precedence:

- `authMode=in-cluster`
  - always use the Pod's ServiceAccount
- `authMode=kubeconfig`
  - always use kubeconfig
- `authMode=auto`
  - use in-cluster auth when running inside a Pod
  - otherwise use `gpuRunner.kubeconfigPath` or `~/.kube/config`

In the current version, `gpuRunner.apiServerUrl` is reserved and unused.

## Auto-discovery of the current IDE Pod context

Auto-discovery works best when the extension runs inside the current IDE Pod.

It tries to discover:

- namespace
- current IDE Pod name
- current ServiceAccount name
- PVC-backed workspace mount

For PVC-backed mount discovery:

- prefer an explicit `workspaceMountPath` if it exists
- otherwise prefer a `HOME`-aligned mount
- otherwise fall back to `/workspace` or the first discovered PVC mount

## Why JupyterHub is special

JupyterHub often mounts a user home PVC at `/home/jovyan` together with a `subPath`.

Example:

- PVC name: `jupyterhub-singleuser-pvc`
- mount path: `/home/jovyan`
- subPath: `user1`

In this case, the execution Pod must use the same `pvcName`, the same `mountPath`, and the same `subPath` so that `/home/jovyan/test.py` points to the same file.

The current implementation auto-discovers this `workspaceSubPath` and applies it to the execution Pod `volumeMount.subPath`.

## Shape of the execution Pod spec

The current execution Pod has these core characteristics:

- namespace: the current or configured namespace
- restartPolicy: `Never`
- serviceAccountName: auto-discovered or explicitly configured
- volumes:
  - one workspace PVC
- volumeMounts:
  - `workspaceMountPath`
  - `workspaceSubPath` when needed
- command:
  - `python <podScriptPath>`
- workingDir:
  - `workspaceMountPath`

GPU resource requests:

- whole GPU mode
  - `nvidia.com/gpu: <gpuCount>`
- fractional GPU sharing mode
  - `nvidia.com/gpumem: <gpuMemoryMB>`

## Permission checks

At initialization the extension uses `SelfSubjectAccessReview` to check:

- `pods`: `get`, `list`, `create`, `delete`
- `pods/log`: `get`

Missing permissions do not immediately block execution, but warnings are surfaced through the output channel and UI.

## Features outside the current scope

The current version does not include:

- `Run Selection`
- ConfigMap-based code packaging execution
- full workspace upload/sync
- multi-root workspace support
- live log streaming
