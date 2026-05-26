FROM node:20-bookworm AS extension-builder

WORKDIR /src

COPY package.json package-lock.json tsconfig.json esbuild.js ./
COPY src ./src
COPY README.md LICENSE ./
COPY docs ./docs
COPY k8s ./k8s
COPY docker ./docker

RUN npm ci
RUN npm run package:vsix && cp ./*.vsix /tmp/gpu-pod-runner.vsix

FROM quay.io/jupyterhub/k8s-singleuser-sample:4.3.5

USER root

ARG CODE_SERVER_VERSION=4.103.2
ENV DEBIAN_FRONTEND=noninteractive
ENV CODE_SERVER_INSTALL_ROOT=/opt/code-server

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  ARCH="$(dpkg --print-architecture)"; \
  case "${ARCH}" in \
    amd64) CODE_SERVER_ARCH="amd64" ;; \
    arm64) CODE_SERVER_ARCH="arm64" ;; \
    *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${CODE_SERVER_ARCH}.tar.gz" \
    | tar -xz -C /opt; \
  mv "/opt/code-server-${CODE_SERVER_VERSION}-linux-${CODE_SERVER_ARCH}" "${CODE_SERVER_INSTALL_ROOT}"; \
  ln -sf "${CODE_SERVER_INSTALL_ROOT}/bin/code-server" /usr/local/bin/code-server

RUN pip install --no-cache-dir "jupyter-server-proxy[standalone]"

COPY docker/start-jupyterhub-code-server.sh /usr/local/bin/start-jupyterhub-code-server.sh
COPY --from=extension-builder /tmp/gpu-pod-runner.vsix /tmp/gpu-pod-runner.vsix

RUN chmod 0755 /usr/local/bin/start-jupyterhub-code-server.sh \
  && chown ${NB_UID}:users /tmp/gpu-pod-runner.vsix

USER ${NB_UID}

RUN mkdir -p /home/jovyan/.local/share/code-server /home/jovyan/.config/code-server /home/jovyan/workspace \
  && code-server --install-extension /tmp/gpu-pod-runner.vsix \
  && rm -f /tmp/gpu-pod-runner.vsix

WORKDIR /home/jovyan
EXPOSE 8888

CMD ["/usr/local/bin/start-jupyterhub-code-server.sh"]
