import test from "node:test";
import assert from "node:assert/strict";
import { detectGPUUsage } from "../gpuDetector";

test("detects high-confidence PyTorch CUDA usage", () => {
  const result = detectGPUUsage(`
import torch
model = model.to("cuda")
`);

  assert.equal(result.requiresGPU, true);
  assert.equal(result.confidence, "high");
  assert.ok(result.frameworks.includes("PyTorch"));
  assert.ok(result.matchedPatternIds.includes("pytorch.to-cuda"));
});

test("treats a conditional CUDA assignment as an explicit GPU request", () => {
  const result = detectGPUUsage(`
import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
model = model.to(device)
`);

  // Per REQ-2, conditional patterns are GPU requests, not a separate category.
  assert.equal(result.requiresGPU, true);
  assert.ok(result.matchedPatternIds.includes("pytorch.device-literal"));
});

test("detects medium-confidence HuggingFace fine-tuning patterns without forcing GPU", () => {
  const result = detectGPUUsage(`
from peft import LoraConfig
trainer = SFTTrainer(...)
`);

  assert.equal(result.requiresGPU, false);
  assert.equal(result.confidence, "medium");
  assert.ok(result.frameworks.includes("HuggingFace"));
});

test("deduplicates repeated reasons and frameworks", () => {
  const result = detectGPUUsage(`
import torch
tensor = tensor.cuda()
model = model.cuda()
`);

  assert.equal(result.requiresGPU, true);
  assert.equal(result.frameworks.filter((framework) => framework === "PyTorch").length, 1);
  assert.equal(result.reasons.length, 1);
});
