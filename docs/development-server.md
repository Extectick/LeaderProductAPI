# Development API server

The public development API is served at `https://dev.leader-product.ru`.

- Checkout: `/opt/leader-api-dev`
- Compose file: `docker-compose.server-dev.yml`
- API listener: `127.0.0.1:3001`
- Nginx terminates TLS and proxies the public domain to port 3001.
- PostgreSQL and Redis use dedicated containers and named volumes.
- Kafka infrastructure is shared with production to save memory, but the dev
  API uses a dedicated client id and request topic.
- S3 credentials may be shared, but `S3_ENV_PREFIX=dev` is mandatory.
- Production and development must never share `DATABASE_URL`, JWT secrets,
  `REDIS_KEY_PREFIX`, `KAFKA_CLIENT_ID` or `KAFKA_REQUEST_TOPIC`.

The server `.env` is intentionally not stored in git. It is created from the
production template during initial provisioning, then all environment-specific
values and authentication secrets are replaced.
