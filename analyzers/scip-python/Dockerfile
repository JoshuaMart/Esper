# scip-python inside Esper's analyzer contract (D12). Built by Esper on first use, from this folder.
FROM ghcr.io/astral-sh/uv:0.13.6@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 AS uv

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# Python only for uv to install wheels with; the analysis runs without it on its path.
RUN apk add --no-cache python3
COPY --from=uv /uv /usr/local/bin/uv
# scip-python at the version the lockfile pins, installed without running a script.
COPY esper /opt/esper
RUN cd /opt/esper && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
# The dependency cache is a volume that starts from this folder, owned by the user that runs.
RUN mkdir -p /esper/cache && chown 65532:65532 /esper/cache
# Wheels only, from PyPI whatever the target's configuration says: no build backend and no setup
# script runs.
ENV HOME=/tmp \
    UV_CACHE_DIR=/esper/cache/uv \
    UV_INDEX_URL=https://pypi.org/simple \
    UV_NO_CONFIG=1 \
    UV_NO_BUILD=1 \
    UV_PYTHON_DOWNLOADS=never \
    npm_config_update_notifier=false \
    NODE_OPTIONS=--max-old-space-size=3072
USER 65532:65532
ENTRYPOINT ["node", "/opt/esper/main.mjs"]
