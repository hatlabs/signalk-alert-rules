import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RULESET_FIELD,
  RULESET_KEYWORD,
  discoverRulesets,
  type DiscoveryResult
} from '../../src/rulesets/discovery.js'

// APFS lists names already sorted and ext4 does not; reversing every listing
// keeps the tests from passing only because of the host filesystem's order.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readdirSync: (dir: string) => fs.readdirSync(dir).reverse() }
})

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), '../../examples/ruleset-example')

/** The example package's ruleset.yaml, written out by hand. */
const exampleRuleset = {
  name: 'Battery monitoring',
  slug: 'batteries',
  version: '1.0.0',
  parameters: [
    {
      name: 'prefix',
      type: 'string',
      description: 'Path of the monitored battery bank',
      default: 'electrical.batteries.house'
    },
    { name: 'lowVoltage', type: 'number', unit: 'V', default: 12, minimum: 10, maximum: 14 },
    { name: 'delay', type: 'number', unit: 's', default: 60, minimum: 0, maximum: 600 }
  ],
  rules: [
    {
      name: 'Battery low',
      slug: 'low',
      message: 'Battery voltage low',
      priority: 'warning',
      signal: { path: '${prefix}.voltage' },
      detector: {
        type: 'sustained',
        direction: 'below',
        limit: { kind: 'fixed', value: { param: 'lowVoltage' } },
        duration: { param: 'delay' }
      }
    }
  ]
}

function rulesetYaml(slug: string, ruleLines = ''): string {
  return [
    'name: Test',
    `slug: ${slug}`,
    'version: "1"',
    'rules:',
    '  - name: Engine stopped',
    '    slug: stopped',
    '    message: Engine stopped',
    '    priority: warning',
    '    signal: { path: propulsion.main.state }',
    '    detector: { type: match, op: changesTo, value: stopped }',
    ruleLines
  ].join('\n')
}

/** The server's config directory, where it installs packages with npm. */
let root: string
let nodeModules: string
let dropIn: string
let dependencies: Record<string, string>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skar-discovery-'))
  nodeModules = join(root, 'node_modules')
  dropIn = join(root, 'rulesets')
  dependencies = {}
  await mkdir(nodeModules)
  await mkdir(dropIn)
  await writeConfigPackage()
})

/** The config directory's package.json, which lists what the server installed. */
async function writeConfigPackage(text?: string): Promise<void> {
  const pkg = { name: 'signalk-server-config', version: '0.0.1', dependencies }
  await writeFile(join(root, 'package.json'), text ?? JSON.stringify(pkg))
}

async function list(name: string): Promise<void> {
  dependencies[name] = '^1.0.0'
  await writeConfigPackage()
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackage(
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
  { listed = true } = {}
): Promise<string> {
  if (listed) await list(name)
  const dir = join(nodeModules, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '2.0.0', keywords: [RULESET_KEYWORD], ...pkg })
  )
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
  return dir
}

function discover(): DiscoveryResult {
  return discoverRulesets({ configDir: root, dropIn })
}

function slugs(result: DiscoveryResult): string[] {
  return result.rulesets.map((r) => r.slug)
}

