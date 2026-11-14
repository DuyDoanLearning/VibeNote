// "[ ] Buy milk" on its own line (no "- " in front) is a checkbox too: before rendering, such lines get the
// missing "- " so they become a normal task list. Lines inside fenced code are left alone.
export const BARE_TASK = /^(\s*(?:>\s*)*)\[([ xX])\](?=[ \t]+\S)/;

export function bareTasks(md) {
  if (!md.includes('[')) return md;
  let fence = null;
  return md.split('\n').map((line) => {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return line; }
    if (fence) return line;
    return line.replace(BARE_TASK, (_m, lead, mark) => `${lead}- [${mark}]`);
  }).join('\n');
}
