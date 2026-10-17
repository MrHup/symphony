import { h } from '../lib/dom.js'

/** A placeholder until the recipe's own screens exist. */
export default function home() {
  return h('main', { class: 'placeholder', 'data-screen': 'Home' }, h('p', {}, 'Building the app…'))
}
