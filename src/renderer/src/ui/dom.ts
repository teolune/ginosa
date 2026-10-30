/** Tiny DOM helpers for the M0 diagnostics shell (React arrives with the workspace in M1). */

type Attrs = Record<string, string | number | boolean | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** A label/value list, used by the diagnostics panels. */
export function definitionList(rows: Array<[string, string | Node]>): HTMLDListElement {
  const list = el('dl', { class: 'kv' })
  for (const [label, value] of rows) {
    list.append(el('dt', { text: label }), el('dd', {}, value))
  }
  return list
}

export function badge(ok: boolean, okText = 'yes', failText = 'no'): HTMLSpanElement {
  return el('span', { class: ok ? 'badge ok' : 'badge no', text: ok ? okText : failText })
}
