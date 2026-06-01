# 문제 해결 가이드

이 문서는 현재까지 실제로 자주 만난 문제를 기준으로 `GPU Pod Runner` 운영 시 확인해야 할 항목을 정리합니다.

## 1. VS Code 안에 GPU Pod Runner 확장이 보이지 않음

가능한 원인:

- JupyterHub home PVC가 `/home/jovyan`을 덮어써서 이미지 빌드 시 설치한 확장이 가려짐
- 사용자 extension cache가 stale 상태
- 확장 디렉토리는 없는데 extension 목록만 남아 있음

현재 대응 방식:

- JupyterHub 이미지는 VSIX를 `/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix`에 보관
- launcher가 시작 시 사용자 extension 디렉토리를 검사
- 설치가 없거나, 디렉토리가 없거나, 버전이 다르면 재설치

확인 포인트:

- single-user Pod 로그에 uninstall/install 메시지가 보이는지
- `code-server --list-extensions --show-versions`에서 `local.gpu-pod-runner`가 보이는지

## 2. `GPU Runner is not initialized.`

가능한 원인:

- extension host가 실제 확장을 로드하지 못함
- stale extension cache로 인해 VSIX가 반영되지 않음
- Kubernetes 초기화 중 인증 또는 권한 점검 실패

확인 포인트:

- Output channel에 Kubernetes auth mode와 warning이 찍히는지
- 확장 버전이 기대한 최신 버전인지
- launcher가 bundled VSIX를 실제로 재설치했는지

## 3. `python: can't open file '/home/jovyan/test.py'`

대표 원인:

- execution Pod가 workspace PVC는 같은 것을 쓰지만, JupyterHub 사용자 home의 `subPath`를 재사용하지 못함

대표 상황:

- IDE Pod
  - PVC: `jupyterhub-singleuser-pvc`
  - mount path: `/home/jovyan`
  - subPath: `user1`
- execution Pod
  - 같은 PVC를 `/home/jovyan`에 mount하지만 `subPath`를 빼먹음

이 경우 IDE Pod에서 보이는 `/home/jovyan/test.py`는 실제로 PVC 루트 기준 `user1/test.py`이므로, execution Pod도 같은 `subPath`를 사용해야 합니다.

현재 구현은 자동 탐지한 `workspaceSubPath`를 execution Pod `volumeMount.subPath`에 반영합니다.

## 4. spawn 시 `/api` timeout 또는 VS Code가 열리지 않음

가능한 원인:

- standalone `code-server` 이미지를 JupyterHub에 그대로 연결함
- launcher가 JupyterHub single-user 계약에 맞게 동작하지 않음
- `jupyter standaloneproxy`를 거치지 않음

확인 포인트:

- JupyterHub profile image가 `docker/jupyterhub-code-server.Dockerfile` 기반 이미지인지
- profile `cmd`가 `/usr/local/bin/start-jupyterhub-code-server.sh`인지

## 5. image pull 인증 오류

가능한 원인:

- private registry 또는 Docker Hub credential 미설정
- 새 태그를 처음 pull하는데 node cache에 없는 상태

확인 포인트:

- namespace에 imagePullSecret이 있는지
- single-user ServiceAccount가 그 secret을 참조하는지
- 예전 태그는 node cache에 있어서 보였던 것은 아닌지

## 6. execution Pod 생성 실패 또는 RBAC 경고

가능한 원인:

- current ServiceAccount에 Pod 생성/조회/삭제 권한 부족
- `pods/log` 조회 권한 부족
- `SelfSubjectAccessReview` 생성 권한 부족

확인 포인트:

- `examples/jupyterhub-vscode-rbac.yaml` 또는 `k8s/rbac.yaml`을 환경에 맞게 적용했는지
- extension output channel의 permission warning 메시지

## 7. GPU resource 관련 Pending 또는 스케줄 실패

가능한 원인:

- 클러스터가 `nvidia.com/gpu`를 제공하지 않음
- fractional GPU sharing이 꺼져야 하는 환경에서 `nvidia.com/gpumem` 요청을 사용
- GPU 수량 또는 메모리 요청이 클러스터 정책과 맞지 않음

권장 기본값:

- `gpuRunner.enableFractionalGpuSharing=false`
- `gpuRunner.gpuCount=1`

KAI-Scheduler처럼 whole GPU 할당만 가능한 환경에서는 기본값을 유지합니다.

## 8. 파일은 있는데 실행 경로가 맞지 않음

가능한 원인:

- IDE Pod와 execution Pod의 workspace root가 다름
- shared PVC 안의 디렉토리 구조가 workspace root 기준 상대경로와 다름

기억할 점:

`Run File`은 현재 파일 경로를 workspace 상대경로로 바꾼 뒤 `workspaceMountPath` 아래에 붙입니다.

즉, IDE Pod에서 열린 파일과 execution Pod 내부 파일이 같은 상대경로를 가져야 합니다.

## 빠른 진단 순서

1. extension output channel 확인
2. 현재 effective namespace, PVC, ServiceAccount 확인
3. single-user Pod의 PVC mount path와 subPath 확인
4. execution Pod 이벤트와 로그 확인
5. execution image의 Python runtime과 dependency 확인
