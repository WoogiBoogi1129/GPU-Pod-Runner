import type { AutoDetectPrompt } from "./config";
import type { DetectionResult } from "./gpuDetector";

export type FileExecutionMode = "gpu" | "local" | "prompt";

export function decideFileExecutionMode(
  promptMode: AutoDetectPrompt,
  detection: DetectionResult
): FileExecutionMode {
  if (!detection.requiresGPU) {
    return "local";
  }

  if (promptMode === "auto-gpu") {
    return "gpu";
  }

  if (promptMode === "auto-local") {
    return "local";
  }

  return "prompt";
}
