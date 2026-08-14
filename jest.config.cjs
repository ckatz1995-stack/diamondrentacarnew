module.exports = {
  testEnvironment: 'node',
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
