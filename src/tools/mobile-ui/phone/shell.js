// The phone side of a Mobile UI preview: the recipe's app full screen in a frame, a handle on the right
// edge to comment on a component or a whole view, and a live link to Symphony that reloads the app
// (on the route it showed) once the sessions working on it finish.
;(() => {
  const $ = (id) => document.getElementById(id)
  const frame = $('app')
  const pick = $('pick')
  const mark = $('mark')
  const sheet = $('sheet')
  const text = $('text')
  const handle = $('handle')
  const status = $('status')
  let version = null
  let reloadWhenDone = false
  let target = null
  let note = ''
  let flashTimer = 0
  const seen = {}

  // Every preview on this address shares the storage; the route is kept per preview.
  const routeKey = `route:${location.pathname}`
  const doc = () => frame.contentDocument
  const route = () => {
    try {
      return frame.contentWindow.location.hash
    } catch {
      return ''
    }
  }

  // ---------- the app ----------

  const load = (hash) => {
    frame.src = `app/index.html?v=${version}${hash || ''}`
  }
  frame.addEventListener('load', () => {
    const save = () => sessionStorage.setItem(routeKey, route())
    save()
    frame.contentWindow.addEventListener('hashchange', save)
  })

  // ---------- status ----------

  const show = (line) => {
    note = line
    if (!flashTimer) render(line)
  }
  const flash = (line) => {
    clearTimeout(flashTimer)
    render(line)
    flashTimer = setTimeout(() => {
      flashTimer = 0
      render(note)
    }, 3000)
  }
  const render = (line) => {
    status.textContent = line
    status.hidden = !line
  }

  const events = new EventSource('events')
  events.onopen = () => show('')
  events.onerror = () => show('Symphony is not reachable. Retrying…')
  events.onmessage = (m) => {
    const s = JSON.parse(m.data)
    if (s.error) return show(s.error)
    document.title = s.name
    const working = s.sessions.filter((x) => x.status === 'working')
    const asking = s.sessions.filter((x) => x.status === 'approval' || x.status === 'input')
    for (const x of s.sessions) {
      if (seen[x.id] === 'working' && x.status === 'finished') flash(`Done: ${x.title}`)
      seen[x.id] = x.status
    }
    show(asking.length ? 'Claude needs you in Symphony' : working.length ? `Claude is working: ${working[0].title}` : '')
    if (version === null) {
      version = s.version
      load(sessionStorage.getItem(routeKey))
    } else if (s.version !== version) {
      version = s.version
      reloadWhenDone = true
    }
    // Files change while a session works; the app reloads once, when it is done.
    if (reloadWhenDone && !working.length) {
      reloadWhenDone = false
      load(route())
    }
  }

  // ---------- choosing what a comment is about ----------

  const view = () => doc().querySelector('[data-screen]') || doc().body
  const nameOf = (el) => el.getAttribute('data-ui') || el.getAttribute('data-screen') || ''

  const outline = (el) => {
    const r = el.getBoundingClientRect()
    Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    mark.hidden = false
  }

  const at = (e) => {
    const el = doc().elementFromPoint(e.clientX, e.clientY)
    return el && el !== doc().documentElement && el !== doc().body ? el.closest('[data-ui]') || el : null
  }

  const choose = (el, kind) => {
    target = { el, kind }
    outline(el)
    pick.hidden = true
    const name = nameOf(el)
    const words = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    $('target').textContent = kind === 'view' ? `Whole view${name ? `: ${name}` : ''}` : name || `${el.localName}${words ? ` "${words}"` : ''}`
    $('parent').hidden = kind === 'view'
    sheet.hidden = false
    text.focus()
  }

  const close = () => {
    sheet.hidden = true
    pick.hidden = true
    mark.hidden = true
    handle.hidden = false
    target = null
  }

  const startPick = () => {
    if (!doc()) return
    close()
    handle.hidden = true
    pick.hidden = false
  }

  pick.addEventListener('pointermove', (e) => {
    const el = e.target === pick && at(e)
    if (el) outline(el)
  })
  pick.addEventListener('click', (e) => {
    const el = e.target === pick && at(e)
    if (el) choose(el, 'component')
  })
  $('pick-view').onclick = () => choose(view(), 'view')
  $('pick-cancel').onclick = close
  $('cancel').onclick = close
  $('parent').onclick = () => {
    const up = target.el.parentElement
    const next = up && (up.closest('[data-ui], [data-screen]') || up)
    if (!next || next === doc().body || next === doc().documentElement || next.hasAttribute('data-screen')) choose(view(), 'view')
    else choose(next, 'component')
  }

  /** A CSS selector for the element, through data-ui and data-screen names where it can. */
  const selectorOf = (el) => {
    const parts = []
    for (let e = el; e && e.nodeType === 1 && e !== doc().documentElement; e = e.parentElement) {
      if (e.id) {
        parts.unshift(`#${CSS.escape(e.id)}`)
        break
      }
      let part = e.localName
      const attr = e.hasAttribute('data-ui') ? 'data-ui' : e.hasAttribute('data-screen') ? 'data-screen' : ''
      if (attr) part += `[${attr}="${e.getAttribute(attr)}"]`
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === e.localName) : []
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`
      parts.unshift(part)
    }
    return parts.join(' > ')
  }

  sheet.addEventListener('submit', async (e) => {
    e.preventDefault()
    const { el, kind } = target
    const body = {
      text: text.value,
      route: route(),
      viewport: { width: innerWidth, height: innerHeight },
      target: { kind, selector: selectorOf(el), name: nameOf(el) || undefined, html: el.outerHTML.slice(0, 4000), text: (el.innerText || '').trim().slice(0, 400) }
    }
    $('send').disabled = true
    try {
      const res = await fetch('comment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error((await res.text()) || res.statusText)
      text.value = ''
      close()
      flash('Sent to Claude')
    } catch (err) {
      flash(`Not sent: ${err.message}`)
    } finally {
      $('send').disabled = false
    }
  })

  // ---------- the handle: tap to comment, drag to move it out of the way ----------

  const saved = Number(localStorage.getItem('handle'))
  if (saved) handle.style.top = `${saved}px`
  let drag = null
  let dragged = false
  handle.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, top: handle.offsetTop }
    dragged = false
    handle.setPointerCapture(e.pointerId)
  })
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dy = e.clientY - drag.y
    if (Math.abs(dy) > 6) dragged = true
    if (!dragged) return
    const top = Math.min(innerHeight - 80, Math.max(40, drag.top + dy))
    handle.style.top = `${top}px`
    localStorage.setItem('handle', String(top))
  })
  handle.addEventListener('pointerup', () => (drag = null))
  // On click, not pointerup: the tap's own click must not land on the layer it opens.
  handle.addEventListener('click', () => !dragged && startPick())

  // ---------- installing ----------

  const standalone = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone
  const closeSetup = () => {
    $('setup').hidden = true
    localStorage.setItem('setup-closed', '1')
  }
  if (!standalone && !localStorage.getItem('setup-closed')) $('setup').hidden = false
  $('fullscreen').hidden = !document.documentElement.requestFullscreen
  $('fullscreen').onclick = () => {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
    closeSetup()
  }
  $('setup-close').onclick = closeSetup
  // Installable as an app once the certificate is trusted; the worker caches nothing.
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => undefined)
})()
