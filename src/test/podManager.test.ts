import test from "node:test";
import assert from "node:assert/strict";
import type { V1Pod } from "@kubernetes/client-node";
import type { GPURunnerConfig } from "../config";
import {
  applyAutoDiscoveredContext,
  buildGpuResourceRequirements,
  buildPodManifest,
  buildSelectionConfigMapManifest,
  discoverPersistentVolumeClaimName,
  mapWorkspaceFileToPodPath,
  normalizeKubeApiServerUrl,
  resolveAuthStrategy,
  type SelectionTarget,
  type WorkspaceFileTarget
} from "../podManager";

const baseConfig: GPURunnerConfig = {
  namespace: "ml-dev",
  image: "image:latest",
  useHAMi: false,
  gpuMemoryMB: 8000,
  gpuCount: 1,
  pvcName: "shared-workspace-pvc",
  workspaceMountPath: "/workspace",
  podTimeoutSeconds: 600,
  autoDetect: true,
  autoDetectPrompt: "always-ask",
  kubeconfigPath: "",
  authMode: "auto",
  autoDiscoverClusterContext: true,
  executionServiceAccountName: "",
  apiServerUrl: "",
  manualOverrides: {
    namespace: false,
    pvcName: false,
    workspaceMountPath: false,
    kubeconfigPath: false,
    authMode: false,
    autoDiscoverClusterContext: false,
    executionServiceAccountName: false
  }
};

test("maps workspace files into pod workspace paths", () => {
  const podPath = mapWorkspaceFileToPodPath(
    "C:\\GPU-Pod-Runner",
    "C:\\GPU-Pod-Runner\\examples\\train.py",
    "/workspace"
  );

  assert.equal(podPath, "/workspace/examples/train.py");
});

test("builds whole GPU resource requirements when HAMi is disabled", () => {
  const resources = buildGpuResourceRequirements(baseConfig);

  assert.equal(resources.limits?.["nvidia.com/gpu"], "1");
  assert.equal(resources.requests?.["nvidia.com/gpu"], "1");
});

test("builds HAMi GPU memory resource requirements when enabled", () => {
  const resources = buildGpuResourceRequirements({
    ...baseConfig,
    useHAMi: true,
    gpuMemoryMB: 12000
  });

  assert.equal(resources.limits?.["nvidia.com/gpumem"], "12000");
  assert.equal(resources.requests?.["nvidia.com/gpumem"], "12000");
});

test("rewrites loopback kube API servers to the TLS server name", () => {
  const normalized = normalizeKubeApiServerUrl("https://127.0.0.1:6443", "172.168.28.244");

  assert.equal(normalized, "https://172.168.28.244:6443");
});

test("keeps non-loopback kube API servers unchanged", () => {
  const normalized = normalizeKubeApiServerUrl("https://10.96.0.1:6443", "172.168.28.244");

  assert.equal(normalized, "https://10.96.0.1:6443");
});

test("prefers in-cluster auth in auto mode when the extension runs inside a pod", () => {
  assert.equal(resolveAuthStrategy("auto", true), "in-cluster");
});

test("falls back to kubeconfig auth in auto mode outside the cluster", () => {
  assert.equal(resolveAuthStrategy("auto", false), "kubeconfig");
});

test("applies auto-discovered namespace, PVC, and service account when no manual override exists", () => {
  const resolved = applyAutoDiscoveredContext(baseConfig, {
    namespace: "team-a",
    pvcName: "workspace-a",
    currentServiceAccountName: "ide-runner",
    warnings: []
  });

  assert.equal(resolved.namespace, "team-a");
  assert.equal(resolved.pvcName, "workspace-a");
  assert.equal(resolved.executionServiceAccountName, "ide-runner");
});

test("keeps manually configured values ahead of auto-discovered context", () => {
  const resolved = applyAutoDiscoveredContext(
    {
      ...baseConfig,
      namespace: "manual-ns",
      pvcName: "manual-pvc",
      executionServiceAccountName: "manual-sa",
      manualOverrides: {
        ...baseConfig.manualOverrides,
        namespace: true,
        pvcName: true,
        executionServiceAccountName: true
      }
    },
    {
      namespace: "auto-ns",
      pvcName: "auto-pvc",
      currentServiceAccountName: "auto-sa",
      warnings: []
    }
  );

  assert.equal(resolved.namespace, "manual-ns");
  assert.equal(resolved.pvcName, "manual-pvc");
  assert.equal(resolved.executionServiceAccountName, "manual-sa");
});

test("discovers the workspace PVC from the current IDE Pod", () => {
  const pod: V1Pod = {
    spec: {
      containers: [
        {
          name: "code-server",
          volumeMounts: [
            {
              name: "workspace",
              mountPath: "/workspace"
            }
          ]
        }
      ],
      volumes: [
        {
          name: "workspace",
          persistentVolumeClaim: {
            claimName: "shared-workspace-pvc"
          }
        }
      ]
    }
  };

  assert.equal(discoverPersistentVolumeClaimName(pod, "/workspace"), "shared-workspace-pvc");
});

test("builds pod manifests for workspace files with an execution service account", () => {
  const target: WorkspaceFileTarget = {
    kind: "workspace-file",
    sourcePath: "C:\\GPU-Pod-Runner\\train.py",
    displayName: "train.py",
    podScriptPath: "/workspace/train.py"
  };

  const manifest = buildPodManifest(
    {
      ...baseConfig,
      executionServiceAccountName: "ide-runner"
    },
    target,
    "gpu-train-abc12",
    "ml-dev"
  );

  assert.equal(manifest.spec?.serviceAccountName, "ide-runner");
  assert.equal(manifest.spec?.restartPolicy, "Never");
  assert.equal(manifest.spec?.containers?.[0].command?.[1], "/workspace/train.py");
});

test("builds ConfigMap-backed pod manifests for selections", () => {
  const target: SelectionTarget = {
    kind: "selection",
    code: "print('hello')",
    sourcePath: "C:\\GPU-Pod-Runner\\train.py",
    displayName: "train-selection",
    podScriptPath: "/opt/gpu-runner/selection.py"
  };

  const configMap = buildSelectionConfigMapManifest("ml-dev", "gpu-train-abc12-cm", target);
  const manifest = buildPodManifest(baseConfig, target, "gpu-train-abc12", "ml-dev", "gpu-train-abc12-cm");

  assert.equal(configMap.data?.["selection.py"], "print('hello')");
  assert.ok(manifest.spec?.volumes?.some((volume) => volume.name === "selection-script"));
  assert.ok(manifest.spec?.containers?.[0].volumeMounts?.some((mount) => mount.mountPath === "/opt/gpu-runner"));
});
