/**
 * Framework -> container image mapping (REQ-4, preparation stage).
 *
 * When a user explicitly requests a GPU and a Pod is created, we want to pick an image whose
 * framework stack matches the detected code — aligning VS Code's UX with Jupyter's "explicit
 * image selection" model.
 *
 * This module is a pure, side-effect-free helper. The framework selection prompt uses the catalog
 * as its option list, and `resolveFrameworkImage` resolves a framework set to an image (falling
 * back to the caller-supplied image when nothing matches). The catalog is injectable so the source
 * can be swapped — short term via the `gpuRunner.frameworkImages` setting, long term via a cluster
 * ConfigMap — without touching the resolver.
 */

export interface FrameworkImageOption {
  /** Framework name, matching `DetectionResult.frameworks` values from gpuDetector. */
  framework: string;
  /** Container image best suited for that framework. */
  image: string;
}

/**
 * Candidate images in priority order. When code matches multiple frameworks, the first entry in
 * this list whose framework was detected wins. Ordering rationale: specialized serving/runtime
 * stacks (vLLM) and GPU-data stacks (RAPIDS/CuPy) are more specific than the general DL frameworks
 * they build on, so they take precedence; HuggingFace usually rides on top of PyTorch, so PyTorch
 * is listed ahead of it as the base image.
 */
export const DEFAULT_FRAMEWORK_IMAGE_OPTIONS: readonly FrameworkImageOption[] = [
  { framework: "vLLM", image: "vllm/vllm-openai:latest" },
  { framework: "RAPIDS", image: "nvcr.io/nvidia/rapidsai/base:24.06-cuda12.2-py3.11" },
  { framework: "CuPy", image: "cupy/cupy:latest" },
  { framework: "PyTorch", image: "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime" },
  { framework: "HuggingFace", image: "huggingface/transformers-pytorch-gpu:latest" },
  { framework: "TensorFlow", image: "tensorflow/tensorflow:2.16.1-gpu" },
  { framework: "JAX", image: "ghcr.io/nvidia/jax:base" },
  { framework: "Numba", image: "nvidia/cuda:12.1.1-runtime-ubuntu22.04" },
  { framework: "CUDA Tools", image: "nvidia/cuda:12.1.1-runtime-ubuntu22.04" }
];

export interface ResolvedFrameworkImage {
  /** Image to use — either a matched framework image or the supplied fallback. */
  image: string;
  /** The framework that was matched, or undefined when the fallback was used. */
  framework?: string;
}

/**
 * Resolves the image to use for a detected framework set, falling back to `fallbackImage`
 * (typically `gpuRunner.image`) when nothing in `catalog` matches. The catalog defaults to the
 * built-in options but can be overridden (e.g. from `gpuRunner.frameworkImages`).
 */
export function resolveFrameworkImage(
  frameworks: Iterable<string>,
  fallbackImage: string,
  catalog: readonly FrameworkImageOption[] = DEFAULT_FRAMEWORK_IMAGE_OPTIONS
): ResolvedFrameworkImage {
  const detected = frameworks instanceof Set ? frameworks : new Set(frameworks);

  for (const option of catalog) {
    if (detected.has(option.framework)) {
      return { image: option.image, framework: option.framework };
    }
  }

  return { image: fallbackImage };
}

/**
 * Convenience wrapper returning just the resolved image string.
 * Behavior-preserving: returns `fallbackImage` unchanged when no framework matches.
 */
export function selectImageForFrameworks(
  frameworks: Iterable<string>,
  fallbackImage: string,
  catalog: readonly FrameworkImageOption[] = DEFAULT_FRAMEWORK_IMAGE_OPTIONS
): string {
  return resolveFrameworkImage(frameworks, fallbackImage, catalog).image;
}
