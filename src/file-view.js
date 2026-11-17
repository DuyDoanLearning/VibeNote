// Files kept as they are — PDF, Word (.docx), Excel (.xlsx) — shown in the main area instead of the editor.
// - PDF: the bundled pdf.js viewer in its own frame (vibe-pdf://, main.js → servePdfViewer). Its highlight / draw /
//   comment tools work; changes are saved back into the PDF automatically (files:save-pdf keeps the original once).
// - Word: converted to HTML with mammoth (pictures included), cleaned with DOMPurify, shown read-only.
//   "Make a note from it" turns it into a Markdown note you can highlight and edit.
// - Excel: every sheet as a table (read-excel-file). "Make a note from this sheet" turns it into a Markdown table.
// The file itself is never changed by Word/Excel viewing; "Open in Word / Excel / Preview" opens the real app.
import DOMPurify from 'dompurify';

const pdfUrl = (file) => `vibe-pdf://viewer/web/viewer.html?file=${encodeURIComponent('/doc' + file.split('/').map(encodeURIComponent).join('/'))}`;
const APP_NAME = { pdf: 'Preview', docx: 'Word', xlsx: 'Excel' };
const MAX_ROWS = 2000;
const MAX_COLS = 60;

export function createFileView({ api, container, el, toast, onSaved, toMarkdown, makeNote }) {
  let shown = null; // { path, kind, seq }
  let wanted = null; // the file asked for last (show() is called often; only the newest call builds the view)
  let frame = null;
  let pdfReady = null;
  let flushes = new Map();
  let flushId = 0;

  addEventListener('message', async (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data?.vibePdf) return;
    const m = e.data;
    if (m.vibePdf === 'save' && shown?.kind === 'pdf') {
      try {
        await api.files.savePdf(shown.path, m.data);
        onSaved?.();
      } catch (err) {
        toast('Couldn’t save your highlights: ' + String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 6000);
      }
    } else if (m.vibePdf === 'error') {
      toast('The PDF viewer couldn’t save: ' + m.message, 6000);
    } else if (m.vibePdf === 'flushed') {
      flushes.get(m.id)?.();
      flushes.delete(m.id);
    }
  });

  function bar(n, extra = []) {
    const b = el('div', 'fv-bar');
    b.append(el('span', `fv-kind k-${n.kind}`, { pdf: 'PDF', docx: 'Word', xlsx: 'Excel' }[n.kind]), ...extra, el('span', 'fv-spacer'));
    const open = el('button', 'fv-btn', `Open in ${APP_NAME[n.kind]}`);
    open.addEventListener('click', () => api.files.open(n.path));
    b.append(open);
    return b;
  }

  async function showPdf(n, seq) {
    pdfReady ??= api.files.pdfAvailable();
    const ok = await pdfReady;
    if (seq !== shown?.seq) return;
    if (!ok) {
      container.append(bar(n), el('div', 'fv-msg', 'The PDF viewer is not part of this build (it is downloaded when VibeNote is built). Use “Open in Preview”.'));
      return;
    }
    frame = document.createElement('iframe');
    frame.className = 'fv-frame';
    frame.title = 'PDF viewer';
    frame.src = pdfUrl(n.path);
    container.append(frame);
  }

  async function showDocx(n, seq) {
    const body = el('div', 'fv-doc markdown');
    body.textContent = 'Opening…';
    const importBtn = el('button', 'fv-btn primary', 'Make a note from it');
    container.append(bar(n, [importBtn]), body);
    try {
      const { default: mammoth } = await import('mammoth');
      const bytes = await api.files.read(n.path);
      const res = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      if (seq !== shown?.seq) return;
      const html = DOMPurify.sanitize(res.value, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
      body.innerHTML = html || '<p class="fv-msg">This document is empty.</p>';
      importBtn.addEventListener('click', () => makeNote(n, toMarkdown(html), { file: n.path.split('/').pop() }));
    } catch (err) {
      if (seq !== shown?.seq) return;
      body.textContent = 'Couldn’t read this Word file: ' + String(err?.message || err);
      importBtn.disabled = true;
    }
  }

  async function showXlsx(n, seq) {
    const tabs = el('div', 'fv-tabs');
    const importBtn = el('button', 'fv-btn primary', 'Make a note from this sheet');
    const body = el('div', 'fv-sheet');
    body.textContent = 'Opening…';
    container.append(bar(n, [tabs, importBtn]), body);
    let sheets;
    try {
      const { default: readXlsxFile } = await import('read-excel-file/universal');
      const bytes = await api.files.read(n.path);
      sheets = await readXlsxFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch (err) {
      if (seq !== shown?.seq) return;
      body.textContent = 'Couldn’t read this Excel file: ' + String(err?.message || err);
      importBtn.disabled = true;
      return;
    }
    if (seq !== shown?.seq) return;
    let cur = 0;
    const cell = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 16 : 10).replace('T', ' ') : String(v));
    const draw = () => {
      tabs.textContent = '';
      sheets.forEach((s, i) => {
        const t = el('button', `fv-tab${i === cur ? ' on' : ''}`, s.sheet);
        t.addEventListener('click', () => { cur = i; draw(); });
        tabs.append(t);
      });
      const rows = sheets[cur]?.data || [];
      body.textContent = '';
      if (!rows.length) { body.append(el('div', 'fv-msg', 'This sheet is empty.')); return; }
      const table = el('table', 'fv-table');
      rows.slice(0, MAX_ROWS).forEach((r, i) => {
        const tr = el('tr');
        tr.append(el(i ? 'td' : 'th', 'fv-rn', String(i + 1)));
        r.slice(0, MAX_COLS).forEach((v) => tr.append(el(i ? 'td' : 'th', typeof v === 'number' ? 'num' : '', cell(v))));
        table.append(tr);
      });
      body.append(table);
      if (rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_COLS)) body.append(el('div', 'fv-msg', `Showing the first ${MAX_ROWS} rows and ${MAX_COLS} columns. Open in Excel for the rest.`));
    };
    draw();
    importBtn.addEventListener('click', () => {
      const s = sheets[cur];
      const rows = (s?.data || []).filter((r) => r.some((v) => v != null && v !== ''));
      if (!rows.length) return toast('This sheet is empty.');
      const width = Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length)));
      const esc = (v) => cell(v).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => esc(r[i])).join(' | ')} |`;
      const md = [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1, MAX_ROWS).map(line)].join('\n');
      makeNote(n, md + '\n', { file: n.path.split('/').pop(), sheet: s.sheet }, `${n.title} — ${s.sheet}`);
    });
  }

  return {
    async show(n) {
      if (wanted === n.path) return;
      wanted = n.path;
      await this.flush(); // the previous PDF's unsaved highlights
      if (wanted !== n.path) return; // another file was asked for meanwhile
      this.clear();
      wanted = n.path;
      shown = { path: n.path, kind: n.kind, seq: Math.random() };
      if (n.kind === 'pdf') await showPdf(n, shown.seq);
      else if (n.kind === 'docx') await showDocx(n, shown.seq);
      else if (n.kind === 'xlsx') await showXlsx(n, shown.seq);
    },
    // Save highlights that haven't been saved yet (before leaving a PDF). Waits up to 3 s.
    flush() {
      if (!frame || shown?.kind !== 'pdf') return Promise.resolve();
      const id = ++flushId;
      return new Promise((resolve) => {
        const t = setTimeout(() => { flushes.delete(id); resolve(); }, 3000);
        flushes.set(id, () => { clearTimeout(t); resolve(); });
        frame.contentWindow.postMessage({ vibePdf: 'flush', id }, '*');
      });
    },
    clear() {
      shown = null;
      wanted = null;
      frame = null;
      flushes.forEach((f) => f());
      flushes = new Map();
      container.textContent = '';
    },
    current: () => shown?.path || null,
  };
}
