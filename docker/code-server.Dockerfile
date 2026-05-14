FROM node:20-bookworm AS extension-builder

WORKDIR /src

COPY package.json package-lock.json tsconfig.json esbuild.js ./
COPY src ./src
COPY README.md LICENSE ./
COPY docs ./docs
COPY k8s ./k8s

RUN npm ci
RUN npm run package:vsix && cp ./*.vsix /tmp/gpu-pod-runner.vsix

FROM codercom/code-server:4.103.2

USER root

COPY --from=extension-builder /tmp/gpu-pod-runner.vsix /tmp/gpu-pod-runner.vsix

RUN code-server --install-extension /tmp/gpu-pod-runner.vsix \
  && rm -f /tmp/gpu-pod-runner.vsix \
  && mkdir -p /workspace \
  && chown -R coder:coder /workspace /home/coder

USER coder
WORKDIR /workspace
EXPOSE 8080
