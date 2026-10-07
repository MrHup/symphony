# Symphony

A desktop app that orchestrates Claude Code sessions across the projects on one machine. Each
project is a node on a graph; every session, subagent, skill and MCP server is a node connected to
it. Everything is monochrome except one color, safety orange, which appears only when something is
waiting for you.

## Run it

Prerequisites:

- Node.js 22.12 or newer and npm
- git on `PATH`
- Claude Code signed in with a Claude subscription (Pro, Max, Team or Enterprise), the same login
  the `claude` CLI uses. Symphony runs only on that subscription and refuses API-key or
  cloud-provider billing (see "Subscription only" below). Symphony runs the Claude Code binary that
  ships with the Agent SDK, so a separate CLI install is not required.
- Optional: [GitHub CLI](https://cli.github.com) (`gh`) for the GitHub identity feature. Symphony
  can sign you in to gh from the hub node, so no terminal is needed for that either.

```bash
npm install
npm run dev     # development, with hot reload for the UI
npm start       # production build, then launch
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Build main, preload and renderer into `out/` |
| `npm run typecheck` | Type-check the main process and the UI |
| `npm run drive` | Launch the built app under Playwright and accept test commands over HTTP (see `scripts/drive.mjs`) |

`npm run dev` and `npm start` go through `scripts/run.mjs`, which clears `ELECTRON_RUN_AS_NODE`.
VS Code and other Electron-based tools export that variable to the processes they spawn, and it
makes Electron start as plain Node.

The app keeps its graph and transcripts in Electron's userData folder
(`%APPDATA%\symphony` on Windows, `~/Library/Application Support/symphony` on macOS). Set
`SYMPHONY_USER_DATA` to use a different folder, for example for test runs.

## Using it

| To | Do this |
|---|---|
| Add a project | Click **+** (bottom left) and pick a folder, or drop a folder onto the window |
| Open a terminal | The terminal button on a project opens PowerShell in that folder; the one in the bottom-left dock opens it in your home folder. Each click opens another floating terminal; closing one ends its shell |
| Check Claude usage | The meter in the bottom-left dock shows the 5-hour, weekly and weekly-per-model (Fable) windows as bars; click it for exact percentages and reset times |
| Start work | Right-click a project, type a prompt, pick a model and its effort, **Start** (Ctrl/⌘+Enter) |
| Set effort | The picker next to the model lists only the levels that model accepts (low, medium, high, extra-high, max) and is hidden for models without effort, such as Haiku. Each model remembers its own effort; "Default effort" leaves it to Claude Code |
| Attach images | Paste them (Ctrl/⌘+V) into the right-click prompt bubble or a session's reply box. Thumbnails appear above the text; hover one to remove it. A reply can be just images |
| Watch or answer a session | Click its node. Approvals, questions and replies all happen in that view |
| Watch a subagent | Click its node (it hangs off its session while it runs) |
| See uncommitted changes | Click the `+n −n` counts on a project |
| Edit CLAUDE.md | Click the page icon on a project. Save with Ctrl/⌘+S |
| Read a skill | Click it (Source or Rendered) |
| Inspect an MCP server | Click it. Secret values are hidden |
| Change a skill or MCP server | Right-click it, describe the change, **Start** |
| Show or hide user skills/MCP | Click the `~/.claude` hub |
| Sign in to GitHub | Click "sign in to GitHub" on the hub; Symphony shows the one-time code and opens the browser |
| Remove a project or a finished session | Trash icon on the project (hover) or in the session view |

How to read the graph without reading text:

| Look | Meaning |
|---|---|
| Thin arc rotating around the node | Working |
| Solid orange square, one damped shake | Needs your input (Claude asked a question, or an MCP server needs auth) |
| Solid orange diamond, one damped shake | Needs your approval |
| Outline, 40% opacity | Finished |
| Dashed circle | The `/optimize-prompt` step of the pipeline |
| Circle with a slash | MCP server failed to connect |

A project takes the most urgent state of its sessions, and a session takes the state of its
subagents, so a single orange shape anywhere tells you where to look.

### The prompt pipeline

A prompt typed on a project first runs as `/optimize-prompt <prompt>` in a session with the model you
picked. When that session finishes, Symphony takes the fenced block under `## Optimized prompt` in its
reply and starts a new session with that text as its first message, using the same model and effort. The
optimize node fades out a few seconds later. If the reply has no such block, Symphony sends your
original prompt and leaves a note in the new session saying so.

Pasted images skip the optimize step's message: Claude Code only runs a slash command when the
message is plain text, so the optimizer is told that images are attached (and keeps references to
them), and the images go with the optimized prompt to the new session. Images larger than
1568 px on the long edge, the size Claude works at, are scaled down before sending; the transcript
keeps small thumbnails. If the optimize session fails, its
node stays so you can open it.

## Subscription only

Every Claude Code process Symphony starts (sessions, and the background checks for skills, MCP
servers and usage) runs on your Claude subscription, never on per-token billing. The rule lives in
`src/main/subscription.ts` and has three layers:

1. **Environment.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
   `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` are removed from
   the environment Symphony passes on, and the two key variables are blanked in the highest settings
   layer, so an `env` block in a project's `settings.json` cannot bring them back.
2. **Before the first message.** A session asks Claude Code which login it will use and sends
   nothing unless it is a Claude subscription with Anthropic as the provider and no API-key source.
   This catches an `apiKeyHelper` in any settings file and a Bedrock/Vertex/Foundry setup.
3. **Every turn.** If a turn's start ever reports an API-key source, the session is stopped.

A refused session shows why in its view, and its node stays on the graph.

This applies to Claude Code processes started by Symphony. The embedded terminal is your own shell
with your own environment, so a `claude` you run there yourself is not covered.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| App stack | Electron 44 + React 19 + TypeScript, built with electron-vite | The Agent SDK is a Node library, so the main process can run sessions in-process without a sidecar. One codebase for Windows and macOS. electron-vite gives a fast dev loop for main, preload and renderer together. |
| Connection to Claude Code | Agent SDK only (`@anthropic-ai/claude-agent-sdk`), no direct CLI calls | The SDK streams thinking, text and tool calls as typed messages, reports subagents (`task_started` / `task_notification`), routes every permission prompt and `AskUserQuestion` through one callback (`canUseTool`), and exposes `supportedCommands()`, `supportedModels()` and `mcpServerStatus()`. With the CLI alone, Symphony would have to scrape output and could not answer approvals. The SDK also bundles the Claude Code binary for each OS. |
| Slash commands | Sent as the prompt text (`/optimize-prompt …`) | Verified against the SDK: commands typed this way are dispatched like in the terminal unless `verbatimPrompts` is on. |
| Discovering skills and MCP servers | Start Claude Code in the folder without sending a prompt, read `initializationResult()` and `mcpServerStatus()`, then close | The CLI is the authority on what it loaded (settings sources, plugins, claude.ai connectors, scopes), and no prompt means no tokens are spent. A filesystem scan only adds the SKILL.md paths for preview. Refreshes on start, when a project is added, after a skill/MCP session, and every 3 minutes. |
| Graph | React Flow (`@xyflow/react`) | Mature, renders custom React nodes, and dragging is built in. Its background grid, minimap, controls, attribution and keyboard shortcuts are all turned off. |
| Diff, preview and editor | Monaco (the editor inside VS Code), bundled locally | The brief asks for VS Code-level diffs; Monaco's diff editor is the same component. Only the editor features and syntax tokenizers are loaded, not the language services, so read-only diffs never show error squiggles. One `Viewer` component serves the git diff, SKILL.md preview, MCP details and the CLAUDE.md editor. |
| Signal color | Safety orange `#FF6A13` | Signal yellow sits close to the bone-white type in brightness, so a yellow-filled node would read as "highlighted" rather than "different". Orange differs from the white in both hue and brightness, and stays visible on charcoal at small sizes. |
| Greys | `#131312` background, `#1A1A18` panels, `#2A2926` / `#3B3A36` hairlines, `#5E5C56` / `#8D8A82` / `#B7B3AA` text greys, `#E9E5DC` bone type | Slightly warm neutrals so bone-white type does not look blue against the background. Syntax highlighting is monochrome too. |
| Diff tints | Desaturated green/red at 16–20% alpha | Separates added and removed lines while staying far dimmer than the signal color. |
| Type | IBM Plex Sans + IBM Plex Mono, bundled | Engineered and legible at small sizes, and avoids the generic Inter look. |
| GitHub identity | Each session is pinned to the gh account that is active for its repo's host when it starts. Symphony passes that account's token (`GH_TOKEN`) into the session and points git's credential helper for that host at `gh auth git-credential` through `GIT_CONFIG_*` environment variables | The account shown on the node is then the one the session's git and gh actually use, even if you switch gh accounts later. Nothing is written to your git config. |
| Embedded terminal | `@lydell/node-pty` + xterm.js | A real pseudo-terminal, so interactive programs, Ctrl+C and resizing work. `@lydell/node-pty` ships prebuilt binaries for Windows and macOS that load in Electron without a native rebuild. Program colors are kept but muted and desaturated, the same exception the diff viewer gets. |
| Plan usage | The Agent SDK's usage call, read through a prompt-less Claude Code start like the skill inspector, every 2 minutes and shortly after any session finishes a turn | It is the same data as the CLI's `/usage` view. The SDK marks this call **experimental** (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), so it lives in one function, `readUsage()` in `src/main/claudeConfig.ts`; if an SDK update renames it, the panel shows that usage is unavailable instead of breaking. |
| Permissions | Sessions run in Claude Code's `default` permission mode with your user/project/local settings | Approvals behave exactly as in the terminal, including your allow rules. "Always allow" applies the rule Claude Code suggests. |
| Session lifetime | A session's Claude Code process stays alive for follow-ups and closes after 10 idle minutes; a later reply resumes it by session id | Avoids keeping one process per finished session while making replies feel instant. |
| Persistence | Projects, positions and session metadata in `symphony-state.json`; each transcript in its own JSON file | Small and inspectable. Restarted sessions show as finished and resume on reply. |

## Code map

| Path | Role |
|---|---|
| `src/main/platform.ts` | **All platform-specific code**: config paths, PATH repair, process spawning, gh and git lookup, the git credential environment, window chrome, the bundled Claude binary path |
| `src/main/sessions.ts` | Runs sessions through the Agent SDK; turns the stream into node status and transcript items; holds approvals and questions until answered |
| `src/main/pipeline.ts` | `/optimize-prompt` command and extraction of the optimized prompt |
| `src/main/claudeConfig.ts` | Inspector query, skill discovery, MCP status, CLAUDE.md read/write |
| `src/main/git.ts` | Change counts and HEAD/working-tree contents (includes untracked files, like VS Code) |
| `src/main/github.ts` | gh accounts, per-session identity, in-app device login |
| `src/main/terminals.ts` | One pseudo-terminal per terminal panel |
| `src/main/index.ts` | Window, IPC handlers, background refresh loops |
| `src/preload/index.ts` | The `window.symphony` bridge (context-isolated, sandboxed) |
| `src/shared/` | Types and the IPC contract shared by both sides |
| `src/renderer/src/components/Graph.tsx` | Layout and interactions of the graph |
| `src/renderer/src/components/Glyph.tsx` | The status shape: arc, square, diamond, outline, shake |
| `src/renderer/src/components/SessionView.tsx` | Session and subagent views |
| `src/renderer/src/components/Viewer.tsx` | Diff viewer, skill preview, MCP details, CLAUDE.md editor |
| `src/renderer/src/components/TerminalPanel.tsx` | Floating terminal (xterm.js) |
| `src/renderer/src/components/UsagePanel.tsx` | Usage bars and reset times |
| `scripts/drive.mjs` | Test driver: Playwright `_electron` behind a small HTTP command server |

## What was verified on Windows

These were exercised against a real git repository (a small JS project with uncommitted changes)
on Windows 11, driving the built app:

- Adding a project; +/− counts matching `git diff` plus untracked files; dragging a project and
  having its position saved.
- The pipeline: an optimize node appeared, finished, faded out; the new session started with the
  optimized prompt as its first message and the same model, with no review step.
- A subagent node appeared when the session spawned it and disappeared when it finished; its
  approval requests turned both the agent and its session into an orange diamond.
- Approving Write/Edit/PowerShell calls from the session view; answering an `AskUserQuestion`
  (orange square) and seeing Claude use the answer; follow-up replies, including after an app
  restart (resume).
- The diff viewer in both Side by side and Inline, CLAUDE.md editing and saving, SKILL.md preview (source and rendered), MCP
  details with secrets hidden.
- Right-clicking a skill and having a session edit its SKILL.md.
- The git credential environment: with a token injected, `git credential fill` inside the session
  environment returns that token through gh.
- `npm start` launching from a shell that has `ELECTRON_RUN_AS_NODE=1` set.
- Terminals: PowerShell in the home folder and in a project folder, commands and output, Ctrl+C
  interrupting a running command, resizing, several at once, and every shell ending when its
  panel closes or the app quits.
- Usage: the bars match the account's 5-hour, weekly and weekly Fable windows, with reset times.
- Pasted images: two screenshots pasted into the prompt bubble reached the real session through the
  pipeline and Claude described both; an image-only reply and a 3000×2000 image (sent at
  1568×1045) worked in a session's reply box. The test fired paste events directly rather than using
  the system clipboard.
- Subscription only: with Symphony started with a fake `ANTHROPIC_API_KEY` and an
  `ANTHROPIC_BASE_URL` pointing at a dead port, sessions still ran normally (so neither reached
  Claude Code); with an `apiKeyHelper` in a project's settings, the session was refused before
  sending anything.

Not verified on this machine:

- **The GitHub identity shown when an account is signed in.** gh had no account here, so sessions
  showed "no GitHub account". The token injection and the parsing of gh's login output were tested
  separately. The in-app login panel was not opened, so the browser approval step was not run.
- **Right-clicking an MCP server.** It uses the same session path as skills, but no MCP config was
  edited during testing, to leave the real configuration alone.
- **Packaging into an installer.** Symphony runs from source (`npm start`). `platform.ts` already
  resolves the Claude binary from an unpacked asar, but no electron-builder config exists yet.

## Still to check on macOS

All of this lives in `src/main/platform.ts` unless noted.

- `npm install` pulls the `@anthropic-ai/claude-agent-sdk-darwin-*` binary, and `claudeExecutable()`
  finds it.
- The Claude login stored in the macOS Keychain is visible to sessions started from the app.
- `repairPath()`: when launched from Finder or the Dock, the login-shell PATH is picked up, so `git`,
  `gh` (Homebrew in `/opt/homebrew/bin` or `/usr/local/bin`) and MCP server commands are found.
- `ghCredentialEnv()`: the `!'…/gh' auth git-credential` helper runs under macOS's `sh`.
- `windowChrome()`: the inset traffic lights do not overlap the "Symphony" mark
  (`.platform-darwin .app-mark` in `styles.css`), and the window drags from the top strip.
- `samePath()`: case-sensitive APFS volumes; `claudeJsonProjectKeys()` uses the path unchanged.
- The app stays open with no windows and reopens from the Dock (`quitWhenAllWindowsClosed`).
- Dropping a folder from Finder adds it (`webUtils.getPathForFile` in the preload).
- ⌘+Enter in the composer and ⌘+S in the CLAUDE.md editor.
- Terminals: `npm install` pulls the `@lydell/node-pty-darwin-*` binary; `terminalShell()` opens `pwsh`
  when PowerShell is installed (for example `brew install powershell`) and otherwise the login shell
  (zsh), and the panel title then says so; ⌘+C copies a selection and ⌘+V pastes.

## Known limitations

- MCP servers in "needs auth" (for example claude.ai connectors) stay orange until you authenticate
  them where they are managed, such as claude.ai's connector settings; Symphony shows the state but
  cannot complete that sign-in.
- Edits to plugin or claude.ai-synced skills can be overwritten by the next plugin update or sync;
  the change session is told to mention this.
- The cost shown at the end of each turn is the session's running total, as the SDK reports it.
- Every MCP check starts Claude Code and connects all configured servers for a few seconds.
