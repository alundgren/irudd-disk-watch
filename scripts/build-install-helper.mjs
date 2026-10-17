import { build } from 'vite'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  configFile: false,
  root,
  publicDir: false,
  // The package's ESM build contains raw require() calls. Bundle its CommonJS entry instead.
  resolve: {
    alias: [
      { find: /^@electron\/osx-sign$/, replacement: createRequire(import.meta.url).resolve('@electron/osx-sign') },
    ],
  },
  // All signing calls override entitlements with an explicit array. The package's default path is unused.
  define: { __dirname: JSON.stringify('/') },
  build: {
    target: 'node22',
    outDir: 'dist/helpers',
    emptyOutDir: true,
    minify: false,
    lib: { entry: 'scripts/install-mac.mjs', formats: ['es'], fileName: () => 'install-mac.mjs' },
    rollupOptions: {
      external: (id) => id.startsWith('node:') || builtinModules.includes(id),
      output: { inlineDynamicImports: true, paths: (id) => (builtinModules.includes(id) ? `node:${id}` : id) },
    },
  },
})
