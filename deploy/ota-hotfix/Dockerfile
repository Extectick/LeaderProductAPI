# Deliberately pin the running production image; reuse its dependencies and schema.
# This narrow overlay is safe only with the source-diff guard in its workflow.
FROM ghcr.io/extectick/leaderproductapi@sha256:fac21813045f0d1c7de74b7af79d4434bfce4138abc7f871577ee9d38ed33e1c
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
COPY --chown=10001:10001 dist/routes/ota.js /app/dist/routes/ota.js
COPY --chown=10001:10001 dist/utils/otaExpoConfig.js /app/dist/utils/otaExpoConfig.js
COPY --chown=10001:10001 scripts/publish-ota-update-db.js /app/scripts/publish-ota-update-db.js
