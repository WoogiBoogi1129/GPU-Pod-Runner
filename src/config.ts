import * as vscode from "vscode";

export type AutoDetectPrompt = "always-ask" | "auto-gpu" | "auto-local";
export type AuthMode = "auto" | "in-cluster" | "kubeconfig";

export interface ConfigManualOverrides {
  namespace: boolean;
  pvcName: boolean;
  workspaceMountPath: boolean;
  kubeconfigPath: boolean;
  authMode: boolean;
  autoDiscoverClusterContext: boolean;
  executionServiceAccountName: boolean;
}

export interface GPURunnerConfig {
  namespace: string;
  image: string;
  useHAMi: boolean;
  gpuMemoryMB: number;
  gpuCount: number;
  pvcName: string;
  workspaceMountPath: string;
  podTimeoutSeconds: number;
  autoDetect: boolean;
  autoDetectPrompt: AutoDetectPrompt;
  kubeconfigPath: string;
  authMode: AuthMode;
  autoDiscoverClusterContext: boolean;
  executionServiceAccountName: string;
  apiServerUrl: string;
  manualOverrides: ConfigManualOverrides;
}

export function loadConfig(): GPURunnerConfig {
  const config = vscode.workspace.getConfiguration("gpuRunner");

  return {
    namespace: config.get<string>("namespace", "ml-dev"),
    image: config.get<string>("image", "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime"),
    useHAMi: config.get<boolean>("useHAMi", false),
    gpuMemoryMB: config.get<number>("gpuMemoryMB", 8000),
    gpuCount: config.get<number>("gpuCount", 1),
    pvcName: config.get<string>("pvcName", "shared-workspace-pvc"),
    workspaceMountPath: config.get<string>("workspaceMountPath", "/workspace"),
    podTimeoutSeconds: config.get<number>("podTimeoutSeconds", 600),
    autoDetect: config.get<boolean>("autoDetect", true),
    autoDetectPrompt: config.get<AutoDetectPrompt>("autoDetectPrompt", "always-ask"),
    kubeconfigPath: config.get<string>("kubeconfigPath", ""),
    authMode: config.get<AuthMode>("authMode", "auto"),
    autoDiscoverClusterContext: config.get<boolean>("autoDiscoverClusterContext", true),
    executionServiceAccountName: config.get<string>("executionServiceAccountName", ""),
    manualOverrides: {
      namespace: hasExplicitConfigurationValue(config, "namespace"),
      pvcName: hasExplicitConfigurationValue(config, "pvcName"),
      workspaceMountPath: hasExplicitConfigurationValue(config, "workspaceMountPath"),
      kubeconfigPath: hasExplicitConfigurationValue(config, "kubeconfigPath"),
      authMode: hasExplicitConfigurationValue(config, "authMode"),
      autoDiscoverClusterContext: hasExplicitConfigurationValue(config, "autoDiscoverClusterContext"),
      executionServiceAccountName: hasExplicitConfigurationValue(config, "executionServiceAccountName")
    },
    apiServerUrl: config.get<string>("apiServerUrl", "")
  };
}

function hasExplicitConfigurationValue(
  config: vscode.WorkspaceConfiguration,
  key: string
): boolean {
  const inspected = config.inspect(key);
  if (!inspected) {
    return false;
  }

  return (
    inspected.globalValue !== undefined
    || inspected.workspaceValue !== undefined
    || inspected.workspaceFolderValue !== undefined
    || inspected.globalLanguageValue !== undefined
    || inspected.workspaceLanguageValue !== undefined
    || inspected.workspaceFolderLanguageValue !== undefined
  );
}
