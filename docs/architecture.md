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
  -> gpuDetector.ts가 GPU 패턴 감지
  -> runnerDecisions.ts가 실행 방식 결정
  -> GPU 실행이면 podManager.ts가 Kubernetes 문맥 준비
  -> 현재 IDE Pod 기준 namespace / PVC / ServiceAccount 자동 탐지
  -> execution Pod manifest 생성
  -> Pod 완료 대기
  -> 로그 수집
  -> Pod 삭제
```

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
