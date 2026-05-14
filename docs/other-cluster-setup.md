# Running GPU Pod Runner on Another Cluster

This guide explains what must be prepared when you want to use the extension against a different Kubernetes cluster.

## What the extension assumes

The current v1 implementation does not upload your full workspace into the cluster.

Instead, it assumes all of the following are true:

1. VS Code can reach the target cluster through the kubeconfig selected by `gpuRunner.kubeconfigPath`.
2. The target namespace already contains the ServiceAccount, Role, RoleBinding, and PVC used by the extension.
3. The Pod can mount a shared workspace PVC at `gpuRunner.workspaceMountPath`.
4. The mounted workspace inside the Pod has the same directory layout as the local workspace for `Run File`.
5. The cluster exposes NVIDIA GPU resources as either `nvidia.com/gpu` or HAMi `nvidia.com/gpumem`.

These assumptions come directly from the current implementation:

- kubeconfig is loaded from `gpuRunner.kubeconfigPath` or `~/.kube/config`: [src/podManager.ts](/C:/GPU-Pod-Runner/src/podManager.ts:226)
- Pods are always created in `gpuRunner.namespace`: [src/config.ts](/C:/GPU-Pod-Runner/src/config.ts:24)
- the workspace PVC name is taken from `gpuRunner.pvcName`: [src/config.ts](/C:/GPU-Pod-Runner/src/config.ts:29)
- the Pod always mounts that PVC and runs the script from the mounted path: [src/podManager.ts](/C:/GPU-Pod-Runner/src/podManager.ts:150)
- the ServiceAccount name is fixed to `gpu-runner-sa`: [src/podManager.ts](/C:/GPU-Pod-Runner/src/podManager.ts:16)
- GPU resource requests are hard-coded to `nvidia.com/gpu` or `nvidia.com/gpumem`: [src/podManager.ts](/C:/GPU-Pod-Runner/src/podManager.ts:101)

## Minimum setup on the new cluster

### 1. Prepare the namespace and RBAC

Apply or adapt [k8s/rbac.yaml](/C:/GPU-Pod-Runner/k8s/rbac.yaml) so that the target namespace contains:

- `gpu-runner-sa`
- a Role that can `get/list/watch/create/delete` Pods and ConfigMaps
- permission to read `pods/log`

Important:

- The namespace in the manifest must match `gpuRunner.namespace`.
- If you change the ServiceAccount name in the manifest only, the extension will still fail because the code always sets `serviceAccountName: gpu-runner-sa`.

### 2. Prepare a shared workspace PVC

Apply or adapt [k8s/shared-pvc.yaml](/C:/GPU-Pod-Runner/k8s/shared-pvc.yaml).

Requirements:

- The PVC must exist in the same namespace as the Pod.
- The claim name must match `gpuRunner.pvcName`.
- The storage class must support `ReadWriteMany` if multiple nodes or remote mounting are involved.
- The mounted contents must contain the same project tree that you opened in VS Code when using `Run File`.

### 3. Ensure the workspace path matches

For `Run File`, the extension converts the local file path to a relative path under the current workspace and then joins it to `gpuRunner.workspaceMountPath`: [src/podManager.ts](/C:/GPU-Pod-Runner/src/podManager.ts:53)

Example:

- local workspace root: `C:\projects\my-train`
- local file: `C:\projects\my-train\examples\train.py`
- `gpuRunner.workspaceMountPath`: `/workspace`
- expected file inside Pod: `/workspace/examples/train.py`

If the PVC contains `/workspace/my-train/examples/train.py` instead, `Run File` will fail because the extension will still try `/workspace/examples/train.py`.

### 4. Use an image that already contains your runtime

The extension only sets:

- image
- command: `python <script>`
- working directory
- volume mounts
- GPU resources

It does not install packages on the fly.

So the image referenced by `gpuRunner.image` must already include:

- Python
- your framework such as PyTorch or TensorFlow
- any extra libraries your project imports

### 5. Match the cluster GPU resource model

The code supports only two resource request styles:

- standard NVIDIA device plugin: `nvidia.com/gpu`
- HAMi fractional GPU memory: `nvidia.com/gpumem`

If the new cluster uses a different resource key or a non-NVIDIA accelerator model, the extension will need a code change before it can schedule Pods successfully.

## Recommended migration procedure

1. Add a kubeconfig entry for the new cluster and verify it works with `kubectl --context <context> get ns`.
2. Create the target namespace.
3. Apply adapted RBAC and PVC manifests to that namespace.
4. Make the project files available in the shared PVC at the same relative layout expected by the extension.
5. Set extension settings for the new cluster.
6. Run a small script first with `GPU Runner: Run Selection`.
7. After that works, test `GPU Runner: Run File` with `examples/cnn_gpu_smoke_test.py` or another small script.

`Run Selection` is useful as a first smoke test because it uploads only the selected snippet through a ConfigMap, so it is less sensitive to PVC path mistakes. `Run File` is the real validation that your shared workspace layout is correct.

## Example settings for another cluster

```json
{
  "gpuRunner.namespace": "team-a-gpu",
  "gpuRunner.image": "my-registry.example.com/ml/pytorch:cuda12.1",
  "gpuRunner.useHAMi": false,
  "gpuRunner.gpuCount": 1,
  "gpuRunner.pvcName": "team-a-workspace",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.kubeconfigPath": "C:\\Users\\USER\\.kube\\team-a-config",
  "gpuRunner.autoDetectPrompt": "always-ask"
}
```

## Troubleshooting checklist

- `Kubeconfig not found`: check `gpuRunner.kubeconfigPath` or the default `~/.kube/config`.
- Pod creation fails with RBAC errors: re-check namespace, ServiceAccount, Role, and RoleBinding.
- Pod starts but Python says file not found: the PVC layout does not match the local workspace layout.
- Pod stays Pending: GPU resources, node selectors, image pull, or PVC binding are not ready in the target cluster.
- Imports fail inside the container: the image does not contain your Python dependencies.
- `Run Selection` works but `Run File` fails: this almost always means the shared workspace mapping is wrong, not the Kubernetes API access.

## When code changes are needed

You can reuse the extension as-is for another cluster if the new environment still matches the current contract.

You will likely need code changes if you want any of the following:

- automatic upload or sync of the full local workspace without a shared PVC
- support for non-NVIDIA GPU resource keys
- a different fixed ServiceAccount name
- extra Pod spec fields such as `nodeSelector`, `tolerations`, `affinity`, or image pull secrets
- multi-root workspace support
