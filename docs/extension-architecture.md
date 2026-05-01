# GPU Pod Runner Extension 구조 및 동작 원리

## 문서 목적

이 문서는 `GPU Pod Runner` VS Code Extension이 어떤 구조로 동작하는지, 각 모듈이 어떤 책임을 가지는지, 그리고 Python 코드를 Kubernetes GPU Pod에서 실행하기까지 어떤 단계가 거치는지를 코드 기준으로 정리한 문서다.

대상 소스:

- `src/extension.ts`
- `src/config.ts`
- `src/gpuDetector.ts`
- `src/runnerDecisions.ts`
- `src/podManager.ts`
- `src/statusBar.ts`
- `package.json`

## 한눈에 보는 아키텍처

이 확장은 크게 5개 계층으로 나뉜다.

1. VS Code 진입 계층
   - 명령 등록, 설정 로딩, 이벤트 구독을 담당한다.
   - 중심 파일: `src/extension.ts`
2. 실행 판단 계층
   - 현재 파일이 GPU가 필요한 코드인지 감지하고, 로컬 실행 또는 GPU Pod 실행을 결정한다.
   - 중심 파일: `src/gpuDetector.ts`, `src/runnerDecisions.ts`
3. UI 계층
   - 상태바, 상태 패널, 실행 프롬프트를 표시한다.
   - 중심 파일: `src/statusBar.ts`
4. Kubernetes 연동 계층
   - kubeconfig 로딩, Pod/ConfigMap 생성, 로그 수집, 상태 조회, 삭제를 담당한다.
   - 중심 파일: `src/podManager.ts`
5. 클러스터 리소스 계층
   - ServiceAccount/RBAC, 공유 PVC 같은 실행 기반을 제공한다.
   - 관련 파일: `k8s/rbac.yaml`, `k8s/shared-pvc.yaml`

간단한 흐름은 아래와 같다.

```text
사용자 명령 실행
  -> extension.ts
  -> 설정 로드 / 현재 파일 확인
  -> GPU 코드 감지
  -> 실행 모드 결정
  -> PodManager로 Kubernetes 리소스 생성
  -> Pod 완료 대기
  -> 로그 수집
  -> Pod/ConfigMap 정리
  -> 상태바/상태 패널 갱신
```

## 엔트리 포인트와 활성화 방식

확장은 `package.json`에 정의된 activation event를 기준으로 활성화된다.

- `onStartupFinished`
- `onCommand:gpu-runner.runFile`
- `onCommand:gpu-runner.runSelection`
- `onCommand:gpu-runner.showStatus`
- `onCommand:gpu-runner.cleanup`

실제 엔트리 포인트는 `src/extension.ts`의 `activate()`다.

`activate()`가 수행하는 핵심 작업:

1. Output Channel 생성
   - 이름: `GPU Pod Runner`
2. 사용자 설정 로딩
   - `loadConfig()` 호출
3. `PodManager` 초기화
4. `StatusBarController` 생성
5. 명령 등록
6. 저장 이벤트와 설정 변경 이벤트 구독
7. 비활성화 시 cleanup 함수 준비
8. 초기 상태 동기화

즉, `extension.ts`는 오케스트레이터 역할을 한다.

## 핵심 명령과 역할

현재 제공되는 명령은 4개다.

### 1. `GPU Runner: Run File`

현재 활성 Python 파일 전체를 대상으로 동작한다.

핵심 흐름:

1. 활성 에디터와 파일 언어 확인
2. GPU 사용 패턴 감지
3. `autoDetectPrompt` 설정에 따라 실행 모드 결정
4. 로컬 실행이면 터미널에서 `python "<file>"` 실행
5. GPU 실행이면 워크스페이스 상대경로를 Pod 내부 경로로 변환
6. Kubernetes Pod 생성 및 실행

### 2. `GPU Runner: Run Selection`

현재 활성 에디터의 선택 영역만 Pod에서 실행한다.

핵심 차이:

