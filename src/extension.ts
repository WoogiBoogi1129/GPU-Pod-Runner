import * as path from "node:path";
import * as vscode from "vscode";
import { loadConfig, type GPURunnerConfig } from "./config";
import { detectGPUUsage } from "./gpuDetector";
import {
  PodManager,
  mapWorkspaceFileToPodPath,
  type ExecutionTarget,
  type ManagedPodRun,
  type PermissionCheckResult,
  type SelectionTarget,
  type WorkspaceFileTarget
} from "./podManager";
import { decideFileExecutionMode } from "./runnerDecisions";
import { StatusBarController } from "./statusBar";

let podManager: PodManager | undefined;
let statusBar: StatusBarController | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let currentConfig: GPURunnerConfig | undefined;
let deactivateCleanup: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("GPU Pod Runner");
  context.subscriptions.push(outputChannel);

  currentConfig = loadConfig();
  warnAboutReservedApiSetting(currentConfig);
  podManager = await createPodManager(currentConfig);
  currentConfig = podManager?.getConfig() ?? currentConfig;

  statusBar = new StatusBarController(context, {
    onRefresh: async () => podManager?.listManagedPods() ?? [],
    onCleanup: async () => {
      if (!podManager) {
        return;
      }

      await podManager.deleteAllManagedPods();
      await refreshRunningState();
    }
  });
  context.subscriptions.push(statusBar);

  const runFileCommand = vscode.commands.registerCommand("gpu-runner.runFile", async () => {
    await runCurrentFile();
  });

  const runSelectionCommand = vscode.commands.registerCommand("gpu-runner.runSelection", async () => {
    await runSelectionInGpuPod();
  });

  const showStatusCommand = vscode.commands.registerCommand("gpu-runner.showStatus", async () => {
    await statusBar?.showStatusPanel();
  });

  const cleanupCommand = vscode.commands.registerCommand("gpu-runner.cleanup", async () => {
    if (!podManager) {
      return;
    }

    await podManager.deleteAllManagedPods();
    await refreshRunningState();
    vscode.window.showInformationMessage("Managed GPU Pods have been cleaned up.");
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!currentConfig?.autoDetect || document.languageId !== "python" || !statusBar) {
      return;
    }

    const detection = detectGPUUsage(document.getText());
    if (detection.requiresGPU) {
      statusBar.showHighConfidenceHint(detection.frameworks);
    }
  });

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("gpuRunner")) {
      return;
    }

    void reinitializePodManager();
  });

  context.subscriptions.push(runFileCommand, runSelectionCommand, showStatusCommand, cleanupCommand, saveListener, configListener);

  deactivateCleanup = async () => {
    if (!podManager) {
      return;
    }

    try {
      await podManager.deleteAllManagedPods();
    } catch (error) {
      outputChannel?.appendLine(`Cleanup on deactivate failed: ${toErrorMessage(error)}`);
    }
  };

  await refreshRunningState();
}

export async function deactivate(): Promise<void> {
  if (deactivateCleanup) {
    await deactivateCleanup();
  }
}

async function runCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a Python file to run with GPU Runner.");
    return;
  }

  const document = editor.document;
  if (document.languageId !== "python") {
    vscode.window.showWarningMessage("GPU Runner only supports Python files.");
    return;
  }

  if (!currentConfig || !podManager || !statusBar) {
    vscode.window.showErrorMessage("GPU Runner is not initialized.");
    return;
  }

  statusBar.setState("scanning");
  const detection = detectGPUUsage(document.getText());
  const executionMode = decideFileExecutionMode(currentConfig.autoDetectPrompt, detection);

  if (executionMode === "local") {
    runFileLocally(document.uri.fsPath);
    await refreshRunningState();
    return;
  }

  if (executionMode === "prompt") {
    const selection = await statusBar.promptForExecution(detection);
    if (!selection) {
      await refreshRunningState();
      return;
    }

    if (selection === "local") {
      runFileLocally(document.uri.fsPath);
      await refreshRunningState();
      return;
    }
  }

  try {
    const target = buildWorkspaceFileTarget(document.uri);
    await runGpuTarget(target);
  } catch (error) {
    statusBar.setState("error");
    await handleUnexpectedError(error, "Failed to prepare the current file for GPU execution.");
  }
}

