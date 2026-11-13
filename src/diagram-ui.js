// Diagrams: open .drawio files in the bundled draw.io editor (a frame with its own origin), save as you draw,
// and reload when the file changes on disk (e.g. Claude edited it). Spec: docs/workspace-spec.md, step 2.
const ICON = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v6M6.5 12h11v3"/></svg>';

export function createDiagramUI(ctx) {
  const { api, S, $, el, toast, isDark, leaveCurrent, closeNote, afterChange } = ctx;
  S.diagram = null; // path of the open diagram
  S.diagrams = { notes: [], recent: [] };
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const view = $('#diagram-view');
  view.innerHTML = `
    <div class="dg-head">
      <span class="ico">${ICON}</span>
      <span class="dg-title"></span>
      <span class="dg-path"></span>
      <span class="spacer"></span>
      <span class="dg-status"></span>
      <button class="ph-small dg-reveal" title="Show the file in Finder">Reveal</button>
      <button class="ph-small dg-external" title="Open this file in the draw.io app">Open in draw.io</button>
      <button class="icon dg-close" title="Close the diagram"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="dg-body"><div class="dg-msg"></div></div>`;
  const body = $('.dg-body', view);
  const msg = $('.dg-msg', view);
  const status = $('.dg-status', view);

  let frame = null;
  let ready = false; // the editor sent "init"
  let dark = null;
  let lastXml = ''; // what the editor and the file agree on
  let pending = null; // xml waiting to be loaded once the editor is ready
  let saveTimer = null;
  let saving = Promise.resolve();

  const post = (m) => frame?.contentWindow?.postMessage(JSON.stringify(m), '*');
  const say = (text) => { msg.textContent = text || ''; msg.hidden = !text; };

  function ensureFrame() {
    if (frame && dark === isDark()) return;
    frame?.remove();
    ready = false;
    dark = isDark();
    frame = document.createElement('iframe');
    frame.className = 'dg-frame';
    // embed + JSON messages; stealth: no outside services (the frame's policy blocks them anyway); we save
    // automatically, so no Save/Exit buttons. Not "offline=1": that mode swaps in cramped dialogs (e.g. More Shapes).
    frame.src = `vibe-drawio://app/index.html?embed=1&proto=json&spin=1&stealth=1&pwa=0&libraries=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&lang=en&dark=${dark ? 1 : 0}`;
    body.append(frame);
  }

  function load(xml) {
    lastXml = xml;
    if (!ready) { pending = xml; return; }
    post({ action: 'load', xml, autosave: 1, modified: 'unsavedChanges', title: S.diagram ? S.diagram.split('/').pop() : '' });
  }

  function write(xml) {
    if (!S.diagram || xml === lastXml) return;
    const path = S.diagram;
    lastXml = xml;
    status.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saving = saving.then(async () => {
        try {
          await api.diagrams.write(path, xml);
          if (S.diagram === path) { status.textContent = 'Saved'; post({ action: 'status', modified: false }); }
        } catch (e) {
          status.textContent = 'Not saved';
          toast('Could not save the diagram: ' + errText(e));
        }
      });
    }, 400);
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === 'init') {
      ready = true;
      say('');
      if (pending != null) { const x = pending; pending = null; load(x); }
    } else if ((m.event === 'autosave' || m.event === 'save') && typeof m.xml === 'string') {
      write(m.xml);
      if (m.event === 'save') post({ action: 'status', modified: false });
    }
  });

  // The file changed on disk (Claude, the draw.io app, git…): show the new version.
  api.diagrams.onChanged(async (path) => {
    if (path !== S.diagram) return;
    await saving;
    try {
      const { xml } = await api.diagrams.read(path);
      if (xml === lastXml) return;
      load(xml);
      toast('The diagram changed on disk — showing the new version');
    } catch {}
  });

  async function open(path) {
    if (!(await api.diagrams.available())) return toast('The diagram editor isn’t part of this build (it is downloaded when the app is built).');
    await leaveCurrent();
    ctx.beforeOpen?.();
    await saving;
    let data;
    try { data = await api.diagrams.read(path); } catch (e) { return toast(errText(e)); }
    closeNote();
    S.diagram = path;
    document.body.classList.add('diagram-open');
    $('.dg-title', view).textContent = path.split('/').pop().replace(/\.drawio$/i, '');
    $('.dg-path', view).textContent = path.slice(0, path.lastIndexOf('/')).replace(/^\/Users\/[^/]+/, '~');
    $('.dg-path', view).title = path;
    status.textContent = '';
    if (!ready) say('Opening the diagram editor…');
    ensureFrame();
    load(data.xml);
    afterChange();
  }

  // quiet: another view is taking over (a note, a project home) and renders itself
  async function close(quiet) {
    if (!S.diagram) return;
    await new Promise((r) => setTimeout(r, saveTimer ? 450 : 0)); // let a save that is about to start go out
    await saving;
    S.diagram = null;
    document.body.classList.remove('diagram-open');
    api.diagrams.close();
    if (!quiet) afterChange();
  }

  async function reload() {
    try { S.diagrams = await api.diagrams.list(); } catch { S.diagrams = { notes: [], recent: [] }; }
  }

  function renderSide() {
    const box = $('#diagrams');
    if (!box) return;
    box.textContent = '';
    const row = (d, sub) => {
      const b = el('button', 'nav-item');
      const ico = el('span', 'ico');
      ico.innerHTML = ICON;
      b.append(ico, el('span', 'label', d.name));
      if (sub) b.append(el('span', 'count', sub));
      b.title = d.path;
      b.classList.toggle('active', S.diagram === d.path);
      b.addEventListener('click', () => open(d.path));
      b.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const id = await api.popup([{ id: 'reveal', label: 'Reveal in Finder' }, { id: 'ext', label: 'Open in draw.io' }, ...(d.folder ? [{ type: 'separator' }, { id: 'forget', label: 'Remove from This List' }] : [])]);
        if (id === 'reveal') api.diagrams.reveal(d.path);
        if (id === 'ext') api.diagrams.openExternal(d.path);
        if (id === 'forget') { await api.diagrams.forget(d.path); await reload(); renderSide(); }
      });
      box.append(b);
    };
    const notes = [...S.diagrams.notes].sort((a, b) => b.mtime - a.mtime);
    for (const d of notes) row(d, d.notebook ? d.notebook.split('/').pop() : '');
    for (const d of S.diagrams.recent.filter((r) => !notes.some((n) => n.path === r.path))) row(d, d.folder.split('/').pop());
    if (!box.childElementCount) box.append(el('div', 'hint', 'Click + to draw a diagram or open a .drawio file.'));
  }

  async function create(notebook) {
    try {
      const p = await api.diagrams.create(notebook || '', '');
      await reload();
      renderSide();
      await open(p);
    } catch (e) { toast(errText(e)); }
  }

  async function pick() {
    const p = await api.diagrams.pick();
    if (!p) return;
    await reload();
    renderSide();
    await open(p);
  }

  async function addMenu(notebook) {
    const id = await api.popup([{ id: 'new', label: notebook ? `New Diagram in “${notebook.split('/').pop()}”` : 'New Diagram' }, { id: 'pick', label: 'Open Diagram File…' }]);
    if (id === 'new') create(notebook);
    if (id === 'pick') pick();
  }

  $('.dg-close', view).addEventListener('click', () => close());
  $('.dg-reveal', view).addEventListener('click', () => S.diagram && api.diagrams.reveal(S.diagram));
  $('.dg-external', view).addEventListener('click', () => S.diagram && api.diagrams.openExternal(S.diagram));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!S.diagram || dark === isDark()) return;
    const x = lastXml;
    ensureFrame();
    load(x);
  });

  return { open, close, reload, renderSide, create, pick, addMenu };
}
