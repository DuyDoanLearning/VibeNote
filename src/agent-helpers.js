// Helper agents (subagents started with the Task / Agent tool) in the Claude panel:
// - a live line under the helper's row: running / done, steps, what it's doing now, tokens, time
// - a strip above the chat listing the helpers still working
// - a view you open by clicking a helper: what it was asked, every step it took (with results) and its report.

const RUNNING = 'running';

export function createHelpers({ root, log, el, md, toolSummary, resultSummary, permissionDetail, fmtTokens, fmtSecs, scroll }) {
  const helpers = new Map(); // tool id → helper
  let ticker = null;
  let viewing = null; // helper shown in the view

  const strip = el('div', 'helper-strip');
  strip.hidden = true;
  log.before(strip);
  const view = el('div', 'helper-view');
  view.hidden = true;
  log.after(view);

  const nameOf = (h) => [h.input.subagent_type && h.input.subagent_type !== 'general-purpose' ? h.input.subagent_type : 'Helper', h.input.description].filter(Boolean).join(': ');
  const elapsed = (h) => fmtSecs((h.end || Date.now()) - h.start);
  const stateText = (h) => (h.status === RUNNING ? 'Working' : h.status === 'failed' ? 'Failed' : h.status === 'stopped' ? 'Stopped' : 'Done');
  const statusLine = (h) => [
    stateText(h),
    `${h.count} step${h.count === 1 ? '' : 's'}`,
    h.status === RUNNING && h.last ? h.last : '',
    h.tokens ? `${fmtTokens(h.tokens)} tokens` : '',
    h.start ? elapsed(h) : '',
  ].filter(Boolean).join(' · ');

  function ensure(id, input = {}, wrap = null) {
    let h = helpers.get(id);
    if (!h) {
      h = { id, input: {}, steps: [], byId: new Map(), status: RUNNING, count: 0, last: '', tokens: 0, start: Date.now(), end: 0, report: '', line: null };
      helpers.set(id, h);
    }
    if (input && Object.keys(input).length) h.input = input;
    if (wrap && !h.line) {
      h.line = el('button', 'helper-line');
      h.line.title = 'Open this helper: see every step it takes';
      h.line.addEventListener('click', () => open(h.id));
      wrap.append(h.line);
      wrap.classList.add('helper-wrap');
    }
    return h;
  }

  function paint(h) {
    if (h.line) {
      h.line.dataset.state = h.status;
      h.line.textContent = '';
      h.line.append(el('span', 'helper-dot'), el('span', 'helper-text', statusLine(h)), el('span', 'helper-open', 'Open ›'));
    }
    if (viewing === h) paintViewHead();
  }

  function paintStrip() {
    const busy = [...helpers.values()].filter((h) => h.status === RUNNING && h.input.description);
    strip.hidden = !busy.length;
    strip.textContent = '';
    if (!busy.length) return;
    strip.append(el('span', 'helper-strip-title', `${busy.length} helper${busy.length === 1 ? '' : 's'} working`));
    for (const h of busy) {
      const b = el('button', 'helper-chip');
      b.append(el('span', 'helper-dot'), el('span', '', `${nameOf(h)} · ${h.count} step${h.count === 1 ? '' : 's'}${h.last ? ` · ${h.last}` : ''}`));
      b.title = 'Open this helper';
      b.addEventListener('click', () => open(h.id));
      strip.append(b);
    }
  }

  function tick() {
    const any = [...helpers.values()].some((h) => h.status === RUNNING);
    if (any && !ticker) ticker = setInterval(() => { for (const h of helpers.values()) if (h.status === RUNNING) paint(h); paintStrip(); }, 1000);
    if (!any && ticker) { clearInterval(ticker); ticker = null; }
  }

  // ---------- steps ----------
  function addStep(h, step) {
    h.steps.push(step);
    if (step.kind === 'tool') {
      h.byId.set(step.id, step);
      h.count++;
      h.last = toolSummary(step.name, step.input || {});
    }
    if (viewing === h) { view.querySelector('.helper-steps').append(stepNode(step)); scrollView(); }
  }

  function stepNode(step) {
    if (step.kind === 'text') {
      const d = md(step.text);
      d.classList.add('helper-said');
      return d;
    }
    const row = el('details', `tool${step.done ? (step.isError ? ' err' : ' ok') : ''}`);
    const sum = el('summary');
    sum.append(el('span', 'tool-state'), el('span', 'tool-text', toolSummary(step.name, step.input || {})), el('span', 'tool-sum', step.done ? resultSummary(step.name, step.input || {}, step.result, step.isError) : ''), el('span', 'tool-time'));
    row.append(sum);
    if (step.input && Object.keys(step.input).length) { const d = permissionDetail(step.name, step.input); d.classList.add('tool-detail'); row.append(d); }
    if (step.result) { const out = el('pre', 'tool-result'); out.textContent = step.result; row.append(out); }
    if ((step.name === 'Task' || step.name === 'Agent') && helpers.has(step.id)) {
      const b = el('button', 'tool-open', '↗');
      b.title = 'Open this helper';
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(step.id); });
      sum.append(b);
    }
    step.node = row;
    return row;
  }

  function finishStep(h, id, isError, text) {
    const step = h.byId.get(id);
    if (!step) return;
    Object.assign(step, { done: true, isError, result: text || '' });
    if (step.node) step.node.replaceWith(stepNode(step));
  }

  // ---------- the helper view ----------
  function paintViewHead() {
    const h = viewing;
    if (!h) return;
    const head = view.querySelector('.helper-status');
    head.dataset.state = h.status;
    head.textContent = '';
    head.append(el('span', 'helper-dot'), el('span', '', statusLine(h)));
  }
  const scrollView = () => { const b = view.querySelector('.helper-body'); if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 80) b.scrollTop = b.scrollHeight; };

  function open(id) {
    const h = helpers.get(id);
    if (!h) return;
    viewing = h;
    view.textContent = '';
    const head = el('div', 'helper-head');
    const back = el('button', 'helper-back', '‹ Back to chat');
    back.addEventListener('click', close);
    head.append(back, el('div', 'helper-title', nameOf(h)), el('div', 'helper-status'));
    const body = el('div', 'helper-body');
    if (h.input.prompt) {
      const ask = el('details', 'helper-ask');
      ask.append(el('summary', '', 'What Claude asked this helper to do'), md(h.input.prompt));
      body.append(ask);
    }
    const steps = el('div', 'helper-steps');
    for (const s of h.steps) steps.append(stepNode(s));
    body.append(steps);
    if (h.report) {
      body.append(el('div', 'helper-report-title', 'Its report to Claude'));
      body.append(md(h.report));
    } else if (h.status === RUNNING && !h.steps.length) {
      steps.append(el('div', 'helper-wait', 'Starting…'));
    }
    view.append(head, body);
    paintViewHead();
    log.hidden = true;
    strip.hidden = true;
    view.hidden = false;
    root.classList.add('viewing-helper');
    body.scrollTop = h.status === RUNNING ? body.scrollHeight : 0;
  }

  function close() {
    viewing = null;
    view.hidden = true;
    log.hidden = false;
    root.classList.remove('viewing-helper');
    paintStrip();
    scroll(false);
  }

  // ---------- events from the panel ----------
  return {
    isHelper: (name) => name === 'Task' || name === 'Agent',
    // A Task / Agent tool row appeared (live or from history).
    start(id, input, wrap, saved) {
      const h = ensure(id, input, wrap);
      if (saved?.sub) for (const s of saved.sub) addStep(h, { ...s, done: s.done, result: s.result });
      if (saved?.task) Object.assign(h, { tokens: saved.task.tokens || h.tokens });
      if (saved) h.start = 0; // from history: no clock
      paint(h);
      paintStrip();
      tick();
    },
    // sub_tool / sub_text / sub_result / sub_progress / task
    event(evt) {
      const pid = evt.parent || evt.toolUseId;
      if (!pid) return;
      const h = ensure(pid);
      if (evt.kind === 'sub_tool' && evt.id) {
        addStep(h, { kind: 'tool', id: evt.id, name: evt.name, input: evt.input || {} });
        if (evt.name === 'Task' || evt.name === 'Agent') ensure(evt.id, evt.input); // a helper of a helper
      } else if (evt.kind === 'sub_text') addStep(h, { kind: 'text', text: evt.text });
      else if (evt.kind === 'sub_result') finishStep(h, evt.id, evt.isError, evt.text);
      else if (evt.kind === 'sub_progress') { if (!h.last) h.last = evt.name; }
      else if (evt.kind === 'task') {
        if (evt.tokens) h.tokens = evt.tokens;
        if (evt.steps != null && evt.steps > h.count) h.count = evt.steps;
        if (evt.lastTool && !h.last) h.last = evt.lastTool;
        if (evt.status && /completed|done/i.test(evt.status)) { h.status = 'done'; h.end = Date.now(); }
        else if (evt.status && /fail|error/i.test(evt.status)) { h.status = 'failed'; h.end = Date.now(); }
        else if (evt.status && /stop|kill|cancel/i.test(evt.status)) { h.status = 'stopped'; h.end = Date.now(); }
      }
      paint(h);
      paintStrip();
      tick();
    },
    // The Task / Agent tool finished: its result is the helper's report.
    done(id, isError, text) {
      const h = helpers.get(id);
      if (!h) return;
      h.status = isError ? 'failed' : 'done';
      h.end ||= Date.now();
      h.report = String(text || '').replace(/\n*agentId: [\w-]+[\s\S]*$/i, '').trim();
      paint(h);
      paintStrip();
      tick();
      if (viewing === h) open(h.id);
    },
    // The chat turn ended: helpers that never reported are not running any more.
    turnEnded() {
      for (const h of helpers.values()) if (h.status === RUNNING && h.input.run_in_background !== true) { h.status = 'stopped'; h.end ||= Date.now(); paint(h); }
      paintStrip();
      tick();
    },
    reset() {
      helpers.clear();
      if (viewing) close();
      paintStrip();
      tick();
    },
    close,
    isOpen: () => !!viewing,
  };
}
