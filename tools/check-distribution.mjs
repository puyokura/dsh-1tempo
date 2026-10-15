/**
 * Verify the distribution packaging of this repository:
 *   - package.json declares a bundle patch and is not private
 *   - the bundle patch parses and declares exactly the onetempo row
 *   - locale files carry display metadata
 *   - dsh's own install-spec reader accepts `github:puyokura/dsh-1tempo`
 *
 * Read-only: it parses the local files and imports dsh's parser. The parser is
 * imported by path because this repository has no dependency on dsh.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// This file lives in <repo>/tools/, so the repository is one level up.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
if (manifest.private === true) problems.push('package.json is private (not installable)')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('dsh.bundle.patch is missing or wrong')
if (typeof manifest.description !== 'string' || manifest.description.length === 0) problems.push('description is missing')
if (!Array.isArray(manifest.files) || !manifest.files.includes('mil-spec/')) problems.push('files must ship mil-spec/')

const base = process.env.APPDATA ?? ''
const dshPackages = join(base, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const yamlEntry = join(dshPackages, 'yaml', 'dist', 'index.js')
if (!existsSync(yamlEntry)) problems.push(`yaml parser not found at ${yamlEntry}`)
const installSpecEntry = join(dshPackages, '@deepseek-ai', 'dsh-plugin-manager', 'lib', 'index.js')
if (!existsSync(installSpecEntry)) problems.push(`plugin-manager entry not found at ${installSpecEntry}`)

const YAML = await import(pathToFileURL(yamlEntry).href)
const patch = YAML.parse(readFileSync(join(repo, 'cordis.patch.yml'), 'utf8'))
const rows = Array.isArray(patch) ? patch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [])) : []
const mine = rows.filter((row) => row?.id === 'onetempo')
if (mine.length !== 1) problems.push(`bundle patch declares ${mine.length} onetempo rows`)
if (mine[0]?.name !== manifest.name) problems.push(`bundle patch name ${mine[0]?.name} != package name ${manifest.name}`)

for (const language of ['en', 'ja']) {
  const file = join(repo, 'locale', `${language}.json`)
  if (!existsSync(file)) {
    problems.push(`locale/${language}.json is missing`)
    continue
  }
  const meta = JSON.parse(readFileSync(file, 'utf8')).meta
  if (typeof meta?.title !== 'string' || typeof meta?.description !== 'string') {
    problems.push(`locale/${language}.json needs meta.title and meta.description`)
  }
}

// dsh's own reader decides which specs the Plugins page accepts. It is exported
// from the manager's built entry (the source module is inlined by the build).
const manager = await import(pathToFileURL(installSpecEntry).href)
let spec
try {
  spec = manager.parseInstallSpec('github:puyokura/dsh-1tempo')
} catch (error) {
  problems.push(`parseInstallSpec rejected the spec: ${error?.message ?? String(error)}`)
}

process.stdout.write(`package: ${manifest.name}@${manifest.version} private=${manifest.private === true}\n`)
process.stdout.write(`bundle patch: ${manifest.dsh?.bundle?.patch}\n`)
process.stdout.write(`rows: ${JSON.stringify(mine)}\n`)
process.stdout.write(`install spec: ${spec === undefined ? '(not parsed)' : JSON.stringify(spec)}\n`)
process.stdout.write(problems.length === 0 ? '判定: 合格\n' : `判定: 失敗\n- ${problems.join('\n- ')}\n`)
process.exit(problems.length === 0 ? 0 : 1)
