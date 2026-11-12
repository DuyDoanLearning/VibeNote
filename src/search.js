// Search query language:  words  "exact phrase"  tag:x  book:x  status:x  title:x  is:pinned  -anything (negate)
const KEYS = ['tag', 'book', 'notebook', 'status', 'title', 'is'];

export function parseQuery(s) {
  const out = [];
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m;
  while ((m = re.exec(s))) {
    const neg = !!m[1];
    let key = (m[2] || '').toLowerCase();
    let val = (m[3] ?? m[4] ?? '').toLowerCase();
    if (key && !KEYS.includes(key)) { val = `${key}:${val}`; key = ''; }
    if (val) out.push({ neg, key, val });
  }
  return out;
}

function test(n, { key, val }) {
  switch (key) {
    case 'tag': return n.meta.tags.some((t) => t.toLowerCase() === val);
    case 'book':
    case 'notebook': {
      if (val === 'inbox') return !n.notebook;
      const nb = n.notebook.toLowerCase();
      return nb === val || nb.startsWith(val + '/') || nb.split('/').includes(val);
    }
    case 'status': return n.meta.status === val.replace(/[\s_-]/g, '') || (val === 'none' && !n.meta.status);
    case 'title': return n.title.toLowerCase().includes(val);
    case 'is':
      if (val === 'pinned') return n.meta.pinned;
      if (val === 'untagged') return !n.meta.tags.length;
      return false;
    default: return (n.title + '\n' + n.body).toLowerCase().includes(val);
  }
}

export function matchQuery(n, terms) {
  return terms.every((t) => (t.neg ? !test(n, t) : test(n, t)));
}

// Small fuzzy scorer for the command palette: substring beats subsequence, earlier beats later.
export function fuzzy(text, q) {
  if (!q) return 1;
  const s = text.toLowerCase();
  q = q.toLowerCase();
  const i = s.indexOf(q);
  if (i >= 0) return 1000 - i - s.length * 0.01;
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, pos);
    if (j < 0) return -1;
    gaps += j - pos;
    pos = j + 1;
  }
  return 500 - gaps - s.length * 0.01;
}
