module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // isolatedModules is set in tsconfig.json (ts-jest reads it from there).
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['lib/**/*.ts', 'config/**/*.ts'],
  // CDK synth of EKS clusters is heavy; give tests room.
  testTimeout: 120000,
};
