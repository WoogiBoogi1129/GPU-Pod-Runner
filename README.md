# GPU Pod Runner

`GPU Pod Runner`는 Python 파일을 분석해 GPU 실행이 필요한 코드를 Kubernetes GPU execution Pod에서 실행하도록 돕는 VS Code Extension입니다.

이 레포는 두 가지 운영 모드를 지원합니다.

- standalone `code-server` IDE Pod
- JupyterHub direct VS Code single-user Pod

## 핵심 기능

- `Run File`로 현재 Python 파일 전체 실행
- `Show Status`로 관리 중인 execution Pod 상태 확인
- `Cleanup Managed Pods`로 확장이 만든 Pod 정리
- `authMode=auto`에서 in-cluster ServiceAccount 인증 우선 사용
- kubeconfig 기반 실행 지원
- 현재 IDE Pod의 namespace, ServiceAccount, PVC-backed workspace mount 자동 탐지
- whole GPU 기본값 사용
- 필요할 때만 fractional GPU sharing 선택 지원

## 빠른 시작

### 1. standalone `code-server`로 시작

1. execution Pod에 사용할 namespace, RBAC, shared PVC를 준비합니다.
2. `docker/code-server.Dockerfile`로 IDE 이미지를 빌드합니다.
3. `k8s/rbac.yaml`, `k8s/shared-pvc.yaml`, `k8s/code-server-ide.yaml`을 환경에 맞게 적용합니다.
4. VS Code에서 Python 파일을 열고 `GPU Runner: Run File`을 실행합니다.

자세한 절차는 [deployment-guide.md](docs/deployment-guide.md)에서 설명합니다.

### 2. JupyterHub direct VS Code로 시작

1. JupyterHub single-user profile에 VS Code 이미지를 연결합니다.
2. `examples/jupyterhub-vscode-rbac.yaml` 기반 ServiceAccount와 RBAC를 적용합니다.
3. `docker/jupyterhub-code-server.Dockerfile`로 이미지를 빌드합니다.
4. JupyterHub에서 `VS Code` 프로필로 로그인한 뒤 `GPU Runner: Run File`을 실행합니다.

자세한 절차는 [jupyterhub-integration.md](docs/jupyterhub-integration.md)에서 설명합니다.

## 필수 설정 예시

아래 예시는 가장 일반적인 설정 조합입니다.

```json
{
  "gpuRunner.authMode": "auto",
  "gpuRunner.autoDiscoverClusterContext": true,
  "gpuRunner.namespace": "ml-dev",
  "gpuRunner.image": "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
  "gpuRunner.pvcName": "shared-workspace-pvc",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.executionServiceAccountName": "",
  "gpuRunner.enableFractionalGpuSharing": false,
  "gpuRunner.gpuCount": 1,
  "gpuRunner.podTimeoutSeconds": 600
}
```

주요 설정 기준:

- `gpuRunner.authMode`
  - `auto`: Pod 내부면 in-cluster, 아니면 kubeconfig
  - `in-cluster`: 항상 현재 Pod ServiceAccount 인증
  - `kubeconfig`: 항상 kubeconfig 인증
- `gpuRunner.autoDiscoverClusterContext`
  - 현재 IDE Pod의 namespace, ServiceAccount, PVC-backed workspace mount 자동 탐지
- `gpuRunner.enableFractionalGpuSharing`
  - 기본값은 `false`
  - `false`면 `nvidia.com/gpu` 기준 whole GPU 요청
  - `true`면 `nvidia.com/gpumem` 기준 fractional GPU sharing 요청
- `gpuRunner.gpuCount`
  - whole GPU 모드에서 요청할 GPU 개수
  - 기본값은 `1`
- `gpuRunner.useHAMi`
  - deprecated alias
  - 새 설정은 `gpuRunner.enableFractionalGpuSharing`
- `gpuRunner.apiServerUrl`
  - 현재 버전에서는 예약값이며 사용하지 않음

## 문서 안내

- [deployment-guide.md](docs/deployment-guide.md)
  - standalone `code-server` 배포와 최소 검증 절차
- [jupyterhub-integration.md](docs/jupyterhub-integration.md)
  - JupyterHub direct VS Code 운영 가이드
- [architecture.md](docs/architecture.md)
  - 현재 extension 동작 구조와 Pod spec 생성 흐름
- [cluster-portability.md](docs/cluster-portability.md)
  - 다른 클러스터로 이식할 때 필요한 계약과 점검 항목
- [troubleshooting.md](docs/troubleshooting.md)
  - 실제 운영 중 자주 만나는 문제와 해결 가이드

## 예제와 검증

- [examples/cnn_gpu_smoke_test.py](examples/cnn_gpu_smoke_test.py)
  - PyTorch 기반 GPU 감지와 실제 execution Pod 실행 확인용 예제
- [examples/jupyterhub-profile-values.yaml](examples/jupyterhub-profile-values.yaml)
  - JupyterHub single-user profile 예시
- [examples/jupyterhub-vscode-rbac.yaml](examples/jupyterhub-vscode-rbac.yaml)
  - JupyterHub VS Code profile용 ServiceAccount/RBAC 예시

## 현재 동작 기준

- 현재 명령은 `Run File`, `Show Status`, `Cleanup Managed Pods` 3개만 제공합니다.
- `Run Selection`과 ConfigMap 기반 선택 실행은 더 이상 지원하지 않습니다.
- shared PVC가 이미 준비되어 있고, IDE Pod와 execution Pod가 같은 파일 레이아웃을 볼 수 있어야 합니다.
- JupyterHub 모드에서는 `/workspace`만 가정하지 않고 `/home/jovyan` 같은 `HOME` 정렬 PVC mount도 자동 탐지합니다.
- JupyterHub의 사용자 home PVC가 `subPath`로 마운트되는 경우 execution Pod도 같은 `subPath`를 사용해야 파일 경로가 일치합니다.

## 제한 사항

- single-root workspace만 지원합니다.
- full workspace 업로드/동기화 기능은 제공하지 않습니다.
- 실시간 로그 스트리밍 대신 완료 후 로그 조회 방식을 사용합니다.
- auto-discovery가 원하는 mount를 찾지 못하면 `HOME` 정렬 PVC 또는 첫 번째 PVC mount로 fallback 할 수 있습니다.

## 개발

```bash
npm install
npm run compile
npm test
```