async function runSelectionInGpuPod(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a Python editor selection to run on a GPU Pod.");
    return;
  }

  const document = editor.document;
  if (document.languageId !== "python") {
    vscode.window.showWarningMessage("GPU Runner only supports Python selections.");
    return;
  }

  if (!currentConfig || !podManager) {
    vscode.window.showErrorMessage("GPU Runner is not initialized.");
    return;
  }

  const selectionText = document.getText(editor.selection).trim();
  if (!selectionText) {
    vscode.window.showInformationMessage("Select Python code before running it in a GPU Pod.");
    return;
  }

  const workspaceFolder = getSingleWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return;
  }

  const target: SelectionTarget = {
    kind: "selection",
    code: selectionText,
    sourcePath: document.uri.fsPath,
    displayName: `${path.parse(document.uri.fsPath).name}-selection`,
    podScriptPath: "/opt/gpu-runner/selection.py"
  };

  await runGpuTarget(target, workspaceFolder);
}

function buildWorkspaceFileTarget(uri: vscode.Uri): WorkspaceFileTarget {
  if (!currentConfig) {
    throw new Error("GPU Runner is not initialized.");
  }

  const workspaceFolder = getSingleWorkspaceFolder(uri);
  if (!workspaceFolder) {
    throw new Error("A single-root workspace is required for GPU execution.");
  }

  return {
    kind: "workspace-file",
    sourcePath: uri.fsPath,
    displayName: path.basename(uri.fsPath),
    podScriptPath: mapWorkspaceFileToPodPath(workspaceFolder.uri.fsPath, uri.fsPath, currentConfig.workspaceMountPath)
  };
}

async function runGpuTarget(
  target: ExecutionTarget,
  workspaceFolder = getSingleWorkspaceFolder(vscode.Uri.file(target.sourcePath))
): Promise<void> {
  if (!currentConfig || !podManager || !statusBar || !outputChannel) {
    vscode.window.showErrorMessage("GPU Runner is not initialized.");
    return;
  }

  if (!workspaceFolder) {
    return;
  }

  let run: ManagedPodRun | undefined;

  try {
    outputChannel.show(true);
    outputChannel.appendLine(`[GPU Runner] Starting ${target.displayName}`);
    outputChannel.appendLine(`[GPU Runner] Namespace: ${currentConfig.namespace}`);
    outputChannel.appendLine(`[GPU Runner] Image: ${currentConfig.image}`);
    outputChannel.appendLine(`[GPU Runner] Script path in pod: ${target.podScriptPath}`);

    run = await podManager.createAndRun(target);
    await refreshRunningState();

    outputChannel.appendLine(`[GPU Runner] Pod created: ${run.podName}`);
    const phase = await podManager.waitForPodPhase(
      run.podName,
      ["Succeeded", "Failed"],
      currentConfig.podTimeoutSeconds * 1000
    );

    await podManager.streamLogs(run.podName, outputChannel);

    if (phase === "Succeeded") {
      vscode.window.showInformationMessage(`GPU Pod run completed: ${run.podName}`);
      statusBar.setState("completed");
    } else {
      statusBar.setState("error");
      vscode.window.showErrorMessage(`GPU Pod run failed: ${run.podName}`);
    }
  } catch (error) {
    statusBar.setState("error");
    await handleUnexpectedError(error, `Failed to run ${target.displayName} on a GPU Pod.`);
  } finally {
    if (run) {
      try {
        await podManager.deletePod(run);
      } catch (cleanupError) {
        outputChannel.appendLine(`[GPU Runner] Cleanup failed for ${run.podName}: ${toErrorMessage(cleanupError)}`);
      }
    }

    await refreshRunningState();
  }
}

function runFileLocally(filePath: string): void {
  const terminal = getOrCreateTerminal();
  terminal.show(true);
  terminal.sendText(`python "${escapeForDoubleQuotes(filePath)}"`, true);
  outputChannel?.appendLine(`[GPU Runner] Running locally: ${filePath}`);
}

