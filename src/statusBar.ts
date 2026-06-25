import * as vscode from "vscode";
import type { DetectionResult } from "./gpuDetector";
import type { ManagedPodSummary } from "./podManager";
import type { PromptKind } from "./runnerDecisions";

export type RunnerState = "idle" | "scanning" | "running" | "completed" | "error";

interface StatusPanelActions {
  onRefresh: () => Promise<ManagedPodSummary[]>;
  onCleanup: () => Promise<void>;
}

export class StatusBarController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private statusPanel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private runningCount = 0;
  private currentState: RunnerState = "idle";
  private completionTimer?: NodeJS.Timeout;
  private hintTimer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly actions: StatusPanelActions
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = "gpu-runner.showStatus";
    this.setState("idle");
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);
  }

  setState(state: RunnerState, runningCount = this.runningCount): void {
    this.currentState = state;
    this.runningCount = runningCount;

    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = undefined;
    }

    switch (state) {
      case "idle":
        this.statusBarItem.text = "$(server) GPU Runner";
        this.statusBarItem.tooltip = "GPU Pod Runner";
        break;
      case "scanning":
        this.statusBarItem.text = "$(loading~spin) 스캔 중...";
        this.statusBarItem.tooltip = "Scanning Python code for GPU usage";
        break;
      case "running":
        this.statusBarItem.text = `$(zap) GPU Pod 실행 중 (${runningCount})`;
        this.statusBarItem.tooltip = "GPU Pods are running";
        break;
      case "completed":
        this.statusBarItem.text = "$(check) 완료";
        this.statusBarItem.tooltip = "Last GPU run completed";
        this.completionTimer = setTimeout(() => {
          this.setState(this.runningCount > 0 ? "running" : "idle", this.runningCount);
        }, 3000);
        break;
      case "error":
        this.statusBarItem.text = "$(error) 오류 발생";
        this.statusBarItem.tooltip = "The last GPU run ended with an error";
        break;
    }
  }

  /**
   * Pre-execution confirmation prompt (REQ-1).
   *
   * This is the universal backup path: it works even with no detection signal at all. The
   * wording branches on `promptKind`:
   *  - `confirm-gpu-request`: the user's code explicitly asks for a GPU, so this is a final
   *    confirmation before allocating a GPU Pod.
   *  - `recommend-gpu`: no GPU request was detected, so this simply offers GPU as a faster
   *    option (defaults to local when dismissed).
   */
  async promptForExecution(
    detection: DetectionResult,
    promptKind: PromptKind = "confirm-gpu-request"
  ): Promise<"gpu" | "local" | undefined> {
    const runOnGpu = "GPU Pod 실행";
    const runLocally = "로컬 실행";

    let message: string;
    if (promptKind === "recommend-gpu") {
      message = "⚡ GPU가 사용 가능합니다. GPU Pod에서 더 빠르게 실행하시겠습니까?";
    } else {
      const frameworkLabel = detection.frameworks.join(", ") || "GPU";
      message = `🎮 GPU 사용을 요청하셨습니다 [${frameworkLabel}]. 정말 GPU Pod에서 실행하시겠습니까?`;
    }

    const selection = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      runOnGpu,
      runLocally
    );

    if (selection === runOnGpu) {
      return "gpu";
    }

    if (selection === runLocally) {
      return "local";
    }

    return undefined;
  }

  showHighConfidenceHint(frameworks: string[]): void {
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
    }

    const previousText = this.statusBarItem.text;
    const previousTooltip = this.statusBarItem.tooltip;
    this.statusBarItem.text = `$(zap) GPU 감지됨: ${frameworks.join(", ")}`;
    this.statusBarItem.tooltip = "High-confidence GPU code detected";

    this.hintTimer = setTimeout(() => {
      this.statusBarItem.text = previousText;
      this.statusBarItem.tooltip = previousTooltip;
    }, 5000);
  }

  async showStatusPanel(): Promise<void> {
    const pods = await this.actions.onRefresh();

    if (!this.statusPanel) {
      this.statusPanel = vscode.window.createWebviewPanel(
        "gpuRunnerStatus",
        "GPU Pod Runner Status",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true
        }
      );

      this.statusPanel.onDidDispose(() => {
        this.statusPanel = undefined;
      }, null, this.disposables);

      this.statusPanel.webview.onDidReceiveMessage(async (message) => {
        if (message?.type === "refresh") {
          const refreshedPods = await this.actions.onRefresh();
          this.updateStatusPanel(refreshedPods);
        }

        if (message?.type === "cleanup") {
          await this.actions.onCleanup();
          const refreshedPods = await this.actions.onRefresh();
          this.updateStatusPanel(refreshedPods);
        }
      }, null, this.disposables);
    }

    this.statusPanel.reveal(vscode.ViewColumn.Beside);
    this.updateStatusPanel(pods);
  }

  getState(): RunnerState {
    return this.currentState;
  }

  dispose(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
    }

    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
    }

    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private updateStatusPanel(pods: ManagedPodSummary[]): void {
    if (!this.statusPanel) {
      return;
    }

    this.statusPanel.webview.html = getStatusPanelHtml(pods);
  }
}

function getStatusPanelHtml(pods: ManagedPodSummary[]): string {
  const rows = pods.length > 0
    ? pods.map((pod) => {
      const createdAt = pod.createdAt ? new Date(pod.createdAt).toLocaleString() : "-";
      const details = pod.sourcePath ? escapeHtml(pod.sourcePath) : "-";
      const executionKind = pod.executionKind ?? "-";

      return `
        <tr>
          <td>${escapeHtml(pod.name)}</td>
          <td>${escapeHtml(pod.phase)}</td>
          <td>${escapeHtml(executionKind)}</td>
          <td>${details}</td>
          <td>${escapeHtml(createdAt)}</td>
        </tr>
      `;
    }).join("")
    : `
      <tr>
        <td colspan="5" class="empty">관리 중인 GPU Pod가 없습니다.</td>
      </tr>
    `;

  return `<!DOCTYPE html>
  <html lang="ko">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        :root {
          color-scheme: light dark;
        }

        body {
          font-family: var(--vscode-font-family);
          padding: 16px;
          color: var(--vscode-foreground);
          background: var(--vscode-editor-background);
        }

        .actions {
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
        }

        button {
          border: 1px solid var(--vscode-button-border, transparent);
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          padding: 8px 12px;
          cursor: pointer;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th, td {
          text-align: left;
          padding: 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
          vertical-align: top;
        }

        th {
          font-weight: 600;
        }

        .empty {
          text-align: center;
          opacity: 0.8;
        }
      </style>
    </head>
    <body>
      <div class="actions">
        <button id="refreshButton">Refresh</button>
        <button id="cleanupButton">Cleanup All</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Pod</th>
            <th>Phase</th>
            <th>Kind</th>
            <th>Source</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById("refreshButton").addEventListener("click", () => {
          vscode.postMessage({ type: "refresh" });
        });
        document.getElementById("cleanupButton").addEventListener("click", () => {
          vscode.postMessage({ type: "cleanup" });
        });
        setInterval(() => {
          vscode.postMessage({ type: "refresh" });
        }, 5000);
      </script>
    </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
