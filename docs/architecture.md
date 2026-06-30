# GPU Pod Runner 아키텍처

이 문서는 현재 구현 기준으로 `GPU Pod Runner`가 어떤 입력을 받아 어떤 Kubernetes Pod spec을 생성하는지 설명합니다.

## 구성 요소

핵심 모듈은 아래와 같습니다.

- `src/extension.ts`
  - 명령 등록, 실행 오케스트레이션, output channel 기록
- `src/config.ts`
  - `gpuRunner.*` 설정 로딩
- `src/gpuDetector.ts`
  - Python 코드에서 GPU 사용 신호(`hasGpuSignal`)와 프레임워크 감지
- `src/frameworkImages.ts`
  - 프레임워크 → 컨테이너 이미지 카탈로그와 이미지 해석 헬퍼
- `src/podManager.ts`
  - Kubernetes 인증, 현재 IDE Pod 문맥 탐지, execution Pod 생성/대기/로그/삭제
- `src/statusBar.ts`
  - 상태바와 상태 패널 UI

## 상위 동작 흐름

```text
사용자 명령 실행
  -> extension.ts가 활성 파일과 설정 확인
  -> gpuDetector.ts가 GPU 사용 신호(hasGpuSignal)와 프레임워크 감지
  -> [Phase 1] statusBar.ts가 "GPU를 할당하시겠습니까?" 확인 프롬프트 표시
       -> 아니오/취소면 로컬 실행
  -> [Phase 2] 예이면 statusBar.ts가 프레임워크 이미지 선택 QuickPick 표시
       (감지된 frameworks[0]를 기본값으로 상단 노출)
  -> 선택한 프레임워크 이미지로 podManager.ts가 Kubernetes 문맥 준비
  -> 현재 IDE Pod 기준 namespace / PVC / ServiceAccount 자동 탐지
  -> execution Pod manifest 생성 (선택 이미지 주입)
  -> Pod 완료 대기
  -> 로그 수집
  -> Pod 삭제 (Zero-Idle: 실행 종료 즉시 반환)
```

## 실행 결정 모델 (R2)

R2 단순화 이후 GPU 실행 여부는 "코드 스캔으로 GPU 필요 여부를 *추론*"하지 않습니다.
정적 정규식 매칭은 의미를 보장할 수 없으므로, 실행 직전 **항상 사용자에게 직접 묻고**
사용자가 최종 결정합니다. 감지 결과는 **프롬프트 문구와 기본값을 거드는 힌트**로만 쓰입니다.

핵심 규칙:

- 코드에 GPU 사용 신호(`device = "cuda"`, `.to("cuda")`, `.cuda()`,
  `torch.device("cuda")`, 조건부 `if cuda.is_available()` 등)가 하나라도 있으면
  `gpuDetector.ts`가 `hasGpuSignal = true`를 반환하고, 매칭된 `frameworks`를 함께 보고합니다.
  (신뢰도 등급 없이 **매칭 ≥ 1**이면 신호로 간주합니다.)
- 실행 결정은 **항상 2단계 프롬프트**로 단순화됩니다. 별도의 auto-pass 리스트나
  `auto-gpu`/`auto-local` 모드는 없습니다.

| 단계 | 동작 |
|---|---|
| Phase 1 | "GPU를 할당하시겠습니까?" 확인 프롬프트 — 아니오/취소면 로컬, 예이면 Phase 2 |
| Phase 2 | 프레임워크 이미지 선택 QuickPick — 감지된 `frameworks[0]`가 기본값(상단 노출) |

선택한 프레임워크 이미지로 GPU Pod를 생성하고, 실행이 끝나면 Zero-Idle로 반환합니다.

### Phase 1: 실행 확인 프롬프트 (REQ-1)

확인 프롬프트는 **어떤 감지 로직도 없이 단독으로 동작 가능한 기본 백업 경로**이며,
실행할 때마다 항상 먼저 표시됩니다. 문구는 `hasGpuSignal` 유무로 두 갈래 분기합니다.

- 신호 있음: "GPU 사용을 요청하셨습니다 […]. 정말 GPU Pod에서 실행하시겠습니까?" — **최종 확인** 성격.
- 신호 없음: "GPU가 사용 가능합니다. GPU Pod에서 더 빠르게 실행하시겠습니까?" — **권유** 성격.

`Yes` → Phase 2로, `No`/닫기 → 로컬(CPU) 경로로 분기합니다.

### Phase 2: 프레임워크 이미지 선택 (REQ-4)

