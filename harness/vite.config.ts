import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { hostReactAliases } from '../vite.config.js'

const repo = path.resolve(import.meta.dirname, '..')
const panelSources = path.join(repo, 'src') + path.sep

/**
 * The panel's React imports resolve to the host shims, as in the panel
 * bundle, while the harness itself imports the real React it puts on the
 * admin UI's globals. A plain alias would apply to both.
 */
function hostReact(): Plugin {
  return {
    name: 'skar-harness-host-react',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.startsWith(panelSources) !== true) return null
      return hostReactAliases.find(({ find }) => find.test(source))?.replacement ?? null
    }
  }
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [hostReact()],
  // The jsx-runtime shim re-exports the production runtime, which has no jsxDEV.
  esbuild: { jsx: 'automatic', jsxDev: false },
  server: { fs: { allow: [repo] } }
})
