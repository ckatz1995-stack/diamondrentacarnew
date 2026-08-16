module.exports = {
  testEnvironment: 'node',
  // The default babel coverage provider does not instrument .jsw at all — it
  // silently reported 490 statements when the backend has ~7,900, measuring only
  // the .js sliver. v8 instruments what actually executes, regardless of extension.
  coverageProvider: 'v8',
  coveragePathIgnorePatterns: ['/node_modules/', '/test/', '/__tests__/'],
  moduleFileExtensions: ['js', 'jsw', 'json'],
  transform: {
    '^.+\\.(js|jsw)$': 'babel-jest',
  },
  testMatch: ['**/__tests__/**/*.test.js'],
  moduleNameMapper: {
    '^wix-data$': '<rootDir>/test/mocks/wix-data.js',
    '^wix-secrets-backend$': '<rootDir>/test/mocks/wix-secrets-backend.js',
    '^wix-users-backend$': '<rootDir>/test/mocks/wix-users-backend.js',
    '^backend/(.*)$': '<rootDir>/src/backend/$1',
  },
};
