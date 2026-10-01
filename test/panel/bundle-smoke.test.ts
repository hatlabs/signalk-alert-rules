import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const publicDir = path.resolve(import.meta.dirname, '../../public')
const remoteEntry = path.join(publicDir, 'remoteEntry.js')
const built = existsSync(remoteEntry)

/** What the admin UI treats as a federated container (dynamicutilities.ts). */
interface Container {
  init: (shareScope: Record<string, unknown>) => Promise<void> | void
  get: (module: string) => Promise<() => { default: React.ComponentType }>
}

function isContainer(value: unknown): value is Container {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<Container>).init === 'function' &&
    typeof (value as Partial<Container>).get === 'function'
  )
}

describe.skipIf(!built)('built panel bundle (skipped until `./run build-panel` has run)', () => {
  const globals = globalThis as { window?: unknown }

  // Only the globals the admin UI sets before loading a webapp (bootstrap.tsx);
  // no document, so the bundle cannot lean on anything else from the page.
  beforeAll(() => {
    globals.window = {
      __SK_REACT__: React,
      __SK_REACT_DOM__: ReactDOM,
      __SK_REACT_DOM_CLIENT__: ReactDOMClient,
      __SK_REACT_JSX_RUNTIME__: ReactJSXRuntime
    }
  })

  afterAll(() => {
    delete globals.window
  })

  it('initialises and returns the exposed webapp, rendered on the host React', async () => {
    const container: unknown = await import(pathToFileURL(remoteEntry).href)
    if (!isContainer(container)) throw new Error('remoteEntry.js exports no init/get container')

    await container.init({})
    const factory = await container.get('./AppPanel')
    const AppPanel = factory().default

    const html = renderToStaticMarkup(React.createElement(AppPanel))
    expect(html).toContain('role="status"')
    expect(html).toContain('Loading')
  })

  it('ships one stylesheet and links it from the container', () => {
    const stylesheets = readdirSync(path.join(publicDir, 'assets')).filter((f) =>
      f.endsWith('.css')
    )
    expect(stylesheets).toHaveLength(1)
    expect(readFileSync(remoteEntry, 'utf8')).toContain(`./assets/${stylesheets[0]}`)
  })

  // The panel copies the model's values rather than import the module that
  // builds the rule schema; typebox would add its whole runtime to the bundle.
  it('leaves typebox out', () => {
    const scripts = readdirSync(publicDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.js')
    )
    expect(scripts.length).toBeGreaterThan(0)
    const withTypebox = scripts.filter((f) =>
      readFileSync(path.join(publicDir, f), 'utf8').includes('~kind')
    )
    expect(withTypebox).toEqual([])
  })
})

describe.skipIf(built)('built panel bundle', () => {
  it.skip('is absent: run `./run build-panel` to build public/ and enable the smoke test', () => {
    // Reported as skipped so a run without the bundle says why.
  })
})
