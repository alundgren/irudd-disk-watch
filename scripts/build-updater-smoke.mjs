import { build } from 'vite'
await build({
  configFile: false,
  publicDir: false,
  build: {
    target: 'node22',
    outDir: 'dist/update-smoke',
    emptyOutDir: true,
    lib: { entry: 'src/main/appUpdates.ts', formats: ['es'], fileName: () => 'app-updates.mjs' },
    rollupOptions: { external: (id) => id.startsWith('node:') },
  },
})
