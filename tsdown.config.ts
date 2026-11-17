import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/action/index.ts',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
  deps: {
    alwaysBundle: (id) => !id.startsWith('node:'),
    onlyBundle: false,
  },
})
