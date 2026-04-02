# Architecture & Design Insights

Deep analysis of the `my-claude-code` codebase — a private fork of Anthropic's Claude Code CLI (~512K LOC). This document captures structural insights, design patterns, and non-obvious implementation details.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Boot Sequence](#2-boot-sequence)
3. [Query Engine](#3-query-engine)
4. [Tool System](#4-tool-system)
5. [State Management](#5-state-management)
6. [Services Layer](#6-services-layer)
7. [Message Types & Formats](#7-message-types--formats)
8. [Feature Flags & Dead Code Elimination](#8-feature-flags--dead-code-elimination)
9. [Plugin & Skill Systems](#9-plugin--skill-systems)
10. [Multi-Agent & Task System](#10-multi-agent--task-system)
11. [REPL Component](#11-repl-component)
12. [Commands System](#12-commands-system)
13. [Bridge / IDE Integration](#13-bridge--ide-integration)
14. [Voice System](#14-voice-system)
15. [Configuration System](#15-configuration-system)
16. [Key Architectural Patterns](#16-key-architectural-patterns)
17. [Performance Optimizations](#17-performance-optimizations)
18. [Security & Permissions](#18-security--permissions)
19. [Cost Tracking & Budgets](#19-cost-tracking--budgets)

---

## 1. Overview

**my-claude-code** is a private fork of Anthropic's Claude Code CLI snapshot with these key modifications over upstream:

- Telemetry stubbed or removed
- Prompt-layer CLI wrapper restrictions reduced
- 88 compile-time experimental feature flags exposed for local testing
- Full multi-provider backend support (Anthropic, OpenAI Codex, AWS Bedrock, Google Vertex AI, Foundry)

### Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | Bun 1.3.11+ (TypeScript/JSX) |
| UI | React 19 + Ink (terminal React renderer) |
| Primary LLM | Anthropic Messages API (`@anthropic-ai/sdk`) |
| Alt LLM | OpenAI Codex via in-flight fetch adapter |
| Cloud LLMs | AWS Bedrock, Google Vertex AI, Anthropic Foundry |
| Schema validation | Zod v4 |
| State | Custom immutable store (no Redux) |
| Build | Bun bundler with compile-time DCE feature flags |
| MCP | `@modelcontextprotocol/sdk` v1.29.0 |

---

## 2. Boot Sequence

### Entry Point (`src/entrypoints/cli.tsx`)

The bootstrap aggressively minimizes startup latency through fast paths and deferred module loading.

**Fast Paths (minimal/zero module loading):**

| Argument | Behavior |
|----------|----------|
| `--version` / `-v` | `MACRO.VERSION` inlined at build time; immediate exit |
| `--dump-system-prompt` | Ant-only feature gate; renders prompt and exits |
| `--claude-in-chrome-mcp` | MCP server for Chrome extension |
| `--chrome-native-host` | Native host communication |
| `--computer-use-mcp` | `feature('CHICAGO_MCP')` gated computer use |
| `--daemon-worker=<kind>` | Internal supervisor-spawned workers (`feature('DAEMON')`) |
| `claude remote-control` | Bridge/remote mode with policy checks |
| `claude daemon` | Long-running supervisor (`feature('DAEMON')`) |
| `claude ps\|logs\|attach\|kill` | Session management (`feature('BG_SESSIONS')`) |
| `--environment-runner` | Headless BYOC runner (`feature('BYOC_ENVIRONMENT_RUNNER')`) |
| `--self-hosted-runner` | Self-hosted runner (`feature('SELF_HOSTED_RUNNER')`) |
| Worktree+tmux | `exec` into tmux before loading full CLI |

For anything else, the full main module loads.

### Main Module (`src/main.tsx`)

**Phase 1 — Parallel Prefetching:**
- `startMdmRawRead()` launches MDM subprocesses (`plutil` / `reg query`) in parallel with imports
- `startKeychainPrefetch()` fires parallel macOS keychain reads (OAuth tokens + legacy API key)
- Both complete during the ~135ms of remaining imports, saving ~65ms on macOS cold start

**Phase 2 — CLI Parsing & Initialization:**
- Commander parses CLI arguments
- `init()` (from `src/entrypoints/init.ts`) runs:
  1. Auth token verification
  2. `enableConfigs()` — loads user settings from disk
  3. Feature gate initialization (GrowthBook, policy limits)
  4. `ToolPermissionContext` setup
  5. Non-blocking background plugin/skill discovery
  6. Session restoration (transcript reload or fresh start)

**Phase 3 — Lazy Circular Dependencies:**
- `TeamCreateTool` / `TeamDeleteTool` lazy-loaded via `require()` to break import cycles
- `CoordinatorMode`, `AssistantMode` (KAIROS) behind feature-conditional requires

### Interactive Mode

After init, the main UI loop is `src/screens/REPL.tsx` — an Ink/React component that owns:
- User input handling and command dispatch
- Message streaming and rendering
- Tool confirmation dialogs
- Task panel, footer, and bridge status

---

## 3. Query Engine

### Architecture (`src/QueryEngine.ts`)

`QueryEngine` is a long-lived class that owns a complete conversation's lifecycle. One instance per conversation session.

```typescript
class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
}
```

State (messages, file cache, usage, costs) persists across turns within the same conversation.

### `submitMessage()` — The Query Loop

`submitMessage(prompt, options)` is an `AsyncGenerator<SDKMessage>` that yields messages as they stream:

1. **Turn initialization** — clear `discoveredSkillNames`, set `cwd`, wrap `canUseTool()` to track permission denials

2. **System prompt assembly** — `fetchSystemPromptParts()` returns `defaultSystemPrompt`, `baseUserContext`, `systemContext`; optionally injects memory mechanics if `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is set; final prompt stack is `[customPrompt | defaultSystemPrompt] + [memoryMechanics] + [appendSystemPrompt]`

3. **User input processing** — `processUserInput()` with mode `'prompt'` returns messages, `shouldQuery`, `allowedTools`, `model`, `resultText`; messages include file attachments and slash-command effects

4. **Transcript persistence** — messages written to `recordTranscript()` _before_ entering the query loop; fire-and-forget in bare mode (~4ms SSD), awaited in interactive mode for resumability

5. **Permission context update** — `setAppState()` merges `allowedTools` into `alwaysAllowRules[command]`

6. **API query loop** — delegates to `query.ts` module which handles the actual streaming API call, tool execution, recursive tool loops, and cost accumulation

### Context Compaction

Multi-level optimization for long conversations:

| Tier | Trigger | Behavior |
|------|---------|----------|
| Full conversation | Normal | No compaction |
| Auto-compact | Token budget exceeded | Summarizes old messages |
| Microcompact (`CACHED_MICROCOMPACT`) | Between turns | Cached compaction state |
| Reactive compact | Approaching limit | Proactive ahead of limit |
| Snip replay (`HISTORY_SNIP`) | SDK headless sessions | Truncates history, yields `compact_boundary` system message |

### Cost & Usage

- `totalUsage: NonNullableUsage` — accumulated across all turns
- `accumulateUsage()` / `updateUsage()` called during each query loop iteration
- `getCost()` / `getModelUsage()` from `src/cost-tracker.ts`
- Hard stop at `maxBudgetUsd` from `QueryEngineConfig`

---

## 4. Tool System

### Tool Interface (`src/Tool.ts`)

Each tool is a typed object (not a class) with this shape:

```typescript
type Tool<Input, Output, Progress> = {
  name: string
  aliases?: string[]

  // Execution
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>

  // Metadata
  description(input, options): Promise<string>
  userFacingName(input): string
  prompt(options): Promise<string>

  // Schemas
  readonly inputSchema: Input         // Zod schema for input validation
  readonly inputJSONSchema?: ...       // JSON Schema for API tool definitions
  outputSchema?: z.ZodType<unknown>

  // Permissions & validation
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>

  // Behavior flags
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'
  isOpenWorld?(input): boolean
  requiresUserInteraction?(): boolean
  shouldDefer?: boolean      // Load lazily via ToolSearchTool
  alwaysLoad?: boolean

  // MCP metadata
  isMcp?: boolean
  isLsp?: boolean
  mcpInfo?: { serverName, toolName }

  // Observability
  maxResultSizeChars: number
  getToolUseSummary?(input): string | null
  getActivityDescription?(input): string | null
  isTransparentWrapper?(): boolean
}
```

### `ToolUseContext`

Rich context object passed to `tool.call()`:

```typescript
type ToolUseContext = {
  options: {
    commands, debug, mainLoopModel, tools, verbose, thinkingConfig,
    mcpClients, mcpResources, isNonInteractiveSession,
    customSystemPrompt, appendSystemPrompt, maxBudgetUsd
  }
  abortController: AbortController
  readFileState: FileStateCache          // Deduplicates reads within a turn
  getAppState(): AppState
  setAppState(updater): void
  setAppStateForTasks(updater): void     // Bypasses no-op for async agents
  handleElicitation(event): Promise<...> // MCP -32042 URL elicitation
  localDenialTracking: ...
  shouldAvoidPermissionPrompts: boolean
  loadedNestedMemoryPaths: Set<string>   // Dedup CLAUDE.md injection
  agentId?: string                        // Set for subagents
  agentType?: string
  preserveToolUseResults?: boolean
  contentReplacementState?: ...           // Tool result budget for subagents
  renderedSystemPrompt?: string           // Shared prompt cache
}
```

### Tool Registry (`src/tools.ts`)

`getAllBaseTools()` is the exhaustive tool list. `getTools(permissionContext)` returns the filtered set for a given session:

- **Simple mode** (`CLAUDE_CODE_SIMPLE` env): `[BashTool, FileReadTool, FileEditTool]`; REPL override replaces primitives with `REPLTool`; coordinator mode adds `AgentTool`, `TaskStopTool`, `SendMessageTool`
- **Default mode**: full tool set, filtered by `getDenyRuleForTool()` per permission context
- **Feature-gated tools**: LSP (`ENABLE_LSP_TOOL`), PowerShell (`isPowerShellToolEnabled()`), CronTools (`AGENT_TRIGGERS`), MonitorTool, SleepTool (`PROACTIVE || KAIROS`), SnipTool (`HISTORY_SNIP`)
- **Ant-only tools** (`process.env.USER_TYPE === 'ant'`): ConfigTool, TungstenTool, REPLTool

### Permission Model

Three-layer permission flow:

1. **Tool-level**: `checkPermissions()` returns `'allow' | 'deny' | 'ask'`
2. **Classifier**: Bash-specific dangerous command detection (optional `tree-sitter` backend via `BASH_CLASSIFIER` / `TREE_SITTER_BASH` features)
3. **UI Dialog**: Interactive confirmation shown in REPL when result is `'ask'`; denial tracked to prevent repeated prompts

Permission context:

```typescript
type ToolPermissionContext = DeepImmutable<{
  mode: 'default' | 'bypass' | 'auto'
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  shouldAvoidPermissionPrompts?: boolean
  prePlanMode?: PermissionMode  // Saved before entering plan mode
}>
```

### Notable Tool Implementations

| Tool | Key detail |
|------|-----------|
| `BashTool` | Captures `DISABLE_BACKGROUND_TASKS` at module eval time (not call time) |
| `FileReadTool` | `maxResultSizeChars = Infinity`; self-bounds via its own limit/offset params |
| `AgentTool` | Spawns subagents with independent `QueryEngine` instances |
| `REPLTool` | Transparent wrapper; marks itself via `isTransparentWrapper()` |
| `ToolSearchTool` | `shouldDefer = true`; only loaded on demand to speed startup |
| `SendMessageTool` | Puts message into teammate mailbox (`pendingUserMessages`) |

---

## 5. State Management

### AppState (`src/state/AppStateStore.ts`)

Single immutable state tree for the entire app:

```typescript
type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  toolPermissionContext: ToolPermissionContext
  sessionHooks: SessionHooksState
  remoteSessionUrl: string | undefined
  remoteConnectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  kairosEnabled: boolean
  // ... bridge state, UI state, etc.
}> & {
  // Mutable sections (excluded from DeepImmutable for perf)
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  foregroundedTaskId?: string
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    errors: PluginError[]
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  elicitation: { queue: ElicitationRequestEvent[] }
}
```

The `DeepImmutable<...> &` pattern is intentional: the serializable core is deeply frozen; task and agent maps are mutable for performance.

### Mutation Pattern

No Redux, no actions — direct callback mutations:

```typescript
setAppState(prev => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    mode: 'bypass'
  }
}))
```

### Side Effects (`src/state/onChangeAppState.ts`)

Fires effects on AppState change:
- Model change → refresh model capabilities
- Tool permission change → update tool visibility
- Settings mutation → persist to disk
- Plugin/skill state → trigger refresh

---

## 6. Services Layer

### API Clients (`src/services/api/`)

#### Primary: Anthropic SDK (`claude.ts`)
- Calls `@anthropic-ai/sdk` Messages API
- Handles streaming SSE responses
- Retries transient errors with exponential backoff

#### Codex Adapter (`codex-fetch-adapter.ts`)

The most architecturally interesting file. Rather than creating a new LLM provider class, this intercepts Anthropic SDK HTTP calls at the fetch layer and translates in-flight.

**Model mapping:**

| Anthropic | Codex |
|-----------|-------|
| `*opus*` | `gpt-5.1-codex-max` |
| `*sonnet*` | `gpt-5.2-codex` |
| `*haiku*` | `gpt-5.1-codex-mini` |
| (default) | `gpt-5.2-codex` |

**Request translation (Anthropic → Codex):**
- Tool definitions: `input_schema` → `parameters`
- Messages: Anthropic content array → Codex `input` array
- System prompt → `instructions` field
- Base64 images → `input_image` blocks
- `tool_use` → `function_call`; `tool_result` → `function_call_output`

**Response translation (Codex SSE → Anthropic SSE):**
- Reconstructs `content_block_start` / `content_block_delta` / `content_block_stop` events
- Intercepts `reasoning.delta` Codex events → `<thinking>` blocks
- Maps token counts from `response.completed` events
- Cost extracted from response headers

This allows backend switching via a single environment variable with zero changes to the rest of the codebase.

### OAuth (`src/services/oauth/`)

- `codex-client.ts`: PKCE grant flow for Codex/GPT backend
- Token refresh and session persistence
- Keychain integration on macOS (prefetched at startup)

### MCP Integration (`src/services/mcp/`)

| File | Responsibility |
|------|---------------|
| `config.ts` | Parse MCP server config from settings.json; dedupes Claude.ai MCP entries from multiple config scopes |
| `client.ts` | MCP client lifecycle; connects to stdio/HTTP/SSE servers; refreshes tools/resources on reconnect |
| `elicitationHandler.ts` | Handles MCP tool `-32042` URL elicitation errors; prompts user for input and returns result to tool |
| `channelPermissions.ts` | Permission callbacks for channel-based MCP (Claude.ai) |

### Analytics (`src/services/analytics/`)

- `growthbook.ts`: GrowthBook feature flags + A/B experiments; prefetched during bootstrap; refreshes after auth changes
- `sink.ts`: Batched analytics event dispatch (tool usage, tokens, costs)

Note: in this fork, telemetry is partially stubbed — event collection infrastructure is present but dispatch is no-op in many paths.

### Policy Limits (`src/services/policyLimits/`)

Organization-level policy enforcement:
- `allow_remote_control`, `allow_mcp_servers`, `allow_project_mcp`
- Plugin restrictions
- Loaded from policy service or local cache on startup

---

## 7. Message Types & Formats

### Internal Message Type

```typescript
type Message =
  | { type: 'user';      content: string | ContentBlock[]; isMeta?: boolean; toolUseResult?: boolean }
  | { type: 'assistant'; content: ContentBlock[] }
  | { type: 'system';    content: string; subtype?: 'compact_boundary' }
  | { type: 'progress';  data: ToolProgressData }
  | SystemLocalCommandMessage  // UI-only, stripped at API boundary

type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'tool_use';    id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'image';       source: { type: 'base64'; data: string; media_type: string } }
  | { type: 'tool_reference'; tool_name: string }
```

`SystemLocalCommandMessage` is a special type that exists only in the REPL UI — it is filtered out before messages are sent to the API.

### SDK Message Format (`src/entrypoints/agentSdkTypes.ts`)

Public-facing types for Agent SDK consumers:

```typescript
type SDKMessage =
  | SDKUserMessageReplay
  | SDKAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatus
  | SDKPermissionDenial
```

---

## 8. Feature Flags & Dead Code Elimination

### Mechanism

Uses Bun's built-in `feature()` function from `'bun:bundle'`:

```typescript
if (feature('FEATURE_NAME')) {
  // This entire block is eliminated at build time if flag is not set
}
```

During `bun build`, the bundler substitutes `feature('X')` with `true` or `false` and then DCE removes dead branches. Result: zero runtime overhead for disabled features — the code literally does not exist in the output binary.

### Feature Set (`scripts/build.ts`)

The default build (`bun run build`) enables ~47 experimental features:

```
AGENT_MEMORY_SNAPSHOT    AGENT_TRIGGERS           AGENT_TRIGGERS_REMOTE
AWAY_SUMMARY             BASH_CLASSIFIER          BRIDGE_MODE
BUILTIN_EXPLORE_PLAN_AGENTS                        CACHED_MICROCOMPACT
CCR_AUTO_CONNECT         CCR_MIRROR               CCR_REMOTE_SETUP
COMPACTION_REMINDERS     CONNECTOR_TEXT           EXTRACT_MEMORIES
HISTORY_PICKER           HOOK_PROMPTS             KAIROS_BRIEF
KAIROS_CHANNELS          LODESTONE                MCP_RICH_OUTPUT
MESSAGE_ACTIONS          NATIVE_CLIPBOARD_IMAGE   NEW_INIT
POWERSHELL_AUTO_MODE     PROMPT_CACHE_BREAK_DETECTION
QUICK_SEARCH             SHOT_STATS               TEAMMEM
TOKEN_BUDGET             TREE_SITTER_BASH         TREE_SITTER_BASH_SHADOW
ULTRAPLAN                ULTRATHINK               UNATTENDED_RETRY
VERIFICATION_AGENT       VOICE_MODE
```

### Build-time Defines

```typescript
MACRO.VERSION            // from package.json
MACRO.BUILD_TIME         // ISO timestamp
MACRO.PACKAGE_URL        // distribution URL
process.env.USER_TYPE = 'external'               // drops Ant-only tools
process.env.CLAUDE_CODE_FORCE_FULL_LOGO = 'true'
process.env.CLAUDE_CODE_VERIFY_PLAN = 'false'
MACRO.FEEDBACK_CHANNEL = 'github'
```

### Notable Feature Gates

| Flag | Gates |
|------|-------|
| `ULTRAPLAN` | UltraPlan mode (deep planning agent) |
| `ULTRATHINK` | Extended thinking budget mode |
| `VOICE_MODE` | Voice input/output |
| `KAIROS` | Assistant mode (natural language OS-level control) |
| `BRIDGE_MODE` | Remote control from claude.ai web UI |
| `DAEMON` | Long-running background supervisor |
| `BG_SESSIONS` | Background session management |
| `AGENT_TRIGGERS` | Cron-based agent scheduling |
| `HISTORY_SNIP` | Context snipping for headless sessions |
| `TREE_SITTER_BASH` | Tree-sitter powered bash safety classifier |
| `CHICAGO_MCP` | Computer use via MCP |
| `COORDINATOR_MODE` | Multi-agent coordinator orchestration |
| `BASH_CLASSIFIER` | Dangerous bash command detection |

---

## 9. Plugin & Skill Systems

### Skill Loading (`src/skills/loadSkillsDir.ts`)

Skills are Markdown files with YAML frontmatter:

**Frontmatter fields:**
- `name`, `description`, `user-invocable`
- `allowed-tools`, `argument-hint`, `arguments`
- `whenToUse`, `version`, `model`, `effort`, `shell`
- `hooks`, `paths`, `execution-context`
- `agent`, `display-name`, `disable-model-invocation`

**Token estimation**: Only frontmatter fields (`name`, `description`, `whenToUse`) are parsed for the skill index; full content is loaded only on invocation. Keeps startup fast with hundreds of installed skills.

**Deduplication**: `realpath()` to resolve symlinks; prevents duplicate registrations via different path aliases.

**Hooks parsing**: Validated against `HooksSchema`; errors logged but non-fatal.

**Paths parsing**: Supports CLAUDE.md-style glob patterns; strips `/**` suffix; filters match-all patterns.

### Bundled Skills (`src/skills/bundled/`)

Precompiled skill registry. No dynamic discovery at startup — skills are statically registered (with feature gating where needed).

### Plugin System (`src/plugins/`)

Plugins are npm packages that export:
- `skill.ts` → `SkillCommand[]`
- `command.ts` → `Command[]`
- `tools.ts` → `Tool[]`

Managed plugins live in `~/.claude/plugins/` and are installed via `/plugin install`. Loading is dynamic (cached; `clearPluginCommandCache()` to refresh). Load errors are non-fatal and reported via `plugins.errors` in AppState.

---

## 10. Multi-Agent & Task System

### Task State Union (`src/tasks/types.ts`)

```typescript
type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
```

`isBackgroundTask()`: true if status is `running | pending` AND backgrounded.

### In-Process Teammates (`src/tasks/InProcessTeammateTask/`)

Rather than spawning subprocesses for multi-agent coordination, teammates run in the same Bun process with isolated `QueryEngine` instances.

```typescript
type TeammateIdentity = {
  agentId: string            // e.g., "researcher@my-team"
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string   // Leader's session ID
}

type InProcessTeammateTaskState = {
  identity: TeammateIdentity
  prompt: string
  model: string
  abortController: AbortController           // Kills whole teammate
  currentWorkAbortController: AbortController // Aborts current turn only
  awaitingPlanApproval: boolean
  permissionMode: PermissionMode
  messages: Message[]                         // UI mirror (capped at 50)
  inProgressToolUseIDs: Set<string>           // For animation tracking
  pendingUserMessages: string[]               // Mailbox queue
  isIdle: boolean
  shutdownRequested: boolean
  onIdleCallbacks: (() => void)[]             // Efficient waiting without polling
}
```

**Memory cap**: `TEAMMATE_MESSAGES_UI_CAP = 50` messages per teammate in the UI mirror. This was added after a "whale session" caused a 36.8GB memory spike — the full message history still exists in the teammate's `QueryEngine`, but the UI AppState copy is bounded.

**Coordination primitives:**
- `pendingUserMessages`: mailbox for leader-to-teammate messages (delivered by `SendMessageTool`)
- `onIdleCallbacks`: callbacks fired when teammate becomes idle (avoids polling)
- Separate `currentWorkAbortController` vs `abortController` — lets leader interrupt a turn without killing the teammate

---

## 11. REPL Component

`src/screens/REPL.tsx` is the primary interactive UI — an Ink/React component tree.

### Rendering

- **Streaming**: Reads from `AsyncGenerator<SDKMessage>`; re-renders incrementally as messages arrive
- **Message blocks**: Each message type has a dedicated renderer; tool results are formatted per tool
- **Tool confirmations**: Modal dialog over current output; shows tool name, input, risk level; options: Allow / Deny / Ask Each Time
- **Thinking blocks**: Extended thinking content rendered in a collapsible `<thinking>` section

### Speculation / Prefilling

While the user types, a background thread generates message suggestions (prefilling). When a suggestion matches the user's input, it is presented and can be accepted to skip round-trip latency. The `SpeculationState` in AppState tracks:
- Prefilled message candidates
- Written file paths in an overlay (to detect conflicts before accepting)

This is a novel latency-reduction technique: prediction runs concurrently with typing, not after submission.

### Footer & Panels

- **Footer**: command palette, plugin status, bridge connectivity indicator, cost/token display
- **Task panel**: expandable sidebar showing background tasks and teammate status
- **Notifications queue**: non-blocking notification system for async events

---

## 12. Commands System

`src/commands.ts` is the slash command registry (100+ commands).

```typescript
type Command = {
  type: 'prompt' | 'action'
  name: string
  description: string
  source: 'builtin' | 'plugin' | 'skill' | 'managed'
  contentLength: number
  progressMessage?: string
  whenToUse?: string
}
```

### Notable Built-in Commands

| Command | File | Purpose |
|---------|------|---------|
| `/commit` | `commands/commit.js` | Create git commits via Claude |
| `/plan` | `commands/plan/` | Enter plan mode |
| `/config` | `commands/config/` | Edit settings |
| `/mcp` | `commands/mcp/` | Manage MCP servers |
| `/agent` | `commands/agents/` | View/create agent definitions |
| `/task` | `commands/tasks/` | Manage task lists |
| `/review` | `commands/review.js` | Code review |
| `/compact` | `commands/compact/` | History snipping |
| `/summary` | `commands/summary/` | Conversation analysis |
| `/insights` | — | Session analysis report |
| `/teleport` | `commands/teleport/` | Clone repo to container |
| `/reload-plugins` | — | Refresh plugin state |

### Feature-gated Commands

| Flag | Commands |
|------|---------|
| `KAIROS` | `/assistant` |
| `KAIROS_BRIEF` | `/brief` |
| `VOICE_MODE` | `/voice` |
| `WORKFLOW_SCRIPTS` | `/workflows` |
| `FORK_SUBAGENT` | `/fork` |
| `BUDDY` | `/buddy` |
| `TORCH` | `/torch` |

---

## 13. Bridge / IDE Integration

`src/bridge/` enables the remote control feature: the local machine acts as a development environment driven by the claude.ai web UI.

### Key Files

| File | Size | Responsibility |
|------|------|---------------|
| `bridgeMain.ts` | ~115KB | Main bridge event loop, session management |
| `bridgeApi.ts` | ~18KB | HTTP endpoints for incoming requests |
| `bridgeMessaging.ts` | ~16KB | WebSocket event streaming to/from cloud |
| `bridgeEnabled.ts` | ~8KB | GrowthBook gate checks, minimum version validation |
| `createSession.ts` | ~12KB | Session creation and registration protocol |
| `codeSessionApi.ts` | ~4KB | Direct API for code execution requests |

### Session Lifecycle

```
claude remote-control <name>
  → Register environment with CCR (CloudCodeRunner)
  → Open WebSocket for event stream
  → Receive prompts from claude.ai
  → Execute locally with full tool access
  → Stream output back via WebSocket
```

The bridge is gated by `feature('BRIDGE_MODE')` and `feature('CCR_AUTO_CONNECT')` for auto-connection behavior.

---

## 14. Voice System

`src/voice/` — voice input/output integration.

Gated behind `feature('VOICE_MODE')`. The implementation enables microphone-based input and audio output for hands-free operation. Not active in the default build configuration.

---

## 15. Configuration System

### Layered Config Sources

Precedence (highest to lowest):
1. **policySettings** — organization MDM policy (`~/.claude/settings.json`); read-only
2. **userSettings** — user preferences (`~/.claude/config.json`)
3. **projectSettings** — project-local (`.claude/config.json`)
4. **defaults** — built-in defaults

### Schema & Validation

Config validated with Zod schema at load time. `resetSettingsCache()` to invalidate.

### Key Config Files

**`~/.claude/config.json`** (user settings):
```json
{
  "model": "claude-opus-4-1-20250805",
  "theme": "auto",
  "outputStyle": "compact",
  "permissionMode": "default"
}
```

**`~/.claude/keybindings.json`** — Vim mappings, custom shortcuts

**`.claude/settings.json`** (project) — project-level overrides

**`.claude/settings.local.json`** — local-only settings (gitignored)

### CLAUDE.md Discovery

`CLAUDE.md` files are discovered hierarchically (project root → parent dirs → `~/.claude/CLAUDE.md`) and injected into the system prompt. Loading is deduped via `loadedNestedMemoryPaths` in `ToolUseContext` to prevent duplicate injection across nested subagent calls.

---

## 16. Key Architectural Patterns

### Lazy Imports for Circular Dependency Breaking

```typescript
// In tools.ts — TeamCreateTool creates agents which create tools
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
// Called at tool-collection time, not module eval time
```

### Feature-Gated Require

```typescript
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
  : null
```

The `feature()` guard is evaluated at build time — in the external build, the `require()` call is never emitted.

### AsyncGenerator Streaming

Messages yielded incrementally as they arrive:

```typescript
async *submitMessage(prompt): AsyncGenerator<SDKMessage> {
  for await (const event of queryStream) {
    yield event  // UI re-renders on each yield
  }
}
```

### DeepImmutable + Mutable Sections

Serializable core is deeply frozen; hot-path maps are left mutable:

```typescript
type AppState = DeepImmutable<{ settings, toolPermissionContext, ... }> & {
  tasks: { [taskId: string]: TaskState }      // Mutable: frequent writes
  agentNameRegistry: Map<string, AgentId>     // Mutable: Map not serializable
}
```

### FileStateCache

All file reads within a turn go through `FileStateCache`:
- Prevents repeated disk I/O within a single query loop
- `cloneFileStateCache()` creates turn-local snapshots for speculation
- Enables prefilling without actual fs writes

### Callback-Based State Mutations

Predictable, composable state updates without a framework:

```typescript
setAppState(prev => ({ ...prev, verbose: true }))
```

Effects fire via `onChangeAppState()` subscribers (React-hook-like pattern, but for non-UI state).

---

## 17. Performance Optimizations

| Optimization | Location | Impact |
|-------------|----------|--------|
| Startup profiler checkpoints | `cli.tsx`, `main.tsx` | Measures module eval time |
| Parallel keychain + MDM prefetch | `main.tsx` Phase 1 | Saves ~65ms on macOS |
| Lazy dynamic imports | `main.tsx`, `tools.ts` | Defers heavy modules to first use |
| FileStateCache | `ToolUseContext` | Eliminates redundant disk reads within a turn |
| Skill index via frontmatter only | `loadSkillsDir.ts` | Fast startup with many skills |
| Plugin cache | `loadPluginCommands.ts` | Avoids repeated npm require overhead |
| Deferred tools (`shouldDefer`) | `ToolSearchTool` | Rare tools not loaded at startup |
| Streaming AsyncGenerator | `QueryEngine.ts` | Incremental UI updates |
| Prompt caching | Optional | Reuses cached prompt prefix across turns |
| Speculation / prefilling | `REPL.tsx` | Concurrent suggestion generation while user types |
| `MACRO.*` build-time inlining | `scripts/build.ts` | Zero-cost constants |

---

## 18. Security & Permissions

| Layer | Mechanism |
|-------|----------|
| Tool-level | `checkPermissions()` returning `allow / deny / ask` |
| Bash safety | Dangerous command detection (tree-sitter backend with `TREE_SITTER_BASH`) |
| Scope limiting | `additionalWorkingDirectories` Map restricts file access |
| Dangerous rule stripping | `stripDangerousPermissionsForAutoMode()` for auto-approved sessions |
| Policy enforcement | `isPolicyAllowed()` checks from `policyLimits` service |
| Denial tracking | Threshold before falling back to prompt dialogs |
| Subagent isolation | Independent `ToolPermissionContext` per teammate |
| Prompt cache isolation | Per-thread `contentReplacementState` prevents cross-conversation leakage |
| XSS sanitization | `xss` package used on rendered HTML content |
| Secret detection | Never log or output API keys/credentials |

---

## 19. Cost Tracking & Budgets

`src/cost-tracker.ts` manages cost attribution across the entire session:

- Tracks per-API-call TTFT (time to first token) and total duration
- Accumulates token usage per model (input, output, cache read, cache write)
- Computes USD cost per call based on model pricing tables
- Enforces `maxBudgetUsd` hard limit from `QueryEngineConfig` — query loop aborts if exceeded
- Usage surfaced in REPL footer in real time
- Session totals persisted to transcript for post-session review

---

*Generated 2026-04-03 via deep codebase analysis.*
