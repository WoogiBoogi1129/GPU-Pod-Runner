import test from "node:test";
import assert from "node:assert/strict";
import { decideFileExecutionMode } from "../runnerDecisions";
import type { DetectionResult } from "../gpuDetector";

const gpuDetection: DetectionResult = {
  requiresGPU: true,
  confidence: "high",
  reasons: ["PyTorch tensor/device is moved to CUDA with `.to(\"cuda\")`."],
  frameworks: ["PyTorch"]
};

const localDetection: DetectionResult = {
  requiresGPU: false,
  confidence: "low",
  reasons: [],
  frameworks: []
};

test("always asks for high-confidence GPU detections", () => {
  assert.equal(decideFileExecutionMode("always-ask", gpuDetection), "prompt");
});

test("auto-gpu bypasses the prompt for GPU detections", () => {
  assert.equal(decideFileExecutionMode("auto-gpu", gpuDetection), "gpu");
});

test("auto-local forces local execution even for GPU detections", () => {
  assert.equal(decideFileExecutionMode("auto-local", gpuDetection), "local");
});

test("non-GPU detections run locally", () => {
  assert.equal(decideFileExecutionMode("always-ask", localDetection), "local");
});
