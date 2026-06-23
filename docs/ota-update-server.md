# OTA Update Server

The API exposes a self-hosted Expo Updates endpoint.

## Public Endpoint

```text
GET /ota/update
POST /ota/update
```

The bridge APK sends Expo headers:

```text
expo-platform: android | ios
expo-runtime-version: <runtimeVersion>
expo-channel-name: dev | prod
expo-current-update-id: <optional current OTA id>
```

Responses:

- `204 No Content`: no compatible OTA update.
- `200 multipart/mixed`: Expo manifest for the selected active OTA update.

Selection rules:

- `platform`, `channel`, and `runtimeVersion` must match.
- Only `isActive=true` rows are eligible.
- Newest `createdAt` wins.
- `rolloutPercent` is applied by deterministic device/update hash.
- If `expo-current-update-id` already equals the selected update id, API returns `204`.

## Admin Endpoints

All admin endpoints require bearer auth and `manage_updates`.

```text
GET /ota
POST /ota/publish
PUT /ota/:id
```

Publish body:

```json
{
  "platform": "android",
  "channel": "dev",
  "runtimeVersion": "0.1.9",
  "updateId": "uuid-or-release-id",
  "launchAssetKey": "dev/updates/ota/android/0.1.9/update-001/bundle.js",
  "launchAssetHash": "sha256...",
  "launchAssetType": "application/javascript",
  "assets": [
    {
      "key": "dev/updates/ota/android/0.1.9/update-001/assets/icon.png",
      "hash": "sha256...",
      "contentType": "image/png",
      "fileExtension": ".png"
    }
  ],
  "metadata": {
    "commitSha": "..."
  },
  "isActive": true,
  "rolloutPercent": 100,
  "commitSha": "...",
  "releaseNotes": "..."
}
```

## S3 Layout

```text
dev/updates/ota/android/<runtimeVersion>/<updateId>/
  bundle.js
  assets/
  manifest.json

prod/updates/ota/android/<runtimeVersion>/<updateId>/
  bundle.js
  assets/
  manifest.json
```

OTA files are immutable. Publish a new `updateId` instead of overwriting existing objects.
