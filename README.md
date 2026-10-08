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
| `npm test` | Protocol, control and security tests of remote orchestration (`test/`), under plain Node |

`npm run dev` and `npm start` go through `scripts/run.mjs`, which clears `ELECTRON_RUN_AS_NODE`.
VS Code and other Electron-based tools export that variable to the processes they spawn, and it
makes Electron start as plain Node.

The app keeps its graph and transcripts in Electron's userData folder
(`%APPDATA%\symphony` on Windows, `~/Library/Application Support/symphony` on macOS). Set
`SYMPHONY_USER_DATA` to use a different folder, for example for test runs.
`SYMPHONY_MACHINE_NAME` overrides the machine name remote orchestration shows, and
`SYMPHONY_REMOTE_LOOPBACK=1` keeps remote orchestration on 127.0.0.1 without mDNS, so two instances
on one machine can be tested without touching the network or the firewall.

## Using it

| To | Do this |
|---|---|
| Add a project | Click **+** (bottom left) and pick a folder, or drop a folder onto the window |
| Open a terminal | The terminal button on a project opens PowerShell in that folder; the one in the bottom-left dock opens it in your home folder. Each click opens another floating terminal; closing one ends its shell |
| Check Claude usage | The meter in the bottom-left dock shows the 5-hour, weekly and weekly-per-model (Fable) windows as bars; click it for exact percentages and reset times |
| Start work | Right-click a project, type a prompt, pick a model and its effort, **Start** (Ctrl/⌘+Enter) |
| Set effort | The picker next to the model lists only the levels that model accepts (low, medium, high, extra-high, max) and is hidden for models without effort, such as Haiku. Each model remembers its own effort; "Default effort" leaves it to Claude Code |
| Build a loop | The loop button on a project opens the loop editor (see Loops below) |
| Approve automatically | The double-check button in the dock. While it is on (bone white, and "auto-approving" next to the Symphony mark), Claude Code permission prompts are allowed without asking, and any waiting ones are released. It is off every time Symphony starts |
| Dictate a prompt | The mic button in the prompt bubble, a session's reply box or a loop step. Click, speak (the words appear dimmed as you speak), click again; the text is cleaned up and inserted where the cursor was. Escape cancels while listening |
| Attach images | Paste them (Ctrl/⌘+V) into the right-click prompt bubble or a session's reply box. Thumbnails appear above the text; hover one to remove it. A reply can be just images |
| Watch or answer a session | Click its node. Approvals, questions and replies all happen in that view |
| Watch a subagent | Click its node (it hangs off its session while it runs) |
| See what a session made | Ask for it ("take a screenshot of the home screen"). Claude shows files with its `show_files` tool: images appear in the session view (click for the full-window viewer, ← → between images), PDFs and other files open in their default app. Images Claude reads itself, such as its own screenshots, appear under that tool call |
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

## Loops

A loop chains prompts on one project and repeats them until its last step moves forward. Each
step is either an **agent step** (a prompt that runs as its own Claude Code session) or a **human
review** (you decide). Example: build the report, review it against the design, code-review the
changes, then you approve.

- **Routing.** Every agent step ends by calling a `loop_route` tool that Symphony gives it:
  `forward` hands the work to the next step, `back` (with a step number) sends it to an earlier
  step, or reruns its own, with a summary of what must change. Agents cannot end a loop early;
  the loop ends only when the last step moves forward, so a final human review cannot be
  skipped. At a human review the loop node turns into the orange square, and the loop panel
  shows your instructions, what the previous step handed over, and its files and links. You
  approve (continue, or finish if it is the last step), send the work back to an earlier step
  with notes, or stop.
- **Handoffs.** Steps run in fresh sessions, so each one starts with the loop's step list, the
  last few moves, and the latest handoff (the summary plus artifacts: file paths and URLs). Work
  sent back arrives as "address this first". Images pasted into a step (for example design
  references) go with every run of that step.
- **Prompt improvement.** When a loop starts, all agent-step prompts go through `/optimize-prompt`
  in parallel, with a note that they are loop steps. The results are cached and reused on later
  runs until you edit the step. Expand a step in the loop panel to see both versions.
- **Limits and pauses.** A loop pauses after a number of agent runs in a row without a human
  decision (12 by default, set in the editor). It also pauses when a step ends without routing
  even after one reminder, when you stop a step's session, or when Symphony closes mid-step. A
  paused loop asks you to continue, rerun the step, send the work back, or stop.
