import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    // Even Hub requires ONE JS bundle — no code-splitting.
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
