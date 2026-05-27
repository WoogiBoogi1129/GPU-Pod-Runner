# 다른 클러스터로 이식하기

이 문서는 현재 `GPU Pod Runner`를 다른 Kubernetes 클러스터에 붙일 때 어떤 계약이 필요한지 정리합니다.

## 현재 구현이 전제하는 계약

현재 버전은 workspace 전체를 업로드하지 않습니다.

대신 아래 계약이 맞아야 합니다.

1. extension이 대상 클러스터에 인증할 수 있어야 함
2. execution Pod를 만들 namespace와 권한이 준비되어 있어야 함
3. execution Pod가 공유 workspace PVC를 mount할 수 있어야 함
4. IDE Pod와 execution Pod가 같은 파일 레이아웃을 봐야 함
5. 클러스터가 `nvidia.com/gpu` 또는 `nvidia.com/gpumem` 자원을 제공해야 함

## 인증 관점

현재 지원하는 인증 방식:

- in-cluster ServiceAccount
- kubeconfig

실행 기준:

- `authMode=auto`
  - Pod 내부면 in-cluster
  - 아니면 kubeconfig
- `authMode=in-cluster`
  - 항상 현재 Pod ServiceAccount
- `authMode=kubeconfig`
  - 항상 kubeconfig

## namespace와 RBAC 관점

대상 클러스터에는 최소한 아래가 준비되어야 합니다.

- execution Pod를 만들 namespace
- Pod 생성/조회/삭제 권한
- Pod 로그 조회 권한
- `SelfSubjectAccessReview` 생성 권한

즉, `k8s/rbac.yaml` 또는 환경별 변형이 필요합니다.

## workspace PVC 관점

가장 중요한 계약은 “같은 파일을 같은 상대경로로 볼 수 있어야 한다”입니다.

예:

- IDE Pod에서 연 파일: `/workspace/examples/train.py`
- execution Pod 내부 예상 경로: `/workspace/examples/train.py`

PVC 안의 실제 레이아웃이 이 기대와 다르면 실행은 실패합니다.

JupyterHub처럼 home PVC를 `/home/jovyan`에 mount하고 `subPath`를 사용하는 환경에서는 execution Pod도 같은 `subPath`를 써야 합니다.

## GPU 자원 모델 관점

현재 지원하는 자원 요청 모델:

- whole GPU
  - `nvidia.com/gpu`
- fractional GPU sharing
  - `nvidia.com/gpumem`

다른 resource key를 쓰는 클러스터라면 코드 수정이 필요합니다.

기본 운영값:

- `enableFractionalGpuSharing=false`
- `gpuCount=1`

VRAM 단위 분할이 보장된 환경에서만 fractional GPU sharing을 켭니다.

## 다른 클러스터로 옮길 때의 추천 절차

1. kubeconfig 또는 in-cluster auth가 실제로 동작하는지 확인
2. namespace 준비
3. RBAC 적용
4. shared PVC 준비
5. execution image 안에 필요한 Python runtime 포함
6. 작은 Python 파일 또는 [cnn_gpu_smoke_test.py](../examples/cnn_gpu_smoke_test.py)로 검증

## 코드 수정이 필요한 경우

아래 요구가 있으면 현재 구현만으로는 부족할 수 있습니다.

- shared PVC 없이 workspace 업로드/동기화
- 다른 GPU resource key 사용
- 추가 Pod spec 필드
  - `nodeSelector`
  - `tolerations`
  - `affinity`
  - `imagePullSecrets`
- multi-root workspace
- 실시간 로그 스트리밍

## 체크리스트

- kubeconfig 또는 ServiceAccount 인증이 준비되었는가
- namespace가 정확한가
- execution image에 Python과 필요한 라이브러리가 들어 있는가
- PVC 이름이 정확한가
- mount path가 정확한가
- 필요하다면 `subPath`도 맞는가
- GPU resource key가 현재 구현과 맞는가
