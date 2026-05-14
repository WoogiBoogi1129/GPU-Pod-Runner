import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as k8s from "@kubernetes/client-node";
import type { AuthMode, GPURunnerConfig } from "./config";

const MANAGED_BY_LABEL_KEY = "managed-by";
const MANAGED_BY_LABEL_VALUE = "vscode-gpu-runner";
const CONFIGMAP_ANNOTATION_KEY = "gpu-runner/configmap-name";
const EXECUTION_KIND_ANNOTATION_KEY = "gpu-runner/execution-kind";
const SOURCE_PATH_ANNOTATION_KEY = "gpu-runner/source-path";
const SELECTION_VOLUME_NAME = "selection-script";
const SELECTION_MOUNT_PATH = "/opt/gpu-runner";
const SELECTION_FILE_NAME = "selection.py";
const SERVICE_ACCOUNT_ROOT = "/var/run/secrets/kubernetes.io/serviceaccount";
const SERVICE_ACCOUNT_NAMESPACE_FILE = path.join(SERVICE_ACCOUNT_ROOT, "namespace");
const SERVICE_ACCOUNT_TOKEN_FILE = path.join(SERVICE_ACCOUNT_ROOT, "token");

const REQUIRED_PERMISSION_CHECKS: PermissionCheckTarget[] = [
  { verb: "get", resource: "pods" },
  { verb: "list", resource: "pods" },
  { verb: "create", resource: "pods" },
  { verb: "delete", resource: "pods" },
  { verb: "get", resource: "pods", subresource: "log" },
  { verb: "get", resource: "configmaps" },
  { verb: "list", resource: "configmaps" },
  { verb: "create", resource: "configmaps" },
  { verb: "delete", resource: "configmaps" }
];

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

export type ResolvedAuthMode = "in-cluster" | "kubeconfig";

export interface DiscoveredClusterContext {
  namespace?: string;
  currentPodName?: string;
  currentServiceAccountName?: string;
  pvcName?: string;
  warnings: string[];
}

export interface PermissionCheckTarget {
  verb: string;
  resource: string;
  subresource?: string;
}

export interface PermissionCheckResult extends PermissionCheckTarget {
  allowed: boolean;
  reason?: string;
}

export interface PermissionReport {
  namespace: string;
  serviceAccountName?: string;
  checks: PermissionCheckResult[];
  warnings: string[];
}

export interface PodManagerRuntimeState {
  authMode: ResolvedAuthMode;
  discoveredContext?: DiscoveredClusterContext;
  permissionReport?: PermissionReport;
  warnings: string[];
}

interface KubernetesClients {
  authMode: ResolvedAuthMode;
  kubeConfig: k8s.KubeConfig;
  coreApi: k8s.CoreV1Api;
  authorizationApi: k8s.AuthorizationV1Api;
  warnings: string[];
}

export function toPosixPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/").split(path.sep).join(path.posix.sep);
}

