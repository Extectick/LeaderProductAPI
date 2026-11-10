# Profile avatars: immutable authenticated assets

`getProfile` retains the existing signed `avatarUrl` for older installed clients.
Managed top-level and subprofile photos additionally return nullable
`avatarAssetUrl` and `avatarVersion`. The URL is relative:

`/users/{ownerId}/avatars/{USER|CLIENT|SUPPLIER|EMPLOYEE}/{64hexVersion}`

Version is SHA-256 of the contract version, owner ID, profile type and canonical
S3 object key. The application writes a new object key for each photo upload;
never overwrite an existing avatar key with different bytes. Signature expiry,
profile refreshes and unrelated profile edits do not change this identity.
For a nonempty external/legacy value outside managed S3 avatar keys, asset fields are omitted so old URL fallback remains possible. Explicit null means no photograph.
The active photo falls back to the legacy user photo when its subprofile has no
photo; nested profiles do not pretend to own that fallback.

The asset endpoint requires normal Bearer authentication and fresh account/profile
access, matching the existing foreign-profile reader policy (employee/admin).
There is no signed URL redirect and no URL access token. Only legacy `avatars/`
and the current environment's `images/avatars/` keys are readable. External URLs,
other storage namespaces and private Help files cannot be fetched through it.

After authorization and version checks it returns `ETag: "avatar-{version}"`,
`Vary: Authorization` and `Cache-Control: private, max-age=31536000, immutable`.
Conditional requests get 304 without fetching storage bytes. Wrong/outdated
versions, missing photos, revoked access and failed storage reads are no-store.
Bytes are bounded to 8 MiB, their raster format is sniffed and current access/photo
identity is checked again before publication. Requesting the current profile is
the update check; it must run in the background without clearing a cached photo.
The frontend must partition persisted data by authenticated account, clear displayed/in-flight memory on logout, and validate the active account before reusing persisted bytes. Retaining a bounded per-account disk cache is distinct from making it available to another signed-in account. Browser Blob URLs themselves are not persistent cache identities.

New uploads use the existing 8 MiB multipart limit, then real image decoding via
installed sharp, EXIF orientation, fit-inside 512×512, metadata stripping and JPEG
encoding. Invalid bytes do not reach S3. Existing uploaded files are not modified
or recompressed by reads; old signed URLs and installed clients keep working.

Unit tests `avatar.asset.unit.test.ts` and `avatar.profile.unit.test.ts` cover
identity, fallback, ACL/version fences, 304 with zero storage reads, no-store errors,
image bytes, invalid uploads and actual sharp normalization. No DB schema change.

## Legacy storage observation (dev, 2026-11-06)

The four existing employee avatar references point to `avatars/*`, but their keys
were absent from the current dev bucket. All matching filenames under
`dev/images/avatars/`, `dev/avatars/`, and `images/avatars/` also returned 404; these
four prefixes were empty. The original dev S3 clone manifest (11,232 objects) had
neither avatar keys nor matching basenames. The supplied handoff contains no image
files. Known dev API filesystem upload/avatar directories were absent.

This observation does not prove the original images are unrecoverable. Restoring
original bytes from the former filesystem/backup is separate from the HTTP/cache
fix; never replace a user's real photo with a generated placeholder. Private keys
and inventory are retained only under `.dev-runtime/avatar-fix/api/recovery.private.json`.

Further read-only checks found the current dev and original production container `/app/uploads` empty, with no uploads volume mounted on dev. The Docker build excludes `uploads`. Exact four keys were also absent from original production S3; no production objects were changed. Recovery/config snapshots under `/opt/leader-api-prod/recovery-{source,state}` contain env references/readiness only. Old references name a former filesystem-facing API at 192.168.30.206:3000 and Beget S3; original host disk/backup investigation remains outside this completed bounded search.

The known old filesystem origin 192.168.30.206:3000 was then checked from host126 with only the four exact legacy filenames under `/files/`, `/uploads/`, and `/` (12 requests, maximum3 concurrent, 5second timeout,8MiB cap). All failed to connect (curl exit7 / no HTTP status); no valid image bytes were recovered. No credentials, guessed tokens or broad scanning were used.
