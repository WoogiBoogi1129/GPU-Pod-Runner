# GPU Pod Runner

GPU 사용 패턴이 포함된 Python 코드를 감지해 Kubernetes GPU Execution Pod에서 실행하도록 도와주는 VS Code Extension입니다.

이번 버전은 로컬 Windows 개발보다, 같은 Kubernetes 클러스터 안에서 `code-server` IDE Pod와 GPU Execution Pod를 분리해 운영하는 시나리오를 우선 지원합니다.

## 주요 기능

- Python 파일 또는 선택 코드 GPU Pod 실행
- `authMode=auto`일 때 Pod 내부 `in-cluster ServiceAccount` 인증 우선 사용
- `kubeconfig` 기반 fallback 유지
- 현재 IDE Pod의 namespace, ServiceAccount, `/workspace` PVC 자동 탐지
- `gpuRunner.*` 수동 설정이 자동 탐지보다 항상 우선
- `SelfSubjectAccessReview` 기반 권한 점검 및 경고 표시
- `code-server` 기반 사전 설치 IDE 이미지와 예시 매니페스트 제공

## 원격 클러스터 운영 전제

- Kubernetes 클러스터에 접근 가능한 Linux 호스트 또는 점프박스
- `kubectl` 사용 가능
- 이미지 빌드 및 레지스트리 푸시 가능
- RWX PVC 준비
- GPU 노드와 `nvidia.com/gpu` 또는 HAMi 자원 사용 가능

## 핵심 동작

- **Run File**
  - IDE Pod와 Execution Pod가 같은 RWX PVC를 `/workspace`에 마운트한다고 가정합니다.
  - 활성 Python 파일을 워크스페이스 상대경로로 변환해 Execution Pod 안의 `/workspace/...` 경로로 실행합니다.
- **Run Selection**
  - 선택 코드를 ConfigMap으로 업로드해 `/opt/gpu-runner/selection.py`로 마운트하고 실행합니다.
- **자동 탐지**
  - 현재 IDE Pod 안에서 실행 중이면 namespace, 현재 ServiceAccount, `/workspace`에 연결된 PVC 이름을 best-effort로 탐지합니다.
  - 탐지가 일부 실패해도 실행 자체를 사전 차단하지는 않고, 설정값 또는 kubeconfig 방식으로 계속 진행합니다.

## 설정

예시는 `.vscode/settings.json`에 둘 수 있습니다.

```json
{
  "gpuRunner.authMode": "auto",
  "gpuRunner.autoDiscoverClusterContext": true,
  "gpuRunner.namespace": "ml-dev",
  "gpuRunner.image": "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
  "gpuRunner.pvcName": "shared-workspace-pvc",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.executionServiceAccountName": "",
  "gpuRunner.useHAMi": false,
  "gpuRunner.gpuCount": 1
}
```

주요 설정:

- `gpuRunner.authMode`
  - `auto`: Pod 내부면 `loadFromCluster()`, 아니면 kubeconfig 사용
  - `in-cluster`: 항상 ServiceAccount 인증 사용
  - `kubeconfig`: 항상 kubeconfig 사용
- `gpuRunner.autoDiscoverClusterContext`
  - `true`면 현재 IDE Pod 기준으로 namespace, PVC, ServiceAccount를 자동 탐지합니다.
- `gpuRunner.executionServiceAccountName`
  - 비어 있으면 자동 탐지된 현재 IDE Pod ServiceAccount를 Execution Pod에 사용합니다.
- `gpuRunner.image`
  - Execution Pod 이미지입니다.
  - 이 값은 자동 탐지하지 않습니다.
- `gpuRunner.apiServerUrl`
  - 현재 버전에서는 계속 예약값이며 사용하지 않습니다.

## 자동 탐지 우선순위

- 사용자가 명시적으로 설정한 `gpuRunner.namespace`, `gpuRunner.pvcName`, `gpuRunner.executionServiceAccountName`은 자동 탐지보다 우선합니다.
- `authMode=auto`의 인증 우선순위는 다음과 같습니다.
  1. Pod 내부면 `loadFromCluster()`
  2. `gpuRunner.kubeconfigPath`
  3. `~/.kube/config`

## code-server IDE 이미지 빌드

Extension이 사전 설치된 `code-server` 이미지 Dockerfile:

- [docker/code-server.Dockerfile](/home/ubuntu/GPU-Pod-Runner/docker/code-server.Dockerfile)

예시 빌드:

```bash
docker build -f docker/code-server.Dockerfile -t your-registry.example.com/gpu-runner-code-server:latest .
docker push your-registry.example.com/gpu-runner-code-server:latest
```

## Kubernetes 매니페스트

- RBAC: [k8s/rbac.yaml](/home/ubuntu/GPU-Pod-Runner/k8s/rbac.yaml)
- RWX PVC 예시: [k8s/shared-pvc.yaml](/home/ubuntu/GPU-Pod-Runner/k8s/shared-pvc.yaml)
- `code-server` IDE Deployment/Service 예시: [k8s/code-server-ide.yaml](/home/ubuntu/GPU-Pod-Runner/k8s/code-server-ide.yaml)

적용 예시:

```bash
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/shared-pvc.yaml
kubectl apply -f k8s/code-server-ide.yaml
```

## 권한 점검

확장은 초기화 시 `SelfSubjectAccessReview`로 현재 인증 주체의 권한을 점검합니다.

점검 대상:

- `pods`: `get`, `list`, `create`, `delete`
- `pods/log`: `get`
- `configmaps`: `get`, `list`, `create`, `delete`

권한이 부족하면 경고를 표시하지만, 실행 자체를 미리 막지는 않습니다.

## 검증 순서

1. `code-server` 이미지를 빌드하고 푸시합니다.
2. IDE Pod를 배포합니다.
3. IDE Pod 안에서 `/workspace` PVC가 마운트되는지 확인합니다.
4. `GPU Pod Runner` extension이 사전 설치되었는지 확인합니다.
5. `Run Selection`이 성공하는지 확인합니다.
6. `Run File`이 성공하는지 확인합니다.
7. 실제 GPU 코드가 정상 실행되는지 확인합니다.

## 개발

```bash
npm install
npm run compile
npm test
```

## 동작 확인용 예제

- `examples/cnn_gpu_smoke_test.py`
- 외부 데이터셋 다운로드 없이 합성 이미지로 작은 CNN을 학습합니다.
- `torch.cuda.*` 호출이 포함되어 있어 GPU Runner 감지 및 실 GPU 실행 검증에 적합합니다.

## 제한 사항

- 단일 루트 워크스페이스만 지원합니다.
- 실시간 로그 스트리밍은 지원하지 않고 완료 후 로그 조회만 지원합니다.
- 전체 파일 실행은 공유 워크스페이스 PVC 구성이 이미 되어 있어야 합니다.
- `/workspace` 마운트를 현재 IDE Pod에서 찾지 못하면 PVC 자동 탐지는 부분 실패로 처리되고, 수동 설정값 또는 기존 값으로 fallback 합니다.
