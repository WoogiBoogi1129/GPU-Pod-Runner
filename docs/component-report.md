# GPU Pod Runner — VS Code Extension 구성요소별 동작 원리 보고서

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [구성요소별 동작 원리](#2-구성요소별-동작-원리)
   - 2.1 [진입점 — `extension.ts`](#21-진입점--extensionts)
   - 2.2 [GPU 패턴 감지 — `gpuDetector.ts`](#22-gpu-패턴-감지--gpudetectorts)
   - 2.3 [실행 모드 결정 — `runnerDecisions.ts`](#23-실행-모드-결정--runnerdecisionsts)
   - 2.4 [Kubernetes Pod 관리 — `podManager.ts`](#24-kubernetes-pod-관리--podmanagerts)
   - 2.5 [UI 상태 관리 — `statusBar.ts`](#25-ui-상태-관리--statusbarts)
   - 2.6 [설정 관리 — `config.ts`](#26-설정-관리--configts)
3. [전체 실행 흐름](#3-전체-실행-흐름)
4. [Kubernetes 인프라 구성](#4-kubernetes-인프라-구성)
5. [빌드 및 테스트 구조](#5-빌드-및-테스트-구조)
6. [제약 사항 및 확장 포인트](#6-제약-사항-및-확장-포인트)

---

## 1. 프로젝트 개요

**GPU Pod Runner**는 Python 코드에서 GPU 사용 패턴을 자동 감지하여, Kubernetes GPU Pod 위에서 해당 코드를 실행할 수 있도록 돕는 VS Code Extension입니다. 개발자는 별도의 Kubernetes 명령어 없이 VS Code 명령 팔레트 또는 단축키만으로 원격 GPU 환경에서 코드를 실행할 수 있습니다.

### 핵심 아키텍처

```
┌────────────────────────────────────────────────────────────┐
│                     VS Code Extension                      │
│                                                            │
│  extension.ts ─────────────────────────────────────────┐  │
│  (진입점 / 오케스트레이터)                              │  │
│       │                                                 │  │
│       ├─── gpuDetector.ts (GPU 패턴 감지)               │  │
│       ├─── runnerDecisions.ts (실행 모드 결정)          │  │
│       ├─── podManager.ts (Kubernetes 리소스 관리)       │  │
│       ├─── statusBar.ts (UI 상태 / WebView)             │  │
│       └─── config.ts (설정 로드)                        │  │
│                                                         │  │
└─────────────────────────────────────────────────────────┘  │
                                                             │
        ↓  @kubernetes/client-node  ↓                        │
┌────────────────────────────────┐                           │
│     Kubernetes Cluster         │                           │
│  ┌──────────┐  ┌────────────┐  │                           │
│  │  GPU Pod │  │ ConfigMap  │  │                           │
│  └──────────┘  └────────────┘  │                           │
│  ┌──────────────────────────┐  │                           │
│  │  PVC (shared-workspace)  │  │                           │
│  └──────────────────────────┘  │                           │
└────────────────────────────────┘
```

### 구성 파일 목록

| 파일 | 역할 |
|------|------|
| [src/extension.ts](../src/extension.ts) | 진입점, 명령 등록, 오케스트레이션 |
| [src/gpuDetector.ts](../src/gpuDetector.ts) | 정규식 기반 GPU 패턴 감지 |
| [src/runnerDecisions.ts](../src/runnerDecisions.ts) | 실행 모드 결정 로직 |
| [src/podManager.ts](../src/podManager.ts) | Kubernetes Pod / ConfigMap 관리 |
| [src/statusBar.ts](../src/statusBar.ts) | VS Code UI (상태바, 프롬프트, WebView) |
| [src/config.ts](../src/config.ts) | 설정 모델 및 로드 |
| [k8s/rbac.yaml](../k8s/rbac.yaml) | ServiceAccount, Role, RoleBinding |
| [k8s/shared-pvc.yaml](../k8s/shared-pvc.yaml) | 공유 PVC (ReadWriteMany) |

---

## 2. 구성요소별 동작 원리

---

### 2.1 진입점 — `extension.ts`

**역할**: Extension의 생명주기 관리, 모든 모듈의 초기화 및 연결, 명령과 이벤트 구독 등록.

#### 생명주기: `activate()` / `deactivate()`

VS Code는 Extension이 처음 활성화될 때 `activate()` 함수를 호출합니다. 이 함수는 다음 순서로 초기화를 수행합니다.

```
activate()
  │
  ├─ 1. OutputChannel 생성 ("GPU Pod Runner")
  ├─ 2. loadConfig() → 사용자 설정 로드
  ├─ 3. new PodManager(config) → Kubernetes 클라이언트 초기화
  ├─ 4. new StatusBarController() → 상태바 생성 및 표시
  ├─ 5. 4개 명령 등록 (registerCommand)
  ├─ 6. 이벤트 구독 등록 (파일 저장, 설정 변경)
  └─ 7. refreshRunningState() → 초기 상태 확인
```

Extension이 비활성화될 때 `deactivate()`가 호출되며, 이 시점에 `deleteAllManagedPods()`를 실행하여 관리 중인 모든 Kubernetes Pod를 삭제합니다.

#### 등록 명령어

| 명령 ID | 단축키 | 기능 |
|---------|--------|------|
| `gpu-runner.runFile` | Ctrl+Shift+G | 현재 활성 Python 파일을 GPU Pod에서 실행 |
| `gpu-runner.runSelection` | (컨텍스트 메뉴) | 선택된 Python 코드를 GPU Pod에서 실행 |
| `gpu-runner.showStatus` | (상태바 클릭) | GPU Pod 상태 WebView 패널 표시 |
| `gpu-runner.cleanup` | (명령 팔레트) | 관리 중인 모든 Pod 일괄 삭제 |

#### 이벤트 구독 (Disposable 패턴)

```typescript
// 파일 저장 시 자동 GPU 감지
vscode.workspace.onDidSaveTextDocument(async (document) => {
  if (!currentConfig?.autoDetect || document.languageId !== "python") return;
  const detection = detectGPUUsage(document.getText());
  if (detection.requiresGPU) {
    statusBar.showHighConfidenceHint(detection.frameworks);
  }
});

// 설정 변경 시 PodManager 재초기화
vscode.workspace.onDidChangeConfiguration((event) => {
  if (!event.affectsConfiguration("gpuRunner")) return;
  currentConfig = loadConfig();
  podManager = createPodManager(currentConfig);
  void refreshRunningState();
});
```

등록된 모든 명령, 이벤트 리스너, UI 컴포넌트는 `context.subscriptions`에 추가됩니다. VS Code가 Extension을 비활성화할 때 이 배열의 모든 항목을 자동으로 `dispose()`합니다.

#### 파일 실행 핵심 함수: `runCurrentFile()`

```
runCurrentFile()
  │
  ├─ 활성 편집기 및 Python 파일 여부 검증
  ├─ statusBar.setState("scanning")
  ├─ detectGPUUsage(document.getText())
  ├─ decideFileExecutionMode(config.autoDetectPrompt, detection)
  │
  ├─ "local" → runFileLocally(filePath)
  │            └─ VS Code 터미널에서 python "<filePath>" 실행
  │
  ├─ "prompt" → statusBar.promptForExecution(detection)
  │             ├─ "local" → runFileLocally()
  │             └─ "gpu"   → runGpuTarget()
  │
  └─ "gpu" → runGpuTarget(target)
             ├─ podManager.createAndRun(target)
             ├─ podManager.waitForPodPhase(["Succeeded", "Failed"], timeout)
             ├─ podManager.streamLogs(podName, outputChannel)
             └─ podManager.deletePod(run)  ← finally 블록에서 반드시 실행
```

#### 로컬 터미널 실행: `runFileLocally()`

"GPU Runner Local"이라는 이름의 터미널을 찾아 재사용하거나 없으면 새로 생성합니다. 파일 경로의 큰따옴표를 이스케이프(`""`)한 뒤 `python "<path>"` 명령을 전송합니다.

#### 상태 동기화: `refreshRunningState()`

`listManagedPods()`로 현재 Pod 목록을 조회한 뒤, `Succeeded` / `Failed` 상태가 아닌 Pod가 하나라도 있으면 상태바를 `"running"`으로 설정합니다. 모두 완료된 경우, 현재 상태가 `"completed"` 또는 `"error"`가 아닐 때만 `"idle"`로 전환합니다.

---

### 2.2 GPU 패턴 감지 — `gpuDetector.ts`

**역할**: Python 소스 코드 문자열을 입력받아 정규식으로 GPU 사용 패턴을 탐색하고, 감지 결과와 신뢰도를 반환합니다.

#### 반환 타입: `DetectionResult`

```typescript
interface DetectionResult {
  requiresGPU: boolean;          // high-confidence 패턴이 하나라도 있으면 true
  confidence: "high" | "medium" | "low";  // 감지된 패턴 중 최고 신뢰도
  reasons: string[];             // 감지 이유 목록 (중복 제거됨)
  frameworks: string[];          // 감지된 프레임워크 목록 (중복 제거됨)
}
```

#### 신뢰도(Confidence) 분류 기준

| 신뢰도 | 의미 | `requiresGPU` |
|--------|------|---------------|
| **High** | GPU 없이는 실행 불가능한 명시적 패턴 | `true` |
| **Medium** | GPU 환경에서 주로 쓰이나 CPU에서도 동작 가능한 패턴 | `false` |
| **Low** | 아무 패턴도 감지되지 않은 상태 | `false` |

#### 지원 프레임워크 및 패턴 (총 32개)

| 프레임워크 | 신뢰도 | 감지 패턴 예시 |
|-----------|--------|--------------|
| **PyTorch** | High | `.to("cuda")`, `.cuda()`, `device="cuda"`, `torch.cuda.*`, `torch.device("cuda")`, `DataParallel`, `DistributedDataParallel`, `DDP` |
| **TensorFlow** | High | `tf.device('/GPU:')`, `tf.config.list_physical_devices('GPU')`, `tf.distribute.*`, `MirroredStrategy`, `MultiWorkerMirroredStrategy`, `OneDeviceStrategy('/GPU:')` |
| **HuggingFace** | High | `device_map="auto"`, `device_map="cuda"`, `load_in_8bit=True`, `load_in_4bit=True`, `BitsAndBytesConfig` |
| **HuggingFace** | Medium | `from peft import`, `SFTTrainer` |
| **vLLM** | High | `import vllm`, `from vllm import`, `tensor_parallel_size=` |
| **CuPy** | High | `import cupy`, `from cupy import` |
| **RAPIDS** | High | `import cudf`, `import cuml` |
| **JAX** | High | `jax.devices('gpu')`, `jax.device_put(` |
| **Numba** | High | `numba.cuda`, `@cuda.jit` |
| **CUDA Tools** | High | `nvidia-smi` |
| **CUDA Tools** | Medium | `cuda.is_available()` |

#### 감지 알고리즘

```typescript
export function detectGPUUsage(source: string): DetectionResult {
  const reasons = new Set<string>();
  const frameworks = new Set<string>();
  let highestConfidence: DetectionConfidence = "low";
  let hasHighConfidence = false;

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;          // 전역 정규식 상태 초기화
    if (!pattern.regex.test(source)) continue;

    reasons.add(pattern.reason);          // Set으로 중복 자동 제거
    frameworks.add(pattern.framework);

    if (pattern.confidence === "high") {
      hasHighConfidence = true;
      highestConfidence = "high";
    } else if (highestConfidence !== "high" && pattern.confidence === "medium") {
      highestConfidence = "medium";
    }
  }

  return {
    requiresGPU: hasHighConfidence,       // High 패턴이 하나라도 있어야 true
    confidence: highestConfidence,
    reasons: [...reasons],
    frameworks: [...frameworks]
  };
}
```

`Set`을 사용하여 동일한 프레임워크나 이유가 여러 번 감지되어도 결과에는 한 번만 포함됩니다. 전역 플래그(`/g`)가 있는 정규식은 `lastIndex`를 매 검사 전에 `0`으로 초기화하여 이전 매칭 위치가 다음 검사에 영향을 미치지 않도록 합니다.

---

### 2.3 실행 모드 결정 — `runnerDecisions.ts`

**역할**: GPU 감지 결과와 사용자 설정(`autoDetectPrompt`)을 조합하여 실행 모드를 결정합니다.

#### 반환 타입: `FileExecutionMode`

```typescript
type FileExecutionMode = "gpu" | "local" | "prompt";
```

#### 결정 트리

```
decideFileExecutionMode(promptMode, detection)
  │
  ├─ detection.requiresGPU === false
  │    └─ → "local"  (GPU 코드가 아니면 무조건 로컬)
  │
  ├─ detection.requiresGPU === true
  │    ├─ promptMode === "auto-gpu"   → "gpu"    (자동으로 GPU Pod 실행)
  │    ├─ promptMode === "auto-local" → "local"  (GPU 코드도 로컬 강제)
  │    └─ promptMode === "always-ask" → "prompt" (사용자에게 선택 요청)
  │
  └─ (결과를 extension.ts가 소비하여 실제 실행 분기 처리)
```

#### `autoDetectPrompt` 설정값 의미

| 설정값 | 동작 |
|--------|------|
| `"always-ask"` (기본값) | High-confidence GPU 코드 감지 시 항상 프롬프트 표시 |
| `"auto-gpu"` | High-confidence GPU 코드 감지 시 자동으로 GPU Pod 실행 |
| `"auto-local"` | GPU 코드가 감지되어도 항상 로컬 터미널에서 실행 |

---

### 2.4 Kubernetes Pod 관리 — `podManager.ts`

**역할**: `@kubernetes/client-node` 라이브러리를 통해 Kubernetes API와 직접 통신하며, Pod 및 ConfigMap의 전체 생명주기(생성 → 대기 → 로그 수집 → 삭제)를 관리합니다.

#### 실행 대상 타입 (ExecutionTarget)

Extension은 두 가지 실행 방식을 지원하며, 각각 다른 Kubernetes 리소스 구성을 사용합니다.

| 타입 | 실행 방식 | Python 경로 |
|------|----------|------------|
| `WorkspaceFileTarget` | 워크스페이스 파일을 PVC 경로로 매핑하여 실행 | `/workspace/...` (PVC 마운트) |
| `SelectionTarget` | 선택 코드를 ConfigMap에 저장 후 볼륨으로 마운트하여 실행 | `/opt/gpu-runner/selection.py` (ConfigMap 마운트) |

#### PodManager 초기화: `updateConfig()`

```
updateConfig(config)
  │
  ├─ kubeconfigPath 해석
  │    ├─ 설정값 있음 → 해당 경로 사용 (~ 홈 디렉토리 확장)
  │    └─ 설정값 없음 → ~/.kube/config 기본 경로
  │
  ├─ kubeConfig.loadFromFile(kubeconfigPath)
  │
  ├─ 현재 클러스터의 API 서버 URL 정규화
  │    └─ normalizeKubeApiServerUrl(server, tlsServerName)
  │         ├─ Loopback 주소(127.0.0.1, ::1, localhost)인 경우
  │         │   → tlsServerName으로 호스트 교체 (SSH 포트 포워딩 대응)
  │         └─ 그 외 → 변경 없음
  │
  └─ kubeConfig.makeApiClient(CoreV1Api)
```

**`normalizeKubeApiServerUrl`의 필요성**: kubeconfig의 API 서버 주소가 `127.0.0.1`(SSH 터널)로 설정되어 있으면 TLS 인증서 검증이 실패합니다. `tlsServerName` 필드에 실제 서버 주소가 있을 때 이를 호스트로 치환하여 인증서 검증이 올바르게 동작하도록 합니다.

#### Pod 및 ConfigMap 생성: `createAndRun()`

```
createAndRun(target)
  │
  ├─ buildManagedPodName(target.displayName)
  │    └─ "gpu-{sanitized-name}-{5자리 난수}" 형식
  │       예: gpu-train-abc12
  │
  ├─ [Selection인 경우만]
  │    ├─ configMapName = "{podName}-cm"
  │    ├─ buildSelectionConfigMapManifest() → ConfigMap 객체 생성
  │    └─ coreApi.createNamespacedConfigMap() → K8s에 생성
  │
  ├─ buildPodManifest(config, target, podName, namespace, configMapName?)
  │    └─ Pod 객체 빌드 (아래 섹션 참조)
  │
  └─ coreApi.createNamespacedPod() → K8s에 생성
     └─ ManagedPodRun 반환 { podName, namespace, configMapName? }
```

#### Pod 매니페스트 구조

```
Pod
├── metadata
│   ├── labels: { managed-by: vscode-gpu-runner }  ← 리소스 추적용
│   └── annotations
│       ├── gpu-runner/execution-kind: "workspace-file" | "selection"
│       ├── gpu-runner/source-path: 로컬 파일 절대경로
│       └── gpu-runner/configmap-name: "{podName}-cm"  (selection만)
│
└── spec
    ├── restartPolicy: "Never"        ← 완료 후 재시작 안 함
    ├── serviceAccountName: "gpu-runner-sa"
    ├── volumes
    │   ├── workspace (PVC: shared-workspace-pvc)
    │   └── selection-script (ConfigMap: {podName}-cm)  (selection만)
    └── containers[0] (name: "runner")
        ├── image: {config.image}
        ├── command: ["python", "{target.podScriptPath}"]
        ├── workingDir: {config.workspaceMountPath}
        ├── volumeMounts
        │   ├── /workspace ← PVC
        │   └── /opt/gpu-runner ← ConfigMap (selection만, readOnly)
        └── resources
            ├── [일반 모드] limits/requests: { nvidia.com/gpu: "1" }
            └── [HAMi 모드] limits/requests: { nvidia.com/gpumem: "8000" }
```

#### 경로 매핑: 로컬 → Pod 내부

워크스페이스 파일 실행 시, 로컬 경로를 PVC 내 경로로 변환합니다.

```
mapWorkspaceFileToPodPath(workspaceRoot, filePath, workspaceMountPath)

입력:
  workspaceRoot      = "C:\GPU-Pod-Runner"
  filePath           = "C:\GPU-Pod-Runner\examples\train.py"
  workspaceMountPath = "/workspace"

처리:
  relativePath = path.relative(workspaceRoot, filePath)
               = "examples\train.py"
  posixPath    = toPosixPath(relativePath)
               = "examples/train.py"
  결과         = path.posix.join("/workspace", "examples/train.py")
               = "/workspace/examples/train.py"
```

워크스페이스 루트 외부 경로(`..`로 시작하는 상대경로)는 오류를 발생시켜 거부합니다.

#### Pod 완료 대기: `waitForPodPhase()`

2초 간격의 폴링 루프로 Pod 상태를 조회합니다.

```typescript
while (Date.now() - startedAt < timeoutMs) {
  const response = await coreApi.readNamespacedPod(podName, namespace);
  const phase = response.body.status?.phase ?? "Unknown";
  if (phases.includes(phase)) return phase;   // "Succeeded" 또는 "Failed"
  await delay(2000);
}
throw new Error(`Timed out after ${timeoutMs / 1000}s`);
```

기본 타임아웃은 600초(10분)이며 `podTimeoutSeconds` 설정으로 조정할 수 있습니다.

#### 로그 수집: `streamLogs()`

Pod 완료 후 `readNamespacedPodLog()`를 호출하여 최근 500줄을 읽어 Output Channel에 출력합니다. 실시간 스트리밍이 아닌 완료 후 일괄 수집입니다.

#### 리소스 정리

| 함수 | 동작 |
|------|------|
| `deletePod(run)` | 단일 Pod 삭제, 연결된 ConfigMap이 있으면 함께 삭제. 404 오류는 무시. |
| `deleteAllManagedPods()` | `managed-by=vscode-gpu-runner` 레이블로 필터링한 모든 Pod/ConfigMap을 `Promise.all()`로 병렬 삭제. |

---

### 2.5 UI 상태 관리 — `statusBar.ts`

**역할**: VS Code 상태바 아이템 관리, 사용자 프롬프트 표시, WebView 기반 상태 패널 제공.

#### 상태 머신: `RunnerState`

```
         명령 실행
  idle ──────────→ scanning ──→ (GPU 감지)
   ↑                               │
   │ 3초 후 자동                   ├──→ local ──→ idle
   │                               │
   └── completed ←── Succeeded     └──→ running ──→ completed
                                              │
       error ←──────── Failed ───────────────┘
         │
         └──→ (사용자 상호작용 후) idle
```

#### 상태별 상태바 표시

| 상태 | 아이콘 + 텍스트 | 툴팁 |
|------|----------------|------|
| `idle` | `$(server) GPU Runner` | GPU Pod Runner |
| `scanning` | `$(loading~spin) 스캔 중...` | Scanning Python code for GPU usage |
| `running` | `$(zap) GPU Pod 실행 중 (N)` | GPU Pods are running |
| `completed` | `$(check) 완료` | Last GPU run completed |
| `error` | `$(error) 오류 발생` | The last GPU run ended with an error |

`completed` 상태는 3초 후 자동으로 전환됩니다. 아직 실행 중인 Pod가 있으면 `running`으로, 없으면 `idle`로 돌아갑니다.

#### 사용자 프롬프트: `promptForExecution()`

`always-ask` 모드에서 GPU 코드가 감지되면 비모달 알림을 표시합니다.

```
"🎮 GPU 코드 감지됨 [PyTorch, HuggingFace]"
  ┌──────────────┐  ┌────────────┐
  │ GPU Pod 실행 │  │  로컬 실행  │  ← 닫기(undefined) 포함 3가지 선택
  └──────────────┘  └────────────┘
```

반환값: `"gpu"` | `"local"` | `undefined`(닫기)

#### 파일 저장 시 힌트: `showHighConfidenceHint()`

파일 저장 이벤트에서 GPU 코드가 감지될 때, 상태바 텍스트를 5초간 `$(zap) GPU 감지됨: PyTorch, ...`로 임시 변경 후 원래 상태로 복원합니다.

#### WebView 상태 패널: `showStatusPanel()`

상태바 클릭 또는 `gpu-runner.showStatus` 명령으로 열리는 WebView 패널입니다.

```
┌─────────────────────────────────────────────────────┐
│  GPU Pod Runner Status                              │
│  [Refresh]  [Cleanup All]                           │
├────────────────┬──────────┬─────────┬───────┬───────┤
│ Pod            │ Phase    │ Kind    │Source │Created│
├────────────────┼──────────┼─────────┼───────┼───────┤
│ gpu-train-abc12│ Running  │ ws-file │...    │...    │
└────────────────┴──────────┴─────────┴───────┴───────┘
```

- HTML은 VS Code 테마 CSS 변수(`--vscode-foreground` 등)를 사용하여 다크/라이트 모드 자동 대응
- JavaScript가 5초마다 `vscode.postMessage({ type: "refresh" })`를 전송하여 자동 갱신
- `Refresh` / `Cleanup All` 버튼 클릭 시 동일한 메시지 채널로 Extension에 이벤트 전달
- HTML 출력에는 `escapeHtml()`을 적용하여 XSS를 방지

---

### 2.6 설정 관리 — `config.ts`

**역할**: `GPURunnerConfig` 인터페이스 정의와 VS Code workspace 설정에서 값을 읽는 `loadConfig()` 함수를 제공합니다.

#### GPURunnerConfig 전체 항목

| 항목 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `namespace` | string | `"ml-dev"` | Pod를 생성할 Kubernetes 네임스페이스 |
| `image` | string | `"pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime"` | 컨테이너 이미지 |
| `useHAMi` | boolean | `false` | HAMi fractional GPU 모드 활성화 여부 |
| `gpuMemoryMB` | number | `8000` | HAMi 모드 시 요청할 GPU 메모리(MB) |
| `gpuCount` | number | `1` | 일반 모드 시 요청할 GPU 개수 |
| `pvcName` | string | `"shared-workspace-pvc"` | 워크스페이스 공유에 사용할 PVC 이름 |
| `workspaceMountPath` | string | `"/workspace"` | Pod 내 PVC 마운트 경로 |
| `podTimeoutSeconds` | number | `600` | Pod 완료 대기 최대 시간(초) |
| `autoDetect` | boolean | `true` | 파일 저장 시 자동 GPU 감지 여부 |
| `autoDetectPrompt` | AutoDetectPrompt | `"always-ask"` | GPU 감지 후 동작 (`always-ask` / `auto-gpu` / `auto-local`) |
| `kubeconfigPath` | string | `""` | kubeconfig 파일 경로 (빈 값이면 `~/.kube/config` 사용) |
| `apiServerUrl` | string | `""` | 향후 백엔드 모드 예약 항목 (v1에서는 미사용) |

#### 설정 로드

```typescript
export function loadConfig(): GPURunnerConfig {
  const config = vscode.workspace.getConfiguration("gpuRunner");
  return {
    namespace:        config.get<string>("namespace", "ml-dev"),
    image:            config.get<string>("image", "pytorch/pytorch:..."),
    // ... 나머지 항목들
  };
}
```

`vscode.workspace.getConfiguration("gpuRunner")`는 VS Code의 설정 해석 우선순위(워크스페이스 설정 > 사용자 설정 > 기본값)를 자동으로 적용합니다.

---

## 3. 전체 실행 흐름

### 3.1 파일 실행 시퀀스

```
사용자: Ctrl+Shift+G (또는 "Run File on GPU Pod" 명령)
  │
  ▼
extension.ts: runCurrentFile()
  ├─ [검증] 활성 편집기 존재 여부, Python 파일 여부
  ├─ statusBar.setState("scanning")
  │
  ▼
gpuDetector.ts: detectGPUUsage(source)
  └─ 32개 정규식 패턴 순회 → DetectionResult 반환
  │
  ▼
runnerDecisions.ts: decideFileExecutionMode(promptMode, detection)
  └─ "local" | "gpu" | "prompt" 반환
  │
  ├─ "local" ──→ extension.ts: runFileLocally()
  │               └─ VS Code 터미널: python "<path>"
  │
  ├─ "prompt" ──→ statusBar.ts: promptForExecution()
  │               ├─ "local" → runFileLocally()
  │               ├─ "gpu"   → runGpuTarget()
  │               └─ undefined → 취소
  │
  └─ "gpu" ──→ extension.ts: runGpuTarget()
               │
               ├─ podManager.createAndRun(WorkspaceFileTarget)
               │    └─ K8s: createNamespacedPod()
               │
               ├─ statusBar.setState("running", count)
               │
               ├─ podManager.waitForPodPhase(["Succeeded","Failed"], timeout)
               │    └─ 2초 간격 폴링 → phase 반환
               │
               ├─ podManager.streamLogs(podName, outputChannel)
               │    └─ K8s: readNamespacedPodLog() → 최근 500줄
               │
               ├─ statusBar.setState("completed") or "error"
               │
               └─ [finally] podManager.deletePod(run)
                    └─ K8s: deleteNamespacedPod() + deleteNamespacedConfigMap()
```

### 3.2 선택 코드 실행 시퀀스

파일 실행과 달리, 선택 코드 실행은 ConfigMap을 통해 코드를 Pod에 전달합니다.

```
사용자: Python 코드 선택 → "Run Selection on GPU Pod" (우클릭 메뉴)
  │
  ▼
extension.ts: runSelectionInGpuPod()
  ├─ 선택 텍스트 추출 (editor.selection)
  └─ SelectionTarget 생성
       { kind: "selection", code: "선택된 코드", podScriptPath: "/opt/gpu-runner/selection.py" }
  │
  ▼
podManager.createAndRun(SelectionTarget)
  ├─ 1. buildSelectionConfigMapManifest()
  │       ConfigMap { data: { "selection.py": "선택된 코드" } }
  ├─ 2. coreApi.createNamespacedConfigMap()   ← 선택 코드 저장
  ├─ 3. buildPodManifest(..., configMapName)
  │       volumes: [PVC(workspace), ConfigMap(selection-script)]
  │       command: ["python", "/opt/gpu-runner/selection.py"]
  └─ 4. coreApi.createNamespacedPod()
  │
  ▼ (이후 파일 실행과 동일한 대기 → 로그 → 삭제 흐름)
```

### 3.3 상태 전이 다이어그램

```
        ┌─────────────────────┐
        │        idle         │◄─────────────────────────────────┐
        └──────────┬──────────┘                                  │
                   │ 명령 실행                                    │
                   ▼                                             │
        ┌─────────────────────┐                                  │
        │      scanning       │                                  │
        └──────────┬──────────┘                                  │
                   │ detectGPUUsage()                            │
                   ▼                                             │
           ┌───────┴───────┐                                     │
     local │               │ gpu / prompt→gpu                    │ 3초
           ▼               ▼                                     │
         [터미널]  ┌─────────────────────┐                       │
                  │      running        │                        │
                  └──────────┬──────────┘                        │
                             │ Pod 완료                          │
                   ┌─────────┴──────────┐                        │
              fail │                    │ succeed                │
                   ▼                    ▼                        │
        ┌──────────────┐    ┌──────────────────┐                 │
        │    error     │    │    completed     │─────────────────┘
        └──────────────┘    └──────────────────┘
```

---

## 4. Kubernetes 인프라 구성

### 4.1 RBAC — `k8s/rbac.yaml`

Extension이 Kubernetes API를 호출하려면 적절한 권한이 필요합니다. `rbac.yaml`은 네임스페이스 레벨의 최소 권한을 정의합니다.

```
Namespace: ml-dev
  │
  ├── ServiceAccount: gpu-runner-sa
  │     └── Pod의 spec.serviceAccountName으로 참조됨
  │
  ├── Role: gpu-runner-role
  │     ├── pods:       get, list, watch, create, delete
  │     ├── pods/log:   get
  │     └── configmaps: get, list, watch, create, delete
  │
  └── RoleBinding: gpu-runner-rolebinding
        └── gpu-runner-sa → gpu-runner-role
```

**설계 의도**:
- 클러스터 레벨(ClusterRole)이 아닌 네임스페이스 레벨(Role)만 사용하여 권한 범위를 최소화
- ConfigMap 권한은 `SelectionTarget` 실행 시 코드를 ConfigMap으로 저장하기 위해 필요

### 4.2 공유 스토리지 — `k8s/shared-pvc.yaml`

```yaml
PersistentVolumeClaim: shared-workspace-pvc
  accessModes: ReadWriteMany   ← 여러 Pod이 동시에 읽기/쓰기 가능
  capacity: 20Gi
```

`ReadWriteMany` 모드를 사용하는 이유: 사용자의 로컬 워크스페이스 파일이 이미 이 PVC에 동기화되어 있다는 전제 하에, 여러 Pod이 동시에 같은 PVC를 마운트할 수 있어야 하기 때문입니다.

### 4.3 로컬-PVC 경로 매핑 원칙

Extension은 사용자의 로컬 워크스페이스 디렉토리 구조와 PVC 내 구조가 동일하다고 가정합니다.

```
로컬 (Windows)               PVC 내부 (Linux Pod)
─────────────────────        ────────────────────────────
C:\GPU-Pod-Runner\        ↔  /workspace/
  examples\                    examples/
    train.py                     train.py
  src\                         src/
    model.py                     model.py
```

Windows 경로 구분자(`\`)는 `toPosixPath()`를 통해 POSIX 구분자(`/`)로 변환됩니다.

---

## 5. 빌드 및 테스트 구조

### 5.1 빌드 파이프라인

```
TypeScript 소스 (src/)
  │
  ▼ tsc --noEmit (타입 체크만)
  │
  ▼ esbuild (번들링)
      entryPoints: ["src/extension.ts"]
      bundle: true
      external: ["vscode"]    ← VS Code API는 번들에 포함하지 않음
      format: "cjs"
      platform: "node"
      target: "node18"
      outfile: "dist/extension.js"
      sourcemap: true
  │
  ▼
dist/extension.js  ← package.json의 "main" 진입점
```

`vscode` 모듈은 번들에서 제외(`external`)됩니다. VS Code 런타임이 Extension 로드 시 주입하기 때문입니다.

### 5.2 npm 스크립트

| 스크립트 | 명령 | 용도 |
|---------|------|------|
| `check-types` | `tsc --noEmit` | 타입 오류만 검사, 파일 생성 없음 |
| `compile` | `check-types && node esbuild.js` | 타입 체크 후 번들 생성 |
| `watch` | `node esbuild.js --watch` | 파일 변경 시 자동 재빌드 |
| `test:unit` | `tsx --test src/test/**/*.test.ts` | 단위 테스트 실행 |
| `test` | `compile && test:unit` | 빌드 후 테스트 |
| `package:vsix` | `vsce package` | 배포용 `.vsix` 생성 |

### 5.3 테스트 파일 구조

테스트는 Node.js 내장 `node:test` 모듈과 `node:assert/strict`를 사용하며, `tsx`로 TypeScript를 직접 실행합니다.

#### `gpuDetector.test.ts` — GPU 감지 로직 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| PyTorch High-confidence 감지 | `.to("cuda")` 패턴 → `requiresGPU: true`, `confidence: "high"` |
| HuggingFace Medium-confidence 감지 | `peft`, `SFTTrainer` 패턴 → `requiresGPU: false`, `confidence: "medium"` |
| 중복 제거 | 동일 프레임워크/이유가 여러 번 매칭되어도 결과에는 1회만 포함 |

#### `podManager.test.ts` — Kubernetes 리소스 생성 로직 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| 경로 매핑 (Windows) | `C:\...\train.py` → `/workspace/examples/train.py` |
| GPU 리소스 (일반 모드) | `nvidia.com/gpu: "1"` |
| GPU 리소스 (HAMi 모드) | `nvidia.com/gpumem: "12000"` |
| API 서버 URL 정규화 | `127.0.0.1:6443` → `{tlsServerName}:6443` |
| Pod 매니페스트 (파일 실행) | `serviceAccountName`, `command`, PVC 볼륨 검증 |
| Pod 매니페스트 (선택 실행) | ConfigMap 볼륨 및 `/opt/gpu-runner` 마운트 포함 여부 검증 |

#### `runnerDecisions.test.ts` — 실행 모드 결정 로직 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| `always-ask` + GPU 감지 | → `"prompt"` |
| `auto-gpu` + GPU 감지 | → `"gpu"` |
| `auto-local` + GPU 감지 | → `"local"` |
| GPU 미감지 (모든 설정) | → `"local"` |

---

## 6. 제약 사항 및 확장 포인트

### 6.1 현재 제약 사항

| 제약 | 내용 |
|------|------|
| **단일 루트 워크스페이스** | 멀티 루트 workspace 미지원. `vscode.workspace.workspaceFolders.length !== 1`이면 오류 |
| **PVC 경로 동기화 전제** | 로컬 워크스페이스와 PVC 내 디렉토리 구조가 동일해야 파일 실행 가능 |
| **로그 실시간 스트리밍 없음** | Pod 완료 후 최근 500줄만 일괄 수집. 실행 중 로그 확인 불가 |
| **Pod 타임아웃** | `podTimeoutSeconds`(기본 600초) 초과 시 예외 발생 |
| **apiServerUrl 미사용** | v1에서는 kubeconfig 직접 제어만 지원. `apiServerUrl` 설정은 예약만 됨 |
| **로컬 kubeconfig 필요** | 사용자 환경에 kubeconfig 파일이 있어야 초기화 가능 |

### 6.2 향후 확장 포인트

| 포인트 | 설명 |
|--------|------|
| **Backend API 모드** | `apiServerUrl` 설정이 채워지면 `PodManager`를 HTTP API 클라이언트로 교체 가능 |
| **실시간 로그 스트리밍** | Kubernetes의 `follow=true` 파라미터 또는 WebSocket을 사용한 실시간 스트리밍 구현 가능 |
| **멀티 루트 워크스페이스** | `getSingleWorkspaceFolder()` 로직 수정으로 지원 가능 |
| **GPU 가용성 표시** | 클러스터 Node 상태를 조회하여 상태바에 GPU 가용 현황 표시 가능 |
| **진행 중 Pod 로그 뷰** | WebView 상태 패널에서 개별 Pod 로그를 실시간으로 표시하는 뷰 추가 가능 |
