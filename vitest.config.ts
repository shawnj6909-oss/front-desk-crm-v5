import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';

// Load .env file
loadEnv();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
