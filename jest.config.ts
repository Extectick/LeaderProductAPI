import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['\\.unit\\.test\\.ts$'],
  setupFiles: ['<rootDir>/__tests__/env.setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    '^expo-server-sdk$': '<rootDir>/__tests__/mocks/expo-server-sdk.ts',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  maxWorkers: 1, // чтобы не было гонок при sqlite
  verbose: true,
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
};
export default config;
