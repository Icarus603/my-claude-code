# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this private internal repository.

## Common commands

```bash
# Install dependencies
bun install

# Build (./dist/cli.js)
bun run build

# Run from source without compiling
bun run dev
```

Run the built binary with `./dist/cli.js`.

- This repository is private/internal and is documented for the repo owner plus invited collaborators.
- Use `./dist/cli.js /login` only for Anthropic OAuth or OpenAI Codex OAuth.
- Bedrock, Vertex AI, and Foundry use provider-specific credentials instead of `/login`.

## High-level architecture

- **Entry point/UI loop**: src/entrypoints/cli.tsx bootstraps the CLI, with the main interactive UI in src/screens/REPL.tsx (Ink/React).
- **Command/tool registries**: src/commands.ts registers slash commands; src/tools.ts registers tool implementations. Implementations live in src/commands/ and src/tools/.
- **LLM query pipeline**: src/QueryEngine.ts coordinates message flow, tool use, and model invocation.
- **Core subsystems**:
  - src/services/: API clients, OAuth/MCP integration, analytics stubs
  - src/state/: app state store
  - src/hooks/: React hooks used by UI/flows
  - src/components/: terminal UI components (Ink)
  - src/skills/: skill system
  - src/plugins/: plugin system
  - src/bridge/: IDE bridge
  - src/voice/: voice input
  - src/tasks/: background task management

## Build system

- scripts/build.ts is the build script and feature-flag bundler. Feature flags are set via build arguments such as `--feature=ULTRAPLAN` (see README for details).
