# Testing

## Fast Local Tests

Use this on any machine, even without a local database:

```bash
npm test
```

This runs the unit-only test suite (`*.unit.test.ts`) through `jest.unit.config.ts`.

You can also run it explicitly:

```bash
npm run test:unit
```

## Integration Tests With Docker

Use this when you want the full Jest suite with a real PostgreSQL instance, but without installing PostgreSQL locally:

```bash
npm run test:integration:docker
```

What it does:

1. Starts `docker-compose.test.yml`
2. Starts test PostgreSQL, Redis, and MinIO (S3-compatible storage)
3. Runs the integration test suite against `LeaderAPI_test` on port `54329`
4. Uses test Redis on port `6389`
5. Uses test S3 on `http://127.0.0.1:9009` with bucket `leader-api-test`
6. Stops the test containers and removes the test volumes

## Manual Docker Commands

If you want to keep the test database running while you work:

```bash
npm run test:integration:db:up
npm run test:integration
```

Then stop and clean it:

```bash
npm run test:integration:db:down
```

## Test Database URL

Default integration test database URL:

```text
postgresql://postgres:postgres@127.0.0.1:54329/LeaderAPI_test?schema=public
```

You can override it with either:

- `DATABASE_URL`
- `TEST_DATABASE_URL`

See [`.env.test.example`](/d:/GitRepositories/LeaderProduct/LeaderProductAPI/.env.test.example).

## Test Redis URL

Default integration test Redis URL:

```text
redis://127.0.0.1:6389
```

You can override it with either:

- `REDIS_URL`
- `TEST_REDIS_URL`

## Test S3 URL

Default integration test S3 endpoint:

```text
http://127.0.0.1:9009
```

Default integration test bucket:

```text
leader-api-test
```

The integration test bootstrap creates the bucket automatically before test seeding.

You can override the S3 settings with either:

- `S3_ENDPOINT` / `TEST_S3_ENDPOINT`
- `S3_PRESIGN_ENDPOINT` / `TEST_S3_PRESIGN_ENDPOINT`
- `S3_BUCKET` / `TEST_S3_BUCKET`
- `S3_ACCESS_KEY` / `TEST_S3_ACCESS_KEY`
- `S3_SECRET_KEY` / `TEST_S3_SECRET_KEY`
