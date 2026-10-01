import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_TEMPLATES,
  TEMPLATES_FIELD,
  TEMPLATES_KEYWORD,
  discoverTemplateSets,
  type DiscoveryResult
} from '../../src/templates/discovery.js'

// APFS lists names already sorted and ext4 does not; reversing every listing
// keeps the tests from passing only because of the host filesystem's order.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readdirSync: (dir: string) => fs.readdirSync(dir).reverse() }
})

/** A package's commented template set, and the same set as data. */
const batteriesYaml = `# Shipped by a package; read as data, never run.
name: Batteries
id: batteries
version: 1.0.0
templates:
  - id: voltage-low
    description: Bank voltage below 12 V
    open: [instance, source]
    rule:
      name: Battery \${instance} low
      message: Battery voltage low
      priority: warning
      # The instance is picked when the template is used.
      signal:
        path: electrical.batteries.\${instance}.voltage
      detector: { type: sustained, direction: below, limit: { kind: fixed, value: 12 } }
  - id: depth-shallow
    rule:
      name: Shallow
      message: Shallow water
      priority: alarm
      signal: { path: environment.depth.belowKeel }
      detector: { type: sustained, direction: below, limit: { kind: fixed, value: 3 } }
`

const batteries = {
  name: 'Batteries',
  id: 'batteries',
  version: '1.0.0',
  templates: [
    {
      id: 'voltage-low',
      description: 'Bank voltage below 12 V',
      open: ['instance', 'source'],
      rule: {
        name: 'Battery ${instance} low',
        message: 'Battery voltage low',
        priority: 'warning',
        signal: { path: 'electrical.batteries.${instance}.voltage' },
        detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 12 } }
      }
    },
    {
      id: 'depth-shallow',
      rule: {
        name: 'Shallow',
        message: 'Shallow water',
        priority: 'alarm',
        signal: { path: 'environment.depth.belowKeel' },
        detector: { type: 'sustained', direction: 'below', limit: { kind: 'fixed', value: 3 } }
      }
    }
  ]
}

function setYaml(id: string, templateLines = ''): string {
  return [
    'name: Test',
    `id: ${id}`,
    'version: "1"',
    'templates:',
    '  - id: stopped',
    '    rule:',
    '      name: Engine stopped',
    '      message: Engine stopped',
    '      priority: warning',
    '      signal: { path: propulsion.main.state }',
    '      detector: { type: match, op: changesTo, value: stopped }',
    templateLines
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
  dropIn = join(root, 'templates')
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
    JSON.stringify({ name, version: '2.0.0', keywords: [TEMPLATES_KEYWORD], ...pkg })
  )
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
  return dir
}

function discover(): DiscoveryResult {
  return discoverTemplateSets({ configDir: root, dropIn })
}

function ids(result: DiscoveryResult): string[] {
  return result.sets.map((s) => s.set.id)
}

