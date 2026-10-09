type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** New releases must carry the config from the same build as their bundle. */
export function validateOtaExpoConfig(metadata: unknown, runtimeVersion: string, platform: string): JsonRecord {
  const config = record(record(metadata).expoClient);
  const schemes = Array.isArray(config.scheme) ? config.scheme : [config.scheme];
  if (!text(config.name) || !text(config.slug) || !text(config.version)
      || !schemes.length || !schemes.every((scheme) => text(scheme) && /^[a-z][a-z0-9+.-]*$/i.test(scheme))) {
    throw new Error('OTA metadata.expoClient must contain name, slug, version and a valid scheme');
  }
  // This application uses the appVersion runtime policy. Never relabel a newer bundle for an old APK.
  if (config.version !== runtimeVersion || config.runtimeVersion !== runtimeVersion) {
    throw new Error('OTA expoClient version/runtimeVersion must match the release runtimeVersion');
  }
  if (platform.toLowerCase() === 'android' && !text(record(config.android).package)) {
    throw new Error('OTA expoClient.android.package is required');
  }
  if (platform.toLowerCase() === 'ios' && !text(record(config.ios).bundleIdentifier)) {
    throw new Error('OTA expoClient.ios.bundleIdentifier is required');
  }
  return config;
}

export function resolveOtaExpoConfig(update: {
  metadata: unknown;
  runtimeVersion: string;
  platform: string;
}): JsonRecord {
  const metadata = record(update.metadata);
  if (metadata.expoClient !== undefined || metadata.expoConfigSchemaVersion !== undefined) {
    return validateOtaExpoConfig(metadata, update.runtimeVersion, update.platform);
  }

  // Legacy releases predate config persistence. These identifiers are shared by the
  // released Leader Product APKs; do not borrow config/native modules from the latest APK.
  // Already downloaded manifests need a NEW update ID to receive this repair.
  const android: JsonRecord = { package: 'com.leaderproduct.app' };
  const ios: JsonRecord = { bundleIdentifier: 'com.leaderproduct.app' };
  const versionCode = Number(metadata.baseVersionCode);
  if (Number.isInteger(versionCode) && versionCode > 0) android.versionCode = versionCode;
  if (text(metadata.baseBuildNumber)) ios.buildNumber = metadata.baseBuildNumber;
  return {
    name: 'Лидер Продукт',
    slug: 'leader-product',
    scheme: 'leaderproduct',
    version: update.runtimeVersion,
    runtimeVersion: update.runtimeVersion,
    android,
    ios,
  };
}
