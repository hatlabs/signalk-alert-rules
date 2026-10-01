import path from 'node:path'
import { federation } from '@module-federation/vite'
import { defineConfig } from 'vite'
import packageJson from './package.json' with { type: 'json' }

const shim = (file: string) => path.resolve(import.meta.dirname, 'src/panel/host-shim', file)

// The admin UI finds the container under the package name with -, @ and /
// replaced (server-admin-ui src/views/Webapps/dynamicutilities.ts, toSafeModuleId).
const containerName = packageJson.name.replace(/[-@/]/g, '_')

export default defineConfig({
  // React resolves to shims over the admin UI's own React, so the panel
  // neither bundles a second copy nor takes part in share-scope negotiation.
  resolve: {
    alias: [
      { find: /^react\/jsx-(dev-)?runtime$/, replacement: shim('react-jsx-runtime.ts') },
      { find: /^react-dom\/client$/, replacement: shim('react-dom-client.ts') },
      { find: /^react-dom$/, replacement: shim('react-dom.ts') },
      { find: /^react$/, replacement: shim('react.ts') }
    ]
  },
  esbuild: { jsx: 'automatic' },
  plugins: [
    federation({
      name: containerName,
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': './src/panel/index.tsx'
      },
      shared: {},
      // Without this the stylesheet is emitted but nothing links it: the
      // exposed module adds the link when the host loads it.
      bundleAllCSS: true,
      // The host reads the container at runtime and never consumes its types.
      dts: false
    })
  ],
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: './src/panel/index.tsx',
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'esm',
        entryFileNames: 'panel-entry.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
  }
})
