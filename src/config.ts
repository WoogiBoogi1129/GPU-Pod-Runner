import * as vscode from "vscode";

export type AutoDetectPrompt = "always-ask" | "auto-gpu" | "auto-local";

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
  apiServerUrl: string;
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
    apiServerUrl: config.get<string>("apiServerUrl", "")
  };
}
