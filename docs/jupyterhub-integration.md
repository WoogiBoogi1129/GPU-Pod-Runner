# JupyterHub direct VS Code 운영 가이드

이 문서는 JupyterHub에서 사용자가 `VS Code` 프로필을 선택하면 바로 `code-server`로 진입하고, 그 안에서 `GPU Pod Runner`로 GPU execution Pod를 실행하는 구성을 설명합니다.

## 목표

- 기존 standalone `code-server` 흐름은 유지
- JupyterHub single-user 계약에 맞는 VS Code 이미지 제공
- execution Pod가 현재 사용자 서버와 같은 namespace, 같은 PVC 문맥을 재사용

## 관련 파일

- JupyterHub 이미지 Dockerfile: `docker/jupyterhub-code-server.Dockerfile`
- launcher script: `docker/start-jupyterhub-code-server.sh`
- profile 예시: `examples/jupyterhub-profile-values.yaml`
- RBAC 예시: `examples/jupyterhub-vscode-rbac.yaml`

## 왜 별도 JupyterHub 이미지가 필요한가

standalone 이미지인 `docker/code-server.Dockerfile`은 `code-server`를 직접 띄우는 용도입니다.

JupyterHub single-user 서버는 아래 조건을 만족해야 합니다.

- JupyterHub가 기대하는 서비스 포트에 응답
- 사용자 base URL과 prefix를 따름
- 활동 상태를 JupyterHub에 보고

이를 위해 JupyterHub 전용 이미지는 `code-server`를 `jupyter standaloneproxy`로 감싸서 실행합니다.

## 이미지 빌드

```bash
docker build \
  -f docker/jupyterhub-code-server.Dockerfile \
  -t your-registry.example.com/gpu-runner-jupyterhub-code-server:latest \
  .

docker push your-registry.example.com/gpu-runner-jupyterhub-code-server:latest
```

## JupyterHub profile 연결

`examples/jupyterhub-profile-values.yaml`을 시작점으로 사용합니다.

중요 포인트:

- VS Code profile image는 JupyterHub 전용 이미지를 사용해야 함
- `cmd`는 `/usr/local/bin/start-jupyterhub-code-server.sh`를 사용해야 함
- single-user Pod ServiceAccount는 execution Pod 생성/조회/삭제와 로그 조회 권한이 있어야 함

## VSIX 설치 전략

JupyterHub는 보통 사용자 home PVC를 `/home/jovyan`에 mount합니다.

이 때문에 이미지 빌드 시 `/home/jovyan` 아래에 확장을 미리 설치해두면, 실제 Pod 실행 시 PVC가 그 경로를 덮어써서 확장이 가려질 수 있습니다.

현재 이미지는 아래 방식으로 이 문제를 해결합니다.

- VSIX를 이미지 내부의 고정 경로인 `/opt/gpu-pod-runner/extensions/gpu-pod-runner.vsix`에 보관
- 컨테이너 시작 시 사용자별 code-server extension 디렉토리에 설치
- 이미 설치된 확장이 있어도 버전이 다르면 재설치
- stale extension cache나 extension directory 누락 상태도 복구

즉, JupyterHub home PVC가 있어도 이미지는 self-contained 상태를 유지합니다.

## PVC mount와 execution Pod 정합성

JupyterHub에서 가장 중요한 운영 포인트는 파일 경로 정합성입니다.

사용자 Pod 예시:

- PVC: `jupyterhub-singleuser-pvc`
- mount path: `/home/jovyan`
- subPath: `user1`

이 경우 사용자는 `/home/jovyan/test.py`를 보지만, 실제 PVC 루트 기준 파일은 `user1/test.py`입니다.

따라서 execution Pod도 아래 세 값을 동일하게 가져가야 합니다.

- 같은 PVC 이름
- 같은 mount path
- 같은 `subPath`

현재 구현은 IDE Pod의 PVC-backed mount를 자동 탐지하면서 `subPath`까지 함께 읽고, execution Pod의 `volumeMount.subPath`에 재사용합니다.

## 권장 RBAC 모델

`examples/jupyterhub-vscode-rbac.yaml`을 기준으로 적용합니다.

필요 권한:

- `pods`: `get`, `list`, `watch`, `create`, `delete`
- `pods/log`: `get`
- `selfsubjectaccessreviews`: `create`

적용 전 확인:

- namespace가 실제 Hub namespace와 일치하는지
- profile에서 사용하는 ServiceAccount 이름과 RBAC subject가 일치하는지

## 최소 검증 절차

1. JupyterHub 전용 이미지를 빌드하고 푸시
2. VS Code profile image를 새 이미지로 연결
3. RBAC와 ServiceAccount 적용
4. 사용자가 JupyterHub에 로그인
5. `VS Code` profile 선택
6. VS Code가 직접 열리는지 확인
7. [cnn_gpu_smoke_test.py](../examples/cnn_gpu_smoke_test.py) 또는 간단한 Python 파일 열기
8. `GPU Runner: Run File` 실행
9. execution Pod가 같은 namespace에서 생성되는지 확인
10. execution Pod가 같은 파일을 보고 정상 실행되는지 확인

## 운영 시 자주 보는 실패 지점

- 확장이 보이지 않음
  - 사용자 PVC가 이전 extension cache를 들고 있거나, launcher 재설치가 필요한 상태
- 이미지 pull 실패
  - private registry 또는 Docker Hub credential 미설정
- `/api` timeout
  - single-user launcher가 JupyterHub 계약에 맞게 기동하지 못한 경우
- `python: can't open file '/home/jovyan/test.py'`
  - execution Pod가 home PVC의 `subPath`를 재사용하지 못한 경우

세부 해결 방법은 [troubleshooting.md](troubleshooting.md)를 참고합니다.
