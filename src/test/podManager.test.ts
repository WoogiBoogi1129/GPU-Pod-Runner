import test from "node:test";
import assert from "node:assert/strict";
import type { GPURunnerConfig } from "../config";
import {
  buildGpuResourceRequirements,
  buildPodManifest,
  buildSelectionConfigMapManifest,
  mapWorkspaceFileToPodPath,
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
  apiServerUrl: ""
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

test("builds pod manifests for workspace files", () => {
  const target: WorkspaceFileTarget = {
    kind: "workspace-file",
    sourcePath: "C:\\GPU-Pod-Runner\\train.py",
    displayName: "train.py",
    podScriptPath: "/workspace/train.py"
  };

  const manifest = buildPodManifest(baseConfig, target, "gpu-train-abc12", "ml-dev");

  assert.equal(manifest.spec?.serviceAccountName, "gpu-runner-sa");
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
