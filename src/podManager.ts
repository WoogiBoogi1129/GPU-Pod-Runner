import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as k8s from "@kubernetes/client-node";
import type { GPURunnerConfig } from "./config";

const MANAGED_BY_LABEL_KEY = "managed-by";
const MANAGED_BY_LABEL_VALUE = "vscode-gpu-runner";
const CONFIGMAP_ANNOTATION_KEY = "gpu-runner/configmap-name";
const EXECUTION_KIND_ANNOTATION_KEY = "gpu-runner/execution-kind";
const SOURCE_PATH_ANNOTATION_KEY = "gpu-runner/source-path";
const SELECTION_VOLUME_NAME = "selection-script";
const SELECTION_MOUNT_PATH = "/opt/gpu-runner";
const SELECTION_FILE_NAME = "selection.py";
const SERVICE_ACCOUNT_NAME = "gpu-runner-sa";

export interface WorkspaceFileTarget {
  kind: "workspace-file";
  sourcePath: string;
  podScriptPath: string;
  displayName: string;
}

export interface SelectionTarget {
  kind: "selection";
  sourcePath: string;
  podScriptPath: string;
  displayName: string;
  code: string;
}

export type ExecutionTarget = WorkspaceFileTarget | SelectionTarget;

export interface ManagedPodRun {
  podName: string;
  namespace: string;
  configMapName?: string;
}

export interface ManagedPodSummary {
  name: string;
  phase: string;
  createdAt?: string;
  executionKind?: string;
  sourcePath?: string;
}

export function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join(path.posix.sep);
}

export function mapWorkspaceFileToPodPath(
  workspaceRoot: string,
  filePath: string,
  workspaceMountPath: string
): string {
  const relativePath = path.relative(workspaceRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The selected file must live inside the current workspace.");
  }

  return path.posix.join(workspaceMountPath, toPosixPath(relativePath));
}

export function buildManagedPodName(sourceName: string): string {
  const baseName = path.parse(sourceName).name.toLowerCase();
  const sanitized = baseName.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const randomSuffix = Math.random().toString(36).slice(2, 7);
  return `gpu-${sanitized || "script"}-${randomSuffix}`;
}

export function buildManagedConfigMapName(sourceName: string): string {
  return `${buildManagedPodName(sourceName)}-cm`;
}

export function buildConfigMapNameForPod(podName: string): string {
  return `${podName}-cm`;
}

export function buildGpuResourceRequirements(config: GPURunnerConfig): k8s.V1ResourceRequirements {
  const key = config.useHAMi ? "nvidia.com/gpumem" : "nvidia.com/gpu";
  const value = config.useHAMi ? String(config.gpuMemoryMB) : String(config.gpuCount);

  return {
    limits: {
      [key]: value
    },
    requests: {
      [key]: value
    }
  };
}