`Yes`를 누르면 `statusBar.ts`의 `promptForFramework`가 프레임워크 이미지 QuickPick을 띄웁니다.
이는 Jupyter(Enterprise Gateway)의 "명시적 이미지 선택" 모델과 일관된 UX입니다.

- 후보 목록 소스는 `gpuRunner.frameworkImages` 설정(없으면 내장 `DEFAULT_FRAMEWORK_IMAGE_OPTIONS`)입니다.
- 감지된 `frameworks[0]`를 목록 상단에 기본값으로 노출합니다.
- 선택한 이미지는 `runGpuTarget → createAndRun → buildPodManifest`로 주입되어
  execution Pod의 컨테이너 이미지가 됩니다. 선택 QuickPick을 닫으면 실행을 취소합니다.

### 설계 원칙 (Non-Goals)

- **사용자 코드를 임의로 보정하지 않습니다.** 무조건 `device = "cuda"`인데
  로컬(CPU)로 실행되어 에러가 나는 경우에도 silent CPU fallback으로 바꾸지 않고
  **에러를 투명하게 노출**합니다. GPU 사용 여부 재확인은 Phase 1 프롬프트로 처리합니다.
- **조건문 내부 의미에 대한 AST 등 정밀 분석을 하지 않습니다.**
  조건부 패턴도 동일하게 GPU 신호로 취급하므로 추가 정적 분석이 불필요합니다.
- **프레임워크별 감지 로직의 점진적 정교화는 핵심 범위에서 제외합니다.**
  감지 결과는 프롬프트 기본값을 거드는 힌트일 뿐, 최종 결정은 사용자가 합니다.

## 설정에서 Pod spec으로 이어지는 계약

execution Pod 생성에 직접 영향을 주는 핵심 설정은 아래와 같습니다.

- `gpuRunner.namespace`
  - Pod를 생성할 namespace
- `gpuRunner.image`
  - 기본 execution container image이자, 프레임워크 매칭 실패 시 fallback 이미지
- `gpuRunner.frameworkImages`
  - Phase 2 프레임워크 선택 프롬프트의 후보 카탈로그(프레임워크 → 이미지). 실행마다 선택 이미지를 주입
- `gpuRunner.pvcName`
  - execution Pod가 마운트할 workspace PVC 이름
- `gpuRunner.workspaceMountPath`
  - execution Pod 내부 mount 경로
- `gpuRunner.executionServiceAccountName`
  - execution Pod에 사용할 ServiceAccount
- `gpuRunner.enableFractionalGpuSharing`
  - GPU resource key 선택
- `gpuRunner.gpuCount`
  - whole GPU 모드에서 요청할 GPU 개수
- `gpuRunner.gpuMemoryMB`
  - fractional GPU sharing 모드에서 요청할 메모리 크기

## `Run File` 경로 매핑

`Run File`은 현재 파일의 절대경로를 그대로 Pod로 복사하지 않습니다.

동작 방식:

1. 활성 파일이 현재 workspace 안에 있는지 확인
2. workspace root 기준 상대경로 계산
3. 그 상대경로를 `workspaceMountPath` 아래에 붙여 Pod 내부 실행 경로 생성

예:

- workspace root: `/home/jovyan`
- 파일 경로: `/home/jovyan/examples/train.py`
- execution Pod path: `/home/jovyan/examples/train.py`

이 계약 때문에 IDE Pod와 execution Pod가 같은 파일 레이아웃을 공유해야 합니다.

## Kubernetes 인증 방식

`podManager.ts`는 아래 우선순위로 인증 전략을 결정합니다.

- `authMode=in-cluster`
  - 항상 Pod 내부 ServiceAccount 사용
- `authMode=kubeconfig`
  - 항상 kubeconfig 사용
- `authMode=auto`
  - Pod 내부면 in-cluster
  - 아니면 `gpuRunner.kubeconfigPath` 또는 `~/.kube/config`

현재 버전에서 `gpuRunner.apiServerUrl`은 예약값이며 사용하지 않습니다.

## 현재 IDE Pod 문맥 자동 탐지

자동 탐지는 현재 IDE Pod 안에서 실행될 때 가장 강하게 동작합니다.

탐지 대상:

- namespace
- 현재 IDE Pod 이름
- 현재 ServiceAccount 이름
- PVC-backed workspace mount

PVC-backed mount 탐지 시:

- 명시한 `workspaceMountPath`가 있으면 우선 사용
- 없으면 `HOME` 정렬 mount를 우선 사용
- 그래도 없으면 `/workspace` 또는 첫 번째 PVC mount로 fallback

## JupyterHub에서 중요한 점

JupyterHub는 사용자 home PVC를 `/home/jovyan`에 mount하되 `subPath`를 함께 사용하는 경우가 많습니다.

