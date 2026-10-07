# Plan: orchestrating Claude Code sessions on other machines

## Goal

Drive Claude Code sessions that run on other machines on the same local network (two MacBooks)
from the Symphony instance on this Windows PC. The sessions, project files, git and each machine's
own Claude Code login stay on that machine. Only orchestration happens on the PC: prompting,
watching, approving and reviewing.

Terminology: the **orchestrator** is this PC. A **remote machine** is a MacBook running Symphony
in remote mode (the "client" laptops in the original request).

## Decisions

| Topic | Decision |
|---|---|
| Claude accounts | Each remote machine uses its **own** Claude Code login and usage; the two MacBooks may be on different accounts, and either may differ from the PC's. The orchestrator does not show or track remote usage. |
| Billing | Every machine uses a Claude subscription; no API keys anywhere. Symphony's subscription-only guard (`subscription.ts`) stays on, unchanged, on every machine. |
| Usage | **Tracked and shown only on the orchestrator**, for the PC's own account. Usage on remote machines is irrelevant: they do not poll it while linked, never send it over the link, and the PC has no place to show it. |
| MacBook's own window | **Read-only while the PC is connected.** It shows the same graph and sessions, but approvals, prompts, edits and toggles come only from the PC. It becomes a normal Symphony window again when the PC disconnects on purpose, or after a grace period when the link drops (see "Control after a drop"). |
| Same repo on two machines | **Two separate projects.** A repo cloned on the PC and on a MacBook appears as two project nodes, one under each machine (the remote one drawn as remote). They are operated separately and never merged or matched, even though they share a repo. |
| Disconnects | When a remote machine disconnects, sleeps or quits, its work pauses and resumes later (as after a Symphony restart today). The orchestrator must show **clearly** which nodes are offline. |
| Must work remotely | Everything that works today, and in particular: the diff viewer, viewing and editing CLAUDE.md, the live thinking (reasoning) and tool-call stream of sessions, and the auto-approve button. |
| Remote terminals | Nice to have, not required. Planned last, behind a switch on the remote machine. |
| Network | Local network only. Nothing besides the Symphony repo and its npm packages can be installed on at least one of the MacBooks, so no Tailscale, no system services and no SSH server. |
| Direction | The PC orchestrates the MacBooks. The reverse direction is not in scope. The design does not rule it out. |

## Recommendation

Run the same Symphony app on each MacBook, from the repo (`npm install`, `npm start`), with
**remote mode** turned on. In remote mode the MacBook keeps running its own sessions, loops, git
and config discovery exactly as Symphony does today. It also **connects out** to the PC over the
local network, through an encrypted, mutually authenticated WebSocket, and lets the PC drive it.
The PC shows each MacBook as a machine node on the graph, with that machine's projects, sessions
and loops under it.

The two machines pair once, by comparing a 6-digit code shown on both screens, after which they
only accept each other. The MacBooks find the PC automatically through mDNS (Bonjour), with
"enter address" as a fallback.

Why the MacBook connects out rather than the PC connecting in: an outgoing connection needs no
firewall exception, admin rights or system setting on the MacBook. Only the PC listens, and that is
your own machine; Windows asks once to allow Symphony through its firewall.

## Why this fits Symphony's current structure

Symphony already separates "what the UI asks for" from "what the machine does":

- The renderer talks to the main process only through `window.symphony` (`src/shared/api.ts`):
  **37 request methods** (`InvokeApi`, e.g. `startPipeline`, `respondApproval`, `gitFileDiff`,
  `readClaudeMd`, `setAutoApprove`, `loopDecide`) and **20 event types** pushed back (`MainEvent` in
  `src/shared/types.ts`, e.g. `session`, `transcript`, `git`, `loop`, `autoApprove`).
