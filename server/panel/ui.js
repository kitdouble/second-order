// Small DOM helpers shared by the in-chat panel and the ESM edit-link page.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style') node.style.cssText = value;
    else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const STATUS = {
  good: ['✓', 'good'],
  warning: ['■', 'warning'],
  critical: ['✕', 'critical'],
};
export const status_ = (kind, label) => el('span', { class: `status ${STATUS[kind][1]}` }, el('i', {}, STATUS[kind][0]), label);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export async function copy(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input?.select();
    return false;
  }
}
