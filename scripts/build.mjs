// Build/typecheck runner with no installed dependencies.
//
// TypeScript and the @deepseek-ai type packages are borrowed from a host
// checkout or a sibling plugin project. The script links the needed entries
// into this project's `node_modules` (a shim — `node_modules/` is gitignored),
// so tsc, vitest and the editor all resolve them natively without any paths
// block in the tsconfig.
//
// The deps root (a directory whose node_modules provides the types) is found
// in this order:
//   $DSH_NODE_MODULES   a node_modules directory, used as-is
//   $DSH_HOME           a DSH checkout; its node_modules is used
//   ./node_modules      if it already provides typescript + @deepseek-ai types
//                       (a previous run's shim, or a real install)
//   sibling projects    <root>/../<name>/node_modules and grandparent entries
//                       offering the same
//   legacy fallback     the Windows checkout path this repo used to sit next
//                       to, translated to every mount under /media that
//                       carries it (the drive may move between machines)
// `tsc` itself can also be pinned via $DSH_TSC (explicit path to tsc.js).
//
// The shim is refreshed on every run: entries are only added, never removed
// or overwritten when they resolve elsewhere, so a real `npm install` wins.
// Two deps-root layouts are understood:
//   published   @deepseek-ai/* are real packages inside node_modules
//   checkout    @deepseek-ai/* are workspace links, while cordis and cosmokit
//               live under vendor/ and need the @deepseek-ai alias
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = process.argv[2] ?? 'tsconfig.build.json'

function isDirectory(path) {
  try { return readdirSync(path) !== null } catch { return false }
}

/** Whether a node_modules directory provides enough for tsc to resolve the sources. */
function providesNodeModules(nodeModules) {
  return nodeModules !== undefined
    && existsSync(join(nodeModules, 'typescript/lib/tsc.js'))
    && existsSync(join(nodeModules, '@deepseek-ai/cordis/package.json'))
}

/** A deps root qualifies when it offers tsc plus the types in either layout. */
function qualifies(nodeModules) {
  return nodeModules !== undefined
    && existsSync(join(nodeModules, 'typescript/lib/tsc.js'))
    && (existsSync(join(nodeModules, '@deepseek-ai/cordis/package.json'))
      || existsSync(join(dirname(nodeModules), 'vendor/cordis/package.json')))
}

/** Translate a `D:/...` Windows path to every /media mount carrying the same subtree. */
function windowsMounts(candidate) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(candidate)
  if (match === null) return []
  const rest = match[2].replaceAll('\\', '/')
  const mounts = []
  try {
    for (const user of readdirSync('/media')) {
      for (const drive of readdirSync(join('/media', user))) {
        const mounted = join('/media', user, drive, rest)
        if (existsSync(mounted)) mounts.push(mounted)
      }
    }
  } catch { /* no /media: not a mount-based host */ }
  return mounts
}

function findDepsRoots() {
  const candidates = []
  const envModules = process.env['DSH_NODE_MODULES']
  const envHome = process.env['DSH_HOME']
  if (envModules !== undefined && envModules !== '') candidates.push(envModules)
  if (envHome !== undefined && envHome !== '') candidates.push(join(envHome, 'node_modules'))
  // A real `npm install` in this project wins, but only when it is complete:
  // this project's own half-built shim would otherwise "qualify" with its own
  // borrowed links and stop borrowing the type libraries it lacks.
  if (existsSync(join(root, 'node_modules', '@types', 'node', 'package.json'))) {
    candidates.push(join(root, 'node_modules'))
  }
  // The checkout this repo's wiring was verified against outranks siblings —
  // published @deepseek-ai packages may lag the checkout's type surface.
  candidates.push(...windowsMounts('D:/Program files/deepseek-harness').map(mounted => join(mounted, 'node_modules')))
  // This deployment builds against the DSH checkout by name: $DSH_HOME points at
  // the data directory here, not at the checkout, so name the checkout too.
  candidates.push('D:/Program files/deepseek-harness/node_modules')
  // Siblings one and two levels up: the repo may sit inside a checkout or
  // next to other plugin projects on either level.
  const seen = new Set([root, dirname(root)])
  for (const level of [dirname(root), dirname(dirname(root))]) {
    try {
      for (const entry of readdirSync(level)) {
        if (entry === 'node_modules') continue
        const candidate = join(level, entry, 'node_modules')
        if (seen.has(candidate)) continue
        seen.add(candidate)
        candidates.push(candidate)
      }
    } catch { /* level unreadable: skip the sibling scan */ }
  }
  return candidates.filter(candidate => qualifies(candidate))
}

const depsRoots = findDepsRoots()
if (depsRoots.length === 0) {
  console.error(
    'No node_modules with typescript and the @deepseek-ai types found. Point DSH_NODE_MODULES at a'
    + ' node_modules directory (or DSH_HOME at a DSH checkout) and retry.',
  )
  process.exit(2)
}

/** Whether any directory entry sits at the path, even a broken link to it. */
function entryExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

