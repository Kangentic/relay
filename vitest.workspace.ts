import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      include: ['test/**/*.test.ts'],
      exclude: ['test/integration.*.test.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      include: ['test/integration.*.test.ts'],
      testTimeout: 20_000,
    },
  },
]);
