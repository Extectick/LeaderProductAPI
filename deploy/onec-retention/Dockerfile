# Reviewed source-only overlay: no schema/dependency changes. Workflow guards the diff.
FROM ghcr.io/extectick/leaderproductapi@sha256:f1ebf8dd2af8ee01f295293cd8344bf402f1eef5c9f785492fbb9888b8dbe718
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
COPY --chown=10001:10001 dist/ /app/dist/
COPY --chown=10001:10001 scripts/onec-sync-retention.js /app/scripts/onec-sync-retention.js