예:

- PVC 이름: `jupyterhub-singleuser-pvc`
- mount path: `/home/jovyan`
- subPath: `user1`

이 경우 execution Pod도 같은 `pvcName`, 같은 `mountPath`, 같은 `subPath`를 사용해야 `/home/jovyan/test.py`가 같은 파일을 가리킵니다.

현재 구현은 이 `workspaceSubPath`를 자동 탐지해서 execution Pod의 `volumeMount.subPath`에도 반영합니다.

## execution Pod spec의 핵심 형태

현재 execution Pod는 아래 성격을 가집니다.

- namespace: 현재 또는 설정된 namespace
- restartPolicy: `Never`
- serviceAccountName: 자동 탐지 또는 명시 설정
- volumes:
  - workspace PVC 하나
- volumeMounts:
  - `workspaceMountPath`
  - 필요 시 `workspaceSubPath`
- command:
  - `python <podScriptPath>`
- workingDir:
  - `workspaceMountPath`

GPU 자원 요청:

- whole GPU 모드
  - `nvidia.com/gpu: <gpuCount>`
- fractional GPU sharing 모드
  - `nvidia.com/gpumem: <gpuMemoryMB>`

## VS Code Zero-Idle 반환 모델 (REQ-3)

VS Code 환경에서는 **단일 파일 실행 = 하나의 GPU 워크로드**로 간주하고,
실행이 종료되면 **즉시 execution Pod를 삭제·반환**합니다(`extension.ts`의 `runGpuTarget`
`finally` 블록에서 `podManager.deletePod` 호출).

Jupyter(Enterprise Gateway)와의 차이는 다음과 같습니다.

| 구분 | Jupyter | VS Code (GPU Pod Runner) |
|---|---|---|
| 세션 유지 | idle time culling 사용 | **불필요** |
| 반환 시점 | idle/busy 상태 기반 | 파일 실행 종료 시점 — **Zero idle** |

**왜 idle time culling이 불필요한가:**
Jupyter는 하나의 커널을 여러 셀/노트북/윈도우가 공유하므로,
"언제 더 이상 쓰지 않는지"를 idle 시간으로 추정해야 합니다.
반면 VS Code의 `Run File`은 **단일 태스크 실행 후 즉시 종료**가 명확하고,
멀티 윈도우로 커널을 공유하는 구조가 아니기 때문에
idle 추정 없이 실행이 끝나는 순간 GPU를 반환할 수 있습니다.

이 모델은 orphan Pod(실행 종료 후 남는 잔여 Pod)가 발생하지 않음을 보장하며,
`src/test/podManager.test.ts`의 "Zero-Idle" 테스트로 검증합니다
(실행 완료 후 관리 대상 Pod 수가 0이 되는지, 중복 삭제가 멱등인지).

## 프레임워크 이미지 조합 (REQ-4)

`src/frameworkImages.ts`는 프레임워크 → 컨테이너 이미지 카탈로그와 순수 해석 헬퍼
(`resolveFrameworkImage`)를 제공합니다. Phase 2 프레임워크 선택 프롬프트가 이 카탈로그를
후보 목록으로 사용하며, 선택한 이미지를 Pod 생성 경로에 주입합니다.

- 카탈로그 소스: `gpuRunner.frameworkImages` 설정. 비어 있거나 유효하지 않으면
  내장 `DEFAULT_FRAMEWORK_IMAGE_OPTIONS`로 fallback합니다.
- `resolveFrameworkImage(frameworks, fallbackImage, catalog)`는 매칭 우선순위에 따라
  이미지를 고르고, 어떤 프레임워크도 매칭되지 않으면 `fallbackImage`(`gpuRunner.image`)를 반환합니다.
- 카탈로그를 인자로 주입할 수 있으므로(해석기는 순수 함수) 장기적으로는 클러스터 ConfigMap에서
  로드하도록 **로드 경로만** 바꾸면 됩니다. 드롭다운/해석 코드는 그대로 둡니다.

## 권한 점검

초기화 시 `SelfSubjectAccessReview`로 아래 권한을 확인합니다.

- `pods`: `get`, `list`, `create`, `delete`
- `pods/log`: `get`

권한이 부족해도 즉시 실행을 막지는 않지만, output channel과 경고 메시지로 알려줍니다.

## 현재 범위 밖 기능

현재 문서 기준으로 아래 기능은 포함되지 않습니다.

- `Run Selection`
- ConfigMap 기반 코드 패키징 실행
- full workspace upload/sync
- multi-root workspace
- 실시간 로그 스트리밍
