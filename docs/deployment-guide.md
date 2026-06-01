# standalone `code-server` 배포 가이드

이 문서는 standalone `code-server` IDE Pod와 `GPU Pod Runner` extension을 함께 배포하는 가장 기본적인 운영 절차를 설명합니다.

## 준비 조건

- Kubernetes 클러스터 접근 가능
- `kubectl` 사용 가능
- 이미지 빌드와 레지스트리 푸시 가능
- execution Pod가 볼 shared PVC 준비 가능
- GPU 노드에서 `nvidia.com/gpu` 또는 `nvidia.com/gpumem` 사용 가능

## 배포 아티팩트

- IDE 이미지 Dockerfile: `docker/code-server.Dockerfile`
- RBAC 예시: `k8s/rbac.yaml`
- shared PVC 예시: `k8s/shared-pvc.yaml`
- standalone IDE Pod 예시: `k8s/code-server-ide.yaml`

## 1. IDE 이미지 빌드

```bash
docker build \
  -f docker/code-server.Dockerfile \
  -t your-registry.example.com/gpu-runner-code-server:latest \
  .

docker push your-registry.example.com/gpu-runner-code-server:latest
```

이 이미지는 `code-server`와 `GPU Pod Runner` 확장이 함께 들어 있는 standalone IDE 이미지입니다.

## 2. namespace, RBAC, PVC 준비

환경에 맞게 아래 매니페스트를 조정한 뒤 적용합니다.

```bash
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/shared-pvc.yaml
```

필수 전제:

- execution Pod를 만들 namespace가 이미 존재해야 함
- PVC 이름이 `gpuRunner.pvcName`과 일치해야 함
- PVC 안의 파일 레이아웃이 IDE Pod와 execution Pod에서 동일해야 함

## 3. IDE Pod 배포

`k8s/code-server-ide.yaml`에서 아래 값을 환경에 맞게 바꿉니다.

- IDE 이미지 경로
- namespace
- PVC 이름
- 필요 시 ServiceAccount 이름

적용:

```bash
kubectl apply -f k8s/code-server-ide.yaml
```

## 4. VS Code 설정 확인

가장 기본적인 설정 예시는 아래와 같습니다.

```json
{
  "gpuRunner.authMode": "auto",
  "gpuRunner.autoDiscoverClusterContext": true,
  "gpuRunner.namespace": "ml-dev",
  "gpuRunner.image": "pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
  "gpuRunner.pvcName": "shared-workspace-pvc",
  "gpuRunner.workspaceMountPath": "/workspace",
  "gpuRunner.enableFractionalGpuSharing": false,
  "gpuRunner.gpuCount": 1
}
```

운영 기본값:

- `enableFractionalGpuSharing=false`
- `gpuCount=1`

VRAM 단위 분할이 실제로 가능한 환경에서만 fractional GPU sharing을 켭니다.

## 5. 최소 검증 절차

1. IDE Pod가 실행 중인지 확인
2. workspace PVC가 IDE Pod에 mount되는지 확인
3. `GPU Pod Runner` 확장이 설치되어 있는지 확인
4. [cnn_gpu_smoke_test.py](../examples/cnn_gpu_smoke_test.py)를 열기
5. `GPU Runner: Run File` 실행
6. execution Pod가 생성되고 로그가 정상 출력되는지 확인

## 실행 성공의 핵심 조건

성공하려면 아래 세 가지가 동시에 맞아야 합니다.

- execution Pod를 만들 권한이 있어야 함
- execution image 안에 Python과 필요한 라이브러리가 있어야 함
- PVC 안의 파일 경로가 IDE Pod와 execution Pod에서 동일해야 함

파일 경로가 다르면 Python이 `No such file or directory`로 실패합니다.

## 다음 문서

- JupyterHub 환경이면 [jupyterhub-integration.md](jupyterhub-integration.md)
- 다른 클러스터 이식이면 [cluster-portability.md](cluster-portability.md)
- 문제 해결은 [troubleshooting.md](troubleshooting.md)
