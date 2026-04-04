import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BRIDGE_MODE',
  'BUDDY',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TRANSCRIPT_CLASSIFIER',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

// Default builds in this repo should include the full bundle of currently
// working experimental features. We still keep the array separate so callers
// can add extra one-off flags with --feature=... when needed.
const defaultFeatures = [...fullExperimentalFeatures]
const featureSet = new Set(defaultFeatures)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      // Backward-compatible no-op now that dev-full is the default bundle.
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    // Backward-compatible no-op now that dev-full is the default bundle.
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
// Also collect FEATURE_* env vars → Bun.build features (same as claude-code build.ts)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('FEATURE_')) {
    featureSet.add(key.replace('FEATURE_', ''))
  }
}

const features = [...featureSet]
const outfile = './dist/cli.js'
const buildTime = new Date().toISOString()
const version = pkg.version

const outDir = dirname(outfile)
if (outDir !== '.') {
  mkdirSync(outDir, { recursive: true })
}

const externals = [
  // '@ant/*' removed — workspace packages must be bundled
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
]

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    'https://github.com/Icarus603/my-claude-code',
  ),
} as const

const cmd = [
  'bun',
  'build',
  './src/entrypoints/cli.tsx',
  '--compile',
  '--target',
  'bun',
  '--format',
  'esm',
  '--outfile',
  outfile,
  '--minify',
  '--bytecode',
  '--packages',
  'bundle',
  '--conditions',
  'bun',
]

for (const external of externals) {
  cmd.push('--external', external)
}

for (const feature of features) {
  cmd.push(`--feature=${feature}`)
}

for (const [key, value] of Object.entries(defines)) {
  cmd.push('--define', `${key}=${value}`)
}

const proc = Bun.spawnSync({
  cmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

console.log(`Built ${outfile}`)
