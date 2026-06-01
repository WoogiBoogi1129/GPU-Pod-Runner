# Troubleshooting guide

This document summarizes the operational issues that have come up most often while using `GPU Pod Runner`.

## 1. The GPU Pod Runner extension is missing inside VS Code

Possible causes:

- a JupyterHub home PVC mounted on `/home/jovyan` hides extensions installed there at image build time
- the user extension cache is stale
- the extension is still listed, but the unpacked extension directory is missing

Current mitigation:

- the JupyterHub image stores the VSIX at `/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix`
- the launcher inspects the user extension directory at startup
- the launcher reinstalls when the extension is missing, the directory is missing, or the installed version differs

What to check:

- whether the single-user Pod logs show uninstall/install messages
- whether `code-server --list-extensions --show-versions` shows `local.gpu-pod-runner`

## 2. `GPU Runner is not initialized.`

Possible causes:

- the extension host did not actually load the extension
- stale extension cache prevented the bundled VSIX from taking effect
- Kubernetes initialization failed during auth or permission checks

What to check:

- whether the output channel shows the Kubernetes auth mode and warnings
- whether the installed extension version matches the expected version
- whether the launcher actually reinstalled the bundled VSIX

## 3. `python: can't open file '/home/jovyan/test.py'`

Typical cause:

- the execution Pod mounted the same workspace PVC but did not reuse the JupyterHub home `subPath`

Typical situation:

- IDE Pod
  - PVC: `jupyterhub-singleuser-pvc`
  - mount path: `/home/jovyan`
  - subPath: `user1`
- execution Pod
  - mounts the same PVC at `/home/jovyan`
  - but omits `subPath`

In that case, `/home/jovyan/test.py` in the IDE Pod is really `user1/test.py` at the PVC root, so the execution Pod must use the same `subPath`.

The current implementation auto-discovers `workspaceSubPath` and applies it to the execution Pod `volumeMount.subPath`.

## 4. `/api` timeout during spawn or VS Code does not open

Possible causes:

- the standalone `code-server` image was connected directly to JupyterHub
- the launcher is not satisfying the JupyterHub single-user contract
- `jupyter standaloneproxy` is not being used

What to check:

- whether the JupyterHub profile image is built from `docker/jupyterhub-code-server.Dockerfile`
- whether the profile `cmd` is `/usr/local/bin/start-jupyterhub-code-server.sh`

## 5. Image pull authentication failure

Possible causes:

- private registry or Docker Hub credentials are missing
- a new tag is being pulled for the first time and is not already cached on the node

What to check:

- whether an imagePullSecret exists in the namespace
- whether the single-user ServiceAccount references that secret
- whether older tags only appeared to work because they were already cached on the node

## 6. Execution Pod creation failure or RBAC warnings

Possible causes:

- the current ServiceAccount lacks Pod create/get/delete permissions
- `pods/log` permission is missing
- `SelfSubjectAccessReview` creation permission is missing

What to check:

- whether `examples/jupyterhub-vscode-rbac.yaml` or `k8s/rbac.yaml` was adapted and applied correctly
- permission warning messages in the extension output channel

## 7. Pending Pods or scheduling failures related to GPU resources

Possible causes:

- the cluster does not expose `nvidia.com/gpu`
- `nvidia.com/gpumem` is requested in an environment where fractional GPU sharing should remain disabled
- GPU count or memory requests do not match cluster policy

Recommended defaults:

- `gpuRunner.enableFractionalGpuSharing=false`
- `gpuRunner.gpuCount=1`

In environments such as KAI-Scheduler where only whole GPU allocation is available, keep those defaults.

## 8. The file exists, but the execution path is still wrong

Possible causes:

- the IDE Pod and execution Pod use different workspace roots
- the shared PVC directory layout does not match the workspace-relative path expected by the extension

Important detail:

`Run File` converts the current file path into a workspace-relative path and then joins it under `workspaceMountPath`.

That means the file opened in the IDE Pod and the file seen by the execution Pod must have the same relative path.

## Fast diagnosis order

1. Inspect the extension output channel
2. Check the effective namespace, PVC, and ServiceAccount
3. Inspect the single-user Pod's PVC mount path and `subPath`
4. Inspect execution Pod events and logs
5. Verify the execution image contains the expected Python runtime and dependencies