/** Link one borrowed entry into the project shim, replacing only stale links. */
function shimLink(source, target) {
  if (!isDirectory(source)) return
  if (entryExists(target)) {
    try {
      if (realpathSync(target) === realpathSync(source)) return
    } catch { /* a broken link: fall through and replace it */ }
    try { unlinkSync(target) } catch { return } // a real install wins over the shim
  }
  const kind = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(realpathSync(source), target, kind)
}

const nodeModules = join(root, 'node_modules')
mkdirSync(nodeModules, { recursive: true })

/** Replace a link — never a real directory — so per-entry links land locally. */
function ensureLocalDirectory(path) {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink() || stats.isJunction()) {
      rmSync(path)
      // A junction that survived its own unlink would silently redirect every
      // link below into the deps root, so stop rather than write there.
      if (entryExists(path)) throw new Error(`could not detach the link at ${path}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('could not detach')) throw error
    /* absent: nothing to replace */
  }
  mkdirSync(path, { recursive: true })
}

/** Link one deps root into the project shim; true when the result satisfies tsc. */
function buildShim(depsRoot) {
  shimLink(join(depsRoot, 'typescript'), join(nodeModules, 'typescript'))
  // Link every `@types` entry separately: junctioning a pnpm-managed @types
  // directory keeps its relative inner links, and those break through the link.
  const typesDir = join(depsRoot, '@types')
  if (isDirectory(typesDir)) {
    const typesTarget = join(nodeModules, '@types')
    ensureLocalDirectory(typesTarget)
    for (const entry of readdirSync(typesDir)) shimLink(join(typesDir, entry), join(typesTarget, entry))
  }
  shimLink(join(depsRoot, '@standard-schema'), join(nodeModules, '@standard-schema'))
  // The vitest package itself, so the test step can run its entry through node
  // in shells that cannot execute a Windows .bin wrapper.
  const vitestPkg = join(depsRoot, 'vitest')
  if (isDirectory(vitestPkg)) shimLink(vitestPkg, join(nodeModules, 'vitest'))
  // @deepseek-ai: either the whole scope directory (published layout) or one
  // link per workspace package plus the vendor aliases (checkout layout).
  const scope = join(nodeModules, '@deepseek-ai')
  const published = join(depsRoot, '@deepseek-ai')
  if (isDirectory(published) && existsSync(join(published, 'cordis/package.json'))) {
    shimLink(published, scope)
  } else {
    ensureLocalDirectory(scope)
    try {
      for (const entry of readdirSync(published)) shimLink(join(published, entry), join(scope, entry))
    } catch { /* no published scope: the checkout keeps its types elsewhere */ }
    shimLink(join(dirname(depsRoot), 'vendor/cordis'), join(scope, 'cordis'))
    shimLink(join(dirname(depsRoot), 'vendor/cosmokit'), join(scope, 'cosmokit'))
  }
  return providesNodeModules(nodeModules)
}

// A neighbouring plugin project can satisfy `qualifies` yet lack the type
// surface this project compiles against, so every root is tried, not just the
// first one that looked promising.
let depsRoot
for (const candidate of depsRoots) {
  if (buildShim(candidate)) {
    depsRoot = candidate
    break
  }
}
if (depsRoot === undefined) {
  console.error(
    `No deps root yields a usable shim (typescript + @deepseek-ai/cordis). Tried: ${depsRoots.join(', ') || 'none'}. `
    + 'Point DSH_NODE_MODULES at a node_modules directory (or DSH_HOME at a DSH checkout) and retry.',
  )
  process.exit(2)
}

// `npm test` needs a runnable vitest in node_modules/.bin. A deps root whose
// node_modules was installed on another OS fails the moment vitest loads its
// native bundler binding (`--version` still exits 0), so every root is probed
// with a one-assertion smoke run before it is linked.
const binDir = join(nodeModules, '.bin')
mkdirSync(binDir, { recursive: true })
if (process.platform === 'win32') {
  shimLink(join(depsRoot, '.bin'), binDir)
} else {
  const target = join(binDir, 'vitest')
  try { unlinkSync(target) } catch { /* absent on a fresh shim */ }
  const probeDir = join(tmpdir(), 'adaptive-effort-scheduler-vitest-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(
    join(probeDir, 'probe.test.js'),
    'import { it, expect } from "vitest"\nit("boots", () => { expect(1).toBe(1) })\n',
  )
  try {
    for (const candidateRoot of depsRoots) {
      const candidate = join(candidateRoot, '.bin', 'vitest')
      if (!existsSync(candidate)) continue
      const probe = spawnSync(candidate, ['run', '--root', probeDir], { stdio: 'pipe', timeout: 120_000 })
      if (probe.status === 0) {
        symlinkSync(realpathSync(candidate), target, 'dir')
        break
      }
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
  if (!existsSync(target)) {
    console.warn('No runnable vitest found in any deps root; `npm test` will be unavailable.')
  }
}

const compiler = process.env['DSH_TSC'] ?? join(nodeModules, 'typescript', 'lib', 'tsc.js')
if (!existsSync(compiler)) {
  console.error(`No TypeScript compiler at ${compiler}. Set DSH_TSC to tsc.js.`)
  process.exit(2)
}

const result = spawnSync(process.execPath, [compiler, '-p', config], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