- All the work happens in main-process services written in plain Node: `SessionManager`
  (`sessions.ts`), `LoopManager` (`loops.ts`), `git.ts`, `claudeConfig.ts`, `github.ts`,
  `terminals.ts`, `subscription.ts`, `dictation.ts`.
- Electron itself is used in only three main-process files: `index.ts` (window, IPC, folder
  dialog), `platform.ts` (`shell`, `systemPreferences`) and `store.ts` (`app.getPath`).

A remote machine is therefore "another Symphony main process, reached over the network instead of
over Electron IPC". The same request names, arguments and events travel over the connection. Every
feature is reused as it is, with no second implementation of git, files, skills, CLAUDE.md, thinking
streams or approvals.

It also fits the install constraint. The Agent SDK's npm package already ships Claude Code for
macOS (`@anthropic-ai/claude-agent-sdk-darwin-arm64` / `-x64`, pulled in by `npm install`).
`@lydell/node-pty` ships prebuilt binaries, and everything else is JavaScript, so nothing needs a
compiler or a system install.

## Options considered

| Option | Verdict |
|---|---|
| Remote desktop / screen sharing | Not orchestration: one machine at a time, no shared graph. |
| Claude Code Remote Control / the Agent SDK `bridge` export | Rejected. The `bridge` module is marked alpha and relays sessions through Anthropic's servers to claude.ai's UI, not to a third-party orchestrator. It covers sessions only (no diffs, files, CLAUDE.md, loops) and leaves the local network. |
| SSH from the PC, nothing installed on the Mac | Rejected. It needs macOS Remote Login (a system setting, likely not allowed on the restricted laptop). Claude Code's Keychain login is unreliable from SSH sessions on macOS, and every feature would need a second, remote implementation. |
| Tailscale or another overlay network | Ruled out by the install constraint. Could be added later as a transport; the design does not depend on it. |
| **Symphony in remote mode on each MacBook, connecting out to the PC** | **Chosen.** |

## Architecture

```
Windows PC (orchestrator)                           MacBook A / MacBook B (remote mode)
┌────────────────────────────┐                      ┌──────────────────────────────────┐
│ Renderer: graph, panels    │                      │ Renderer: own window (optional)  │
│        │ IPC               │                      │        │ IPC                     │
│ Main process               │                      │ Main process                     │
│  ├ Local core              │   wss, mutual TLS    │  ├ Core: sessions, loops, git,   │
│  └ Remote listener ◄───────┼──────────────────────┼──┤  config, CLAUDE.md, terminals │
│     one link per machine   │   connection opened  │  └ Remote link (dials out,      │
│                            │   by the MacBook     │     reconnects on its own)       │
└────────────────────────────┘                      │ Claude Code (this Mac's login)   │
                                                    └──────────────────────────────────┘
```

### The core split

1. **Extract `SymphonyCore`** from `src/main/index.ts`: everything except the window. It owns the
   services, implements `InvokeApi`, and emits `MainEvent`s to any number of listeners. Electron
   needs become small injected adapters, kept with the other platform code: folder dialog, opening
   paths and URLs, userData path, microphone access.
2. The **local window** is one client of the local core, through the existing IPC. Nothing changes
   for the renderer.
3. **Remote mode** (MacBook) adds a link that dials the orchestrator and serves the same core over
   it: `invoke` → `core[method](...args)` → `result`, and every core event is forwarded.
   - **Read-only local window:** while the link is up, the core accepts only reading methods from
     its own window (`snapshot`, `transcript`, `gitStats`, `gitFileDiff`, `readSkill`,
     `readClaudeMd`), plus Disconnect. Every other method returns "controlled by <PC name>".
   - **Window display:** the renderer shows a banner ("Orchestrated by DESKTOP-PC, read-only") and
     disables its inputs, buttons and the composer.
   - **Enforced by the core:** the rule lives in the core, not only in the UI, so it holds even if
     the UI misbehaves.
4. The **orchestrator** (PC) holds one link per connected machine. It merges each machine's state
   with its own and routes every request to the machine that owns the target.