- 파일 전체를 PVC에서 읽지 않는다.
- 선택한 코드 문자열을 ConfigMap으로 만들어 Pod에 주입한다.
- Pod 내부에서는 `/opt/gpu-runner/selection.py`를 실행한다.

### 3. `GPU Runner: Show Status`

상태 패널을 열고, 관리 대상 Pod 목록을 표시한다.

표시 항목:

- Pod 이름
- Phase
- 실행 종류
- 소스 파일 경로
- 생성 시간

### 4. `GPU Runner: Cleanup Managed Pods`

확장이 만든 Pod와 ConfigMap을 일괄 삭제한다.

## 설정 시스템

설정은 `src/config.ts`의 `loadConfig()`에서 읽는다.

주요 설정:

- `gpuRunner.namespace`
- `gpuRunner.image`
- `gpuRunner.useHAMi`
- `gpuRunner.gpuMemoryMB`
- `gpuRunner.gpuCount`
- `gpuRunner.pvcName`
- `gpuRunner.workspaceMountPath`
- `gpuRunner.podTimeoutSeconds`
- `gpuRunner.autoDetect`
- `gpuRunner.autoDetectPrompt`
- `gpuRunner.kubeconfigPath`
- `gpuRunner.apiServerUrl`

### 설정의 실제 의미

#### `namespace`

Pod와 ConfigMap을 만들 Kubernetes namespace다.

#### `image`

실험 코드를 실행할 컨테이너 이미지다.

#### `useHAMi`, `gpuMemoryMB`, `gpuCount`

GPU 리소스 요청 방식을 결정한다.

- `useHAMi=false`
  - `nvidia.com/gpu: <gpuCount>` 요청
- `useHAMi=true`
  - `nvidia.com/gpumem: <gpuMemoryMB>` 요청

즉, 기본 모드는 정수 GPU 할당이고, HAMi 모드는 fractional GPU 운영을 전제로 한다.

#### `pvcName`, `workspaceMountPath`

파일 기반 실행의 핵심이다.

- `pvcName`: Pod에 마운트할 공유 PVC 이름
- `workspaceMountPath`: Pod 내부 마운트 위치

이 확장은 로컬 파일을 직접 업로드하지 않고, "로컬 워크스페이스와 클러스터 PVC가 같은 내용을 공유한다"는 전제를 둔다.

#### `kubeconfigPath`

Kubernetes 접속에 사용할 kubeconfig 경로다.

비어 있으면 기본값은 `~/.kube/config`다.

#### `apiServerUrl`

현재 버전에서는 예약값이며 실제 실행에는 사용하지 않는다.

## GPU 코드 감지 방식

GPU 여부는 `src/gpuDetector.ts`에서 정규식 기반으로 판단한다.

지원 감지 대상 예시:

- PyTorch
  - `.cuda()`
  - `.to("cuda")`
  - `torch.cuda.*`
  - `torch.device("cuda")`
- TensorFlow
  - `tf.device("/GPU:0")`
  - `tf.config.list_physical_devices("GPU")`
- HuggingFace
  - `device_map="auto"`
  - `load_in_4bit=True`
  - `BitsAndBytesConfig`
- vLLM, CuPy, RAPIDS, JAX, Numba
- `nvidia-smi`

감지 결과는 `DetectionResult`로 반환된다.

- `requiresGPU`
- `confidence`
- `reasons`
- `frameworks`

중요한 점:

- 실제 실행 환경을 검사하지는 않는다.
- 코드 패턴만 보고 "GPU가 필요해 보이는지"를 추정한다.
- 현재 `requiresGPU`는 high-confidence 패턴이 있을 때만 `true`가 된다.

## 실행 모드 결정 로직

`src/runnerDecisions.ts`의 `decideFileExecutionMode()`가 실행 모드를 정한다.

가능한 결과:

- `local`
- `gpu`
- `prompt`

결정 규칙:

