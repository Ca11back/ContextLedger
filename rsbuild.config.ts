import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
import { ClientBoundaryPlugin } from './scripts/client-boundary';
export default defineConfig({
  plugins: [
    tanstackStart({
      importProtection: {
        behavior: 'error',
        client: { files: ['**/*.server.*', '**/src/server/**'] },
      },
    }),
    pluginReact(),
  ],
  resolve: { alias: { '@': './src' } },
  tools: {
    rspack: (config, { environment }) => {
      config.externals = { 'bun:sqlite': 'module bun:sqlite' };
      if (environment.name === 'client') config.plugins?.push(new ClientBoundaryPlugin());
    },
  },
});
