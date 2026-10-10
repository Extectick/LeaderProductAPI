export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }] },
  setupFiles: ['<rootDir>/__tests__/env.unit.setup.ts'],
  moduleNameMapper: { '^expo-server-sdk$': '<rootDir>/__tests__/mocks/expo-server-sdk.ts' },
  testMatch: ['**/__tests__/onecSyncRetention.test.ts'],
  testTimeout: 60_000,
};
