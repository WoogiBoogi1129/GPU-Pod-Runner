import type { AutoDetectPrompt } from "./config";
import type { DetectionResult } from "./gpuDetector";

export type FileExecutionMode = "gpu" | "local" | "prompt";

/**
 * When the decision is `prompt`, this describes which confirmation the user should see.
 *
 * - `confirm-gpu-request`: the code contains an explicit GPU request that is not (yet) on the
 *   auto-pass list, so we ask the user to confirm before allocating a GPU Pod.
 * - `recommend-gpu`: no GPU request was detected, so we simply offer GPU as a faster option.
 */
export type PromptKind = "confirm-gpu-request" | "recommend-gpu";

export interface ExecutionDecision {
  mode: FileExecutionMode;
  /** Present only when `mode === "prompt"`. */
  promptKind?: PromptKind;
  /** True when the code matched the auto-pass list and skipped the prompt entirely. */
  autoPassed: boolean;
  /** Whether the code contains any explicit GPU request signal. */
  hasGpuRequest: boolean;
  reasons: string[];
}

/**
 * Auto-pass list (REQ-2).
 *
 * These are the explicit GPU-request patterns we trust enough to run on a GPU Pod *without*
 * a confirmation prompt. The list is intentionally conservative: it starts with the most
 * unambiguous "the user is asking for CUDA right here" signals and is meant to grow one
 * pattern at a time as confidence in additional patterns is established.
 *
 * Patterns that signal a GPU request but are *not* on this list still count as a GPU request;
 * they fall through to the `confirm-gpu-request` prompt (REQ-1) rather than auto-passing.
 */
export const DEFAULT_AUTO_PASS_PATTERN_IDS: readonly string[] = [
  "pytorch.to-cuda",
  "pytorch.cuda-call",
  "pytorch.device-literal",
  "pytorch.torch-device-cuda"
];

/**
 * Decides how a file should run under the "trust explicit request, re-confirm when uncertain"
 * model (REQ-1 / REQ-2).
 *
 * Decision surface:
 *  - `auto-local`  -> always run locally (explicit user override).
 *  - `auto-gpu`    -> run any detected GPU request on a Pod, otherwise locally (no prompt).
 *  - `always-ask`  -> auto-pass trusted patterns, otherwise prompt:
 *      - explicit GPU request not on the auto-pass list -> `confirm-gpu-request`
 *      - no GPU request                                  -> `recommend-gpu`
 */
export function decideFileExecution(
  promptMode: AutoDetectPrompt,
  detection: DetectionResult,
  autoPassPatternIds: Iterable<string> = DEFAULT_AUTO_PASS_PATTERN_IDS
): ExecutionDecision {
  const hasGpuRequest = detection.requiresGPU;

  if (promptMode === "auto-local") {
    return {
      mode: "local",
      autoPassed: false,
      hasGpuRequest,
      reasons: ["Configured to always run locally (auto-local)."]
    };
  }

  if (promptMode === "auto-gpu") {
    return {
      mode: hasGpuRequest ? "gpu" : "local",
      autoPassed: false,
      hasGpuRequest,
      reasons: hasGpuRequest
        ? detection.reasons
        : ["No GPU request detected; running locally (auto-gpu)."]
    };
  }

  // always-ask: the prompt is the universal backup path, narrowed by the auto-pass list.
  if (hasGpuRequest && matchesAutoPass(detection, autoPassPatternIds)) {
    return {
      mode: "gpu",
      autoPassed: true,
      hasGpuRequest,
      reasons: detection.reasons
    };
  }

  if (hasGpuRequest) {
    return {
      mode: "prompt",
      promptKind: "confirm-gpu-request",
      autoPassed: false,
      hasGpuRequest,
      reasons: detection.reasons
    };
  }

  return {
    mode: "prompt",
    promptKind: "recommend-gpu",
    autoPassed: false,
    hasGpuRequest,
    reasons: ["No GPU request detected; offering GPU as a faster option."]
  };
}

function matchesAutoPass(
  detection: DetectionResult,
  autoPassPatternIds: Iterable<string>
): boolean {
  const autoPass = autoPassPatternIds instanceof Set
    ? autoPassPatternIds
    : new Set(autoPassPatternIds);

  return detection.matchedPatternIds.some((id) => autoPass.has(id));
}
