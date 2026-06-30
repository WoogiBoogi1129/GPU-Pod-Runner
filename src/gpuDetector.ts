export interface DetectionResult {
  /** True when the source contains at least one GPU/framework usage signal. */
  hasGpuSignal: boolean;
  /** Frameworks whose patterns matched, used to seed the framework selection prompt. */
  frameworks: string[];
}

interface DetectionPattern {
  framework: string;
  regex: RegExp;
}

const PATTERNS: DetectionPattern[] = [
  { framework: "PyTorch", regex: /\.to\(\s*["']cuda(?::\d+)?["']\s*\)/g },
  { framework: "PyTorch", regex: /\.cuda\(\s*\)/g },
  { framework: "PyTorch", regex: /device\s*=\s*["']cuda(?::\d+)?["']/g },
  { framework: "PyTorch", regex: /torch\.cuda\.[A-Za-z_][A-Za-z0-9_]*/g },
  { framework: "PyTorch", regex: /torch\.device\(\s*["']cuda(?::\d+)?["']\s*\)/g },
  { framework: "PyTorch", regex: /\bDataParallel\b/g },
  { framework: "PyTorch", regex: /\bDistributedDataParallel\b/g },
  { framework: "PyTorch", regex: /\bDDP\b/g },
  { framework: "TensorFlow", regex: /tf\.device\(\s*["']\/GPU(?::\d+)?["']\s*\)/g },
  { framework: "TensorFlow", regex: /tf\.config\.list_physical_devices\(\s*["']GPU["']\s*\)/g },
  { framework: "TensorFlow", regex: /tf\.distribute\.[A-Za-z_][A-Za-z0-9_.]*/g },
  { framework: "TensorFlow", regex: /\bMirroredStrategy\b/g },
  { framework: "TensorFlow", regex: /\bMultiWorkerMirroredStrategy\b/g },
  { framework: "TensorFlow", regex: /OneDeviceStrategy\(\s*["']\/GPU(?::\d+)?["']\s*\)/g },
  { framework: "HuggingFace", regex: /device_map\s*=\s*["']auto["']/g },
  { framework: "HuggingFace", regex: /device_map\s*=\s*["']cuda["']/g },
  { framework: "HuggingFace", regex: /load_in_8bit\s*=\s*True/g },
  { framework: "HuggingFace", regex: /load_in_4bit\s*=\s*True/g },
  { framework: "HuggingFace", regex: /\bBitsAndBytesConfig\b/g },
  { framework: "HuggingFace", regex: /from\s+peft\s+import\s+/g },
  { framework: "HuggingFace", regex: /\bSFTTrainer\b/g },
  { framework: "vLLM", regex: /(?:from\s+vllm\s+import\s+|import\s+vllm\b)/g },
  { framework: "vLLM", regex: /tensor_parallel_size\s*=/g },
  { framework: "CuPy", regex: /\bimport\s+cupy\b|\bfrom\s+cupy\s+import\b/g },
  { framework: "RAPIDS", regex: /\bimport\s+cudf\b|\bfrom\s+cudf\s+import\b/g },
  { framework: "RAPIDS", regex: /\bimport\s+cuml\b|\bfrom\s+cuml\s+import\b/g },
  { framework: "JAX", regex: /jax\.devices\(\s*["']gpu["']\s*\)/g },
  { framework: "JAX", regex: /jax\.device_put\(/g },
  { framework: "Numba", regex: /numba\.cuda\b/g },
  { framework: "Numba", regex: /@cuda\.jit\b/g },
  { framework: "CUDA Tools", regex: /nvidia-smi/g },
  { framework: "CUDA Tools", regex: /cuda\.is_available\(\)/g }
];

/**
 * Scans Python source for GPU/framework usage. Static regex matching cannot prove intent, so the
 * result is intentionally coarse: `hasGpuSignal` is true when *any* pattern matches, and the user
 * makes the final allocation decision in the pre-execution prompt. The matched `frameworks` seed
 * the framework selection step (and its default).
 */
export function detectGPUUsage(source: string): DetectionResult {
  const frameworks = new Set<string>();

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(source)) {
      frameworks.add(pattern.framework);
    }
  }

  return {
    hasGpuSignal: frameworks.size > 0,
    frameworks: [...frameworks]
  };
}
