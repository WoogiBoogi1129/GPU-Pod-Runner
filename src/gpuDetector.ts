export type DetectionConfidence = "high" | "medium" | "low";

export interface DetectionResult {
  requiresGPU: boolean;
  confidence: DetectionConfidence;
  reasons: string[];
  frameworks: string[];
}

interface DetectionPattern {
  framework: string;
  confidence: DetectionConfidence;
  reason: string;
  regex: RegExp;
}

const PATTERNS: DetectionPattern[] = [
  { framework: "PyTorch", confidence: "high", reason: 'PyTorch tensor/device is moved to CUDA with `.to("cuda")`.', regex: /\.to\(\s*["']cuda(?::\d+)?["']\s*\)/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch tensor or module uses `.cuda()`.", regex: /\.cuda\(\s*\)/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch code sets `device=\"cuda\"`.", regex: /device\s*=\s*["']cuda(?::\d+)?["']/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch checks or uses the `torch.cuda` namespace.", regex: /torch\.cuda\.[A-Za-z_][A-Za-z0-9_]*/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch explicitly creates a CUDA device object.", regex: /torch\.device\(\s*["']cuda(?::\d+)?["']\s*\)/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch DataParallel is imported or referenced.", regex: /\bDataParallel\b/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch DistributedDataParallel is imported or referenced.", regex: /\bDistributedDataParallel\b/g },
  { framework: "PyTorch", confidence: "high", reason: "PyTorch DDP alias is referenced.", regex: /\bDDP\b/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow code scopes execution to a GPU device.", regex: /tf\.device\(\s*["']\/GPU(?::\d+)?["']\s*\)/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow enumerates GPU devices.", regex: /tf\.config\.list_physical_devices\(\s*["']GPU["']\s*\)/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow distribute APIs are used.", regex: /tf\.distribute\.[A-Za-z_][A-Za-z0-9_.]*/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow MirroredStrategy is used.", regex: /\bMirroredStrategy\b/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow MultiWorkerMirroredStrategy is used.", regex: /\bMultiWorkerMirroredStrategy\b/g },
  { framework: "TensorFlow", confidence: "high", reason: "TensorFlow OneDeviceStrategy targets a GPU.", regex: /OneDeviceStrategy\(\s*["']\/GPU(?::\d+)?["']\s*\)/g },
  { framework: "HuggingFace", confidence: "high", reason: "Transformers device mapping is set to auto.", regex: /device_map\s*=\s*["']auto["']/g },
  { framework: "HuggingFace", confidence: "high", reason: "Transformers device mapping is set to CUDA.", regex: /device_map\s*=\s*["']cuda["']/g },
  { framework: "HuggingFace", confidence: "high", reason: "Transformers quantization uses 8-bit loading.", regex: /load_in_8bit\s*=\s*True/g },
  { framework: "HuggingFace", confidence: "high", reason: "Transformers quantization uses 4-bit loading.", regex: /load_in_4bit\s*=\s*True/g },
  { framework: "HuggingFace", confidence: "high", reason: "BitsAndBytesConfig is referenced for quantized GPU loading.", regex: /\bBitsAndBytesConfig\b/g },
  { framework: "HuggingFace", confidence: "medium", reason: "PEFT imports often indicate parameter-efficient GPU fine-tuning.", regex: /from\s+peft\s+import\s+/g },
  { framework: "HuggingFace", confidence: "medium", reason: "TRL SFTTrainer is commonly used with GPU-backed fine-tuning.", regex: /\bSFTTrainer\b/g },
  { framework: "vLLM", confidence: "high", reason: "vLLM is imported.", regex: /(?:from\s+vllm\s+import\s+|import\s+vllm\b)/g },
  { framework: "vLLM", confidence: "high", reason: "vLLM tensor parallelism is configured.", regex: /tensor_parallel_size\s*=/g },
  { framework: "CuPy", confidence: "high", reason: "CuPy is imported.", regex: /\bimport\s+cupy\b|\bfrom\s+cupy\s+import\b/g },
  { framework: "RAPIDS", confidence: "high", reason: "cuDF is imported.", regex: /\bimport\s+cudf\b|\bfrom\s+cudf\s+import\b/g },
  { framework: "RAPIDS", confidence: "high", reason: "cuML is imported.", regex: /\bimport\s+cuml\b|\bfrom\s+cuml\s+import\b/g },
  { framework: "JAX", confidence: "high", reason: "JAX explicitly queries GPU devices.", regex: /jax\.devices\(\s*["']gpu["']\s*\)/g },
  { framework: "JAX", confidence: "high", reason: "JAX device_put is used, often for accelerator placement.", regex: /jax\.device_put\(/g },
  { framework: "Numba", confidence: "high", reason: "Numba CUDA namespace is used.", regex: /numba\.cuda\b/g },
  { framework: "Numba", confidence: "high", reason: "Numba CUDA JIT decorator is used.", regex: /@cuda\.jit\b/g },
  { framework: "CUDA Tools", confidence: "high", reason: "The script invokes `nvidia-smi`.", regex: /nvidia-smi/g },
  { framework: "CUDA Tools", confidence: "medium", reason: "CUDA availability checks often indicate GPU-dependent logic.", regex: /cuda\.is_available\(\)/g }
];

export function detectGPUUsage(source: string): DetectionResult {
  const reasons = new Set<string>();
  const frameworks = new Set<string>();
  let highestConfidence: DetectionConfidence = "low";
  let hasHighConfidence = false;

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (!pattern.regex.test(source)) {
      continue;
    }

    reasons.add(pattern.reason);
    frameworks.add(pattern.framework);

    if (pattern.confidence === "high") {
      hasHighConfidence = true;
      highestConfidence = "high";
      continue;
    }

    if (highestConfidence !== "high" && pattern.confidence === "medium") {
      highestConfidence = "medium";
    }
  }

  return {
    requiresGPU: hasHighConfidence,
    confidence: highestConfidence,
    reasons: [...reasons],
    frameworks: [...frameworks]
  };
}

export function hasHighConfidenceGPUUsage(source: string): boolean {
  return detectGPUUsage(source).requiresGPU;
}
