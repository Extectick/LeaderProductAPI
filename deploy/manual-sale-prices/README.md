# Production overlay for manual sale price selection

The production runtime for 24 November 2026 contains earlier release layers beyond the TypeScript in main. This directory reproduces the six changed runtime modules from the deployed base image. The manifest pins the base image and every original and resulting file by SHA-256. The assembly script reads the base through a stopped, network-isolated container.

```sh
python3 deploy/manual-sale-prices/assemble.py /tmp/leader-price-build
docker build --network=none --pull=false -t leader-api-prod:common-sale-prices-20261124-r1 /tmp/leader-price-build
```

The 1C publisher sends its eligible common wholesale GUIDs in the optional `commonSalePriceTypeGuids` field on the existing authenticated offline-policy exchange. Eligibility comes from the current source business day in Omsk. Ordinary offline data, agreement-based pricing and its dependencies retain their existing scope. Explicit online price selection adds common sale prices and revalidates employee access for reads, order writes and retrying stored orders. The scope never adds dependencies of newly available common prices.

This release uses two steps because the older source omits the field. Initially deploy only the resulting `offlineExportPolicy.js` over the same base to accept the additional field while preserving current sales. Switch the API to the full overlay after a normal, current production export authorizes the intended price and an audit confirms existing orders retain their permitted prices. The service `api` alone uses this release. The running Help and knowledge workers use their own existing images.

When building from a newer production base, carry these changes into the corresponding sources or rebase the patch on the new files and repeat the sale and denial checks. A hash mismatch stops this assembly before producing a release. The production rollout does not depend on merging dev.
