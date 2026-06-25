import test from "node:test";
import assert from "node:assert/strict";
import { decideFileExecution, DEFAULT_AUTO_PASS_PATTERN_IDS } from "../runnerDecisions";
import type { DetectionResult } from "../gpuDetector";

// Explicit GPU request that is on the auto-pass list.
const autoPassDetection: DetectionResult = {
  requiresGPU: true,
  confidence: "high",
  reasons: ["PyTorch tensor/device is moved to CUDA with `.to(\"cuda\")`."],
  frameworks: ["PyTorch"],
  matchedPatternIds: ["pytorch.to-cuda"]
};

// Explicit GPU request that is NOT (yet) on the auto-pass list.
const offListGpuDetection: DetectionResult = {
  requiresGPU: true,
  confidence: "high",
  reasons: ["TensorFlow MirroredStrategy is used."],
  frameworks: ["TensorFlow"],
  matchedPatternIds: ["tensorflow.mirrored-strategy"]
};

// No GPU request signal at all.
const noRequestDetection: DetectionResult = {
  requiresGPU: false,
  confidence: "low",
  reasons: [],
  frameworks: [],
  matchedPatternIds: []
};

test("auto-passes confirmed explicit requests without prompting", () => {
  const decision = decideFileExecution("always-ask", autoPassDetection);
  assert.equal(decision.mode, "gpu");
  assert.equal(decision.autoPassed, true);
  assert.equal(decision.hasGpuRequest, true);
});

test("uncertain GPU requests fall back to a confirmation prompt", () => {
  const decision = decideFileExecution("always-ask", offListGpuDetection);
  assert.equal(decision.mode, "prompt");
  assert.equal(decision.promptKind, "confirm-gpu-request");
  assert.equal(decision.autoPassed, false);
  assert.equal(decision.hasGpuRequest, true);
});

test("no GPU request offers GPU as a recommendation prompt", () => {
  const decision = decideFileExecution("always-ask", noRequestDetection);
  assert.equal(decision.mode, "prompt");
  assert.equal(decision.promptKind, "recommend-gpu");
  assert.equal(decision.hasGpuRequest, false);
});

test("the auto-pass list works with a single pattern", () => {
  const decision = decideFileExecution("always-ask", autoPassDetection, ["pytorch.to-cuda"]);
  assert.equal(decision.mode, "gpu");
  assert.equal(decision.autoPassed, true);
});

test("a pattern can be added to the auto-pass list without regressing others", () => {
  // tensorflow.mirrored-strategy starts off-list (prompts)...
  assert.equal(
    decideFileExecution("always-ask", offListGpuDetection).mode,
    "prompt"
  );

  // ...and graduates to auto-pass simply by extending the list.
  const grown = [...DEFAULT_AUTO_PASS_PATTERN_IDS, "tensorflow.mirrored-strategy"];
  const decision = decideFileExecution("always-ask", offListGpuDetection, grown);
  assert.equal(decision.mode, "gpu");
  assert.equal(decision.autoPassed, true);

  // The previously auto-passing pattern is unaffected.
  assert.equal(decideFileExecution("always-ask", autoPassDetection, grown).mode, "gpu");
});

test("auto-gpu runs any GPU request on a Pod and everything else locally", () => {
  assert.equal(decideFileExecution("auto-gpu", offListGpuDetection).mode, "gpu");
  assert.equal(decideFileExecution("auto-gpu", noRequestDetection).mode, "local");
});

test("auto-local always runs locally, even for explicit GPU requests", () => {
  const decision = decideFileExecution("auto-local", autoPassDetection);
  assert.equal(decision.mode, "local");
  assert.equal(decision.autoPassed, false);
});

test("a false-negative case (no signal) never auto-passes; it stays a prompt", () => {
  const decision = decideFileExecution("always-ask", noRequestDetection);
  assert.notEqual(decision.mode, "gpu");
  assert.equal(decision.autoPassed, false);
});

test("an off-list explicit request is never silently auto-passed", () => {
  const decision = decideFileExecution("always-ask", offListGpuDetection);
  assert.equal(decision.autoPassed, false);
  assert.equal(decision.mode, "prompt");
});
