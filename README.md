# GPU Pod Runner

GPU 사용 패턴이 포함된 Python 코드를 감지해 Kubernetes GPU Pod에서 실행하도록 도와주는 VS Code Extension입니다.

## v1 범위

- `@kubernetes/client-node` 기반 direct kubeconfig 제어
- Python 파일 GPU 패턴 감지
- GPU Pod 생성, 완료 대기, 로그 수집, 정리
- 상태바와 WebView 기반 상태 확인
- 선택 코드(`runSelection`)는 ConfigMap 임시 업로드 방식으로 실행

## 전제 조건

- VS Code 1.85+
- Node.js 18+
- Kubernetes 클러스터 접근 가능한 `kubectl`
- GPU 노드, NVIDIA Device Plugin, RWX PVC 준비
- v1은 `gpuRunner.apiServerUrl`을 실제로 사용하지 않습니다

## 핵심 동작

- **전체 파일 실행**
  - 로컬 워크스페이스와 클러스터 PVC가 같은 내용을 공유한다고 가정합니다
  - 활성 Python 파일을 워크스페이스 상대경로로 변환해 Pod 안의 `workspaceMountPath`로 매핑합니다
- **선택 코드 실행**
  - 선택한 코드 조각을 ConfigMap으로 업로드한 뒤 Pod에 마운트해 실행합니다
  - 실행 종료 후 Pod와 ConfigMap을 정리합니다

## 주요 명령

- `GPU Runner: Run File` (`Ctrl+Shift+G`)
- `GPU Runner: Run Selection`
- `GPU Runner: Show Status`
- `GPU Runner: Cleanup Managed Pods`

## 설정

예시는 `.vscode/settings.json`에 포함되어 있습니다.

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

## 개발

```bash
npm install
npm run compile
npm test
```

개발용 Extension Host 실행:

1. VS Code에서 이 폴더를 연다
2. `F5`를 눌러 Extension Development Host를 실행한다

## Kubernetes 리소스

- RBAC: `k8s/rbac.yaml`
- RWX PVC 예시: `k8s/shared-pvc.yaml`

적용 예시:

```bash
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/shared-pvc.yaml
```

## 제한 사항

- v1은 단일 루트 워크스페이스만 지원합니다
- 실시간 로그 스트리밍은 지원하지 않고 완료 후 로그 조회만 지원합니다
- API 서버 프록시 모드는 후속 버전 범위입니다
- 전체 파일 실행은 공유 워크스페이스 구성이 이미 되어 있어야 합니다