### Routing and identity

- Every machine has a stable `machineId`, the fingerprint of its certificate, and a display name
  ("MacBook Pro of Ana"). The PC itself is `local`.
- Projects, sessions, agents and loops already have UUIDs, unique across machines. The orchestrator
  keeps a routing table `id → machineId`, filled from snapshots and events.
- IDs that repeat across machines get a machine prefix at the boundary: skills and MCP servers
  (`skill:user::name`), the `~/.claude` hub (`hub:user`) and terminal IDs. The renderer sees
  prefixed IDs, and the link strips the prefix before forwarding.
- Shared types gain an optional `machineId` on `Project`, `SessionInfo`, `LoopInfo`, `SkillInfo`
  and `McpInfo`. A missing value means the PC.

### Requests without a target

Most requests name a project, session, loop, skill or terminal, and route through the table above.
The rest name nothing that belongs to a machine, so the PC's API gives them an explicit, optional
`machineId` argument (missing means the PC). The link removes it before forwarding.

| Request | Routing |
|---|---|
| `snapshot` | The PC merges its own snapshot with the last snapshot of each machine (see below) |
| `addProject(path?)` | Goes to the chosen machine. Without a path, a remote machine never opens a dialog; the PC shows the remote folder browser instead |
| `setDefaultModel`, `setModelEffort` | Go to the chosen machine. Each machine keeps its own default model and per-model efforts, because each account can offer different models |
| `refreshConfig` | Goes to every connected machine, or to one when given |
| `ghLogin` | Goes to the chosen machine (the hub node it was clicked on) |
| `setAutoApprove` | Goes to the chosen machine (its machine node's toggle) |
| `termStart(id, null, …)` | The home-folder terminal of the chosen machine (its machine node's terminal button) |
| `refreshUsage` | PC only, never routed |
| `micAccess`, `refineDictation`, `dictationLanguage` | PC only, never routed |
| `moveNode` | PC only, never routed (see "Graph layout") |

### Merging snapshots

`AppSnapshot` has fields that hold one value for the whole app. The PC keeps them per machine:

- **`models`, `defaultModel`, `efforts`:** stored per machine. The prompt bubble, reply box and loop
  editor use the lists and defaults of the machine that owns the target project.
- **`gh`:** stored per machine and shown on that machine's hub.
- **`usage`:** the PC's own only. A remote snapshot's `usage` field and any remote `usage` event
  are dropped at the link, in case a remote machine sends one.
- **`autoApprove`:** stored per machine, shown on that machine's node.
- **`hubPosition`:** replaced by the PC's own layout (see below).

### Graph layout

Today positions are saved by the machine that owns the node (`Project.position`, the optional
`SessionInfo.position` and `LoopInfo.position`, and `hubPosition`). The PC's graph has several
machine roots, and a MacBook's own window has only its own projects, so the two layouts would
overwrite each other. Instead:

- **The PC owns the layout of remote nodes.** It stores, per machine, the position of the machine
  node and of every remote node the user has dragged, keyed by `machineId` and node ID, in its own
  state.
- **Remote positions are ignored on the PC.** When it merges a remote snapshot, the PC replaces each
  position with its stored one. A node without one is placed relative to its machine node, the
  same way sessions and loops are placed relative to their project today.
- **`moveNode` on a remote ID stays on the PC** and never crosses the link. The MacBook's own
  layout is untouched and is what its window shows.
- Positions of remote nodes that no longer exist are pruned when a fresh snapshot arrives.

### What runs where

| Feature | Runs on | Notes |
|---|---|---|
| Sessions, the prompt pipeline (optimize → task), subagents | Remote machine | Its own Claude Code login, under its own subscription-only guard |
| Live thinking, text and tool calls | Remote machine, streamed | The batched updates (about 20 a second) are forwarded unchanged, so reasoning appears live, as for local sessions |
| Approvals, questions, follow-up messages | Remote machine holds them | Answered only from the PC while it is connected (the MacBook's window is read-only); they wait if the PC goes away |
| Auto-approve | Remote machine, toggled from the PC per machine | Each machine node gets its own toggle; off when the MacBook's Symphony starts, as today |
| Git counts and the diff viewer | Remote machine | File contents come over the link; Monaco renders them on the PC as it does now |
| CLAUDE.md view and edit | Remote machine | Read and saved through the existing `readClaudeMd` / `writeClaudeMd` |
| Loops | Remote machine | A loop keeps running while the PC is away; a human step waits for the PC |
| Skills, MCP status, GitHub identity | Remote machine | Each machine has its own `~/.claude`, MCP servers and gh login |
| Usage | PC only | By decision. Remote machines stop polling usage while linked; the dock meter is the PC's own account |
| Dictation, pasted images | PC | Speech is turned into text on the PC; only text and images cross the network |
| Adding a project | Remote folder browser | The native dialog cannot browse another machine; limited to the folders the MacBook shares |
| Opening artifacts | File fetched from the remote machine, opened on the PC | Viewable types only, as today; links to `localhost` on the MacBook cannot open on the PC (shown as such) |
| Terminals | Remote machine's shell, streamed | Last phase, off unless enabled on the MacBook |

## Offline machines

The orchestrator must make offline state unmistakable, without breaking the one-color rule (offline
is not something the user has to act on):

- **Machine node:** a broken ring with a slash (the shape already used for a failed MCP server),
  outline only. The label is "offline · since 14:32", and the node's edges become dashed.
- **Everything under it** (projects, sessions, loops, skills) drops to 40% opacity with dashed
  edges, whatever its last state was. A waiting approval does not stay orange on an offline
  machine, because it cannot be answered until the machine is back.
- **Open panels** for that machine show a one-line banner ("MacBook A is offline. Showing its last
  known state from 14:32."). Every action is disabled: sending, approving, saving CLAUDE.md, the
  auto-approve toggle.
- **Reconnecting** shows the rotating arc on the machine node. When the link is back, the PC
  requests a full snapshot, so nothing stale remains.
- **What pauses:**
  - *Network drop, or the PC asleep:* sessions on the MacBook keep running, and approvals wait.
  - *MacBook asleep or Symphony quit there:* its sessions stop. On return they appear finished, or
    paused in the case of loops, exactly as after a restart today, and resume on reply or "Rerun
    this step".
- **Asleep vs. lost:** when a MacBook is about to sleep or quit, it sends a last `bye { reason }`
  frame (`sleep`, `quit` or `disconnect`). The node then reads "asleep · since 14:32" or "quit",
  rather than the generic "offline", which is kept for links that just went silent.

### Remembered across PC restarts

The PC saves what it knows about each paired machine in its userData folder
(`remotes/<machineId>.json`): name, platform, Symphony version, last-seen time, its last snapshot,
and the transcripts the PC has already fetched (the most recent 20 sessions per machine). It writes
this debounced, as it does its own state. When the PC starts, every paired machine appears at once,
offline, with that last known state, until it connects and sends a fresh snapshot. Revoking a
machine deletes its file.

### Control after a drop

The MacBook's window must not switch between read-only and editable every time the Wi-Fi hiccups.

| How the link ended | The MacBook's window |
|---|---|
| Disconnect clicked on the MacBook | Editable immediately. The link stays off until the user turns it back on there |
| The PC disconnects or revokes on purpose, or quits (`bye` received) | Editable immediately. The link redials on its own, except after a revoke |
| The link drops (socket closed, or 30 s of silence) | **Grace period of 2 minutes:** still read-only, banner "Connection to DESKTOP-PC lost, reconnecting… read-only for 1:45". Disconnect stays available and ends the grace period at once |
| Grace period ends without a reconnect | Editable. The link keeps redialing in the background |

- **Reconnect after the window became editable:** the window turns read-only again and the banner
  comes back. If the user is typing in a field at that moment, the window waits until the field
  loses focus or 30 s pass, so the text is not lost. Whatever was done locally in between is
  already applied and reaches the PC in the fresh snapshot.
- **The same approval or question answered on both sides:** the first answer wins. The MacBook
  already ignores a response to a request that is no longer pending (`respondApproval` and
  `respondQuestion` return early). The link reports it as "already answered on <machine>", and the
  PC's panel shows that, not an error.
- The grace period is a setting on the MacBook (default 2 minutes; 0 turns it off).

## Needs you

With several machines on one graph, waiting items can be far apart. A **Needs you** list in the
dock collects them all:

- **What it lists:** every pending approval, question, human loop step and pairing request, on every
  machine, oldest first. Each row shows the machine, project and a one-line summary.
- **How it looks:** a count next to the dock buttons, in orange only when it is above zero (the one
  color still means only "waiting for you"). Click it to open the list; click a row to open its
  panel.
- **Keyboard:** Ctrl/⌘+J opens the panel of the oldest waiting item; pressing it again moves to the
  next one.
- **Offline machines:** their items stay in the list at 40% opacity with "offline", and cannot be
  opened for answering, matching the graph.
- **Source:** the list is computed in the renderer from the merged state; it needs no new request.

## Protocol

- **Transport:** one WebSocket over TLS (`wss`) per remote machine. The MacBook connects to the PC
  on port `47821` (configurable). It retries with backoff (1 s up to 30 s), and immediately when
  its network changes.
- **Frames** (JSON, versioned):
  - `hello { protocol, appVersion, machineId, machineName, platform, capabilities }`, both
    directions, first frame
  - `snapshot { AppSnapshot, seq }`, MacBook → PC after hello and on request
  - `invoke { id, method, args }` → `result { id, ok, value | error }`, PC → MacBook → PC
  - `event { seq, MainEvent }`, MacBook → PC
  - `ping` / `pong` every 10 s; a link with 30 s of silence counts as offline
  - `bye { reason }`, either direction, last frame of a deliberate end (`sleep`, `quit`,
    `disconnect`, `revoke`)
  - `refresh`, PC → MacBook (see "Refresh on focus")
  - `health { battery, charging, lowPower }`, MacBook → PC, after hello and on change
- **Requests and retries:**
  - **Request IDs:** every `invoke` carries a fresh UUID `id`. The MacBook keeps the results of the
    last 5 minutes of requests by `id`. A repeated `id` returns the stored result and does not run
    again.
  - **Resend on reconnect:** when the link drops, requests still waiting for a result are kept on
    the PC for the 2-minute grace period. They are sent again, with the same `id`, after the
    reconnect. A `sendMessage`, `respondApproval` or `startPipeline` that reached the MacBook before
    the drop therefore runs once. After the grace period they fail with "MacBook A went offline".
  - **Timeouts:** a request with no result after 30 s fails in the UI with "no answer from
    MacBook A", while the link stays up. Requests that wait on a person (the remote folder browser)
    have no timeout. Reads (`transcript`, `gitStats`, `gitFileDiff`, `readSkill`, `readClaudeMd`)
    are not resent but fetched again after the resync.
- **Resync:** events carry a sequence number. A gap, or any reconnect, makes the PC ask for a fresh
  snapshot and re-fetch the transcripts of open panels.
  - **Sequence numbers on replies too:** `snapshot` and `transcript` replies carry the sequence
    number they reflect. The PC drops buffered events at or below it, so an event is never applied
    on top of a state that already contains it.
  - **Transcript items are merged by `id`:** every `TranscriptItem` already has one. A re-fetched
    transcript replaces the cached one, and a later event for an existing `id` (a live thinking
    block growing, a tool result arriving) updates that item rather than adding a duplicate.
- **Refresh on focus:** today, focusing the window refreshes git counts and the GitHub identity
  (`win.on('focus')` in `index.ts`), on the local machine only. When the PC's window gains focus,
  the PC also sends `refresh` to every connected machine, at most once every 10 s per machine. The
  MacBook runs the same refresh as for its own window focus. Each machine's regular polling
  (`GIT_POLL_MS`, `CONFIG_POLL_MS`) continues as it does today.
- **Version check:** the protocol number must match. A different app version is allowed, but the
  machine node shows "update Symphony on this machine".
- **Flow control:** terminal output is batched and paused when the socket buffer is high, so it
  cannot delay session events. Frames are capped (for example 32 MB) on both sides.

## Security

The PC gets the same power over each MacBook that Symphony has there locally: Claude Code with tool
access in the shared folders, CLAUDE.md editing, and terminals if enabled. Pairing is treated like
handing over a key.

1. **Off by default.** A MacBook connects only after "Let a Symphony on this network orchestrate
   this Mac" is turned on in its Symphony and it has been paired. While the PC is connected, the
   MacBook's window is read-only and shows who is connected, with a Disconnect button. Disconnect
   is the one action that stays available locally: the person at the MacBook can always take it
   back.
2. **Device identity.** Each Symphony generates a key pair and a self-signed certificate on first
   use. The private key is stored with Electron `safeStorage` (Keychain on macOS, DPAPI on
   Windows), which needs no extra install. This is platform code and lives in `platform.ts`.
3. **Pairing by numeric comparison.**
   1. The MacBook opens TLS to the PC, both sides accepting any certificate for this one
      connection.
   2. Both sides compute a 6-digit code from the two certificate fingerprints and show it.
   3. The user confirms on **both** machines that the codes match.
   4. Each side then pins the other's fingerprint.

   A man-in-the-middle would present different certificates and get different codes, and there is
   no secret to guess offline. Pairing requests are rate-limited and expire after two minutes.
4. **After pairing:** mutual TLS with both certificates pinned. The PC refuses unknown or revoked
   machines during the TLS handshake, before reading any request. The MacBook refuses any PC except
   the paired one.
5. **Least exposure on the MacBook:**
   - **Shared folders:** projects can only be added from these (default: the home folder,
     editable). Paths are resolved and checked on the MacBook.
   - **Terminals:** a separate switch, off by default.
   - **Revoke:** each side lists its paired machines, with last-seen times and a Revoke button.
6. **Local network only.** The PC listens on its LAN addresses only (not on public interfaces) and
   advertises itself over mDNS only while remote orchestration is enabled. No port is opened on the
   MacBooks.
7. **No secrets cross the network.** Claude, GitHub and MCP credentials stay on each machine. The
   subscription guard runs on the machine where the session runs, so a machine whose Claude Code
   is not signed in with a subscription refuses to run sessions and says why. MCP configs are
   already redacted before they leave the main process.
8. **Audit:** each MacBook logs remote actions locally (session started, approval answered,
   auto-approve toggled, CLAUDE.md saved, terminal opened), viewable in its Symphony.

Libraries (all npm, pure JavaScript, no system install): `ws` for WebSockets; Node's `tls`/`https`
with a custom fingerprint check; `@peculiar/x509` or `selfsigned` to create certificates;
`bonjour-service` for mDNS on both platforms. To confirm in phase 1.

## Setting up a MacBook (within the install constraint)

1. Clone the Symphony repo and run `npm install`. This brings Electron, the macOS Claude Code
   binary (through the Agent SDK) and everything else. One known dependency: `npm install`
   downloads Electron's binary from GitHub, which must not be blocked on that network.
2. `npm start`, then sign in to Claude Code once. If the laptop has no `claude` command, Symphony
   offers "Sign in to Claude" in its own window, which opens its embedded terminal running the
   bundled Claude Code binary with `/login`. This avoids installing the Claude Code CLI.
3. Turn on remote orchestration, pick the PC from the list (found over mDNS) or enter its address,
   and compare the pairing code on both screens.
4. Optional: keep the window closed and the app in the menu bar (`app.dock.hide()`), and start at
   login (`app.setLoginItemSettings`). Neither needs admin rights.

git must be available on the MacBook for the diff counts and viewer. macOS provides it through the
Command Line Tools, which developer laptops normally have. If it is missing, the project node says
"git not available" instead of showing counts.

While a remote machine has sessions or loops running, its Symphony holds `powerSaveBlocker`
(`prevent-app-suspension`) to prevent idle sleep. A closed lid still sleeps the machine, which is
covered by "pause and resume".

## UI changes on the PC

- **Machine nodes.** One root per machine on the graph ("This PC", "MacBook A", "MacBook B"). Each
  has its projects and its `~/.claude` hub (skills, MCP) under it. A connected machine shows its
  name and, on hover, its platform and Symphony version; offline is shown as described above.
- **Machine health.** A remote machine node shows a small battery mark with the percentage when it
  runs on battery, and nothing while it is charging. Below 15% on battery, the label adds
  "battery low · may sleep" in plain text, not orange, because no input is needed. When the
  MacBook goes to sleep, the node reads "asleep" (from the `bye` frame), not "offline".
  - The MacBook reads this with `powerMonitor` (`on-battery`, `on-ac`, `suspend`, `resume`) and
    `pmset -g batt` for the percentage. Both are built into Electron and macOS, need no install,
    and live in `platform.ts`.
  - It sends `health` after hello and whenever the state or a 5% step changes.
- **Pairing.** When a MacBook asks to pair, its machine node appears as the orange square (it needs
  you), and clicking it shows the code to compare, with Accept and Reject.
- **Per-machine controls.** The auto-approve toggle and the GitHub identity sit on each machine
  node; the dock's auto-approve button controls the PC only. The usage meter stays PC-only.
- **Add a project on a MacBook.** The machine node's + opens a folder browser limited to that
  MacBook's shared folders.
- **Panels.** Session (thinking, tool calls, approvals, replies), diff, CLAUDE.md, skill, MCP and
  loop panels work unchanged. Their header shows the machine name when it is not this PC.
- **Remote project nodes** show their machine's name as a small tag under their label, so they
  read as remote even when the graph is zoomed in away from the machine node.
- **Same repo on several machines.** Each copy is its own project node under its own machine, the
  remote one tagged as above. Prompts, loops, diffs and CLAUDE.md act only on the copy they were
  started from.
- **Needs you** list in the dock (see above).

## Implementation phases

Each phase ends with something runnable and checkable.

**Phase 0: core extraction (no behavior change).**
- Move services and handlers from `index.ts` (about 460 lines) into `SymphonyCore`; inject the
  Electron adapters.
- Support several event listeners.
- *Done when:* the app behaves exactly as now.

**Phase 1: link, pairing and a live read-only mirror.**
- PC listener and MacBook dialer, certificates, numeric-comparison pairing on both sides, mDNS
  advertising and discovery.
- Snapshot and event forwarding; machine nodes; offline display.
- Per-machine snapshot merging, with remote usage dropped; the PC-owned layout of remote nodes.
- Read-only enforcement in the remote machine's core and window.
- *Done when:* a second Symphony on the same PC (separate `SYMPHONY_USER_DATA`, remote mode on)
  pairs by code and appears as a machine node. Its sessions show live thinking and tool calls; its
  own window turns read-only with the banner while connected; and killing it turns its subtree into
  the clear offline look.

**Phase 2: the required remote features.**
- Request routing by `machineId`, ID prefixing, and every `InvokeApi` method over the link,
  including the requests without a target.
- The Needs you list and refresh on focus.
- Specifically verified:
  - the prompt pipeline on a remote project, with live thinking
  - answering approvals and questions
  - the per-machine auto-approve toggle
  - the diff viewer
  - viewing and saving CLAUDE.md
  - follow-up replies and loops, including a human step
- *Done when:* all of the above work against the second instance from the first.

**Phase 3: resilience and the rest of today's features.**
- Remote folder browser with shared folders, artifact fetching, skills and MCP panels, config
  sessions on remote skills.
- Reconnect with resync and sequence-gap detection; request IDs, resend and timeouts; the grace
  period and `bye`; revoke lists and the audit log; power-save blocking; version-mismatch handling;
  "Sign in to Claude" through the bundled binary.
- Remote state remembered across PC restarts; machine health.
- *Done when:* cutting the network mid-session and restoring it recovers the view without losing
  or repeating approvals and messages, and revoking a machine refuses its next connection.

**Phase 4: real MacBooks.**
- Both MacBooks set up from the repo only, on different Claude accounts.
- Checked: mDNS discovery on the real network, Keychain login, sleep and wake, Wi-Fi changes, and
  the README's "Still to check on macOS" list.
- *Done when:* both MacBooks appear on the PC, each running sessions on its own account, with
  everything from phase 2 working.

**Phase 5 (optional): remote terminals.** Behind the MacBook's switch, using the existing terminal
panel and `termStart`/`termWrite`/`termResize`.

Rough size: phase 0 small; phases 1 and 2 are the bulk; phases 3 and 4 medium; phase 5 small (the
terminal API already exists).

## Testing strategy

- **Two instances on one PC** cover phases 0–3 without a Mac. `scripts/drive.mjs` already supports
  a separate profile through `SYMPHONY_USER_DATA`; running a second driver on another port lets one
  test script control both the orchestrator and the remote instance.
- **Protocol tests:** request routing (including requests without a target), ID prefixing,
  sequence gaps, oversized frames, version mismatch, a request resent with the same `id` runs once,
  transcript items are not duplicated after a resync, remote `usage` never reaches the PC's state.
- **Control tests:** a link drop keeps the MacBook read-only for the grace period and then frees
  it; Disconnect frees it at once; an approval answered on both sides is applied once.
- **Restart test:** quit the PC while a remote instance is stopped; on restart the machine appears
  offline with its last known state.
- **Security tests:**
  - an unpaired machine is refused at the TLS handshake
  - a changed certificate is refused
  - pairing after the window expires fails
  - a project path outside the shared folders is rejected
  - terminals are refused while switched off
- **Offline tests:** kill the remote instance, block its port, and suspend it. Each time, the
  machine and its subtree must turn offline within 30 seconds, panels become read-only, and
  reconnecting restores the state.
- **Real MacBooks** (phase 4): two accounts, real network.

## Not in this plan

Deliberately left out for now, and not blocked by the design:

- **Clients that join the orchestrator over the internet**, for example a lightweight viewer that
  connects to the PC from outside the local network. The link protocol and pairing would carry
  over, but this needs a reachable endpoint and a different threat model, and is out of scope
  while everything stays on the local network.
- **Overlay networks** such as Tailscale, which need an install on each device.
- **The reverse direction** (a MacBook orchestrating the PC).
- **Interactive MacBook windows during orchestration.** The MacBook's window is read-only while the
  PC is connected; letting both sides act at once would need rules for conflicting answers.
- **Remote usage tracking.** Each machine's usage is its own business; the PC shows only its own.
- **OS notifications** (toasts, taskbar flashing) for waiting items. For now the user is expected to
  keep an eye on the PC's window, where the graph and the Needs you list show every machine. To be
  added later.

Network issues on the restricted laptop (beyond github.com being reachable, which is confirmed)
will be handled when setting it up in phase 4. If mDNS is filtered there, entering the PC's
address in the MacBook's Symphony is the fallback.
