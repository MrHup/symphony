---
name: mobile-ui-recipe
description: How to build and change a Mobile UI recipe in this folder, a working web replica of a mobile app (app/) and its documentation (docs/RECIPE.md and docs/screens/). Use it for every change to this folder.
---

# Mobile UI recipe

A recipe has two parts:

- **app/**: a working replica of the mobile app that runs in a phone's browser, full screen, and feels like the installed app.
- **docs/**: one Markdown file, `docs/RECIPE.md`, that describes everything in the app, plus a screenshot of every screen, view and state in `docs/screens/`.

The user reviews the app on their phone and sends comments from there. Each comment starts a new session with the selected component or view, its route and a screenshot.

## Stack

- Plain HTML, CSS and JavaScript modules. No build step, no npm, no framework, no CDN: the files in app/ are served as they are, and the app must work without a network.
- `app/index.html` loads `base.css` (keep it), `app.css` (your styles), the Rive runtime and `main.js`.
- `app/main.js` is the router. A route is `#/<screen>[/<more>][?state=<state>]`. Register screens in `app/screens/index.js`; the first one is the start screen.
- A screen is `export default function ({ state, params, rest, go })` in `app/screens/<name>.js`. It returns an element, or `{ el, cleanup }` when it starts timers or animations. Build elements with `h()` from `app/lib/dom.js`, or with template strings when that reads better.
- Shared components go in `app/components/`, sample data in `app/data.js` (realistic, never lorem ipsum), images, fonts and `.riv` files in `app/assets/`.

## Every screen, view and state has a route

The preview reloads after each change and returns to the route it showed, and screenshots are taken by route. So:

- Tabs, sheets, dialogs, menus and steps of a flow are routes too (`#/home/filters`, `#/checkout/2`).
- States are `?state=` values: `empty`, `loading`, `error`, `success`, `editing`, and whatever else the app has. A screen shows that state directly when it is in the route.
- Navigate with `go()` so the route always matches what is on screen.

## Name what the user can select

The user selects things on their phone by tapping them, and their comment names what they selected:

- Every screen's root element has `data-screen="ScreenName"`.
- Every component's root element has `data-ui="ComponentName"` (`PrimaryButton`, `TaskCard`, `TabBar`). Use the same name for every instance of a component.
- Keep these names stable when you change things: comments and the docs refer to them.

## Feel like an installed app

- Design for 390×844 CSS pixels and work from 360 to 430 wide. Respect `--safe-top` and `--safe-bottom` (the notch and home indicator).
- Touch targets at least 44×44. Nothing depends on hover. Use the platform's conventions (iOS or Android, whichever the app is, or the source app's).
- Animate only `transform` and `opacity`, with eased curves such as `cubic-bezier(.2, .8, .2, 1)`, 150 to 350 ms. Screen changes use the router's view transition; give shared elements a `view-transition-name` when it helps. Add press feedback to buttons. Keep `prefers-reduced-motion` working (base.css does).
- Scroll only inside the screen's content area, not the whole page.
- No console errors. `capture_screens` reports the page's errors: fix every one.

## Rive

The Rive runtime is in `app/vendor/rive/` and loads offline. Play a `.riv` file with `riveAnimation(canvas, 'assets/name.riv', { stateMachines: 'Name' })` from `app/lib/rive.js`, and call `instance.cleanup()` in the screen's cleanup. You cannot create `.riv` files: use the ones from the source app or the user's, and use CSS animations otherwise. Document each `.riv` file's artboards, state machines and inputs.

## docs/RECIPE.md

One file that someone could rebuild the app from, without running it:

1. **Overview**: what the app is, its platform conventions, and the source it was built from.
2. **Design tokens**: colors, typography, spacing, radii, shadows, motion (durations and curves), as tables with their CSS variable names.
3. **Components**: each `data-ui` name, what it is, its variants and states, and its screenshot.
4. **Screens**: each route, with its purpose, layout, components, states, where it navigates and how it animates, and a screenshot of every state.
5. **Flows**: the paths through the app, step by step.
6. **Assets**: images, fonts and Rive files, where they came from, and how they are used.

Take the screenshots with the `capture_screens` tool: one per screen, view and state, named `<screen>` or `<screen>--<state>` (`home`, `home--empty`, `home-filters`). Reference them from RECIPE.md as `![Home, empty](screens/home--empty.png)`.

## Changing the recipe after a comment

- Change only what the comment asks for, in the style of what is there.
- Then update the parts of RECIPE.md that describe what you changed, and recapture the screenshots of the screens and states you changed (and remove those of screens that no longer exist).

## Never

- Never change anything in the source app's folder; only read it.
- Never load anything from the network (CDNs, fonts, images, APIs).
- Never remove `base.css`, the router, or the Rive runtime.
