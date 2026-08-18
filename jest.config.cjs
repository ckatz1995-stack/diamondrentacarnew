module.exports = {
  testEnvironment: 'node',
  // The default babel coverage provider does not instrument .jsw at all — it
  // silently reported 490 statements when the backend has ~7,900, measuring only
  // the .js sliver. v8 instruments what actually executes, regardless of extension.
  coverageProvider: 'v8',
  // Without this, coverage only counts files some test happened to import, so a
  // module with no test at all is neither covered nor uncovered — it just vanishes
  // from the denominator and flatters the total. Six backend files were being
  // omitted that way. Listing the sources explicitly makes untested files count as
  // 0%, which is what the number is supposed to mean.
  collectCoverageFrom: [
    'src/backend/**/*.{js,jsw}',
    '!src/backend/__tests__/**',
    // src/public is shared page code — the postMessage bridge and the backroom
    // auth guard. Left out, a file there was neither covered nor uncovered and
    // simply vanished from the denominator, which is the same flattering
    // arithmetic the note above describes.
    'src/public/**/*.js',
    '!src/public/__tests__/**',
  ],
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
    '^wix-http-functions$': '<rootDir>/test/mocks/wix-http-functions.js',
    '^wix-fetch$': '<rootDir>/test/mocks/wix-fetch.js',
    '^wix-location$': '<rootDir>/test/mocks/wix-location.js',
    '^wix-storage$': '<rootDir>/test/mocks/wix-storage.js',
    '^backend/(.*)$': '<rootDir>/src/backend/$1',
  },
};