describe('discoverTemplateSets', () => {
  it("loads a commented YAML template set from a package, with each template's open parts", async () => {
    await writePackage(
      'signalk-battery-templates',
      { version: '1.0.0', [TEMPLATES_FIELD]: 'templates.yaml' },
      { 'templates.yaml': batteriesYaml }
    )

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.sets).toEqual([
      {
        source: 'package signalk-battery-templates',
        package: { name: 'signalk-battery-templates', version: '1.0.0' },
        set: batteries
      }
    ])
    expect(result.sets[0]?.set.templates.map((t) => t.open)).toEqual([
      ['instance', 'source'],
      undefined
    ])
  })

  it('loads the same set written as JSON identically', async () => {
    await writeFile(join(dropIn, 'batteries.json'), JSON.stringify(batteries, null, 2))

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.sets).toEqual([{ source: 'file batteries.json', set: batteries }])
  })

  it("loads the built-in set from the plugin's own package, first", async () => {
    await writeFile(join(dropIn, 'mine.yaml'), setYaml('mine'))

    const result = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES, configDir: root, dropIn })

    expect(result.problems).toEqual([])
    expect(result.sets.map((s) => [s.source, s.set.id])).toEqual([
      ['built-in', 'builtin'],
      ['file mine.yaml', 'mine']
    ])
    expect(result.sets[0]?.set.templates.length).toBeGreaterThan(0)
  })

  it('ships the built-in set in the published package', async () => {
    const root = join(import.meta.dirname, '../..')
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      files: string[]
    }
    expect(pkg.files).toContain(`${relative(root, dirname(BUILTIN_TEMPLATES))}/`)
  })

  it("keeps the built-in set's id from every other set", async () => {
    await writeFile(join(dropIn, 'builtin.yaml'), setYaml('builtin'))

    const result = discoverTemplateSets({ builtin: BUILTIN_TEMPLATES, dropIn })

    expect(result.sets.map((s) => s.source)).toEqual(['built-in'])
    expect(result.problems).toEqual([
      { source: 'file builtin.yaml', message: 'id builtin is already used by built-in' }
    ])
  })

  it('finds scoped packages', async () => {
    await writePackage(
      '@acme/rules',
      { [TEMPLATES_FIELD]: 'rules/acme.yml' },
      { 'rules/acme.yml': setYaml('acme') }
    )

    const result = discover()

    expect(result.problems).toEqual([])
    expect(result.sets[0]).toMatchObject({
      set: { id: 'acme' },
      package: { name: '@acme/rules', version: '2.0.0' }
    })
  })

  it('ignores packages without the keyword', async () => {
    await writePackage(
      'other',
      { keywords: ['signalk-node-server-plugin'], [TEMPLATES_FIELD]: 'r.yaml' },
      { 'r.yaml': setYaml('other') }
    )
    expect(discover()).toEqual({ sets: [], problems: [] })
  })

  it('reports a package with the keyword but no field', async () => {
    await writePackage('nofield', {})
    const result = discover()
    expect(result.problems).toEqual([
      { source: 'package nofield', message: expect.stringContaining(TEMPLATES_FIELD) as string }
    ])
  })

  it('reports a package whose version is not a string', async () => {
    await writePackage(
      'numeric',
      { version: 2, [TEMPLATES_FIELD]: 'r.yaml' },
      { 'r.yaml': setYaml('numeric') }
    )

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'package numeric', message: expect.stringContaining('version') as string }
    ])
  })

  it('labels a package without a name as the config lists it', async () => {
    await writePackage('@scope/nameless', { name: undefined, [TEMPLATES_FIELD]: 'r.yaml' })

    const result = discover()

    expect(result.problems).toEqual([
      {
        source: 'package @scope/nameless',
        message: expect.stringContaining('name') as string
      }
    ])
  })

  it('rejects a field naming the package root itself', async () => {
    await writePackage('dot', { [TEMPLATES_FIELD]: '.' })

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'package dot', message: expect.stringContaining('outside the package') as string }
    ])
  })

  it('rejects a field pointing outside the package', async () => {
    await writeFile(join(root, 'outside.yaml'), setYaml('outside'))
    await writePackage('escape', { [TEMPLATES_FIELD]: '../../outside.yaml' })

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      {
        source: 'package escape',
        message: expect.stringContaining('outside the package') as string
      }
    ])
  })

  it('rejects a field pointing at a .js file', async () => {
    await writePackage('script', { [TEMPLATES_FIELD]: 'index.js' }, { 'index.js': 'export {}' })

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.message).toContain('.yaml')
  })

  it('rejects a symlink escaping the package', async () => {
    await writeFile(join(root, 'outside.yaml'), setYaml('outside'))
    const dir = await writePackage('linked', { [TEMPLATES_FIELD]: 'templates.yaml' })
    await symlink(join(root, 'outside.yaml'), join(dir, 'templates.yaml'))

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      {
        source: 'package linked',
        message: expect.stringContaining('outside the package') as string
      }
    ])
  })

  it('reports a missing template set file', async () => {
    await writePackage('missing', { [TEMPLATES_FIELD]: 'templates.yaml' })
    const result = discover()
    expect(result.problems.map((p) => p.source)).toEqual(['package missing'])
  })

  it('reads only .yaml, .yml and .json files from the drop-in directory', async () => {
    await writeFile(join(dropIn, 'a.yaml'), setYaml('a'))
    await writeFile(join(dropIn, 'b.yml'), setYaml('b'))
    await writeFile(join(dropIn, 'c.js'), 'export default {}')
    await writeFile(join(dropIn, 'd.txt'), setYaml('d'))

    const result = discover()

    expect(result.problems).toEqual([])
    expect(ids(result)).toEqual(['a', 'b'])
  })

  it('treats missing directories as empty', () => {
    const result = discoverTemplateSets({
      configDir: join(root, 'nope'),
      dropIn: join(root, 'nada')
    })
    expect(result).toEqual({ sets: [], problems: [] })
  })

  it('reports an unreadable listed package and loads the others', async () => {
    await writePackage(
      '@locked/rules',
      { [TEMPLATES_FIELD]: 'r.yaml' },
      { 'r.yaml': setYaml('locked') }
    )
    await writePackage('open', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('open') })
    const scope = join(nodeModules, '@locked')
    await chmod(scope, 0o000)
    let result: DiscoveryResult
    try {
      result = discover()
    } finally {
      // Without read permission the temporary tree cannot be removed.
      await chmod(scope, 0o755)
    }

    expect(ids(result)).toEqual(['open'])
    expect(result.problems).toEqual([
      { source: 'package @locked/rules', message: expect.stringContaining('EACCES') as string }
    ])
  })

  it('reads only the packages the config directory lists', async () => {
    await writePackage(
      'unlisted',
      { [TEMPLATES_FIELD]: 'r.yaml' },
      { 'r.yaml': setYaml('unlisted') },
      { listed: false }
    )
    await writePackage('listed', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('listed') })

    expect(ids(discover())).toEqual(['listed'])
    expect(discover().problems).toEqual([])
  })

  it('skips a listed package that is not installed', async () => {
    await list('not-installed')
    await writePackage('open', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('open') })

    expect(ids(discover())).toEqual(['open'])
    expect(discover().problems).toEqual([])
  })

  it('finds no package without a config package.json', async () => {
    await writePackage('open', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('open') })
    await rm(join(root, 'package.json'))

    expect(discover()).toEqual({ sets: [], problems: [] })
  })

  it('reports a config package.json that cannot be parsed and loads the drop-ins', async () => {
    await writeConfigPackage('{')
    await writeFile(join(dropIn, 'mine.yaml'), setYaml('mine'))

    const result = discover()

    expect(ids(result)).toEqual(['mine'])
    expect(result.problems).toEqual([
      { source: `file ${join(root, 'package.json')}`, message: expect.any(String) as string }
    ])
  })

  it('reports a listed name that is not a package name', async () => {
    await mkdir(join(root, 'outside'))
    await writeFile(
      join(root, 'outside', 'package.json'),
      JSON.stringify({ name: 'outside', version: '1', keywords: [TEMPLATES_KEYWORD] })
    )
    await list('../outside')

    expect(discover()).toEqual({
      sets: [],
      problems: [{ source: 'package ../outside', message: 'not a package name' }]
    })
  })

  it('reports an unreadable drop-in directory and loads the packages', async () => {
    await writePackage('open', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('open') })
    await writeFile(join(dropIn, 'hidden.yaml'), setYaml('hidden'))
    await chmod(dropIn, 0o000)
    let result: DiscoveryResult
    try {
      result = discover()
    } finally {
      await chmod(dropIn, 0o755)
    }

    expect(ids(result)).toEqual(['open'])
    expect(result.problems).toEqual([
      { source: `directory ${dropIn}`, message: expect.stringContaining('EACCES') as string }
    ])
  })

  it('keeps unquoted on, yes, no and stopped as strings', async () => {
    const template = (id: string, path: string, op: string, value: string) => [
      `  - id: ${id}`,
      '    rule:',
      `      name: ${id}`,
      `      message: ${id}`,
      '      priority: warning',
      `      signal: { path: ${path} }`,
      `      detector: { type: match, op: ${op}, value: ${value} }`
    ]
    await writeFile(
      join(dropIn, 'words.yaml'),
      setYaml('words').replace('value: stopped', 'value: on') +
        [
          ...template('pump', 'electrical.switches.pump.state', 'equals', 'yes'),
          ...template('heater', 'electrical.switches.heater.state', 'equals', 'no'),
          ...template('engine', 'propulsion.port.state', 'changesTo', 'stopped')
        ].join('\n')
    )

    const result = discover()

    expect(result.problems).toEqual([])
    const values = result.sets[0]?.set.templates.map(
      (t) => (t.rule.detector as { value?: unknown }).value
    )
    expect(values).toEqual(['on', 'yes', 'no', 'stopped'])
  })

  it('reports a string where a boolean is required', async () => {
    await writeFile(
      join(dropIn, 'latching.yaml'),
      setYaml('latching').replace('priority: warning', 'priority: warning\n      latching: yes')
    )

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.source).toBe('file latching.yaml')
    expect(result.problems[0]?.message).toMatch(/\/templates\/0\/rule\/latching.*boolean/)
  })

  it('reports malformed YAML with its line while others load', async () => {
    await writeFile(join(dropIn, 'a-good.yaml'), setYaml('good'))
    await writeFile(join(dropIn, 'b-bad.yaml'), 'name: Bad\nid: bad\ntemplates: [\n  - x\n')

    const result = discover()

    expect(ids(result)).toEqual(['good'])
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatchObject({ source: 'file b-bad.yaml' })
    expect(result.problems[0]?.line).toBeGreaterThanOrEqual(3)
  })

  it('rejects a duplicated key with its line', async () => {
    await writeFile(
      join(dropIn, 'twice.yaml'),
      setYaml('twice').replace('priority: warning', 'priority: warning\n      priority: alarm')
    )

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'file twice.yaml', message: expect.stringContaining('unique') as string, line: 10 }
    ])
  })

  it('rejects a custom tag as malformed', async () => {
    await writeFile(
      join(dropIn, 'tagged.yaml'),
      setYaml('tagged').replace('name: Test', 'name: !shell Test')
    )

    const result = discover()

    expect(result.sets).toEqual([])
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

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      { source: 'file bomb.yaml', message: expect.stringContaining('alias') as string }
    ])
  })

  it('rejects a template set file over 1 MiB while others load', async () => {
    const valid = setYaml('big')
    const padding = `\n# ${'x'.repeat(1024 * 1024 - valid.length)}`
    await writeFile(join(dropIn, 'big.yaml'), valid + padding)
    await writeFile(join(dropIn, 'small.yaml'), setYaml('small'))

    const result = discover()

    expect(ids(result)).toEqual(['small'])
    expect(result.problems).toEqual([
      { source: 'file big.yaml', message: expect.stringContaining('1 MiB') as string }
    ])
  })

  it('reports a set with an invalid template, with each error pointing into the set, and does not load it', async () => {
    await writeFile(
      join(dropIn, 'broken.yaml'),
      setYaml('broken').replace('op: changesTo', 'op: becomes')
    )

    const result = discover()

    expect(result.sets).toEqual([])
    expect(result.problems).toEqual([
      {
        source: 'file broken.yaml',
        message: expect.stringContaining('/templates/0/rule/detector/op') as string,
        errors: [{ path: '/templates/0/rule/detector/op', message: expect.any(String) as string }]
      }
    ])
  })

  it('loads the first of two sets sharing an id and reports the later one', async () => {
    await writePackage('z-pkg', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('same') })
    await writePackage('a-pkg', { [TEMPLATES_FIELD]: 'r.yaml' }, { 'r.yaml': setYaml('same') })
    await writeFile(join(dropIn, 'same.yaml'), setYaml('same'))

    const result = discover()

    expect(result.sets.map((r) => r.source)).toEqual(['package a-pkg'])
    expect(result.problems).toEqual([
      { source: 'package z-pkg', message: expect.stringContaining('same') as string },
      { source: 'file same.yaml', message: expect.stringContaining('same') as string }
    ])
  })
})
