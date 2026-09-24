import { defineConfig } from 'tsdown'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_CLIENT_EXTERNALS = /^@deepseek-ai\//
const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const COMPILED_UI_HOST = resolve(PRODUCT_ROOT, 'lib/packages/dsh-integration/src/ui-host.js')
const COMPILED_RUNTIME = resolve(PRODUCT_ROOT, 'lib/packages/dsh-integration/src/deepseek-harness-runtime.js')

/** Build the Node Host half and the DSH closure-factory browser bundle. */
export default defineConfig([
  {
    name: '@monash-study/dsh-ui-plugin',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [{
      name: 'monash-study-compiled-host-boundary',
      resolveId(source: string) {
        if (source === '@monash-study/dsh-integration/ui-host') return COMPILED_UI_HOST
        if (source === '@monash-study/dsh-integration') return COMPILED_RUNTIME
        return null
      },
    }],
    deps: {
      neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
      alwaysBundle: (specifier: string) => specifier.startsWith('@monash-study/'),
    },
  },
  {
    name: '@monash-study/dsh-ui-plugin/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => DSH_CLIENT_EXTERNALS.test(specifier) || specifier === 'react' || specifier === 'react-dom',
      alwaysBundle: (specifier: string) => !(DSH_CLIENT_EXTERNALS.test(specifier) || specifier === 'react' || specifier === 'react-dom'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: 'window.__ModuleLoader__.load({ id: "@monash-study/dsh-ui-plugin", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
