import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.unit.test.ts'],
  setupFiles: ['<rootDir>/__tests__/env.unit.setup.ts'],
  moduleNameMapper: {
    '^exceljs$': '<rootDir>/__tests__/mocks/exceljs.ts',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  verbose: true,
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
};

export default config;
