import test from "node:test";
import assert from "node:assert/strict";
import { resolveFrameworkImage, selectImageForFrameworks } from "../frameworkImages";

const FALLBACK = "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime";

test("selects a framework-specific image for a single detected framework", () => {
  const resolved = resolveFrameworkImage(["TensorFlow"], FALLBACK);
  assert.equal(resolved.framework, "TensorFlow");
  assert.match(resolved.image, /tensorflow/);
});

test("prefers the more specific framework when several are detected", () => {
  // vLLM rides on PyTorch but is the more specific runtime, so it wins.
  const resolved = resolveFrameworkImage(["PyTorch", "vLLM"], FALLBACK);
  assert.equal(resolved.framework, "vLLM");
});

test("prefers PyTorch base image over HuggingFace when both are present", () => {
  const resolved = resolveFrameworkImage(["HuggingFace", "PyTorch"], FALLBACK);
  assert.equal(resolved.framework, "PyTorch");
});

test("is behavior-preserving: unknown frameworks return the fallback image", () => {
  const resolved = resolveFrameworkImage(["SomethingUnknown"], FALLBACK);
  assert.equal(resolved.image, FALLBACK);
  assert.equal(resolved.framework, undefined);
});

test("is behavior-preserving: an empty framework set returns the fallback image", () => {
  assert.equal(selectImageForFrameworks([], FALLBACK), FALLBACK);
});

test("selectImageForFrameworks returns just the image string", () => {
  assert.equal(selectImageForFrameworks(["JAX"], FALLBACK), "ghcr.io/nvidia/jax:base");
});
