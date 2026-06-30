import test from "node:test";
import assert from "node:assert/strict";
import { detectGPUUsage } from "../gpuDetector";

test("detects PyTorch CUDA usage as a GPU signal", () => {
  const result = detectGPUUsage(`
import torch
model = model.to("cuda")
`);

  assert.equal(result.hasGpuSignal, true);
  assert.ok(result.frameworks.includes("PyTorch"));
});

test("treats a conditional CUDA assignment as a GPU signal", () => {
  const result = detectGPUUsage(`
import torch
device = "cuda" if torch.cuda.is_available() else "cpu"
model = model.to(device)
`);

  // The user makes the final call in the prompt; conditional patterns still count as a signal.
  assert.equal(result.hasGpuSignal, true);
  assert.ok(result.frameworks.includes("PyTorch"));
});

test("any matching pattern is a GPU signal, including former medium-confidence ones", () => {
  const result = detectGPUUsage(`
from peft import LoraConfig
trainer = SFTTrainer(...)
`);

  // Behavior change: with confidence grades gone, a single match is enough for hasGpuSignal.
  assert.equal(result.hasGpuSignal, true);
  assert.ok(result.frameworks.includes("HuggingFace"));
});

test("reports no signal for code with no GPU patterns", () => {
  const result = detectGPUUsage(`
import math
print(math.sqrt(2))
`);

  assert.equal(result.hasGpuSignal, false);
  assert.deepEqual(result.frameworks, []);
});

test("deduplicates repeated frameworks", () => {
  const result = detectGPUUsage(`
import torch
tensor = tensor.cuda()
model = model.cuda()
`);

  assert.equal(result.hasGpuSignal, true);
  assert.equal(result.frameworks.filter((framework) => framework === "PyTorch").length, 1);
});
