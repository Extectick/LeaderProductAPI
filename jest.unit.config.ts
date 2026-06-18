import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  testMatch: ['**/__tests__/**/*.unit.test.ts'],
  setupFiles: ['<rootDir>/__tests__/env.unit.setup.ts'],
  moduleNameMapper: {
    '^exceljs$': '<rootDir>/__tests__/mocks/exceljs.ts',
    '^expo-server-sdk$': '<rootDir>/__tests__/mocks/expo-server-sdk.ts',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  verbose: true,
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
};

export default config;