1. GPU가 필요하지 않다고 판단되면 `local`
2. GPU가 필요하고 `auto-gpu`면 `gpu`
3. GPU가 필요하고 `auto-local`이면 `local`
4. GPU가 필요하고 `always-ask`면 `prompt`

즉, 이 계층은 "감지 결과"를 "실행 정책"으로 변환한다.

## 파일 실행과 선택 실행의 차이

두 실행 방식은 내부 원리가 다르다.

### 파일 실행

목적:

- 워크스페이스 안에 있는 Python 파일 전체 실행

원리:

1. 활성 파일의 절대 경로를 가져온다.
2. 워크스페이스 루트 기준 상대경로를 계산한다.
3. 그 상대경로를 Pod 내부의 `workspaceMountPath` 밑 경로로 변환한다.
4. Pod는 해당 파일 경로를 `python <path>`로 실행한다.

예시:

- 워크스페이스 루트: `C:\GPU-Pod-Runner`
- 실행 파일: `C:\GPU-Pod-Runner\examples\cnn_gpu_smoke_test.py`
- Pod 내부 경로: `/workspace/examples/cnn_gpu_smoke_test.py`

이때 가장 중요한 전제는 PVC 내부에도 동일한 디렉터리 구조가 존재해야 한다는 점이다.

### 선택 실행

목적:

- 현재 선택한 코드 조각만 빠르게 GPU Pod에서 실행

원리:

1. 선택 문자열을 읽는다.
2. ConfigMap을 만든다.
3. `selection.py`라는 이름으로 코드를 ConfigMap에 저장한다.
4. Pod는 이 ConfigMap을 `/opt/gpu-runner/selection.py`로 마운트한다.
5. `python /opt/gpu-runner/selection.py`를 실행한다.

장점:

- PVC에 파일이 없어도 실행 가능

주의:

- 선택 코드만 떼어 실행하므로 import, helper 함수, 전역 상태가 빠질 수 있다.

## 워크스페이스 경로 매핑 원리

`src/podManager.ts`의 `mapWorkspaceFileToPodPath()`가 이 역할을 담당한다.

동작:

1. `workspaceRoot`와 `filePath`의 상대경로 계산
2. 현재 파일이 워크스페이스 바깥이면 에러
3. Windows 경로 구분자를 POSIX 경로 구분자로 변환
4. `workspaceMountPath`와 합쳐 Pod 경로 생성

이 로직 때문에 현재 확장은 다음 제약을 가진다.

- single-root workspace만 지원
- 선택한 파일은 반드시 현재 워크스페이스 내부에 있어야 함

실제로 `getSingleWorkspaceFolder()`도 워크스페이스가 정확히 1개일 때만 동작한다.

## UI 계층 구조

UI는 `src/statusBar.ts`가 담당한다.

### 상태바

상태 값:

- `idle`
- `scanning`
- `running`
- `completed`
- `error`

상태바는 다음 역할을 한다.

- 현재 상태 텍스트 표시
- GPU 감지 힌트 표시
- 상태 패널 열기

### 실행 프롬프트

`promptForExecution()`는 GPU 코드 감지 시 사용자의 선택을 받는다.

선택지:

- GPU Pod 실행
- 로컬 실행

### 상태 패널

상태 패널은 Webview 기반이다.

기능:

- 관리 대상 Pod 목록 테이블 표시
- Refresh 버튼
- Cleanup All 버튼
- 5초 주기 자동 refresh

상태 패널의 데이터는 `onRefresh` 콜백을 통해 `PodManager.listManagedPods()`에서 가져온다.

## Kubernetes 연동 구조

실질적인 클러스터 작업은 `PodManager`가 담당한다.

### 1. kubeconfig 초기화

`updateConfig()` 흐름:

1. kubeconfig 경로 결정
2. 파일 존재 여부 확인
3. kubeconfig 로드
4. 현재 cluster 정보 추출
5. 필요 시 API server URL 보정
6. `CoreV1Api` 클라이언트 생성

### 2. TLS 서버명 보정

