# S3 Storage Layout

Один бакет используется для всех окружений. Разделение выполняется первым сегментом object key:

```text
dev/
prod/
```

## Environment Variables

```env
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=leader-product
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

# dev для тестовых сборок, prod для production
S3_ENV_PREFIX=dev

# Обычные вложения. Итоговый путь будет dev/files/uploads/...
S3_KEY_PREFIX=uploads

# API route для выдачи файлов клиентам
FILES_BASE_URL=https://api.example.com
UPDATE_PUBLIC_BASE_URL=https://api.example.com/files
FILES_REQUIRE_TOKEN=1
```

Секреты должны храниться только в локальных `.env` и GitHub Secrets. Не добавляйте реальные ключи в git.

## Object Key Layout

```text
dev/
  files/
    uploads/
      ...
  images/
    avatars/
      ...
  updates/
    apk/
      ...
    ota/
      ...

prod/
  files/
    uploads/
      ...
  images/
    avatars/
      ...
  updates/
    apk/
      ...
    ota/
      ...
```

## Current Mappings

- `uploadMulterFile(file)` -> `${S3_ENV_PREFIX}/files/uploads/...`
- `uploadMulterFile(file, false, "avatars")` -> `${S3_ENV_PREFIX}/images/avatars/...`
- `uploadMulterFile(file, true, "updates")` -> `${S3_ENV_PREFIX}/updates/apk/...`
- `buildObjectKey(fileName, "updates")` -> `${S3_ENV_PREFIX}/updates/apk/...`
- future OTA prefix `"ota"` -> `${S3_ENV_PREFIX}/updates/ota/...`

## Release Flow

Development:

```text
GitHub Actions / local build
  -> upload APK to dev/updates/apk/...
  -> create release-metadata.json
  -> local publish script calls dev API, for example http://192.168.30.206:3000
  -> create AppUpdate with channel=dev
  -> dev app checks /updates/check?channel=dev
```

Production:

```text
GitHub Actions approved production release
  -> upload APK to prod/updates/apk/...
  -> create release-metadata.json
  -> local publish script calls https://api.leader-product.ru
  -> create AppUpdate with channel=prod
  -> prod app checks /updates/check?channel=prod
```

## Notes

- `S3_ENV_PREFIX` controls storage folder.
- `EXPO_PUBLIC_UPDATE_CHANNEL` controls which update channel the app checks.
- For dev app builds, use `S3_ENV_PREFIX=dev` on the API that publishes files and `EXPO_PUBLIC_UPDATE_CHANNEL=dev` in the app.
- For production app builds, use `S3_ENV_PREFIX=prod`, `EXPO_PUBLIC_UPDATE_CHANNEL=prod`, and API URL `https://api.leader-product.ru`.
- GitHub Actions does not need public access to the dev API. It can upload APK files to S3 and produce metadata; a local script publishes `AppUpdate` through the API reachable from the operator machine.
- Existing old object keys without `dev/` or `prod/` still resolve because keys stored in DB are used as-is.
