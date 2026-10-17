/**
 * Builds an element: h('button', { class: 'primary', 'data-ui': 'PrimaryButton', onclick }, 'Save').
 * Attributes starting with "on" become listeners; children are elements, text, or arrays of them.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false))
  return el
}