- **On the graph.** The loop node hangs under its project, with markers for its steps (circles
  for agent steps, squares for human reviews; the current one is white). Only the running step's
  session is shown, under the loop; earlier runs are listed in the loop's history with "Open
  session".
- **Reviewing artifacts.** Files a step hands over (a file, a folder, or a pattern such as
  `out/*.png`) are copied when the step routes, so the review shows exactly what the step produced.
  Images appear as a gallery in the review card, with the full-window viewer; PDFs and other
  documents open in their default app. Links open in the browser. Files that cannot be shown
  (scripts, programs) stay as paths and are only shown in their folder, because opening one would
  run it.

## Files shown in sessions

Every session (except the optimize step) has a `show_files` tool, and its system prompt says that
the user watches from Symphony's window, possibly on another computer, so a file only reaches them
through that tool. Shown and handed-over files are copied into an asset store in Symphony's data
folder, named by the SHA-256 of their content (images, PDFs, HTML and text; up to 20 files at a
time, 20 MB each). Transcripts and handoffs carry only a reference and a small preview made with
Electron's `nativeImage` (PDF previews come from the OS thumbnailer on macOS and Windows). For a
remote machine, the orchestrator fetches each file once, checks it against its hash, keeps it in
its own store, and fetches new files as soon as they appear, so they can still be reviewed while
that machine sleeps.

Files are deleted with what showed them: removing a session (or its project) deletes its files,
and deleting a loop or running it again deletes the files its handoffs carried, unless another
session or loop still refers to the same file. The orchestrator records which remote session or
loop each of its copies belongs to (`remote-files.json`), and deletes a copy once those are gone,
including ones removed while the link was down (noticed at the resync) or when the machine is
revoked. A minute after startup, a sweep deletes stored files that nothing refers to and that are
older than ten minutes, in case Symphony quit in the middle of a cleanup.

## Remote machines

Symphony on one machine (the **orchestrator**, e.g. a Windows PC) can drive Symphony on other
machines on the same local network (**remote machines**, e.g. MacBooks). Sessions, project files,
git and each machine's own Claude Code login stay on that machine; the orchestrator only prompts,
watches, approves and reviews. Nothing besides the Symphony repo and its npm packages is installed
anywhere: no SSH, no system service, no overlay network.

Set up, once per remote machine:

1. On the orchestrator: the remote-machines button in the dock, then **Orchestrate other machines**.
   It listens on its local-network addresses (port 47821) and advertises itself over mDNS. Windows
   asks once to allow Symphony through its firewall.
2. On the remote machine: `npm install`, `npm start`, and sign in to Claude Code (**Sign in to
   Claude** in the same panel runs the Claude Code binary that ships with Symphony, if there is no
   `claude` command). Turn on **Let a Symphony on this network orchestrate this machine**, pick the
   orchestrator from the list (or enter its address), and pick the shared folders.
3. Both screens show a 6-digit code. Accept on both when they match. From then on the two accept
   only each other (pinned certificates, mutual TLS); the remote machine dials out, so no port is
   opened on it.

On the orchestrator each remote machine is its own root on the graph, with its `~/.claude` hub and
projects under it; remote projects carry the machine's name. Everything works as for local
projects: the prompt pipeline with live thinking and tool calls, approvals and questions, replies,
loops (including human steps), the diff viewer, CLAUDE.md, skills, MCP, artifacts (files are
fetched and opened here; `localhost` links cannot), and terminals if the remote machine allows
them. The machine node carries that machine's auto-approve toggle, the folder browser for adding a
project from its shared folders, a terminal button, and its battery when it runs on battery. The
dock's auto-approve and the usage meter are this machine's only; remote machines stop polling
usage while linked. A repo cloned on two machines is two separate projects.

While linked, the remote machine's own window is read-only (enforced by its core, not only its
UI), with a banner naming the orchestrator and a **Disconnect** button that always works. If the
link drops without a goodbye, it stays read-only for a grace period (2 minutes by default,
settable, 0 to turn it off) while it redials. If the same approval is answered on both sides, the
first answer wins and the other side is told so.