export function mapWorkspaceFileToPodPath(
  workspaceRoot: string,
  filePath: string,
  workspaceMountPath: string
): string {
  const pathModule = looksLikeWindowsPath(workspaceRoot) || looksLikeWindowsPath(filePath) ? path.win32 : path;
  const relativePath = pathModule.relative(workspaceRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || pathModule.isAbsolute(relativePath)) {
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

export function normalizeKubeApiServerUrl(server: string, tlsServerName?: string): string {
  const normalizedTlsServerName = tlsServerName?.trim();
  if (!normalizedTlsServerName) {
    return server;
  }

  let parsedServer: URL;
  try {
    parsedServer = new URL(server);
  } catch {
    return server;
  }

  if (!isLoopbackHost(parsedServer.hostname) || isLoopbackHost(normalizedTlsServerName)) {
    return server;
  }

  return buildUrlWithHost(server, parsedServer, normalizedTlsServerName);
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

export function resolveAuthStrategy(
  authMode: AuthMode,
  isInsideCluster: boolean
): ResolvedAuthMode {
  if (authMode === "in-cluster") {
    return "in-cluster";
  }

  if (authMode === "kubeconfig") {
    return "kubeconfig";
  }

  return isInsideCluster ? "in-cluster" : "kubeconfig";
}

export function isInClusterEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  serviceAccountNamespaceFile = SERVICE_ACCOUNT_NAMESPACE_FILE,
  serviceAccountTokenFile = SERVICE_ACCOUNT_TOKEN_FILE
): boolean {
  return Boolean(environment.KUBERNETES_SERVICE_HOST)
    && fs.existsSync(serviceAccountNamespaceFile)
    && fs.existsSync(serviceAccountTokenFile);
}

export function discoverPersistentVolumeClaimName(
  pod: k8s.V1Pod,
  workspaceMountPath: string
): string | undefined {
  const containers = pod.spec?.containers ?? [];
  const volumeName = containers
    .flatMap((container) => container.volumeMounts ?? [])
    .find((mount) => mount.mountPath === workspaceMountPath)
    ?.name;

  if (!volumeName) {
    return undefined;
  }

  return pod.spec?.volumes?.find((volume) => volume.name === volumeName)?.persistentVolumeClaim?.claimName;
}

export function applyAutoDiscoveredContext(
  config: GPURunnerConfig,
  discovery?: DiscoveredClusterContext
): GPURunnerConfig {
  if (!discovery || !config.autoDiscoverClusterContext) {
    return config;
  }

  return {
    ...config,
    namespace: config.manualOverrides.namespace ? config.namespace : discovery.namespace ?? config.namespace,
    pvcName: config.manualOverrides.pvcName ? config.pvcName : discovery.pvcName ?? config.pvcName,
    executionServiceAccountName: config.manualOverrides.executionServiceAccountName
      ? config.executionServiceAccountName
      : discovery.currentServiceAccountName ?? config.executionServiceAccountName
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
      serviceAccountName: config.executionServiceAccountName || undefined,
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
  private authorizationApi: k8s.AuthorizationV1Api;
  private runtimeState: PodManagerRuntimeState;

  private constructor(config: GPURunnerConfig) {
    this.config = config;
    this.kubeConfig = new k8s.KubeConfig();
    this.coreApi = {} as k8s.CoreV1Api;
    this.authorizationApi = {} as k8s.AuthorizationV1Api;
    this.runtimeState = {
      authMode: "kubeconfig",
      warnings: []
    };
  }

  static async create(config: GPURunnerConfig): Promise<PodManager> {
    const manager = new PodManager(config);
    await manager.updateConfig(config);
    return manager;
  }

  getConfig(): GPURunnerConfig {
    return this.config;
  }

  getRuntimeState(): PodManagerRuntimeState {
    return {
      authMode: this.runtimeState.authMode,
      discoveredContext: this.runtimeState.discoveredContext,
      permissionReport: this.runtimeState.permissionReport,
      warnings: [...this.runtimeState.warnings]
    };
  }

  async updateConfig(config: GPURunnerConfig): Promise<void> {
    const clients = initializeKubernetesClients(config);
    this.kubeConfig = clients.kubeConfig;
    this.coreApi = clients.coreApi;
    this.authorizationApi = clients.authorizationApi;

    let discovery: DiscoveredClusterContext | undefined;
    const warnings = [...clients.warnings];

    if (config.autoDiscoverClusterContext) {
      discovery = await discoverCurrentClusterContext(this.coreApi, config.workspaceMountPath);
      warnings.push(...discovery.warnings);
    }

    this.config = applyAutoDiscoveredContext(config, discovery);

    const permissionReport = await checkRequiredPermissions(
      this.authorizationApi,
      this.config.namespace,
      this.config.executionServiceAccountName || discovery?.currentServiceAccountName
    );

    warnings.push(...permissionReport.warnings);

    this.runtimeState = {
      authMode: clients.authMode,
      discoveredContext: discovery,
      permissionReport,
      warnings
    };
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

function initializeKubernetesClients(config: GPURunnerConfig): KubernetesClients {
  const warnings: string[] = [];
  const isInsideCluster = isInClusterEnvironment();
  const resolvedAuthMode = resolveAuthStrategy(config.authMode, isInsideCluster);
  const kubeConfig = new k8s.KubeConfig();

  if (resolvedAuthMode === "in-cluster") {
    try {
      kubeConfig.loadFromCluster();
      normalizeCurrentClusterServer(kubeConfig);

      return {
        authMode: "in-cluster",
        kubeConfig,
        coreApi: kubeConfig.makeApiClient(k8s.CoreV1Api),
        authorizationApi: kubeConfig.makeApiClient(k8s.AuthorizationV1Api),
        warnings
      };
    } catch (error) {
      if (config.authMode !== "auto") {
        throw new Error(`Failed to initialize in-cluster Kubernetes auth: ${toErrorMessage(error)}`);
      }

      warnings.push(`In-cluster auth failed, falling back to kubeconfig: ${toErrorMessage(error)}`);
    }
  }

  const kubeconfigPath = resolveAvailableKubeconfigPath(config.kubeconfigPath, config.manualOverrides.kubeconfigPath);
  if (!kubeconfigPath) {
    throw new Error(
      "No usable kubeconfig was found. Set gpuRunner.kubeconfigPath or run the extension inside a Kubernetes Pod."
    );
  }

  kubeConfig.loadFromFile(kubeconfigPath);
  normalizeCurrentClusterServer(kubeConfig);

  return {
    authMode: "kubeconfig",
    kubeConfig,
    coreApi: kubeConfig.makeApiClient(k8s.CoreV1Api),
    authorizationApi: kubeConfig.makeApiClient(k8s.AuthorizationV1Api),
    warnings
  };
}

async function discoverCurrentClusterContext(
  coreApi: k8s.CoreV1Api,
  workspaceMountPath: string
): Promise<DiscoveredClusterContext> {
  const warnings: string[] = [];
  const namespace = readCurrentNamespace();
  const currentPodName = readCurrentPodName();

  if (!namespace) {
    warnings.push(
      "Automatic namespace discovery failed because the service account namespace file was not available."
    );
  }

  if (!currentPodName) {
    warnings.push("Automatic Pod discovery failed because the current Pod name could not be determined.");
  }

  if (!namespace || !currentPodName) {
    return {
      namespace,
      currentPodName,
      warnings
    };
  }

  try {
    const response = await coreApi.readNamespacedPod(currentPodName, namespace);
    const pod = response.body;
    const pvcName = discoverPersistentVolumeClaimName(pod, workspaceMountPath);
    if (!pvcName) {
      warnings.push(
        `Automatic PVC discovery could not find a PersistentVolumeClaim mounted at ${workspaceMountPath}.`
      );
    }

    return {
      namespace: pod.metadata?.namespace ?? namespace,
      currentPodName,
      currentServiceAccountName: pod.spec?.serviceAccountName,
      pvcName,
      warnings
    };
  } catch (error) {
    warnings.push(
      `Automatic IDE Pod metadata discovery failed for ${namespace}/${currentPodName}: ${toErrorMessage(error)}`
    );
    return {
      namespace,
      currentPodName,
      warnings
    };
  }
}

async function checkRequiredPermissions(
  authorizationApi: k8s.AuthorizationV1Api,
  namespace: string,
  serviceAccountName?: string
): Promise<PermissionReport> {
  const checks = await Promise.all(
    REQUIRED_PERMISSION_CHECKS.map(async (target) => {
      try {
        const response = await authorizationApi.createSelfSubjectAccessReview({
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: {
            resourceAttributes: {
              namespace,
              group: "",
              verb: target.verb,
              resource: target.resource,
              subresource: target.subresource
            }
          }
        });

        return {
          ...target,
          allowed: Boolean(response.body.status?.allowed),
          reason: response.body.status?.reason
        } satisfies PermissionCheckResult;
      } catch (error) {
        return {
          ...target,
          allowed: false,
          reason: `Permission review failed: ${toErrorMessage(error)}`
        } satisfies PermissionCheckResult;
      }
    })
  );

  const warnings = checks
    .filter((check) => !check.allowed)
    .map((check) => {
      const resourceName = check.subresource ? `${check.resource}/${check.subresource}` : check.resource;
      const suffix = check.reason ? ` (${check.reason})` : "";
      return `Current ServiceAccount may be missing '${check.verb}' permission for '${resourceName}' in namespace '${namespace}'${suffix}`;
    });

  return {
    namespace,
    serviceAccountName,
    checks,
    warnings
  };
}

function resolveAvailableKubeconfigPath(
  configuredPath: string,
  isConfiguredPathExplicit: boolean
): string | undefined {
  if (configuredPath.trim()) {
    const expandedPath = expandHomeDir(configuredPath.trim());
    if (!fs.existsSync(expandedPath)) {
      throw new Error(`Kubeconfig not found at ${expandedPath}`);
    }

    return expandedPath;
  }

  const defaultPath = path.join(os.homedir(), ".kube", "config");
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  if (isConfiguredPathExplicit) {
    return undefined;
  }

  return undefined;
}

function normalizeCurrentClusterServer(kubeConfig: k8s.KubeConfig): void {
  const cluster = kubeConfig.getCurrentCluster();
  if (!cluster) {
    return;
  }

  const normalizedServer = normalizeKubeApiServerUrl(cluster.server, cluster.tlsServerName);
  (cluster as { server: string }).server = normalizedServer;
}

function readCurrentNamespace(serviceAccountNamespaceFile = SERVICE_ACCOUNT_NAMESPACE_FILE): string | undefined {
  try {
    return fs.readFileSync(serviceAccountNamespaceFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function readCurrentPodName(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment.POD_NAME?.trim() || environment.HOSTNAME?.trim() || undefined;
}

function expandHomeDir(inputPath: string): string {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }

  return path.join(os.homedir(), inputPath.slice(1));
}

function buildUrlWithHost(originalUrl: string, parsedUrl: URL, host: string): string {
  const auth =
    parsedUrl.username || parsedUrl.password
      ? `${parsedUrl.username}${parsedUrl.password ? `:${parsedUrl.password}` : ""}@`
      : "";
  const normalizedHost = net.isIPv6(host) && !host.startsWith("[") ? `[${host}]` : host;
  const port = parsedUrl.port ? `:${parsedUrl.port}` : "";
  const pathName = parsedUrl.pathname === "/" && !originalUrl.endsWith("/") ? "" : parsedUrl.pathname;

  return `${parsedUrl.protocol}//${auth}${normalizedHost}${port}${pathName}${parsedUrl.search}${parsedUrl.hash}`;
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return normalizedHost === "127.0.0.1" || normalizedHost === "::1" || normalizedHost === "localhost";
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFoundError(error: unknown): boolean {
  const maybeStatusCode = (error as { response?: { statusCode?: number }; statusCode?: number } | undefined)?.response?.statusCode
    ?? (error as { statusCode?: number } | undefined)?.statusCode;
  return maybeStatusCode === 404;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
