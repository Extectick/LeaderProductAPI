module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }] },
  testMatch: ['**/__tests__/help.service.integration.qa.ts'],
  moduleNameMapper: { '^expo-server-sdk$': '<rootDir>/__tests__/mocks/expo-server-sdk.ts' },
  maxWorkers: 1,
  testTimeout: 30000,
  verbose: true,
};