Offline machines are unmistakable but never orange: the machine node turns into a broken ring
labelled "offline", "asleep" or "quit" with the time, everything under it fades to 40% with dashed
edges, and open panels say they show the last known state, with every action disabled. On return
the orchestrator takes a fresh snapshot and fetches open transcripts again; requests interrupted by
a drop are resent with the same id and run once. What the orchestrator knows about each machine is
saved, so after a restart every paired machine appears at once, offline, with its last state.

**Needs you**: the count at the end of the dock lists every waiting approval, question, human loop
step and pairing request on every machine, oldest first. Ctrl/⌘+J opens the oldest; pressing it
again moves to the next.

Each remote machine logs what the orchestrator did there (sessions started, approvals answered,
auto-approve toggled, CLAUDE.md saved, terminals opened); **Show the audit log** in its panel.
Either side can revoke the other. The design is in `plan.md`.

## Auto-approve and dictation

**Auto-approve** answers Claude Code's permission prompts with "allow" for every session and loop
step while it is on. It does not answer Claude's questions, which still need you. It does not
override `ask` rules you set in Claude Code settings (those prompts are still asked), and deny rules
are applied by Claude Code before Symphony is asked. Each auto-allowed action stays in the
transcript as "auto-allowed".

**Dictation** runs speech recognition locally. Claude Code's own voice dictation uses a private
claude.ai speech endpoint that the Agent SDK does not expose, so Symphony uses Whisper (`whisper-base`,
multilingual) through Transformers.js instead: on the GPU through WebGPU when available, otherwise on
the CPU. The model (about 80–150 MB) downloads from Hugging Face on first use and is cached; audio
never leaves the machine. While you speak, the text so far is re-transcribed about once a second and
shown dimmed; when you stop, the take is transcribed once more and Claude Haiku cleans it up (filler
words, pause dots, punctuation, misheard technical terms) through Claude Code, on the subscription
like everything else. The language comes from Claude Code's `language` setting in
`~/.claude/settings.json` (the same setting Claude Code uses for its own dictation), English when
unset.

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
| `src/main/sessions.ts` | Runs sessions through the Agent SDK; turns the stream into node status and transcript items; holds approvals and questions until answered; the `show_files` tool |
| `src/main/assets.ts` | The asset store: files shown in sessions and handed over in loops, by content hash |
| `src/renderer/src/components/Files.tsx` | File gallery and the full-window image viewer |
| `src/main/pipeline.ts` | `/optimize-prompt` command and extraction of the optimized prompt |
| `src/main/claudeConfig.ts` | Inspector query, skill discovery, MCP status, CLAUDE.md read/write |
| `src/main/git.ts` | Change counts and HEAD/working-tree contents (includes untracked files, like VS Code) |
| `src/main/github.ts` | gh accounts, per-session identity, in-app device login |
| `src/main/terminals.ts` | One pseudo-terminal per terminal panel |
| `src/main/loops.ts` | Loops: running steps, the `loop_route` tool, handoffs, human decisions, pauses |
| `src/main/core.ts` | `SymphonyCore`: the services and every request, without the window; any number of event listeners; read-only enforcement for a controlled machine |
| `src/main/index.ts` | Window and IPC; every request goes through remote orchestration |
| `src/main/remote/` | Remote orchestration: `orchestrator.ts` (listener, pairing, routing, merging), `link.ts` (remote side: dialing out, serving the core, read-only control, shared folders, audit), `mirror.ts` (a remote machine's state as the orchestrator sees it), `server.ts` (request ids, sequence numbers), `wire.ts` (frames, ping, silence), `identity.ts` (certificate, pairing code), `mdns.ts`, `settings.ts` |
| `src/shared/remote.ts` | The link protocol: frames, timings, which request goes where, ID prefixes |
| `src/preload/index.ts` | The `window.symphony` bridge (context-isolated, sandboxed) |
| `src/shared/` | Types and the IPC contract shared by both sides |
| `src/renderer/src/components/Graph.tsx` | Layout and interactions of the graph |
| `src/renderer/src/components/Glyph.tsx` | The status shape: arc, square, diamond, outline, shake |
| `src/renderer/src/components/SessionView.tsx` | Session and subagent views |
| `src/renderer/src/components/Viewer.tsx` | Diff viewer, skill preview, MCP details, CLAUDE.md editor |
| `src/renderer/src/components/TerminalPanel.tsx` | Floating terminal (xterm.js) |
| `src/renderer/src/components/UsagePanel.tsx` | Usage bars and reset times |
| `src/renderer/src/components/LoopPanel.tsx` | Loop editor, running view, human review card, history |
| `src/renderer/src/speech/` | Dictation: microphone capture, the local Whisper worker, live preview |
| `src/main/dictation.ts` | Clean-up of dictated text with Claude Haiku |
| `scripts/drive.mjs` | Test driver: Playwright `_electron` behind a small HTTP command server |
| `src/renderer/src/components/RemotePanel.tsx`, `MachinePanels.tsx`, `NeedsYou.tsx`, `ControlBanner.tsx` | Remote-machines panel, pairing and folder browser, the Needs you list, the read-only banner |
| `scripts/test.mjs`, `test/` | Remote-orchestration tests: an orchestrator and a remote machine in one Node process over TLS on 127.0.0.1 |

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
- Loops, in a three-step loop (build page, design review, human approval) on Haiku: the review
  step sent the page back once with the list of changes and passed it on the second try; at the
  human step, sending it back with a note got the change made and returned to review; approving
  finished the loop. Also: cached improved prompts were reused on the next run; quitting
  mid-step brought the loop back paused, and "Rerun this step" continued it; "Stop loop"
  stopped the running step; artifact opening refused a missing file and non-web links.
- Auto-approve: turning it on released a waiting Write approval (recorded as auto-allowed), and a
  session started while it was on never stopped for approval; turning it off removed the reminder.
- Dictation, with a Windows text-to-speech recording of a sentence with "um"s and "uh"s fed in
  place of the microphone: the model downloaded on first use and ran on the GPU (WebGPU); the
  words appeared dimmed in the prompt bubble while the audio played (first words about 4 s after
  starting, including loading the cached model); after stopping, the cleaned text ("Please add a
  test file for the math module. Use Node test, and run it with npm test when you are done.")
  replaced it about 5 s later, and in the reply box it was inserted at the cursor between existing
  text. Not tested with a physical microphone, and not with a language other than English.
- Pasted images: two screenshots pasted into the prompt bubble reached the real session through the
  pipeline and Claude described both; an image-only reply and a 3000×2000 image (sent at
  1568×1045) worked in a session's reply box. The test fired paste events directly rather than using
  the system clipboard.
- Subscription only: with Symphony started with a fake `ANTHROPIC_API_KEY` and an
  `ANTHROPIC_BASE_URL` pointing at a dead port, sessions still ran normally (so neither reached
  Claude Code); with an `apiKeyHelper` in a project's settings, the session was refused before
  sending anything.

- Remote orchestration, with two instances on this PC (separate `SYMPHONY_USER_DATA`,
  `SYMPHONY_REMOTE_LOOPBACK=1`): pairing by code from both windows; the remote machine as its own
  root with hub and project; adding its project through the folder browser; a Haiku pipeline on the
  remote project with live thinking, the approval answered from the orchestrator while the remote
  window showed it read-only; the diff viewer; CLAUDE.md read and saved; the per-machine
  auto-approve toggle; a loop's human step decided from the orchestrator; the audit log; quitting
  the remote instance (broken ring, "quit", faded dashed subtree, panel banner, actions disabled);
  restarting it (relinked and resynced in 2 s, read-only again); restarting the orchestrator
  (machine shown offline with its last state at once, then relinked). `npm test` covers the rest
  of the plan's protocol, control and security tests (30 tests).

Not verified on this machine:

- **Remote orchestration on a real network**: mDNS discovery, a remote machine on another computer,
  Windows Firewall, sleep and wake, and Wi-Fi changes (the two-instance test runs on loopback).
  This is phase 4 of `plan.md`.
- **Remote terminals in the window.** Routing, the switch and the ID handling are covered by
  `npm test`; a remote terminal panel was not opened in the app.

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
- Dictation: `ensureMicAccess()` triggers the macOS microphone prompt (a packaged app also needs
  `NSMicrophoneUsageDescription` in its Info.plist); WebGPU is used on Apple GPUs, with the CPU
  fallback otherwise.
- Remote orchestration (phase 4 of `plan.md`): the device key in the Keychain through `safeStorage`
  (`sealSecret()`), `scutil --get ComputerName` for the machine name, `pmset` for the battery
  (`readHealth()`), sleep and wake through `powerMonitor` (`onPower()`), `powerSaveBlocker`
  (`keepAwake()`), mDNS discovery of the orchestrator, and **Sign in to Claude** running the
  bundled binary with `/login`.
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
