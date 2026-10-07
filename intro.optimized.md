Build Symphony, a desktop app that orchestrates Claude Code sessions across multiple projects on one machine, in this repository (currently empty apart from intro.md). It must run on Windows and macOS.

<context>
Symphony is a visual, node-based harness for Claude Code. Each local project is a node on a graph, and every session and agent working on that project is a node connected to it, so the user can see at a glance what is running where and what needs their attention. The user works by clicking and right-clicking nodes and opening floating views, not by navigating menus.
</context>

<sources>
- The Claude Agent SDK and Claude Code docs on sessions, subagents, permission prompts, hooks, MCP servers and skills. Symphony uses these to start sessions, stream their thinking and tool calls, and answer approvals.
- ~/.claude/skills/optimize-prompt/SKILL.md, the skill used by the prompt pipeline (feature 9). Its reply puts the rewritten prompt in a fenced text block under the "## Optimized prompt" heading. That block is what the second session receives.
- The files Claude Code reads for skills, MCP servers and CLAUDE.md at user level (~/.claude/) and project level (.claude/, .mcp.json, CLAUDE.md). Check the docs for the exact locations instead of guessing.
</sources>

<features>
1. Graph: each project is a node, added by picking a local folder. Each session on that project, and each agent the session spawns, is a node connected to it. Agents appear when they start and disappear when they finish. The user can drag nodes around to arrange the graph.
2. Status: every project, session and agent node shows whether it is working, needs input, needs approval, or has finished. Each state has its own look, defined in <style>. A node that needs the user also shakes, so it gets noticed without anyone reading text.
3. Spawning sessions: right-clicking a project node opens a text box for a prompt plus a Claude model picker. Submitting runs the prompt pipeline (feature 9), which creates the session.
4. Session detail: clicking a session or agent node shows its thinking, tool calls, file changes and approval requests. The user answers approvals and input requests right there. Symphony is meant to be the one place the user works from, so nothing should send them to a terminal.
5. Git diff: each project node shows a +0,000 −0,000 indicator of uncommitted changes. Clicking it opens a floating view that compares the working tree with the last commit, file by file, clearly, the way VS Code's built-in Git diff does.
6. Git identity: using gh, show which GitHub account's credentials each session is using.
7. Skills and MCP: show the available MCP servers with their connection status, and the available skills, as nodes in the same visual language as sessions. Clicking a skill previews its SKILL.md in the same floating viewer component as the git diff. Right-clicking a skill or MCP node opens a floating chat bubble with a model picker. Submitting it starts a session that makes the requested change, editing the markdown and running whatever commands are needed.
8. CLAUDE.md: the user can view and edit each project's CLAUDE.md from its node.
9. Prompt pipeline: every prompt sent from a project node's right-click box first goes to a session that runs /optimize-prompt on it, using the model the user picked. When that session finishes, Symphony automatically starts a new session with the optimized prompt and the same model, with no review step in between. The optimize session's node appears like any other and can be clicked while it runs, then disappears shortly after it finishes. The new session's first message is the optimized prompt, so the user can read it there along with the session's thinking.
</features>

<style>
Dark mode, modern, sleek and clean, built on one rule: color means "you." Everything is monochrome (a charcoal background, bone-white type, greys for structure) except one signal color, either safety orange or signal yellow. That color appears only when the user needs to act. So if the user sees color anywhere, something is waiting for them, and they can read the whole graph's status without reading any text.

- Working: a thin hairline arc rotates around the node, in monochrome.
- Needs input or needs approval: the node fills with the signal color and shakes once, a short damped movement rather than a looping wiggle, so it reads as intentional and not as a glitch. Input and approval differ by shape (a filled square vs a filled diamond), not by a second color. That keeps the rule intact and lets color-blind users tell them apart.
- Finished: the node turns into an outline and fades to 40% opacity.
- The +/− diff counts on project nodes are monochrome type.

Communicate through design instead of text: state, available actions and relationships should be readable from shape, motion, position and that one color. Use labels only where the interface would stop being intuitive without them.

The one exception to the color rule is the diff viewer. It may use muted, desaturated tints to separate added and removed lines, because there VS Code-level readability matters more. Keep those tints clearly dimmer than the signal color.

Avoid these, because they are the defaults that make dark developer tools look generic:
- Color: any second accent color, purple or blue gradients, gradient text.
- Surfaces: glassmorphism, neon glow shadows, cards nested in cards, rounded-2xl cards, borders on every element.
- Type and labels: Inter everywhere, uppercase wide-tracked monospace labels, "01 / 02 / 03" numbering.
- AI and chat: sparkle icons for AI, chat bubbles with avatars, pill buttons.
- Status: toasts, spinners and shimmering skeleton loaders. The node itself carries status.
- Graph: the graph library's default dot-grid background, minimap and zoom controls.
</style>

<decisions>
Already decided: the features and style above, support for Windows and macOS, and that sessions are Claude Code sessions.
Yours to decide: the app stack, how Symphony connects to Claude Code (Agent SDK, CLI, or both), the graph library, the exact greys, and the signal color (safety orange or signal yellow). Record the main choices, the reason for each, and how to run the app in README.md.
</decisions>

<done>
Done when the app launches on this Windows machine and each feature above works end to end against a real local git project. macOS can't be tested here, so keep platform-specific code (paths, shells, process spawning, credential lookup) in one isolated place, and list in README.md what still needs checking on macOS.
</done>
