# GPU Pod Runner 아키텍처

이 문서는 현재 구현 기준으로 `GPU Pod Runner`가 어떤 입력을 받아 어떤 Kubernetes Pod spec을 생성하는지 설명합니다.

## 구성 요소

핵심 모듈은 아래와 같습니다.

- `src/extension.ts`
  - 명령 등록, 실행 오케스트레이션, output channel 기록
- `src/config.ts`
  - `gpuRunner.*` 설정 로딩
- `src/gpuDetector.ts`
  - Python 코드에서 GPU 사용 패턴 감지
- `src/runnerDecisions.ts`
  - local 실행, GPU 실행, prompt 표시 여부 결정
- `src/podManager.ts`
  - Kubernetes 인증, 현재 IDE Pod 문맥 탐지, execution Pod 생성/대기/로그/삭제
- `src/statusBar.ts`
  - 상태바와 상태 패널 UI

## 상위 동작 흐름

```text
사용자 명령 실행
  -> extension.ts가 활성 파일과 설정 확인
  -> gpuDetector.ts가 GPU 요청 신호 감지 (matchedPatternIds 포함)
  -> runnerDecisions.ts가 실행 방식 결정 (auto-pass / 확인 프롬프트 / 로컬)
  -> 확인 프롬프트면 statusBar.ts가 GPU/로컬 선택을 받음
  -> GPU 실행이면 podManager.ts가 Kubernetes 문맥 준비
  -> 현재 IDE Pod 기준 namespace / PVC / ServiceAccount 자동 탐지
  -> execution Pod manifest 생성
  -> Pod 완료 대기
  -> 로그 수집
  -> Pod 삭제 (Zero-Idle: 실행 종료 즉시 반환)
```

## 실행 결정 모델 (R2)

R2부터 GPU 실행 여부는 "코드 스캔으로 GPU 필요 여부를 *추론*"하는 모델이 아니라,
**"사용자의 GPU 사용 의도를 *신뢰*하고, 불확실할 때만 사람에게 되묻는"** 모델로 동작합니다.

핵심 규칙:

- 코드에 GPU 요청 신호(`device = "cuda"`, `.to("cuda")`, `.cuda()`,
  `torch.device("cuda")`, 조건부 `if cuda.is_available()` 등)가 있으면
  **사용자가 GPU를 요청한 것**으로 간주합니다.
  조건부/무조건 여부로 카테고리를 나누지 않습니다(조건부도 동일하게 GPU 요청).
- GPU 요청 신호 중 **확실히 드러난 패턴**은 `runnerDecisions.ts`의
  **auto-pass 리스트**(`DEFAULT_AUTO_PASS_PATTERN_IDS`)에 등록되어
  확인 없이 바로 GPU Pod로 실행됩니다.
  이 리스트는 **최소 1개 패턴부터 시작해 한 번에 하나씩 추가**하며 점진적으로 확장합니다.
- auto-pass 리스트에 없는 불확실한 경우는 **확인 프롬프트**로 위임합니다(최소 동작 보장).

즉 의사결정은 다음 두 갈래로 단순화됩니다.

| 입력 | 결정 |
|---|---|
| 확실히 드러난 GPU 요청 (auto-pass 매칭) | **auto-pass** → GPU Pod (프롬프트 없음) |
| GPU 요청이지만 auto-pass 리스트에 없음 | **확인 프롬프트** (`confirm-gpu-request`) |
| GPU 요청 신호 없음 | **권유 프롬프트** (`recommend-gpu`) → 기본 로컬 |

`autoDetectPrompt` 설정은 위 모델을 감쌉니다.

- `always-ask`(기본): auto-pass 외에는 프롬프트로 되묻습니다.
- `auto-gpu`: GPU 요청이 있으면 프롬프트 없이 GPU Pod, 없으면 로컬.
- `auto-local`: 항상 로컬(명시적 사용자 override).

### 확인 프롬프트 (REQ-1)

확인 프롬프트는 **어떤 감지 로직도 없이 단독으로 동작 가능한 기본 백업 경로**입니다.
문구는 GPU 요청 신호 유무에 따라 두 갈래로 분기합니다.

- `confirm-gpu-request`: 코드에 GPU 요청이 있을 때.
  "GPU 사용을 요청하셨습니다 […]. 정말 GPU Pod에서 실행하시겠습니까?" — 요청 **최종 확인** 성격.
- `recommend-gpu`: GPU 요청 신호가 없을 때.
  "GPU가 사용 가능합니다. GPU Pod에서 더 빠르게 실행하시겠습니까?" — **권유** 성격.

`Yes` → GPU Pod 할당, `No`/닫기 → 로컬(CPU) 경로로 분기합니다.

### 설계 원칙 (Non-Goals)

- **사용자 코드를 임의로 보정하지 않습니다.** 무조건 `device = "cuda"`인데
  로컬(CPU)로 실행되어 에러가 나는 경우에도 silent CPU fallback으로 바꾸지 않고
  **에러를 투명하게 노출**합니다. GPU 사용 여부 재확인은 확인 프롬프트로 처리합니다.
- **조건문 내부 의미에 대한 AST 등 정밀 분석을 하지 않습니다.**
  조건부 패턴도 GPU 요청으로 동일 취급하므로 추가 정적 분석이 불필요합니다.
- **프레임워크별 감지 로직의 점진적 정교화는 핵심 범위에서 제외합니다.**
  프레임워크별 *명시적 요청 시나리오* 수집은 auto-pass 리스트를 채우는 입력으로 활용하되,
  본 구현 범위 밖에서 관리합니다.

## 설정에서 Pod spec으로 이어지는 계약

execution Pod 생성에 직접 영향을 주는 핵심 설정은 아래와 같습니다.

- `gpuRunner.namespace`
  - Pod를 생성할 namespace
- `gpuRunner.image`
  - execution container image
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

## 프레임워크 이미지 조합 (REQ-4, 준비 단계)

사용자가 GPU를 요청해 GPU Pod가 생성될 때, 설치된 프레임워크 이미지 조합 중
적절한 이미지를 선택할 수 있도록 `src/frameworkImages.ts`에 매핑과 선택 헬퍼를 준비해 둡니다.
이는 Jupyter의 "명시적 선택" 모델과 일관된 UX를 목표로 하는 준비 단계이며,
핵심 흐름(REQ-1/REQ-2)이 검증된 뒤 Pod 생성 경로에 연결합니다.
현재는 `gpuRunner.image` 기본값 동작을 바꾸지 않습니다(behavior-preserving).

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
