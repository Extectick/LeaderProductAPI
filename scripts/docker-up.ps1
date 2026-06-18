$ErrorActionPreference = "Stop"

docker compose up -d
docker compose --profile init run --rm minio-init
