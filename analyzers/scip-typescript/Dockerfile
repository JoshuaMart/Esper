# scip-typescript inside Esper's analyzer contract (D12). Built by Esper on first use, from this folder.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
# scip-typescript and pnpm at the versions the lockfile pins, installed without running a script.
COPY esper /opt/esper
RUN cd /opt/esper && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
# The dependency cache is a volume that starts from this folder, owned by the user that runs.
RUN mkdir -p /esper/cache && chown 65532:65532 /esper/cache
# No script of the target's or of a dependency runs, and no package manager updates itself.
ENV HOME=/tmp \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    npm_config_logs_dir=/tmp/npm-logs \
    COREPACK_ENABLE_STRICT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    NODE_OPTIONS=--max-old-space-size=3072
USER 65532:65532
ENTRYPOINT ["node", "/opt/esper/main.mjs"]
