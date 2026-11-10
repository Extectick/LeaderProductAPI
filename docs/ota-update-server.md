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
- Manifest `metadata.displayVersion` contains the human-readable runtime version, for example `v0.1.12+11.ota.2`.

The public manifest's `launchAsset.key` and `assets[].key` are **local cache
identifiers**, not S3 paths. For Metro assets the API preserves the MD5 file
hash from the object basename, so `expo-asset` can find images and fonts in
`ExpoUpdates.localAssets`. Other keys, including `bundle.hbc`, become the
SHA-256 hex digest of the stored object key. Download URLs still resolve the original S3 paths and
`hash` still verifies the downloaded bytes. Expo SDK 58 builds local filenames
from `key + fileExtension` and rejects `/`, `\`, NUL, `.` and `..`. Passing an
S3 path as the manifest key makes the installed APK reject the update before
downloading it, even when the endpoint and all asset URLs return HTTP 200.

On 2026-11-04 this caused APK 0.1.46 (build 45) to stay on embedded 0.1.46.0
despite published OTA 0.1.46.3. The dev server fix is
`leaderproductapi:ota-filename-dev-20261104-r2`, layered on the active
`leaderproductapi:help-behavior-dev-20261104`; only `dist/routes/ota.js` changed.
API and Help worker use the same image. No APK rebuild, OTA republication,
storage rewrite or database change is required. The regression test in
`__tests__/ota.manifest.unit.test.ts` exercises the real HTTP route, safe
filenames, distinct objects with the same basename, stable identifiers and
preservation of URLs and content hashes.

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
    "commitSha": "...",
    "baseVersionName": "0.1.12",
    "baseVersionCode": 11
  },
  "otaSequence": 2,
  "displayVersion": "v0.1.12+11.ota.2",
  "isActive": true,
  "rolloutPercent": 100,
  "commitSha": "...",
  "releaseNotes": "..."
}
```

`otaSequence` and `displayVersion` are optional on publish. When omitted, API calculates the next sequence for the same `platform + channel + runtimeVersion` and builds:

```text
v<baseVersionName>+<baseVersionCode>.ota.<otaSequence>
```

If base version metadata is missing, API falls back to `runtimeVersion`.

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