`normalizeKubeApiServerUrl()`는 loopback 주소와 인증서 SAN 불일치를 줄이기 위한 보정 로직이다.

의도:

- kubeconfig의 `server`가 `127.0.0.1` 같은 loopback인데
- `tls-server-name`은 실제 인증서 SAN에 맞는 값일 때
- host를 `tls-server-name`으로 교체한 URL을 사용하도록 시도

이 로직은 로컬 프록시나 SSH 터널 환경을 고려한 방어 코드로 볼 수 있다.

### 3. Pod 생성

`createAndRun()`은 실행 대상에 따라 다음을 수행한다.

- `selection`
  - ConfigMap 생성
  - Pod 생성
- `workspace-file`
  - Pod만 생성

Pod 이름은 `buildManagedPodName()`으로 생성되며, 짧은 랜덤 suffix가 붙는다.

### 4. Pod Manifest 구성

`buildPodManifest()`는 다음 요소를 가진다.

- label
  - `managed-by=vscode-gpu-runner`
- annotation
  - 실행 종류
  - 소스 파일 경로
  - selection이면 ConfigMap 이름
- volume
  - 공유 PVC
  - selection이면 추가 ConfigMap volume
- container
  - `python <target.podScriptPath>`
  - `workingDir = workspaceMountPath`
  - GPU resource requests/limits

### 5. Pod 완료 대기

`waitForPodPhase()`는 2초 간격 polling 방식이다.

대상 phase:

- `Succeeded`
- `Failed`

타임아웃은 `podTimeoutSeconds` 설정을 사용한다.

### 6. 로그 수집

`streamLogs()`는 Pod 완료 후 `readNamespacedPodLog()`로 로그를 읽는다.

즉, 실시간 스트리밍은 아니고 완료 후 조회 방식이다.

### 7. 정리

실행이 끝나면 `finally` 블록에서 Pod를 삭제한다.

selection 실행이었다면 연결된 ConfigMap도 함께 삭제한다.

또한 확장 deactivate 시에도 `deleteAllManagedPods()`를 시도한다.

## Output Channel 로그 구조

실행 중 Output Channel에는 대략 다음 순서로 로그가 남는다.

```text
[GPU Runner] Starting <displayName>
[GPU Runner] Namespace: <namespace>
[GPU Runner] Image: <image>
[GPU Runner] Script path in pod: <pod path>
[GPU Runner] Pod created: <pod name>
----- Logs for <pod name> -----
<container stdout/stderr>
```

이 로그는 다음 문제를 디버깅할 때 특히 중요하다.

- Pod 내부 실행 경로 오류
- PVC 파일 누락
- Python import 오류
- 컨테이너 이미지 문제
- GPU 자원 스케줄링 지연

## 관리 대상 리소스 식별 방식

확장이 생성한 리소스는 label 기반으로 추적된다.

- key: `managed-by`
- value: `vscode-gpu-runner`

이 label 덕분에 아래 작업이 가능하다.

- 현재 관리 대상 Pod 목록 조회
- 일괄 cleanup

## 상태 갱신 방식

`refreshRunningState()`는 현재 Pod 목록을 조회해 상태바를 업데이트한다.

규칙:

- 활성 Pod가 하나 이상 있으면 `running`
- 완료/에러 상태가 아니고 활성 Pod가 없으면 `idle`
- 실행 성공 시 `completed`
- 실행 실패 시 `error`

즉, 상태바는 "마지막 실행 결과"와 "현재 살아 있는 Pod 수"를 함께 반영한다.

## 현재 구조의 중요한 전제

이 확장은 편의상 단순한 구조를 택하고 있으며, 다음 전제를 강하게 가진다.

### 1. 워크스페이스와 PVC의 내용이 같아야 한다

파일 실행은 로컬 파일 업로드가 아니라 PVC 마운트를 전제로 한다.

따라서 아래 중 하나라도 어긋나면 `Run File`이 실패할 수 있다.

