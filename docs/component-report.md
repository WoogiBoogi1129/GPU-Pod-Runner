# GPU Pod Runner — VS Code Extension 구성요소별 동작 원리 보고서

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [구성요소별 동작 원리](#2-구성요소별-동작-원리)
   - 2.1 [진입점 — `extension.ts`](#21-진입점--extensionts)
   - 2.2 [GPU 신호 감지 — `gpuDetector.ts`](#22-gpu-신호-감지--gpudetectorts)
   - 2.3 [실행 결정 흐름 & 프레임워크 이미지 — `extension.ts` inline + `frameworkImages.ts`](#23-실행-결정-흐름--프레임워크-이미지)
   - 2.4 [Kubernetes Pod 관리 — `podManager.ts`](#24-kubernetes-pod-관리--podmanagerts)
   - 2.5 [UI 상태 관리 — `statusBar.ts`](#25-ui-상태-관리--statusbarts)
   - 2.6 [설정 관리 — `config.ts`](#26-설정-관리--configts)
3. [전체 실행 흐름](#3-전체-실행-흐름)
4. [Kubernetes 인프라 구성](#4-kubernetes-인프라-구성)
5. [빌드 및 테스트 구조](#5-빌드-및-테스트-구조)
6. [제약 사항 및 확장 포인트](#6-제약-사항-및-확장-포인트)

> 본 보고서는 R2 단순화 리팩터링 이후의 현재 구현을 기준으로 작성되었습니다.
> 핵심 변화: 정적 감지로 GPU 필요 여부를 *추론*하던 모델을 제거하고, 실행 전 **항상 사용자에게 묻는
> 2단계 프롬프트**(GPU 할당 확인 → 프레임워크 이미지 선택)로 단순화했습니다.

---

## 1. 프로젝트 개요

**GPU Pod Runner**는 Python 코드의 GPU 사용 신호를 감지해 프롬프트의 기본값을 거들고, 사용자가
확인하면 Kubernetes GPU Pod 위에서 코드를 실행하도록 돕는 VS Code Extension입니다. 개발자는 별도의
Kubernetes 명령어 없이 VS Code 명령 팔레트 또는 단축키만으로 원격 GPU 환경에서 코드를 실행할 수 있습니다.

### 핵심 아키텍처

```
┌────────────────────────────────────────────────────────────┐
│                     VS Code Extension                      │
│                                                            │
│  extension.ts ─────────────────────────────────────────┐  │
│  (진입점 / 오케스트레이터 / 2단계 프롬프트 흐름)        │  │
│       │                                                 │  │
│       ├─── gpuDetector.ts (GPU 신호·프레임워크 감지)    │  │
│       ├─── frameworkImages.ts (프레임워크→이미지 카탈로그)│ │
│       ├─── podManager.ts (Kubernetes 리소스 관리)       │  │
│       ├─── statusBar.ts (UI 상태 / 프롬프트 / WebView)  │  │
│       └─── config.ts (설정 로드)                        │  │
│                                                         │  │
└─────────────────────────────────────────────────────────┘  │
                                                             │
        ↓  @kubernetes/client-node  ↓                        │
┌────────────────────────────────┐                           │
│     Kubernetes Cluster         │                           │
│  ┌──────────┐                  │                           │
│  │  GPU Pod │ (실행 후 즉시 삭제)│                          │
│  └──────────┘                  │                           │
│  ┌──────────────────────────┐  │                           │
│  │  PVC (shared-workspace)  │  │                           │
│  └──────────────────────────┘  │                           │
└────────────────────────────────┘
```

### 구성 파일 목록

| 파일 | 역할 |
|------|------|
| [src/extension.ts](../src/extension.ts) | 진입점, 명령 등록, 오케스트레이션, 2단계 프롬프트 흐름 |
| [src/gpuDetector.ts](../src/gpuDetector.ts) | 정규식 기반 GPU 신호(`hasGpuSignal`)·프레임워크 감지 |
| [src/frameworkImages.ts](../src/frameworkImages.ts) | 프레임워크 → 컨테이너 이미지 카탈로그와 이미지 해석 헬퍼 |
| [src/podManager.ts](../src/podManager.ts) | Kubernetes Pod 관리, 인증, IDE Pod 문맥 자동 탐지 |
| [src/statusBar.ts](../src/statusBar.ts) | VS Code UI (상태바, 프롬프트, WebView) |
| [src/config.ts](../src/config.ts) | 설정 모델 및 로드 |
| [k8s/rbac.yaml](../k8s/rbac.yaml) | ServiceAccount, Role, RoleBinding |
| [k8s/shared-pvc.yaml](../k8s/shared-pvc.yaml) | 공유 PVC (ReadWriteMany) |

---

## 2. 구성요소별 동작 원리

---

### 2.1 진입점 — `extension.ts`

**역할**: Extension의 생명주기 관리, 모든 모듈의 초기화 및 연결, 명령과 이벤트 구독 등록, 2단계
프롬프트 오케스트레이션.

#### 생명주기: `activate()` / `deactivate()`

VS Code는 Extension이 처음 활성화될 때 `activate()` 함수를 호출합니다. 이 함수는 다음 순서로 초기화를 수행합니다.

```
activate()
  │
  ├─ 1. OutputChannel 생성 ("GPU Pod Runner")
  ├─ 2. loadConfig() → 사용자 설정 로드
  ├─ 3. PodManager.create(config) → Kubernetes 클라이언트 초기화 + IDE Pod 문맥 자동 탐지
  ├─ 4. new StatusBarController() → 상태바 생성 및 표시
  ├─ 5. 3개 명령 등록 (registerCommand)
  ├─ 6. 설정 변경 이벤트 구독 등록
  └─ 7. refreshRunningState() → 초기 상태 확인
```

Extension이 비활성화될 때 `deactivate()`가 호출되며, 이 시점에 `deleteAllManagedPods()`를 실행하여 관리 중인 모든 Kubernetes Pod를 삭제합니다.

#### 등록 명령어

| 명령 ID | 단축키 | 기능 |
|---------|--------|------|
| `gpu-runner.runFile` | Ctrl+Shift+G | 현재 활성 Python 파일을 GPU Pod에서 실행 |
| `gpu-runner.showStatus` | (상태바 클릭) | GPU Pod 상태 WebView 패널 표시 |
| `gpu-runner.cleanup` | (명령 팔레트) | 관리 중인 모든 Pod 일괄 삭제 |

#### 이벤트 구독 (Disposable 패턴)

R2 단순화로 **파일 저장 시 자동 감지(on-save) 리스너는 제거**되었습니다. GPU 감지는 이제
`Run File`을 실행할 때 온디맨드로만 수행됩니다. 현재 구독하는 이벤트는 설정 변경 하나입니다.

```typescript
// 설정 변경 시 PodManager 재초기화
vscode.workspace.onDidChangeConfiguration((event) => {
  if (!event.affectsConfiguration("gpuRunner")) return;
  void reinitializePodManager();   // loadConfig() + PodManager.create()
});
```

등록된 모든 명령, 이벤트 리스너, UI 컴포넌트는 `context.subscriptions`에 추가됩니다. VS Code가 Extension을 비활성화할 때 이 배열의 모든 항목을 자동으로 `dispose()`합니다.

#### 파일 실행 핵심 함수: `runCurrentFile()`

R2 단순화 이후 실행 결정은 **항상 2단계 프롬프트**입니다. auto-pass 리스트나 `auto-gpu`/`auto-local`
모드는 없습니다.

```
runCurrentFile()
  │
  ├─ 활성 편집기 및 Python 파일 여부 검증
  ├─ detectGPUUsage(document.getText())   ← { hasGpuSignal, frameworks }
  │
  ├─ [Phase 1] statusBar.promptForExecution(hasGpuSignal, frameworks)
  │     ├─ undefined(닫기) / "local" → runFileLocally(filePath)
  │     └─ "gpu" → Phase 2로 진행
  │
  ├─ [Phase 2] statusBar.promptForFramework(config.frameworkImages, frameworks[0])
  │     ├─ undefined(닫기) → 실행 취소
  │     └─ 선택한 FrameworkImageOption → runGpuTarget(target, option.image)
  │
  └─ runGpuTarget(target, image)
        ├─ podManager.createAndRun(target, image)
        ├─ podManager.waitForPodPhase(["Succeeded", "Failed"], timeout)
        ├─ podManager.streamLogs(podName, outputChannel)
        └─ podManager.deletePod(run)  ← finally 블록에서 반드시 실행 (Zero-Idle)
```

#### 로컬 터미널 실행: `runFileLocally()`

"GPU Runner Local"이라는 이름의 터미널을 찾아 재사용하거나 없으면 새로 생성합니다. 파일 경로의 큰따옴표를 이스케이프(`""`)한 뒤 `python "<path>"` 명령을 전송합니다.

#### 상태 동기화: `refreshRunningState()`

`listManagedPods()`로 현재 Pod 목록을 조회한 뒤, `Succeeded` / `Failed` 상태가 아닌 Pod가 하나라도 있으면 상태바를 `"running"`으로 설정합니다. 모두 완료된 경우, 현재 상태가 `"completed"` 또는 `"error"`가 아닐 때만 `"idle"`로 전환합니다.

---

### 2.2 GPU 신호 감지 — `gpuDetector.ts`

**역할**: Python 소스 코드 문자열을 입력받아 정규식으로 GPU 사용 신호를 탐색하고, 신호 유무와 매칭된
프레임워크를 반환합니다.

> **R2 변화**: 정적 정규식은 의미(GPU가 *정말* 필요한지)를 보장할 수 없으므로, 감지기는 신뢰도 등급
> (high/medium/low)을 매기지 않습니다. 매칭이 하나라도 있으면 `hasGpuSignal = true`로 일관되게
> 보고하고, 최종 실행 결정은 사용자가 프롬프트에서 합니다. 감지 결과는 **프롬프트 문구와 기본값을
> 거드는 힌트**로만 쓰입니다.

#### 반환 타입: `DetectionResult`

```typescript
interface DetectionResult {
  hasGpuSignal: boolean;   // 패턴이 하나라도 매칭되면 true
  frameworks: string[];    // 매칭된 프레임워크 목록 (중복 제거됨)
}
```

#### 지원 프레임워크 및 패턴 (총 32개)

| 프레임워크 | 감지 패턴 예시 |
|-----------|--------------|
| **PyTorch** | `.to("cuda")`, `.cuda()`, `device="cuda"`, `torch.cuda.*`, `torch.device("cuda")`, `DataParallel`, `DistributedDataParallel`, `DDP` |
| **TensorFlow** | `tf.device('/GPU:')`, `tf.config.list_physical_devices('GPU')`, `tf.distribute.*`, `MirroredStrategy`, `MultiWorkerMirroredStrategy`, `OneDeviceStrategy('/GPU:')` |
| **HuggingFace** | `device_map="auto"`, `device_map="cuda"`, `load_in_8bit=True`, `load_in_4bit=True`, `BitsAndBytesConfig`, `from peft import`, `SFTTrainer` |
| **vLLM** | `import vllm`, `from vllm import`, `tensor_parallel_size=` |
| **CuPy** | `import cupy`, `from cupy import` |
| **RAPIDS** | `import cudf`, `import cuml` |
| **JAX** | `jax.devices('gpu')`, `jax.device_put(` |
| **Numba** | `numba.cuda`, `@cuda.jit` |
| **CUDA Tools** | `nvidia-smi`, `cuda.is_available()` |

> 참고: 이전 버전에서 medium-confidence로 분류되어 `requiresGPU=false`였던 패턴(`from peft import`,
> `SFTTrainer`, `cuda.is_available()`)도 이제 **신호로 간주(`hasGpuSignal=true`)**됩니다. 이는 의도된
> 동작 변화이며, 사용자가 Phase 1에서 최종 결정하므로 안전합니다.

#### 감지 알고리즘

```typescript
export function detectGPUUsage(source: string): DetectionResult {
  const frameworks = new Set<string>();

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;          // 전역 정규식 상태 초기화
    if (pattern.regex.test(source)) {
      frameworks.add(pattern.framework);  // Set으로 중복 자동 제거
    }
  }

  return {
    hasGpuSignal: frameworks.size > 0,
    frameworks: [...frameworks]
  };
}
```

`Set`을 사용하여 동일한 프레임워크가 여러 번 감지되어도 결과에는 한 번만 포함됩니다. 전역 플래그(`/g`)가 있는 정규식은 `lastIndex`를 매 검사 전에 `0`으로 초기화하여 이전 매칭 위치가 다음 검사에 영향을 미치지 않도록 합니다. `DetectionPattern`은 `{ framework, regex }`만 가집니다(이전의 `id`·`confidence`·`reason` 필드 제거).

---

### 2.3 실행 결정 흐름 & 프레임워크 이미지

**역할**: R2 단순화 이후 실행 모드 결정 로직(`runnerDecisions.ts`)은 **삭제**되었고, 결정은
`extension.ts`의 2단계 프롬프트 흐름에 inline으로 녹아 있습니다. 프레임워크 → 이미지 매핑은 순수
헬퍼 모듈 `frameworkImages.ts`가 담당합니다.

#### 2단계 프롬프트

| 단계 | 함수 | 동작 |
|------|------|------|
| **Phase 1** | `statusBar.promptForExecution(hasGpuSignal, frameworks)` | "GPU를 할당하시겠습니까?" 확인. 아니오/취소 → 로컬, 예 → Phase 2 |
| **Phase 2** | `statusBar.promptForFramework(catalog, defaultFramework)` | 프레임워크 이미지 선택 QuickPick. 감지된 `frameworks[0]`가 상단 기본값 |

- 별도의 auto-pass 리스트, `auto-gpu`/`auto-local` 모드, `autoDetectPrompt` 설정은 모두 제거되었습니다.
- 사용자 코드를 임의로 보정하지 않습니다. `device="cuda"`인데 로컬(CPU)로 실행돼 에러가 나도 silent
  fallback으로 바꾸지 않고 에러를 투명하게 노출합니다.

#### `frameworkImages.ts`

```typescript
interface FrameworkImageOption { framework: string; image: string; }

// 우선순위 순 카탈로그 (vLLM/RAPIDS/CuPy 등 특화 스택이 일반 DL 프레임워크보다 앞)
export const DEFAULT_FRAMEWORK_IMAGE_OPTIONS: readonly FrameworkImageOption[] = [ ... ];

// 프레임워크 집합 → 이미지 해석. 카탈로그를 인자로 주입 가능(순수 함수).
export function resolveFrameworkImage(
  frameworks: Iterable<string>,
  fallbackImage: string,
  catalog: readonly FrameworkImageOption[] = DEFAULT_FRAMEWORK_IMAGE_OPTIONS
): { image: string; framework?: string };
```

- Phase 2 QuickPick의 후보 목록 소스는 `gpuRunner.frameworkImages` 설정입니다. 비어 있거나 유효하지
  않으면 내장 `DEFAULT_FRAMEWORK_IMAGE_OPTIONS`로 fallback합니다.
- 어떤 프레임워크도 매칭되지 않으면 `resolveFrameworkImage`는 `fallbackImage`(= `gpuRunner.image`)를 반환합니다.
- 해석기는 순수 함수이고 카탈로그를 주입할 수 있으므로, 장기적으로 클러스터 ConfigMap에서 카탈로그를
  로드하도록 **로드 경로만** 교체할 수 있습니다(드롭다운/해석 코드 불변).

---

### 2.4 Kubernetes Pod 관리 — `podManager.ts`

**역할**: `@kubernetes/client-node` 라이브러리를 통해 Kubernetes API와 직접 통신하며, execution Pod의 전체 생명주기(생성 → 대기 → 로그 수집 → 삭제)를 관리합니다. 또한 인증 전략 결정과 현재 IDE Pod 문맥 자동 탐지를 담당합니다.

#### 실행 대상 타입 (ExecutionTarget)

현재 구현은 워크스페이스 파일 실행 한 가지를 지원합니다.

| 타입 | 실행 방식 | Python 경로 |
|------|----------|------------|
| `WorkspaceFileTarget` | 워크스페이스 파일을 PVC 경로로 매핑하여 실행 | `/workspace/...` (PVC 마운트) |

> 선택 코드 실행(`Run Selection`)과 ConfigMap 기반 코드 패키징은 현재 범위 밖입니다([6.2 확장 포인트](#62-향후-확장-포인트) 참조).

#### PodManager 초기화: `updateConfig()`

```
updateConfig(config)
  │
  ├─ 인증 전략 결정 (authMode: auto | in-cluster | kubeconfig)
  │    ├─ Pod 내부(in-cluster) → ServiceAccount 토큰 사용
  │    └─ 그 외(kubeconfig) → kubeconfigPath 또는 ~/.kube/config
  │
  ├─ 현재 클러스터의 API 서버 URL 정규화
  │    └─ normalizeKubeApiServerUrl(server, tlsServerName)
  │         ├─ Loopback 주소(127.0.0.1, ::1, localhost)인 경우
  │         │   → tlsServerName으로 호스트 교체 (SSH 포트 포워딩 대응)
  │         └─ 그 외 → 변경 없음
  │
  ├─ [autoDiscoverClusterContext] 현재 IDE Pod 문맥 자동 탐지
  │    └─ namespace / PVC / mountPath / subPath / ServiceAccount
  │
  └─ SelfSubjectAccessReview로 필요한 권한 점검 (pods get/list/create/delete, pods/log get)
```

**`normalizeKubeApiServerUrl`의 필요성**: kubeconfig의 API 서버 주소가 `127.0.0.1`(SSH 터널)로 설정되어 있으면 TLS 인증서 검증이 실패합니다. `tlsServerName` 필드에 실제 서버 주소가 있을 때 이를 호스트로 치환하여 인증서 검증이 올바르게 동작하도록 합니다.

#### Pod 생성 + 이미지 주입: `createAndRun()`

```
createAndRun(target, image = config.image)
  │
  ├─ buildManagedPodName(target.displayName)
  │    └─ "gpu-{sanitized-name}-{5자리 난수}" 형식  예: gpu-train-abc12
  │
  ├─ buildPodManifest(config, target, podName, namespace, image)
  │    └─ Pod 객체 빌드 (아래 섹션 참조). 컨테이너 image = 인자로 받은 image
  │
  └─ coreApi.createNamespacedPod() → K8s에 생성
     └─ ManagedPodRun 반환 { podName, namespace }
```

> **R2 변화**: `createAndRun`/`buildPodManifest`는 **기본값 있는 선택적 `image` 인자**를 받습니다
> (`image = config.image`). Phase 2를 거친 경로만 선택 이미지를 넘기고, 그 외 호출부·테스트는 인자를
> 생략하면 기존과 동일하게 `config.image`를 사용합니다(동작 보존).

#### Pod 매니페스트 구조

```
Pod
├── metadata
│   ├── labels: { managed-by: vscode-gpu-runner }  ← 리소스 추적용
│   └── annotations
│       ├── gpu-runner/execution-kind: "workspace-file"
│       └── gpu-runner/source-path: 로컬 파일 절대경로
│
└── spec
    ├── restartPolicy: "Never"        ← 완료 후 재시작 안 함
    ├── serviceAccountName: {executionServiceAccountName or 자동탐지 or 클러스터 기본}
    ├── volumes
    │   └── workspace (PVC: {config.pvcName})
    └── containers[0] (name: "runner")
        ├── image: {선택 이미지 or config.image}
        ├── command: ["python", "{target.podScriptPath}"]
        ├── workingDir: {config.workspaceMountPath}
        ├── volumeMounts
        │   └── {workspaceMountPath} ← PVC (필요 시 subPath)
        └── resources
            ├── [일반 모드] limits/requests: { nvidia.com/gpu: "{gpuCount}" }
            └── [fractional 모드] limits/requests: { nvidia.com/gpumem: "{gpuMemoryMB}" }
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
  relativePath = path.relative(workspaceRoot, filePath)  = "examples\train.py"
  posixPath    = toPosixPath(relativePath)               = "examples/train.py"
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
| `deletePod(run)` | 단일 Pod 삭제. 404 오류는 무시(멱등). |
| `deleteAllManagedPods()` | `managed-by=vscode-gpu-runner` 레이블로 필터링한 모든 Pod를 `Promise.all()`로 병렬 삭제. |

---

### 2.5 UI 상태 관리 — `statusBar.ts`

**역할**: VS Code 상태바 아이템 관리, 사용자 프롬프트(2단계) 표시, WebView 기반 상태 패널 제공.

#### 상태 머신: `RunnerState`

R2 단순화로 `"scanning"` 상태는 제거되었습니다(on-save 감지 제거).

```
         GPU 실행 선택
  idle ──────────────────→ running ──→ completed ──(3초)──→ idle
   ↑                          │             │
   │                          │ Failed      │ Succeeded
   └────────── error ←────────┘             │
                  └──(사용자 상호작용 후)── idle
```

#### 상태별 상태바 표시

| 상태 | 아이콘 + 텍스트 | 툴팁 |
|------|----------------|------|
| `idle` | `$(server) GPU Runner` | GPU Pod Runner |
| `running` | `$(zap) GPU Pod 실행 중 (N)` | GPU Pods are running |
| `completed` | `$(check) 완료` | Last GPU run completed |
| `error` | `$(error) 오류 발생` | The last GPU run ended with an error |

`completed` 상태는 3초 후 자동으로 전환됩니다. 아직 실행 중인 Pod가 있으면 `running`으로, 없으면 `idle`로 돌아갑니다.

#### Phase 1 프롬프트: `promptForExecution(hasGpuSignal, frameworks)`

실행할 때마다 항상 먼저 표시되는 비모달 알림입니다. 문구는 `hasGpuSignal` 유무로 분기합니다.

```
[신호 있음] "🎮 GPU 사용을 요청하셨습니다 [PyTorch, ...]. 정말 GPU Pod에서 실행하시겠습니까?"
[신호 없음] "⚡ GPU가 사용 가능합니다. GPU Pod에서 더 빠르게 실행하시겠습니까?"
  ┌──────────────┐  ┌────────────┐
  │ GPU Pod 실행 │  │  로컬 실행  │  ← 닫기(undefined) 포함 3가지 선택
  └──────────────┘  └────────────┘
```

반환값: `"gpu"` | `"local"` | `undefined`(닫기). `"gpu"`만 Phase 2로 진행하고, 나머지는 로컬 실행합니다.

#### Phase 2 프롬프트: `promptForFramework(catalog, defaultFramework?)`

`showQuickPick`으로 프레임워크 이미지 후보를 보여줍니다. 감지된 `defaultFramework`(= `frameworks[0]`)를
목록 상단에 "감지된 프레임워크 (기본값)"으로 노출합니다. 반환값은 선택한 `FrameworkImageOption` 또는
`undefined`(닫기 → 실행 취소)입니다.

```
GPU Pod 프레임워크 이미지 선택
  ┌──────────────────────────────────────────────────────────┐
  │ PyTorch        pytorch/pytorch:2.3.0-...   감지된 프레임워크│ ← 기본값(상단)
  │ vLLM           vllm/vllm-openai:latest                     │
  │ TensorFlow     tensorflow/tensorflow:2.16.1-gpu            │
  │ ...                                                        │
  └──────────────────────────────────────────────────────────┘
```

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

#### 주요 GPURunnerConfig 항목

| 항목 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `namespace` | string | `"ml-dev"` | Pod를 생성할 Kubernetes 네임스페이스 |
| `image` | string | `"pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime"` | 기본 컨테이너 이미지이자, 프레임워크 매칭 실패 시 fallback |
| `frameworkImages` | FrameworkImageOption[] | 내장 카탈로그 | Phase 2 프레임워크 선택 프롬프트의 후보 카탈로그 |
| `enableFractionalGpuSharing` | boolean | `false` | HAMi fractional GPU(VRAM) 모드 활성화 여부 (`useHAMi`는 deprecated 별칭) |
| `gpuMemoryMB` | number | `8000` | fractional 모드 시 요청할 GPU 메모리(MB) |
| `gpuCount` | number | `1` | 일반(whole GPU) 모드 시 요청할 GPU 개수 |
| `pvcName` | string | `"shared-workspace-pvc"` | 워크스페이스 공유에 사용할 PVC 이름 (자동 탐지 가능) |
| `workspaceMountPath` | string | `"/workspace"` | Pod 내 PVC 마운트 경로 (자동 탐지 가능) |
| `podTimeoutSeconds` | number | `600` | Pod 완료 대기 최대 시간(초) |
| `authMode` | "auto"\|"in-cluster"\|"kubeconfig" | `"auto"` | Kubernetes 인증 모드 |
| `autoDiscoverClusterContext` | boolean | `true` | 현재 IDE Pod에서 namespace/PVC/SA 자동 탐지 |
| `executionServiceAccountName` | string | `""` | execution Pod에 사용할 ServiceAccount (빈 값이면 자동 탐지) |
| `kubeconfigPath` | string | `""` | kubeconfig 파일 경로 (빈 값이면 `~/.kube/config` 사용) |
| `apiServerUrl` | string | `""` | 향후 백엔드 모드 예약 항목 (v1에서는 미사용) |

> **R2 변화**: `autoDetect`(on-save 감지), `autoDetectPrompt`(always-ask/auto-gpu/auto-local)와 그
> 타입은 제거되었습니다. `frameworkImages`가 추가되었습니다.

#### 설정 로드

```typescript
export function loadConfig(): GPURunnerConfig {
  const config = vscode.workspace.getConfiguration("gpuRunner");
  return {
    namespace:        config.get<string>("namespace", "ml-dev"),
    image:            config.get<string>("image", "pytorch/pytorch:..."),
    frameworkImages:  resolveFrameworkImageCatalog(config),  // 유효성 검사 + 기본 카탈로그 fallback
    // ... 나머지 항목들
  };
}
```

`vscode.workspace.getConfiguration("gpuRunner")`는 VS Code의 설정 해석 우선순위(워크스페이스 설정 > 사용자 설정 > 기본값)를 자동으로 적용합니다.

---

## 3. 전체 실행 흐름

### 3.1 파일 실행 시퀀스

```
사용자: Ctrl+Shift+G (또는 "GPU Runner: Run File" 명령)
  │
  ▼
extension.ts: runCurrentFile()
  ├─ [검증] 활성 편집기 존재 여부, Python 파일 여부
  │
  ▼
gpuDetector.ts: detectGPUUsage(source)
  └─ 32개 정규식 패턴 순회 → { hasGpuSignal, frameworks } 반환
  │
  ▼
[Phase 1] statusBar.ts: promptForExecution(hasGpuSignal, frameworks)
  ├─ undefined(닫기) / "local" ──→ runFileLocally()  → 터미널: python "<path>"
  └─ "gpu" ──→ Phase 2
  │
  ▼
[Phase 2] statusBar.ts: promptForFramework(config.frameworkImages, frameworks[0])
  ├─ undefined(닫기) ──→ 실행 취소
  └─ 선택 FrameworkImageOption ──→ runGpuTarget(target, option.image)
  │
  ▼
extension.ts: runGpuTarget(target, image)
  ├─ podManager.createAndRun(target, image)
  │    └─ K8s: createNamespacedPod() (컨테이너 image = 선택 이미지)
  ├─ statusBar.setState("running", count)
  ├─ podManager.waitForPodPhase(["Succeeded","Failed"], timeout)
  │    └─ 2초 간격 폴링 → phase 반환
  ├─ podManager.streamLogs(podName, outputChannel)
  │    └─ K8s: readNamespacedPodLog() → 최근 500줄
  ├─ statusBar.setState("completed") or "error"
  └─ [finally] podManager.deletePod(run)   ← Zero-Idle: 즉시 반환
       └─ K8s: deleteNamespacedPod()
```

### 3.2 상태 전이 다이어그램

```
        ┌─────────────────────┐
        │        idle         │◄─────────────────────────────────┐
        └──────────┬──────────┘                                  │
                   │ Run File → 2단계 프롬프트                    │
          ┌────────┴────────┐                                    │
    local │                 │ gpu (Phase 1 "예" + Phase 2 선택)   │ 3초
          ▼                 ▼                                    │
       [터미널]  ┌─────────────────────┐                         │
                │      running        │                          │
                └──────────┬──────────┘                          │
                           │ Pod 완료                            │
                 ┌─────────┴──────────┐                          │
            fail │                    │ succeed                  │
                 ▼                    ▼                          │
      ┌──────────────┐    ┌──────────────────┐                   │
      │    error     │    │    completed     │───────────────────┘
      └──────────────┘    └──────────────────┘
```

---

## 4. Kubernetes 인프라 구성

### 4.1 RBAC — `k8s/rbac.yaml`

Extension이 Kubernetes API를 호출하려면 적절한 권한이 필요합니다. `rbac.yaml`은 네임스페이스 레벨의 최소 권한을 정의합니다.

```
Namespace: ml-dev
  │
  ├── ServiceAccount: gpu-runner-ide
  │     └── execution Pod / IDE Pod의 ServiceAccount로 참조됨
  │
  ├── Role: gpu-runner-role
  │     ├── pods:                        get, list, watch, create, delete
  │     ├── pods/log:                    get
  │     └── selfsubjectaccessreviews,
  │         selfsubjectrulesreviews:     create   ← 초기화 시 권한 점검용
  │
  └── RoleBinding: gpu-runner-rolebinding
        └── gpu-runner-ide → gpu-runner-role
```

**설계 의도**:
- 클러스터 레벨(ClusterRole)이 아닌 네임스페이스 레벨(Role)만 사용하여 권한 범위를 최소화
- `selfsubjectaccessreviews` 권한은 초기화 시 `SelfSubjectAccessReview`로 사전 권한 점검을 하기 위해 필요

### 4.2 공유 스토리지 — `k8s/shared-pvc.yaml`

```yaml
PersistentVolumeClaim: shared-workspace-pvc
  accessModes: ReadWriteMany   ← 여러 Pod이 동시에 읽기/쓰기 가능
  storage: 20Gi
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
| `test` | `test:unit` (pretest에서 compile) | 빌드 후 테스트 |
| `package:vsix` | `vsce package` | 배포용 `.vsix` 생성 |

### 5.3 테스트 파일 구조

테스트는 Node.js 내장 `node:test` 모듈과 `node:assert/strict`를 사용하며, `tsx`로 TypeScript를 직접 실행합니다.

#### `gpuDetector.test.ts` — GPU 신호 감지 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| PyTorch CUDA 감지 | `.to("cuda")` → `hasGpuSignal: true`, `frameworks`에 `PyTorch` 포함 |
| 조건부 CUDA 할당 | `device = "cuda" if ...` → `hasGpuSignal: true` |
| 이전 medium 패턴 | `peft`/`SFTTrainer` → `hasGpuSignal: true` (동작 변화) |
| 신호 없음 | GPU 패턴 없는 코드 → `hasGpuSignal: false`, `frameworks: []` |
| 중복 제거 | 동일 프레임워크가 여러 번 매칭되어도 결과에는 1회만 포함 |

#### `frameworkImages.test.ts` — 이미지 해석 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| 단일 프레임워크 | `["TensorFlow"]` → tensorflow 이미지 |
| 우선순위 | `["PyTorch","vLLM"]` → vLLM(더 특화)이 우선 |
| fallback | 미지/빈 프레임워크 → `fallbackImage` 반환 |
| 카탈로그 override | 주입 카탈로그로 내장 이미지 덮어쓰기 |
| 카탈로그 우선순위 | 주입 카탈로그의 나열 순서를 따름 |

#### `podManager.test.ts` — Kubernetes 리소스 생성 로직 검증

| 테스트 케이스 | 검증 내용 |
|-------------|---------|
| 경로 매핑 (Windows) | `C:\...\train.py` → `/workspace/examples/train.py` |
| GPU 리소스 (일반 모드) | `nvidia.com/gpu: "1"` |
| GPU 리소스 (HAMi 모드) | `nvidia.com/gpumem: "12000"` |
| API 서버 URL 정규화 | `127.0.0.1:6443` → `{tlsServerName}:6443` |
| Pod 매니페스트 (파일 실행) | `serviceAccountName`, `command`, PVC 볼륨/subPath 검증 |
| 이미지 주입 | `buildPodManifest(..., image)` → 컨테이너 image = 주입 이미지 |
| 이미지 기본값 | image 인자 생략 → 컨테이너 image = `config.image` |
| Zero-Idle | 단일 실행 완료 후 관리 Pod 0개, 중복 삭제 멱등 |
| 자동 탐지 | namespace/PVC/SA 자동 탐지 및 manual override 우선순위 |

---

## 6. 제약 사항 및 확장 포인트

### 6.1 현재 제약 사항

| 제약 | 내용 |
|------|------|
| **단일 루트 워크스페이스** | 멀티 루트 workspace 미지원. `vscode.workspace.workspaceFolders.length !== 1`이면 오류 |
| **PVC 경로 동기화 전제** | 로컬 워크스페이스와 PVC 내 디렉토리 구조가 동일해야 파일 실행 가능 |
| **로그 실시간 스트리밍 없음** | Pod 완료 후 최근 500줄만 일괄 수집. 실행 중 로그 확인 불가 |
| **Pod 타임아웃** | `podTimeoutSeconds`(기본 600초) 초과 시 예외 발생 |
| **apiServerUrl 미사용** | v1에서는 kubeconfig/in-cluster 직접 제어만 지원. `apiServerUrl` 설정은 예약만 됨 |
| **kubeconfig 또는 in-cluster 필요** | 로컬은 kubeconfig, Pod 내부는 ServiceAccount 토큰이 있어야 초기화 가능 |

### 6.2 향후 확장 포인트

| 포인트 | 설명 |
|--------|------|
| **Run Selection** | 선택 코드를 ConfigMap에 패키징해 실행하는 모드. 현재 미구현 (범위 밖) |
| **이미지 카탈로그 ConfigMap 로드** | `frameworkImages` 카탈로그를 클러스터 ConfigMap에서 로드(해석기는 순수 함수라 로드 경로만 교체) |
| **Backend API 모드** | `apiServerUrl` 설정이 채워지면 `PodManager`를 HTTP API 클라이언트로 교체 가능 |
| **실시간 로그 스트리밍** | Kubernetes의 `follow=true` 파라미터 또는 WebSocket을 사용한 실시간 스트리밍 구현 가능 |
| **멀티 루트 워크스페이스** | `getSingleWorkspaceFolder()` 로직 수정으로 지원 가능 |
| **GPU 가용성 표시** | 클러스터 Node 상태를 조회하여 상태바에 GPU 가용 현황 표시 가능 |
