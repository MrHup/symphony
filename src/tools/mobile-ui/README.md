# Mobile UI

Mobile UI makes a **UI recipe** of a mobile app and shows it on your phone, where you review it full
screen and ask Claude to change it.

A recipe has two parts:

- **A working replica of the app** in `app/`: plain HTML, CSS and JavaScript that runs in the phone's
  browser like an installed app, with smooth animations and the Rive runtime for `.riv` animations.
- **Its documentation** in `docs/`: one Markdown file, `RECIPE.md`, that describes everything (design
  tokens, components, screens, states, flows, assets), and a screenshot of every screen, view and state
  in `docs/screens/`.

You start a recipe from a prompt alone, or from an existing app's folder plus a prompt (Claude rebuilds
your app, then applies the prompt; it only reads your folder).

## Prepare

On the machine the recipe runs on (this PC, or a remote machine):

- **Google Chrome or Microsoft Edge.** Screenshots (for the docs, and of what you comment on) are taken
  in a headless browser through Playwright, which uses the installed browser. Set `SYMPHONY_BROWSER` to
  the path of another Chromium-based browser to use that instead. Without one, recipes still work, but
  comments arrive without a screenshot and the docs have none.
- Nothing else: no API keys, no Flutter or Xcode. Sessions run on your Claude subscription like any
  other.

On the machine with Symphony's window (where you scan the QR code):

- **Your phone on the same network.** The preview server listens on port 47822 on this machine's
  local-network addresses. Windows asks once to let Symphony through its firewall.

On the phone, once (see "The phone" below): trust the preview's certificate, then add the preview to the
home screen.

## Use

1. Click the tools button on a machine node (This PC, or a remote machine) and pick **Mobile UI**. The
   recipe, its files and its sessions live on that machine.
2. Describe the app, optionally pick a project to build from (on this PC, **Add a folder…** adds one),
   pick a model, and **Create recipe**. A session builds the app and its docs; it appears on the graph
   under the recipe's project, like any other session.
3. **Preview on phone** shows a QR code and the link. Scan it.
4. On the phone, tap the tab on the right edge (drag it to move it), then tap what your comment is about:
   a component, **Wider** for what contains it, or **Whole view** (drag the bar at the top by its
   label to uncover what is under it). Write what should change and **Send to Claude**.
5. Each comment starts a new session on the recipe's machine, shown on the graph under the recipe.
   The top of the phone's screen says while Claude works, and the app reloads on the same screen once
   it is done. If the session asks for approval or a question, answer it in Symphony.
6. **Docs** in the panel shows `RECIPE.md` with its screenshots. **Stop preview** turns the link off.

A comment gives its session:

- your text,
- what you selected: whether it is a component or the whole view, its `data-ui` or `data-screen` name,
  a CSS selector, its text and its markup (shortened),
- the route the app showed and the phone's screen size,
- a screenshot of that view at the phone's size with the selection outlined, and any errors the page
  raised.

After each change, the session also updates the parts of `RECIPE.md` and the screenshots it changed, so
the documentation always matches the app.

## The phone

The preview is served over HTTPS, so the phone treats it as a secure site: it can be installed as an
app that opens full screen without the browser's bars. That needs the phone to trust Symphony's preview
certificate, once per phone and orchestrating machine:

1. Open the link and accept the certificate warning.
2. Tap **this certificate** in the preview's banner to download it.
3. Trust it:
   - **iPhone:** Settings › General › VPN & Device Management › install the profile, then Settings ›
     General › About › Certificate Trust Settings › turn on "Symphony phone preview".
   - **Android:** Settings › Security › Encryption & credentials › Install a certificate › CA
     certificate › pick the downloaded file. (Menu names vary by maker.)
4. Reload the preview (no warning now), then add it to the home screen: **Share › Add to Home Screen**
   on iPhone, **⋮ › Install app** (or Add to Home screen) on Android. Open it from there.

Without these steps the preview still works in the browser; **Full screen now** in the banner hides
the browser's bars on Android.

The certificate can only vouch for private network addresses (10.x, 172.16–31.x, 192.168.x,
169.254.x), so trusting it lets nothing else on the internet impersonate a site. Its key stays on the
machine with the window, encrypted by the OS.

## How it works

- **Where things are.** Recipes live in Symphony's data folder on their machine, under
  `tools/mobile-ui/<name>/`. Each recipe folder is added as a project there, so its sessions, CLAUDE.md
  and terminal work like any project's. Deleting a recipe in the panel removes its folder, its project
  and its sessions.
- **The recipe folder:** `app/` (served to the phone), `docs/RECIPE.md` and `docs/screens/`, and
  `.claude/skills/mobile-ui-recipe/SKILL.md`, the rules every session follows (stack, routes, names,
  motion, docs). The starter app has a hash router (`#/<screen>?state=<state>`, so every screen, view
  and state can be opened and captured directly), `base.css` for the installed-app feel, and the Rive
  runtime in `app/vendor/rive/`. Nothing is loaded from the network.
- **Agent tool.** Recipe sessions have `capture_screens`: screenshots of routes at the phone's size,
  saved to `docs/screens/`, with any errors the page raised.
- **Remote machines.** The phone always talks to the machine with Symphony's window. When the recipe is
  on a remote machine, that machine serves the files and runs the sessions, and the preview server
  relays to it over the existing link, so the remote machine still opens no port and the phone trusts
  one certificate.
- **Least exposure.** The preview server runs only while a preview is open, listens only on loopback
  and private or link-local addresses, and answers only paths that begin with the preview's secret
  (256 random bits). **Stop preview** ends the link for good; the next preview gets a new one. Links
  survive a restart of Symphony, but the server stays off until you open a preview again. On a remote
  machine, every comment is in the audit log.
- **Live reload.** The recipe's machine watches `app/`; the phone gets the change over server-sent
  events and reloads once the sessions working on the recipe have finished, on the route it showed.

## Code

| Path | Role |
|---|---|
| `core.ts` | On the recipe's machine: recipes, their sessions and folders, files for the preview, `capture_screens` |
| `capture.ts` | Screenshots in a headless browser, with the app served through request routing (no socket) |
| `local.ts` | On the window's machine: the HTTPS preview server, QR codes, relaying files and comments |
| `cert.ts` | The preview certificate authority and the server certificate it signs |
| `phone/` | The page the phone opens: the app in a frame, selection, comments, live reload |
| `template/`, `skill/` | The starter app and the skill copied into each recipe |
| `Panel.tsx`, `panel.css` | The panel in Symphony |
| `types.ts` | Types shared by all of the above |
