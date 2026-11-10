import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
    '^.+/node_modules/(?:htmlparser2|domhandler|domutils|domelementtype|dom-serializer|entities|is-plain-object|launder)/.+\\.js$':
      ['ts-jest', { tsconfig: { target:'ES2022', module:'CommonJS', allowJs:true, checkJs:false, esModuleInterop:true } }],
  },
  // The current HTML parser is ESM; production Node24 supports require(esm),
  // while Jest's VM needs these real dependencies transformed for CJS tests.
  transformIgnorePatterns:['/node_modules/(?!(?:htmlparser2|domhandler|domutils|domelementtype|dom-serializer|entities|is-plain-object|launder)/)'],
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
