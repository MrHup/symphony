// The app's entry: a hash router that shows one screen at a time, with a view transition between
// screens. A route is "#/<screen>[/<more>][?state=<state>&...]", so every screen, view and state can be
// opened directly (by the phone preview after a reload, and by capture_screens for the docs).
import screens from './screens/index.js'

const root = document.getElementById('app')
let current = null

/** The current route: the screen's name, the rest of the path, and the query (state among it). */
export function route(hash = location.hash) {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const [name, ...rest] = path.split('/').filter(Boolean)
  const params = Object.fromEntries(new URLSearchParams(query))
  return { name: name && screens[name] ? name : Object.keys(screens)[0], rest, params, state: params.state ?? null }
}

/** Go to a route, e.g. go('profile') or go('#/profile?state=editing'). */
export function go(to) {
  location.hash = to.startsWith('#') ? to : `#/${to}`
}

function render() {
  const r = route()
  const show = () => {
    current?.cleanup?.()
    const view = screens[r.name]({ ...r, go })
    current = view instanceof Node ? { el: view } : view
    root.replaceChildren(current.el)
  }
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(show)
  else show()
}

addEventListener('hashchange', render)
render()