describe('discoverRulesets', () => {
  it('loads a commented YAML ruleset from a package', async () => {
    await cp(exampleDir, join(nodeModules, 'signalk-alert-ruleset-example'), { recursive: true })
    await list('signalk-alert-ruleset-example')

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.rulesets).toEqual([
      {
        slug: 'batteries',
        source: 'package signalk-alert-ruleset-example',
        package: { name: 'signalk-alert-ruleset-example', version: '1.0.0' },
        ruleset: exampleRuleset
      }
    ])
  })

  it('loads the same ruleset written as JSON identically', async () => {
    await writeFile(join(dropIn, 'batteries.json'), JSON.stringify(exampleRuleset, null, 2))

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.rulesets).toEqual([
      { slug: 'batteries', source: 'file batteries.json', ruleset: exampleRuleset }
    ])
  })

  it('finds scoped packages', async () => {
    await writePackage(
      '@acme/rules',
      { [RULESET_FIELD]: 'rules/acme.yml' },
      { 'rules/acme.yml': rulesetYaml('acme') }
    )

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.rulesets[0]).toMatchObject({
      slug: 'acme',
      package: { name: '@acme/rules', version: '2.0.0' }
    })
  })

  it('ignores packages without the keyword', async () => {
    await writePackage(
      'other',
      { keywords: ['signalk-node-server-plugin'], [RULESET_FIELD]: 'r.yaml' },
      { 'r.yaml': rulesetYaml('other') }
    )
    expect(discover()).toEqual({ rulesets: [], problems: [] })
  })

  it('reports a package with the keyword but no field', async () => {
    await writePackage('nofield', {})
    const result = discover()
    expect(result.problems).toEqual([
      { source: 'package nofield', message: expect.stringContaining(RULESET_FIELD) as string }
    ])
  })

  it('reports a package whose version is not a string', async () => {
    await writePackage(
      'numeric',
      { version: 2, [RULESET_FIELD]: 'r.yaml' },
      { 'r.yaml': rulesetYaml('numeric') }
    )

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'package numeric', message: expect.stringContaining('version') as string }
    ])
  })

  it('labels a package without a name as the config lists it', async () => {
    await writePackage('@scope/nameless', { name: undefined, [RULESET_FIELD]: 'r.yaml' })

    const result = discover()

    expect(result.problems).toEqual([
      {
        source: 'package @scope/nameless',
        message: expect.stringContaining('name') as string
      }
    ])
  })

  it('rejects a field naming the package root itself', async () => {
    await writePackage('dot', { [RULESET_FIELD]: '.' })

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'package dot', message: expect.stringContaining('outside the package') as string }
    ])
  })

  it('rejects a field pointing outside the package', async () => {
    await writeFile(join(root, 'outside.yaml'), rulesetYaml('outside'))
    await writePackage('escape', { [RULESET_FIELD]: '../../outside.yaml' })

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      {
        source: 'package escape',
        message: expect.stringContaining('outside the package') as string
      }
    ])
  })

  it('rejects a field pointing at a .js file', async () => {
    await writePackage('script', { [RULESET_FIELD]: 'index.js' }, { 'index.js': 'export {}' })

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.message).toContain('.yaml')
  })

  it('rejects a symlink escaping the package', async () => {
    await writeFile(join(root, 'outside.yaml'), rulesetYaml('outside'))
    const dir = await writePackage('linked', { [RULESET_FIELD]: 'ruleset.yaml' })
    await symlink(join(root, 'outside.yaml'), join(dir, 'ruleset.yaml'))

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      {
        source: 'package linked',
        message: expect.stringContaining('outside the package') as string
      }
    ])
  })

  it('reports a missing ruleset file', async () => {
    await writePackage('missing', { [RULESET_FIELD]: 'ruleset.yaml' })
    const result = discover()
    expect(result.problems.map((p) => p.source)).toEqual(['package missing'])
  })

  it('reads only .yaml, .yml and .json files from the drop-in directory', async () => {
    await writeFile(join(dropIn, 'a.yaml'), rulesetYaml('a'))
    await writeFile(join(dropIn, 'b.yml'), rulesetYaml('b'))
    await writeFile(join(dropIn, 'c.js'), 'export default {}')
    await writeFile(join(dropIn, 'd.txt'), rulesetYaml('d'))

    const result = discover()

    expect(result.problems).toEqual([])
    expect(slugs(result)).toEqual(['a', 'b'])
  })

  it('treats missing directories as empty', () => {
    const result = discoverRulesets({
      configDir: join(root, 'nope'),
      dropIn: join(root, 'nada')
    })
    expect(result).toEqual({ rulesets: [], problems: [] })
  })

  it('reports an unreadable listed package and loads the others', async () => {
    await writePackage(
      '@locked/rules',
      { [RULESET_FIELD]: 'r.yaml' },
      { 'r.yaml': rulesetYaml('locked') }
    )
    await writePackage('open', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('open') })
    const scope = join(nodeModules, '@locked')
    await chmod(scope, 0o000)
    let result: DiscoveryResult
    try {
      result = discover()
    } finally {
      // Without read permission the temporary tree cannot be removed.
      await chmod(scope, 0o755)
    }

    expect(slugs(result)).toEqual(['open'])
    expect(result.problems).toEqual([
      { source: 'package @locked/rules', message: expect.stringContaining('EACCES') as string }
    ])
  })

  it('reads only the packages the config directory lists', async () => {
    await writePackage(
      'unlisted',
      { [RULESET_FIELD]: 'r.yaml' },
      { 'r.yaml': rulesetYaml('unlisted') },
      { listed: false }
    )
    await writePackage('listed', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('listed') })

    expect(discover()).toMatchObject({ rulesets: [{ slug: 'listed' }], problems: [] })
  })

  it('skips a listed package that is not installed', async () => {
    await list('not-installed')
    await writePackage('open', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('open') })

    expect(discover()).toMatchObject({ rulesets: [{ slug: 'open' }], problems: [] })
  })

  it('finds no package without a config package.json', async () => {
    await writePackage('open', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('open') })
    await rm(join(root, 'package.json'))

    expect(discover()).toEqual({ rulesets: [], problems: [] })
  })

  it('reports a config package.json that cannot be parsed and loads the drop-ins', async () => {
    await writeConfigPackage('{')
    await writeFile(join(dropIn, 'mine.yaml'), rulesetYaml('mine'))

    const result = discover()

    expect(slugs(result)).toEqual(['mine'])
    expect(result.problems).toEqual([
      { source: `file ${join(root, 'package.json')}`, message: expect.any(String) as string }
    ])
  })

  it('reports a listed name that is not a package name', async () => {
    await mkdir(join(root, 'outside'))
    await writeFile(
      join(root, 'outside', 'package.json'),
      JSON.stringify({ name: 'outside', version: '1', keywords: [RULESET_KEYWORD] })
    )
    await list('../outside')

    expect(discover()).toEqual({
      rulesets: [],
      problems: [{ source: 'package ../outside', message: 'not a package name' }]
    })
  })

  it('reports an unreadable drop-in directory and loads the packages', async () => {
    await writePackage('open', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('open') })
    await writeFile(join(dropIn, 'hidden.yaml'), rulesetYaml('hidden'))
    await chmod(dropIn, 0o000)
    let result: DiscoveryResult
    try {
      result = discover()
    } finally {
      await chmod(dropIn, 0o755)
    }

    expect(slugs(result)).toEqual(['open'])
    expect(result.problems).toEqual([
      { source: `directory ${dropIn}`, message: expect.stringContaining('EACCES') as string }
    ])
  })

  it('keeps unquoted on, yes, no and stopped as strings', async () => {
    await writeFile(
      join(dropIn, 'words.yaml'),
      rulesetYaml('words').replace('value: stopped', 'value: on') +
        [
          '  - name: Pump',
          '    slug: pump',
          '    message: Pump',
          '    priority: warning',
          '    signal: { path: electrical.switches.pump.state }',
          '    detector: { type: match, op: equals, value: yes }',
          '  - name: Heater',
          '    slug: heater',
          '    message: Heater',
          '    priority: warning',
          '    signal: { path: electrical.switches.heater.state }',
          '    detector: { type: match, op: equals, value: no }',
          '  - name: Stopped',
          '    slug: engine',
          '    message: Engine',
          '    priority: warning',
          '    signal: { path: propulsion.port.state }',
          '    detector: { type: match, op: changesTo, value: stopped }'
        ].join('\n')
    )

    const result = discover()

    expect(result.problems).toEqual([])
    const values = result.rulesets[0]?.ruleset.rules.map((r) =>
      'value' in r.detector ? r.detector.value : undefined
    )
    expect(values).toEqual(['on', 'yes', 'no', 'stopped'])
  })

  it('reports a string where a boolean is required', async () => {
    await writeFile(
      join(dropIn, 'latching.yaml'),
      rulesetYaml('latching').replace('priority: warning', 'priority: warning\n    latching: yes')
    )

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.source).toBe('file latching.yaml')
    expect(result.problems[0]?.message).toMatch(/\/rules\/0\/latching.*boolean/)
  })

  it('reports malformed YAML with its line while others load', async () => {
    await writeFile(join(dropIn, 'a-good.yaml'), rulesetYaml('good'))
    await writeFile(join(dropIn, 'b-bad.yaml'), 'name: Bad\nslug: bad\nrules: [\n  - x\n')

    const result = discover()

    expect(slugs(result)).toEqual(['good'])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({ source: 'file b-bad.yaml' })
    expect(result.problems[0]?.line).toBeGreaterThanOrEqual(3)
  })

  it('rejects a duplicated key with its line', async () => {
    await writeFile(
      join(dropIn, 'twice.yaml'),
      rulesetYaml('twice').replace('priority: warning', 'priority: warning\n    priority: alarm')
    )

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'file twice.yaml', message: expect.stringContaining('unique') as string, line: 9 }
    ])
  })

  it('rejects a custom tag as malformed', async () => {
    await writeFile(
      join(dropIn, 'tagged.yaml'),
      rulesetYaml('tagged').replace('name: Test', 'name: !shell Test')
    )

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'file tagged.yaml', message: expect.stringContaining('!shell') as string, line: 1 }
    ])
  })

  it('rejects alias expansion past the cap', async () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
    for (const [prev, next] of [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e']
    ] as const)
      levels.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(', ')}]`)
    await writeFile(join(dropIn, 'bomb.yaml'), levels.join('\n'))

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'file bomb.yaml', message: expect.stringContaining('alias') as string }
    ])
  })

  it('rejects a ruleset file over 1 MiB while others load', async () => {
    const valid = rulesetYaml('big')
    const padding = `\n# ${'x'.repeat(1024 * 1024 - valid.length)}`
    await writeFile(join(dropIn, 'big.yaml'), valid + padding)
    await writeFile(join(dropIn, 'small.yaml'), rulesetYaml('small'))

    const result = discover()

    expect(slugs(result)).toEqual(['small'])
    expect(result.problems).toEqual([
      { source: 'file big.yaml', message: expect.stringContaining('1 MiB') as string }
    ])
  })

  it('reports a ruleset with slug user as malformed', async () => {
    await writeFile(join(dropIn, 'user.yaml'), rulesetYaml('user'))

    const result = discover()

    expect(result.rulesets).toEqual([])
    expect(result.problems[0]).toMatchObject({ source: 'file user.yaml' })
  })

  it('loads the first of two rulesets sharing a slug and reports the later one', async () => {
    await writePackage('z-pkg', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('same') })
    await writePackage('a-pkg', { [RULESET_FIELD]: 'r.yaml' }, { 'r.yaml': rulesetYaml('same') })
    await writeFile(join(dropIn, 'same.yaml'), rulesetYaml('same'))

    const result = discover()

    expect(result.rulesets.map((r) => r.source)).toEqual(['package a-pkg'])
    expect(result.problems).toEqual([
      { source: 'package z-pkg', message: expect.stringContaining('same') as string },
      { source: 'file same.yaml', message: expect.stringContaining('same') as string }
    ])
  })
})
