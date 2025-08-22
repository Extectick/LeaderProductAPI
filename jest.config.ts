import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  maxWorkers: 1, // чтобы не было гонок при sqlite
  verbose: true,
  testTimeout: 30000,
};
export default config;
