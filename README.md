<h1 align="center">my-claude-code</h1>

<p align="center">
  A personal build of Claude Code with multi-provider support and experimental feature flags.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-9.9.99-blue?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/Bun-1.3.11+-black?style=flat-square&logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Anthropic-Claude-D97757?style=flat-square" alt="Anthropic Claude">
  <img src="https://img.shields.io/badge/OpenAI-Codex-412991?style=flat-square&logo=openai&logoColor=white" alt="OpenAI Codex">
  <img src="https://img.shields.io/badge/AWS-Bedrock-FF9900?style=flat-square&logo=amazonaws&logoColor=white" alt="AWS Bedrock">
  <img src="https://img.shields.io/badge/Google-Vertex_AI-4285F4?style=flat-square&logo=google&logoColor=white" alt="Google Vertex AI">
</p>

<p align="center">
  <img src="assets/demo.png" alt="my-claude-code demo" width="800">
</p>

---

## Table of Contents

- [What This Repository Is](#what-this-repository-is)
- [Quick Start](#quick-start)
- [Authentication and Providers](#authentication-and-providers)
- [Build and Run](#build-and-run)
- [Feature Flags and Supporting Docs](#feature-flags-and-supporting-docs)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

---

## What This Repository Is

`my-claude-code` is a personal fork of Anthropic's Claude Code CLI, maintained as a public build workspace.

This fork makes three practical changes over upstream:

- telemetry-related behavior is removed or stubbed where possible
- prompt-layer restrictions added by the CLI wrapper are reduced
- build-time experimental feature flags are exposed for local builds and testing

---

## Quick Start

### Option 1: Clone and build locally

```bash
git clone https://github.com/Icarus603/my-claude-code.git
cd my-claude-code
bun install
bun run build
./dist/cli.js
```

### Option 2: One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/Icarus603/my-claude-code/main/install.sh | bash
```

The installer checks your system, installs Bun if needed, clones the repo, builds `dist/cli.js`, and symlinks `my-claude-code` into `~/.local/bin`.

---

## Authentication and Providers

This repo supports multiple providers, but they do not all authenticate the same way.

### Anthropic

Use Anthropic directly with either:

- `ANTHROPIC_API_KEY`
- `/login` for Anthropic OAuth

```bash
export ANTHROPIC_API_KEY="..."
./dist/cli.js
```

### OpenAI Codex

Codex authenticates via OpenAI OAuth through the CLI:

```bash
./dist/cli.js
```

Inside the CLI, run `/login` and choose the Codex login flow.

After a successful Codex login, `CLAUDE_CODE_USE_OPENAI=1` is persisted in your user config automatically, so new terminal sessions will continue using OpenAI Codex without a manual `export`.

Supported model examples:

| Model | ID |
|---|---|
| GPT-5.3 Codex | `gpt-5.3-codex` |
| GPT-5.4 | `gpt-5.4` |
| GPT-5.4 Mini | `gpt-5.4-mini` |

### AWS Bedrock

Bedrock does not use `/login`. It uses AWS credentials plus provider flags.

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"
./dist/cli.js
```

### Google Vertex AI

Vertex does not use `/login`. It uses Google Cloud credentials.

```bash
gcloud auth application-default login
export CLAUDE_CODE_USE_VERTEX=1
./dist/cli.js
```

### Anthropic Foundry

Foundry does not use `/login`. It uses explicit environment configuration.

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
./dist/cli.js
```

### Provider Summary

| Provider | Selection | Authentication |
|---|---|---|
| Anthropic | default | `ANTHROPIC_API_KEY` or Anthropic `/login` |
| OpenAI Codex | default after Codex login | OpenAI `/login` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | AWS credentials |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | Google ADC |
| Anthropic Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `ANTHROPIC_FOUNDRY_API_KEY` |

---

## Build and Run

### Requirements

- Bun `>= 1.3.11`
- macOS or Linux
- valid credentials for whichever provider you plan to use

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Standard build

```bash
bun install
bun run build
./dist/cli.js
```

### Build output

| Command | Output | Notes |
|---|---|---|
| `bun run build` | `./dist/cli.js` | compiled standalone binary |
| `bun run dev` | source execution | slower startup, no standalone binary |

### Common usage

```bash
# interactive mode
./dist/cli.js

# one-shot prompt
./dist/cli.js -p "what files are in this directory?"

# choose a model explicitly
./dist/cli.js --model claude-opus-4-6

# switch to Codex backend
CLAUDE_CODE_USE_OPENAI=1 ./dist/cli.js
```

### Selected environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | alternative Anthropic auth token |
| `ANTHROPIC_MODEL` | override default Anthropic model |
| `ANTHROPIC_BASE_URL` | custom Anthropic-compatible endpoint |
| `CLAUDE_CODE_USE_OPENAI` | force OpenAI Codex backend |
| `CLAUDE_CODE_USE_BEDROCK` | switch to AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | switch to Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | switch to Anthropic Foundry |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token provided via environment |
| `CLAUDE_CONFIG_DIR` | override the config directory (default: `~/.my-claude-code`) |

### Config isolation

This fork defaults `CLAUDE_CONFIG_DIR` to `~/.my-claude-code` so its settings, auth tokens, teammate models, and MCP configs are fully separate from an official Claude Code installation in `~/.claude`.

To share config with the official installation:

```bash
export CLAUDE_CONFIG_DIR="$HOME/.claude"
./dist/cli.js
```

---

## Feature Flags and Supporting Docs

- [FEATURES.md](FEATURES.md): technical audit of compile-time feature flags in this snapshot
- [AGENTS.md](AGENTS.md): Codex-oriented repo guidance for coding agents
- [CLAUDE.md](CLAUDE.md): Claude-oriented repo guidance for coding agents
- [ARCHITECTURE.md](ARCHITECTURE.md): deep-dive into codebase design and architecture

The default build already includes this repo's current working feature bundle:

```bash
bun run build
./dist/cli.js
```

To enable specific flags manually:

```bash
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK
```

---

## Project Structure

```text
scripts/
  build.ts                build script and feature flag bundler

src/
  entrypoints/cli.tsx     CLI entrypoint
  commands.ts             slash command registry
  tools.ts                tool registry
  QueryEngine.ts          message and tool orchestration

  commands/               slash command implementations
  tools/                  tool implementations
  components/             Ink/React terminal UI
  hooks/                  React hooks
  services/               API, OAuth, MCP, analytics integrations
  state/                  application state
  skills/                 skill system
  plugins/                plugin system
  bridge/                 IDE bridge
  voice/                  voice support
  tasks/                  background task management
```

---

## Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to discuss the approach.