export function buildSelectionConfigMapManifest(
  namespace: string,
  configMapName: string,
  target: SelectionTarget
): k8s.V1ConfigMap {
  return {
    metadata: {
      namespace,
      name: configMapName,
      labels: {
        [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE
      }
    },
    data: {
      [SELECTION_FILE_NAME]: target.code
    }
  };
}

export function buildPodManifest(
  config: GPURunnerConfig,
  target: ExecutionTarget,
  podName: string,
  namespace: string,
  configMapName?: string
): k8s.V1Pod {
  const annotations: Record<string, string> = {
    [EXECUTION_KIND_ANNOTATION_KEY]: target.kind,
    [SOURCE_PATH_ANNOTATION_KEY]: target.sourcePath
  };

  if (configMapName) {
    annotations[CONFIGMAP_ANNOTATION_KEY] = configMapName;
  }

  const volumes: k8s.V1Volume[] = [
    {
      name: "workspace",
      persistentVolumeClaim: {
        claimName: config.pvcName
      }
    }
  ];

  const volumeMounts: k8s.V1VolumeMount[] = [
    {
      name: "workspace",
      mountPath: config.workspaceMountPath
    }
  ];

  if (configMapName) {
    volumes.push({
      name: SELECTION_VOLUME_NAME,
      configMap: {
        name: configMapName,
        items: [
          {
            key: SELECTION_FILE_NAME,
            path: SELECTION_FILE_NAME
          }
        ]
      }
    });

    volumeMounts.push({
      name: SELECTION_VOLUME_NAME,
      mountPath: SELECTION_MOUNT_PATH,
      readOnly: true
    });
  }

  return {
    metadata: {
      namespace,
      name: podName,
      labels: {
        [MANAGED_BY_LABEL_KEY]: MANAGED_BY_LABEL_VALUE
      },
      annotations
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: SERVICE_ACCOUNT_NAME,
      volumes,
      containers: [
        {
          name: "runner",
          image: config.image,
          command: ["python", target.podScriptPath],
          workingDir: config.workspaceMountPath,
          volumeMounts,
          resources: buildGpuResourceRequirements(config)
        }
      ]
    }
  };
}

export class PodManager {
  private config: GPURunnerConfig;
  private kubeConfig: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;

  constructor(config: GPURunnerConfig) {
    this.config = config;
    this.kubeConfig = new k8s.KubeConfig();
    this.coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.updateConfig(config);
  }

  updateConfig(config: GPURunnerConfig): void {
    this.config = config;
    const kubeconfigPath = resolveKubeconfigPath(config.kubeconfigPath);
    if (!fs.existsSync(kubeconfigPath)) {
      throw new Error(`Kubeconfig not found at ${kubeconfigPath}`);
    }

    this.kubeConfig = new k8s.KubeConfig();
    this.kubeConfig.loadFromFile(kubeconfigPath);
    this.coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
  }

  async createAndRun(target: ExecutionTarget): Promise<ManagedPodRun> {
    const podName = buildManagedPodName(target.displayName);
    const namespace = this.config.namespace;
    let configMapName: string | undefined;

    if (target.kind === "selection") {
      configMapName = buildConfigMapNameForPod(podName);
      const configMap = buildSelectionConfigMapManifest(namespace, configMapName, target);
      await this.coreApi.createNamespacedConfigMap(namespace, configMap);
    }

    const manifest = buildPodManifest(this.config, target, podName, namespace, configMapName);
    await this.coreApi.createNamespacedPod(namespace, manifest);

    return {
      podName,
      namespace,
      configMapName
    };
  }

  async waitForPodPhase(
    podName: string,
    phases: string[],
    timeoutMs: number
  ): Promise<string> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const response = await this.coreApi.readNamespacedPod(podName, this.config.namespace);
      const phase = response.body.status?.phase ?? "Unknown";
      if (phases.includes(phase)) {
        return phase;
      }

      await delay(2000);
    }

    throw new Error(`Timed out waiting for pod ${podName} after ${Math.round(timeoutMs / 1000)} seconds.`);
  }

  async streamLogs(podName: string, outputChannel: { appendLine(value: string): void }): Promise<void> {
    const response = await this.coreApi.readNamespacedPodLog(
      podName,
      this.config.namespace,
      "runner",
      false,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      500,
      true
    );

    outputChannel.appendLine(`----- Logs for ${podName} -----`);
    outputChannel.appendLine(response.body || "(no logs returned)");
  }

  async deletePod(run: ManagedPodRun | string): Promise<void> {
    const podName = typeof run === "string" ? run : run.podName;
    const configMapName = typeof run === "string" ? await this.lookupConfigMapName(podName) : run.configMapName;

    try {
      await this.coreApi.deleteNamespacedPod(podName, this.config.namespace);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    if (configMapName) {
      try {
        await this.coreApi.deleteNamespacedConfigMap(configMapName, this.config.namespace);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
  }

  async deleteAllManagedPods(): Promise<void> {
    const labelSelector = `${MANAGED_BY_LABEL_KEY}=${MANAGED_BY_LABEL_VALUE}`;
    const [podsResponse, configMapsResponse] = await Promise.all([
      this.coreApi.listNamespacedPod(this.config.namespace, undefined, undefined, undefined, undefined, labelSelector),
      this.coreApi.listNamespacedConfigMap(this.config.namespace, undefined, undefined, undefined, undefined, labelSelector)
    ]);

    await Promise.all(
      (podsResponse.body.items ?? []).map(async (pod) => {
        const podName = pod.metadata?.name;
        if (!podName) {
          return;
        }

        try {
          await this.coreApi.deleteNamespacedPod(podName, this.config.namespace);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      })
    );

    await Promise.all(
      (configMapsResponse.body.items ?? []).map(async (configMap) => {
        const configMapName = configMap.metadata?.name;
        if (!configMapName) {
          return;
        }

        try {
          await this.coreApi.deleteNamespacedConfigMap(configMapName, this.config.namespace);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      })
    );
  }

  async listManagedPods(): Promise<ManagedPodSummary[]> {
    const labelSelector = `${MANAGED_BY_LABEL_KEY}=${MANAGED_BY_LABEL_VALUE}`;
    const response = await this.coreApi.listNamespacedPod(
      this.config.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return (response.body.items ?? [])
      .map((pod) => ({
        name: pod.metadata?.name ?? "unknown",
        phase: pod.status?.phase ?? "Unknown",
        createdAt: pod.metadata?.creationTimestamp?.toISOString(),
        executionKind: pod.metadata?.annotations?.[EXECUTION_KIND_ANNOTATION_KEY],
        sourcePath: pod.metadata?.annotations?.[SOURCE_PATH_ANNOTATION_KEY]
      }))
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  }

  private async lookupConfigMapName(podName: string): Promise<string | undefined> {
    try {
      const response = await this.coreApi.readNamespacedPod(podName, this.config.namespace);
      return response.body.metadata?.annotations?.[CONFIGMAP_ANNOTATION_KEY];
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }
}

function resolveKubeconfigPath(configuredPath: string): string {
  if (configuredPath.trim()) {
    return expandHomeDir(configuredPath.trim());
  }

  return path.join(os.homedir(), ".kube", "config");
}

function expandHomeDir(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }

  return path.join(os.homedir(), inputPath.slice(1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFoundError(error: unknown): boolean {
  const maybeStatusCode = (error as { response?: { statusCode?: number }; statusCode?: number } | undefined)?.response?.statusCode
    ?? (error as { statusCode?: number } | undefined)?.statusCode;
  return maybeStatusCode === 404;
}