async function refreshRunningState(): Promise<void> {
  if (!podManager || !statusBar) {
    return;
  }

  try {
    const pods = await podManager.listManagedPods();
    const activePods = pods.filter((pod) => !["Succeeded", "Failed"].includes(pod.phase));
    if (activePods.length > 0) {
      statusBar.setState("running", activePods.length);
      return;
    }

    if (!["completed", "error"].includes(statusBar.getState())) {
      statusBar.setState("idle");
    }
  } catch (error) {
    outputChannel?.appendLine(`[GPU Runner] Failed to refresh pod status: ${toErrorMessage(error)}`);
  }
}

function getSingleWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length !== 1) {
    vscode.window.showErrorMessage("GPU Runner v1 only supports a single-root workspace.");
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("The selected file must be inside the active workspace.");
    return undefined;
  }

  return workspaceFolder;
}

async function reinitializePodManager(): Promise<void> {
  const loadedConfig = loadConfig();
  currentConfig = loadedConfig;
  warnAboutReservedApiSetting(loadedConfig);
  podManager = await createPodManager(loadedConfig);
  currentConfig = podManager?.getConfig() ?? loadedConfig;
  await refreshRunningState();
}

async function createPodManager(config: GPURunnerConfig): Promise<PodManager | undefined> {
  try {
    const manager = await PodManager.create(config);
    reportPodManagerRuntime(manager);
    return manager;
  } catch (error) {
    outputChannel?.appendLine(`[GPU Runner] Pod manager initialization skipped: ${toErrorMessage(error)}`);
    void vscode.window.showWarningMessage(
      `GPU Runner could not initialize Kubernetes access yet: ${toErrorMessage(error)}`
    );
    return undefined;
  }
}

function reportPodManagerRuntime(manager: PodManager): void {
  const runtime = manager.getRuntimeState();
  const effectiveConfig = manager.getConfig();
  const deniedChecks = runtime.permissionReport?.checks.filter((check) => !check.allowed) ?? [];

  outputChannel?.appendLine(`[GPU Runner] Kubernetes auth mode: ${runtime.authMode}`);
  outputChannel?.appendLine(`[GPU Runner] Effective namespace: ${effectiveConfig.namespace}`);
  outputChannel?.appendLine(`[GPU Runner] Effective workspace PVC: ${effectiveConfig.pvcName}`);
  outputChannel?.appendLine(
    `[GPU Runner] Execution ServiceAccount: ${effectiveConfig.executionServiceAccountName || "(cluster default)"}`
  );

  if (runtime.discoveredContext?.currentPodName) {
    outputChannel?.appendLine(`[GPU Runner] Current IDE Pod: ${runtime.discoveredContext.currentPodName}`);
  }

  if (runtime.warnings.length > 0) {
    runtime.warnings.forEach((warning) => {
      outputChannel?.appendLine(`[GPU Runner] Warning: ${warning}`);
    });

    void vscode.window.showWarningMessage(
      "GPU Runner initialized with Kubernetes warnings. See the GPU Pod Runner output channel for details."
    );
  }

  if (deniedChecks.length > 0) {
    outputChannel?.appendLine("[GPU Runner] Permission warnings:");
    deniedChecks.forEach((check) => {
      outputChannel?.appendLine(`  - ${formatPermissionCheck(check)}`);
    });
  }
}

function warnAboutReservedApiSetting(config: GPURunnerConfig): void {
  if (!config.apiServerUrl.trim()) {
    return;
  }

  void vscode.window.showWarningMessage(
    "gpuRunner.apiServerUrl is reserved for a future backend mode and is ignored in v1."
  );
}

function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === "GPU Runner Local");
  if (existing) {
    return existing;
  }

  return vscode.window.createTerminal("GPU Runner Local");
}

async function handleUnexpectedError(error: unknown, contextMessage: string): Promise<void> {
  const message = `${contextMessage} ${toErrorMessage(error)}`;
  outputChannel?.appendLine(message);
  await vscode.window.showErrorMessage(message);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/"/g, '""');
}

function formatPermissionCheck(check: PermissionCheckResult): string {
  const resourceName = check.subresource ? `${check.resource}/${check.subresource}` : check.resource;
  const reason = check.reason ? ` (${check.reason})` : "";
  return `${check.verb} ${resourceName}: denied${reason}`;
}