- VS Code가 연 워크스페이스 루트
- 로컬 파일 경로 구조
- PVC 내부 디렉터리 구조
- `workspaceMountPath`

### 2. single-root workspace만 지원한다

멀티 루트 워크스페이스는 현재 지원하지 않는다.

### 3. 실시간 로그 스트리밍이 아니다

로그는 Pod 완료 후 읽는다.

### 4. selection 실행은 문맥이 잘릴 수 있다

현재 선택 영역만 독립 Python 파일처럼 실행되기 때문이다.

### 5. API 서버 프록시 모드는 아직 없다

`apiServerUrl`은 아직 구현되지 않았다.

## 최근 디버깅에서 드러난 포인트

이 구조를 이해할 때 특히 중요한 실제 이슈가 두 가지 있다.

### 1. kubeconfig 경로 혼선

확장은 `gpuRunner.kubeconfigPath`를 우선 사용하고, 비어 있으면 홈 디렉터리의 기본 kubeconfig를 사용한다.

따라서 다음이 다를 수 있다.

- 터미널에서 기본 `kubectl`이 읽는 kubeconfig
- 확장이 읽는 kubeconfig

문제 발생 시 반드시 두 경로를 분리해서 확인해야 한다.

### 2. 파일 실행 경로 불일치

로그에 `/workspace/GPU-Pod-Runner/examples/...`처럼 예상보다 한 단계 더 깊은 경로가 찍힌다면, 보통 다음 중 하나다.

- VS Code를 repo 루트가 아닌 상위 디렉터리로 열었음
- PVC 내부 구조가 로컬 워크스페이스 구조와 다름

즉, 이런 문제는 Kubernetes가 아니라 "경로 매핑 가정"의 문제다.

## 향후 확장 포인트

현재 구조를 기반으로 자연스럽게 확장할 수 있는 방향은 아래와 같다.

### 1. 다중 실험 fan-out 실행

가능한 형태:

- 동일 파일 여러 번 병렬 실행
- 여러 selection을 각기 다른 Pod로 병렬 실행
- 실험 배치를 한 번에 생성

현재 구조에서는 `runGpuTarget()`을 여러 target에 대해 fan-out하는 방식으로 확장 가능하다.

### 2. 실시간 로그 스트리밍

현재의 완료 후 로그 조회를 watch 기반 로그 스트리밍으로 교체할 수 있다.

### 3. PVC 의존성 완화

파일 실행 시에도 소스 파일을 업로드하거나 tar sync하는 기능을 넣으면 워크스페이스와 PVC 동기화 전제를 줄일 수 있다.

### 4. richer status view

예시:

- GPU 요청량 표시
- 실행 시간 표시
- 실패 원인 분류
- Pod 이벤트 표시

### 5. 백엔드 API 모드

현재 예약된 `apiServerUrl` 설정을 실제 서버 중계 모드로 확장할 수 있다.

## 요약

이 확장은 "VS Code에서 GPU가 필요한 Python 코드를 감지하고, Kubernetes GPU Pod에서 대신 실행해주는 얇은 오케스트레이션 레이어"다.

핵심 특징은 다음과 같다.

- 명령 중심 VS Code UX
- 정규식 기반 GPU 코드 감지
- kubeconfig 기반 직접 Kubernetes API 호출
- 파일 실행과 selection 실행의 이원 구조
- 상태바와 Webview를 통한 가벼운 상태 관리
- PVC 공유를 전제로 한 단순한 워크스페이스 매핑

구조는 단순하지만, 실제 안정성은 아래 세 가지에 크게 좌우된다.

1. 올바른 kubeconfig 사용
2. 로컬 워크스페이스와 PVC 내부 경로 일치
3. 클러스터의 GPU/RBAC/PVC 준비 상태

이 세 축이 맞으면, 현재 구조만으로도 "로컬 VS Code에서 클러스터 GPU 실험을 빠르게 트리거하는 개발용 실행기"로 충분히 동작한다.
