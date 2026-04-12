/* ═══════════════════════════════════════════════════════════════════
   WF — Workflows (frontend)

   Three-pane layout with collapsible sidebars:

     ┌────────────┬─────────────────────────┬────────────┐
     │            │                         │            │
     │  Saved /   │   Builder  OR  Run      │   Report   │
     │  Compile / │   stream (live events)  │   (once    │
     │  New       │                         │    done)   │
     │            │                         │            │
     └────────────┴─────────────────────────┴────────────┘

   The right pane is hidden by default and only appears when a run
   completes. Left/right panes can each be collapsed via the × button
   in their header, and restored via the vertical strip that replaces
   them.

   Communication with the backend is Server-Sent Events. Each step's
   tool result carries a ``widget`` hint (a JSON render spec) that we
   turn into a DOM node and, once rendered, screenshot via html2canvas
   for the final report.

   Reads from globals in app.js: $, escHtml, showToast.
   ═══════════════════════════════════════════════════════════════════ */

const WF = {
  workflows: [],
  tools: [],                    // full tool registry from /api/wf/tools
  agentic: false,
  currentRun: null,
  renderedSteps: {},            // step_id → widget DOM node (html2canvas targets)
  stepResults: {},              // step_id → FunctionResult
  finalReport: null,            // {text, steps}
  focus: '',
  workflowName: '',
  // Autoscroll state — we only auto-follow the tail if the user
  // hasn't manually scrolled up
  followTail: true,
  // Pane collapse state (persisted in sessionStorage so a reload
  // inside the same session keeps the layout)
  leftCollapsed: false,
  rightCollapsed: false,
};

// Persist / restore collapse state within a session
try {
  const saved = JSON.parse(sessionStorage.getItem('wf-layout') || '{}');
  WF.leftCollapsed = !!saved.left;
  WF.rightCollapsed = !!saved.right;
} catch { /* ignore */ }

function wfSaveLayout() {
  try {
    sessionStorage.setItem('wf-layout', JSON.stringify({
      left: WF.leftCollapsed, right: WF.rightCollapsed,
    }));
  } catch { /* ignore */ }
}

// ── html2canvas loader (CDN, lazy) ──
function wfLoadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error('html2canvas failed to load'));
    document.head.appendChild(s);
  });
}

/* ─────────────────────────────────────────────────────────────────
   Main view renderer
   ───────────────────────────────────────────────────────────────── */

async function renderWorkflowHub(container) {
  WF.currentRun = null;
  WF.renderedSteps = {};
  WF.stepResults = {};
  WF.finalReport = null;
  WF.followTail = true;

  container.className = 'dashboard wf-dashboard';
  container.innerHTML = `
    <div class="wf-layout" id="wf-layout">
      <aside class="wf-sidebar">
        <div class="wf-collapse-strip" id="wf-left-expand" title="Expand sidebar">
          Workflows
        </div>
        <div class="wf-sidebar__header">
          <div class="wf-sidebar__title">WORKFLOWS</div>
          <div style="display:flex; align-items:center; gap:6px">
            <div class="wf-agent-status" id="wf-agent-status">checking…</div>
            <button class="wf-pane-toggle" id="wf-left-collapse" title="Collapse sidebar">◀</button>
          </div>
        </div>
        <div class="wf-sidebar__body">
          <button class="wf-new-btn" id="wf-new-btn">+ New workflow</button>

          <div class="wf-nl-box">
            <label class="wf-nl-label">Describe a workflow</label>
            <textarea id="wf-nl-input" class="wf-nl-textarea" rows="3"
              placeholder="e.g. Find US names reporting next week with elevated IV skew and check their news flow"></textarea>
            <button id="wf-nl-btn" class="wf-btn wf-btn--secondary">Compile → Edit</button>
          </div>

          <div class="wf-sidebar__section">Saved workflows</div>
          <div id="wf-list" class="wf-list">
            <div class="wf-empty">Loading…</div>
          </div>
        </div>
      </aside>

      <section class="wf-main">
        <header class="wf-main__header" id="wf-main-header">
          <div class="wf-main__title">Select a workflow to begin</div>
        </header>
        <div class="wf-stream" id="wf-stream">
          <div class="wf-placeholder">
            <div class="wf-placeholder__icon">◆</div>
            <div class="wf-placeholder__text">
              Pick a workflow on the left, describe one in natural
              language, or click <strong>+ New workflow</strong> to
              build one step by step. Tool calls stream live, and the
              final report captures screenshots of every widget.
            </div>
          </div>
        </div>
      </section>

      <aside class="wf-report" id="wf-report">
        <div class="wf-collapse-strip" id="wf-right-expand" title="Expand report">
          Report
        </div>
        <div class="wf-report__header">
          <div class="wf-report__title">REPORT</div>
          <div style="display:flex; align-items:center; gap:6px">
            <button id="wf-export-btn" class="wf-btn wf-btn--primary" disabled>
              Export
            </button>
            <button class="wf-pane-toggle" id="wf-right-collapse" title="Collapse report">▶</button>
          </div>
        </div>
        <div id="wf-report-body" class="wf-report__body">
          <div class="wf-placeholder wf-placeholder--small">
            The agent's analysis and captured widgets will appear here
            once the workflow completes.
          </div>
        </div>
      </aside>
    </div>
  `;

  // Parallel loads: workflows, tools catalog, agent status
  await Promise.all([wfLoadWorkflows(), wfLoadTools(), wfLoadAgentStatus()]);

  // Listeners
  document.getElementById('wf-nl-btn').addEventListener('click', wfCompileFromNL);
  document.getElementById('wf-new-btn').addEventListener('click', () => wfShowBuilder(null));
  document.getElementById('wf-export-btn').addEventListener('click', wfExportReport);

  document.getElementById('wf-left-collapse').addEventListener('click', () => wfSetLeftCollapsed(true));
  document.getElementById('wf-left-expand').addEventListener('click', () => wfSetLeftCollapsed(false));
  document.getElementById('wf-right-collapse').addEventListener('click', () => wfSetRightCollapsed(true));
  document.getElementById('wf-right-expand').addEventListener('click', () => wfSetRightCollapsed(false));

  // Follow-tail detection: if the user scrolls up, stop auto-scrolling
  // until they scroll back to the bottom (same behaviour as a chat).
  const stream = document.getElementById('wf-stream');
  stream.addEventListener('scroll', () => {
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40;
    WF.followTail = atBottom;
  });

  // Initial layout state (no report yet → hide right pane)
  wfApplyLayoutClass();
}

/* ─────────────────────────────────────────────────────────────────
   Pane collapse management
   ───────────────────────────────────────────────────────────────── */

function wfSetLeftCollapsed(v) {
  WF.leftCollapsed = v;
  wfSaveLayout();
  wfApplyLayoutClass();
}
function wfSetRightCollapsed(v) {
  WF.rightCollapsed = v;
  wfSaveLayout();
  wfApplyLayoutClass();
}

function wfApplyLayoutClass() {
  const layout = document.getElementById('wf-layout');
  if (!layout) return;
  layout.classList.remove(
    'wf-layout--left-collapsed',
    'wf-layout--right-collapsed',
    'wf-layout--both-collapsed',
    'wf-layout--no-report',
  );
  // No report yet → hide the right pane entirely (the collapse buttons
  // still work but are redundant).
  if (!WF.finalReport) {
    layout.classList.add('wf-layout--no-report');
    if (WF.leftCollapsed) layout.classList.add('wf-layout--left-collapsed');
    return;
  }
  if (WF.leftCollapsed && WF.rightCollapsed) {
    layout.classList.add('wf-layout--both-collapsed');
  } else if (WF.leftCollapsed) {
    layout.classList.add('wf-layout--left-collapsed');
  } else if (WF.rightCollapsed) {
    layout.classList.add('wf-layout--right-collapsed');
  }
}

/* ─────────────────────────────────────────────────────────────────
   Workflow / tools / agent-status loading
   ───────────────────────────────────────────────────────────────── */

async function wfLoadWorkflows() {
  try {
    const res = await fetch('/api/wf/list');
    const data = await res.json();
    WF.workflows = data.workflows || [];
    wfRenderList();
  } catch (err) {
    document.getElementById('wf-list').innerHTML =
      `<div class="wf-empty">Failed to load: ${escHtml(String(err))}</div>`;
  }
}

async function wfLoadTools() {
  try {
    const res = await fetch('/api/wf/tools');
    const data = await res.json();
    WF.tools = data.tools || [];
  } catch { /* ignore — builder still works but with no tool hints */ }
}

async function wfLoadAgentStatus() {
  try {
    const res = await fetch('/api/wf/agent_status');
    const data = await res.json();
    WF.agentic = !!data.agentic;
    wfUpdateAgentLabel(data.default_model || 'scripted');
  } catch { /* ignore */ }
}

// Called on load AND whenever the user saves their settings (so the
// chip stays in sync with the current primary-provider selection).
function wfUpdateAgentLabel(fallback) {
  const el = document.getElementById('wf-agent-status');
  if (!el) return;

  const keys = window.User?.llm_keys || {};
  const provider = keys.provider;
  const model = keys.agent_model;

  // Determine label + status color
  let label, live;
  if (!WF.agentic) {
    label = 'scripted';
    live = false;
  } else if (provider && model) {
    // Check the user actually has a key for the selected provider
    const providerKey = keys[provider];
    if (!providerKey) {
      label = `${provider} · no key`;
      live = false;
    } else {
      label = wfShortModelLabel(provider, model);
      live = true;
    }
  } else {
    label = fallback || 'scripted';
    live = false;
  }

  el.textContent = label;
  el.className = 'wf-agent-status ' + (live ? 'wf-agent-status--live' : 'wf-agent-status--off');
  el.title = live
    ? `Active agent: ${provider}/${model}`
    : 'Runs will use scripted mode. Open ⚙ settings to pick a provider and paste a key.';
}

function wfShortModelLabel(provider, model) {
  // Strip provider prefixes that litellm adds, then shorten common names
  let m = model.replace(/^openrouter\//, '').replace(/^gemini\//, '').replace(/^perplexity\//, '');
  if (provider === 'openrouter') return `OR · ${m.split('/').pop()}`;
  // Shorten dated Anthropic tags: claude-3-5-sonnet-20241022 → claude-3-5-sonnet
  m = m.replace(/-\d{8}$/, '');
  return m;
}

// Keep the chip in sync when settings are saved elsewhere in the page
window.addEventListener('storage', wfUpdateAgentLabel);

/* ─────────────────────────────────────────────────────────────────
   Saved workflow list — with edit / delete
   ───────────────────────────────────────────────────────────────── */

function wfRenderList() {
  const el = document.getElementById('wf-list');
  if (!el) return;
  if (!WF.workflows.length) {
    el.innerHTML = '<div class="wf-empty">No workflows saved.</div>';
    return;
  }
  el.innerHTML = WF.workflows.map((wf) => `
    <div class="wf-card" data-id="${escHtml(wf.id)}">
      <div class="wf-card__actions">
        <button class="wf-card__action-btn" data-action="edit" title="Edit">✎</button>
        <button class="wf-card__action-btn wf-card__action-btn--danger" data-action="delete" title="Delete">✕</button>
      </div>
      <div class="wf-card__name">${escHtml(wf.name)}</div>
      <div class="wf-card__desc">${escHtml(wf.description || '')}</div>
      <div class="wf-card__meta">
        <span>${wf.step_count} steps</span>
        <span>${(wf.tags || []).map(escHtml).join(' · ')}</span>
      </div>
    </div>
  `).join('');

  // Delegated click handling: card → open run panel; action button → edit/delete
  el.querySelectorAll('.wf-card').forEach((card) => {
    card.addEventListener('click', async (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        const id = card.dataset.id;
        if (action === 'edit') await wfOpenEditor(id);
        if (action === 'delete') await wfDeleteWorkflow(id);
        return;
      }
      wfShowRunPanel(card.dataset.id);
    });
  });
}

async function wfDeleteWorkflow(id) {
  const wf = WF.workflows.find((w) => w.id === id);
  if (!wf) return;
  if (!confirm(`Delete "${wf.name}"? This cannot be undone.`)) return;

  try {
    const res = await fetch(`/api/wf/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      showToast('Delete failed: ' + (data.error || res.status));
      return;
    }
    showToast(`Deleted "${wf.name}"`);
    await wfLoadWorkflows();
  } catch (err) {
    showToast('Delete failed: ' + err.message);
  }
}

async function wfOpenEditor(id) {
  try {
    const res = await fetch(`/api/wf/${encodeURIComponent(id)}`);
    if (!res.ok) {
      showToast('Could not load workflow');
      return;
    }
    const spec = await res.json();
    wfShowBuilder(spec);
  } catch (err) {
    showToast('Load failed: ' + err.message);
  }
}

/* ─────────────────────────────────────────────────────────────────
   Run panel (read-only plan + inputs + Run button)
   ───────────────────────────────────────────────────────────────── */

function wfShowRunPanel(workflowId) {
  const wf = WF.workflows.find((w) => w.id === workflowId);
  if (!wf) return;

  WF.renderedSteps = {};
  WF.stepResults = {};
  WF.finalReport = null;
  wfApplyLayoutClass();
  document.getElementById('wf-export-btn').disabled = true;

  const header = document.getElementById('wf-main-header');
  header.innerHTML = `
    <div class="wf-main__title">
      <span class="wf-main__code">WF</span>
      ${escHtml(wf.name)}
    </div>
    <div class="wf-main__desc">${escHtml(wf.description || '')}</div>
    ${wf.focus ? `<div class="wf-main__focus"><em>Focus:</em> ${escHtml(wf.focus)}</div>` : ''}
  `;

  const inputs = wf.inputs || {};
  const inputFields = Object.entries(inputs).map(([key, spec]) => {
    const dflt = (spec && typeof spec === 'object' && 'default' in spec) ? spec.default : '';
    return `
      <div class="wf-input-group">
        <label class="wf-input-label">${escHtml(key)}</label>
        <input class="wf-input" data-input="${escHtml(key)}"
               value="${escHtml(String(dflt ?? ''))}" />
      </div>
    `;
  }).join('');

  const stream = document.getElementById('wf-stream');
  stream.innerHTML = `
    <div class="wf-run-panel">
      <div class="wf-inputs">
        ${inputFields || '<div class="wf-empty-inline">No inputs required.</div>'}
      </div>
      <div class="wf-steps-preview">
        <div class="wf-steps-preview__title">Plan (${wf.step_count} steps)</div>
        ${wf.steps.map((s) => `
          <div class="wf-step-preview">
            <span class="wf-step-preview__tool">${escHtml(s.tool)}</span>
            <span class="wf-step-preview__label">${escHtml(s.label || '')}</span>
          </div>
        `).join('')}
      </div>
      <div class="wf-run-controls">
        <select class="wf-mode-select" id="wf-mode-select" title="Execution mode">
          <option value="auto">Auto (agent if available)</option>
          <option value="agentic">Agentic (requires API key)</option>
          <option value="scripted">Scripted (no LLM)</option>
        </select>
        <button class="wf-btn wf-btn--primary wf-run-btn">
          ▶ Run
        </button>
        <button class="wf-btn wf-btn--secondary wf-edit-btn" style="margin-left:8px">
          ✎ Edit
        </button>
      </div>
    </div>
  `;

  // Pre-select the mode based on whether the user has keys configured
  const modeSelect = stream.querySelector('#wf-mode-select');
  const userKeys = window.User?.llm_keys || {};
  const hasKey = userKeys.provider && userKeys[userKeys.provider];
  if (hasKey && WF.agentic) {
    modeSelect.value = 'agentic';
  } else if (hasKey) {
    modeSelect.value = 'auto';
  } else {
    modeSelect.value = 'scripted';
  }

  stream.querySelector('.wf-run-btn').addEventListener('click', () => {
    const inputValues = {};
    stream.querySelectorAll('[data-input]').forEach((el) => {
      const k = el.dataset.input;
      let v = el.value;
      if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
      inputValues[k] = v;
    });
    const mode = modeSelect.value;
    wfStartRun(wf.id, inputValues, wf, null, mode);
  });
  stream.querySelector('.wf-edit-btn').addEventListener('click', () => wfOpenEditor(wf.id));
}

/* ─────────────────────────────────────────────────────────────────
   Workflow builder — new / edit / NL-compile prefill

   Renders a form in the center pane. On save, POSTs to /api/wf/save.
   The "Run now" button saves AND immediately runs (so the user never
   has to reopen after editing). "Run without saving" is an explicit
   escape hatch for one-off compiled workflows that shouldn't clutter
   the saved list.
   ───────────────────────────────────────────────────────────────── */

function wfShowBuilder(existing) {
  // ``existing`` is either the full spec from /api/wf/<id> or null
  // (= new workflow). It may also be a Workflow from NL compile which
  // came in via wfShowAdHocPreview, in which case we pass through the
  // already-normalized spec.
  const spec = existing || {
    id: '',
    name: '',
    description: '',
    focus: '',
    inputs: {},
    steps: [{ id: 'step1', tool: 'MOST', label: '', params: {} }],
    tags: [],
  };
  WF.finalReport = null;
  wfApplyLayoutClass();

  const header = document.getElementById('wf-main-header');
  header.innerHTML = `
    <div class="wf-main__title">
      <span class="wf-main__code wf-main__code--adhoc">WB</span>
      ${existing ? 'Edit: ' + escHtml(spec.name || spec.id || '') : 'New workflow'}
    </div>
    <div class="wf-main__desc">
      Chain tools, describe the focus, save for reuse — or run it once without saving.
    </div>
  `;

  const stream = document.getElementById('wf-stream');
  stream.innerHTML = `
    <div class="wf-builder">
      <div class="wf-builder__section">
        <label class="wf-builder__label">Name</label>
        <input class="wf-builder__input" id="wb-name" value="${escHtml(spec.name || '')}"
               placeholder="e.g. Earnings vol screen" />
      </div>
      <div class="wf-builder__section">
        <label class="wf-builder__label">Description</label>
        <textarea class="wf-builder__textarea" id="wb-desc" rows="2"
                  placeholder="One-line summary shown in the saved list">${escHtml(spec.description || '')}</textarea>
      </div>
      <div class="wf-builder__section">
        <label class="wf-builder__label">Focus (what the agent should optimize for)</label>
        <textarea class="wf-builder__textarea" id="wb-focus" rows="2"
                  placeholder="e.g. Rank names where implied move looks rich vs realized vol">${escHtml(spec.focus || '')}</textarea>
      </div>

      <div class="wf-builder__section">
        <label class="wf-builder__label">Steps</label>
        <div class="wf-builder__steps" id="wb-steps"></div>
        <button class="wf-btn wf-btn--secondary" id="wb-add-step" type="button">+ Add step</button>
      </div>

      <div class="wf-builder__actions">
        <div class="wf-builder__actions-left">
          <button class="wf-btn wf-btn--primary" id="wb-save-run">▶ Save &amp; run</button>
          <button class="wf-btn wf-btn--secondary" id="wb-save" style="margin-left:6px">Save</button>
        </div>
        <button class="wf-btn wf-btn--secondary" id="wb-run-once">Run without saving</button>
        <button class="wf-btn wf-btn--secondary" id="wb-cancel" style="margin-left:6px">Cancel</button>
      </div>
    </div>
  `;

  // ── Steps rendering ──
  const stepsHost = document.getElementById('wb-steps');

  // In-memory editable copy — we mutate this and re-render rows on add/remove
  const editable = {
    name: spec.name || '',
    description: spec.description || '',
    focus: spec.focus || '',
    id: spec.id || '',
    inputs: spec.inputs || {},
    steps: (spec.steps && spec.steps.length
      ? spec.steps
      : [{ id: 'step1', tool: 'MOST', label: '', params: {} }]
    ).map((s, i) => ({
      id: s.id || `step${i + 1}`,
      tool: s.tool || 'MOST',
      label: s.label || '',
      params: typeof s.params === 'string' ? s.params : JSON.stringify(s.params || {}, null, 0),
    })),
  };

  function renderSteps() {
    stepsHost.innerHTML = editable.steps.map((s, i) => `
      <div class="wf-step-row" data-idx="${i}">
        <div class="wf-step-row__idx">${i + 1}</div>
        <select class="wf-step-row__tool" data-field="tool">
          ${WF.tools.map((t) => `
            <option value="${escHtml(t.name)}" ${t.name === s.tool ? 'selected' : ''}>
              ${escHtml(t.name)}
            </option>
          `).join('')}
        </select>
        <div class="wf-step-row__body">
          <input class="wf-step-row__label-input" data-field="label"
                 value="${escHtml(s.label)}" placeholder="Label (what this step is for)" />
          <textarea class="wf-step-row__params-input" data-field="params"
                    rows="1" placeholder='{"country":"US","limit":10}'>${escHtml(s.params)}</textarea>
          <div class="wf-step-row__hint" data-hint="${escHtml(s.tool)}"></div>
        </div>
        <button class="wf-step-row__remove" data-action="remove" title="Remove step">✕</button>
      </div>
    `).join('');

    // Populate per-row hints from the tool registry.
    // We show the FULL description (wrapped) plus a compact param
    // line so the user understands what each tool does without
    // bouncing back to docs.
    stepsHost.querySelectorAll('.wf-step-row').forEach((row) => {
      const idx = +row.dataset.idx;
      const step = editable.steps[idx];
      const hint = row.querySelector('[data-hint]');
      const tool = WF.tools.find((t) => t.name === step.tool);
      if (hint && tool) {
        const paramHint = Object.entries(tool.params || {})
          .map(([k, v]) => {
            const req = v.required ? '*' : '';
            const type = v.type ? `:${v.type}` : '';
            const dflt = (v.default !== undefined && v.default !== '') ? `=${JSON.stringify(v.default)}` : '';
            const enums = v.enum ? ` (${v.enum.join('|')})` : '';
            return `${k}${req}${type}${dflt}${enums}`;
          })
          .join(', ') || '(no params)';
        hint.innerHTML = `
          <div class="wf-step-row__desc">${escHtml(tool.description || '')}</div>
          <div class="wf-step-row__params">params: ${escHtml(paramHint)}</div>
        `;
      }

      // Wire up per-row inputs to the editable state
      row.querySelector('[data-field="tool"]').addEventListener('change', (e) => {
        editable.steps[idx].tool = e.target.value;
        renderSteps();  // re-render to refresh hint
      });
      row.querySelector('[data-field="label"]').addEventListener('input', (e) => {
        editable.steps[idx].label = e.target.value;
      });
      row.querySelector('[data-field="params"]').addEventListener('input', (e) => {
        editable.steps[idx].params = e.target.value;
      });
      row.querySelector('[data-action="remove"]').addEventListener('click', () => {
        if (editable.steps.length === 1) {
          showToast('At least one step is required');
          return;
        }
        editable.steps.splice(idx, 1);
        renderSteps();
      });
    });
  }
  renderSteps();

  document.getElementById('wb-add-step').addEventListener('click', () => {
    const nextIdx = editable.steps.length + 1;
    editable.steps.push({
      id: `step${nextIdx}`,
      tool: WF.tools[0]?.name || 'MOST',
      label: '',
      params: '{}',
    });
    renderSteps();
  });

  // Shared builder → payload conversion
  function collect() {
    editable.name = document.getElementById('wb-name').value.trim();
    editable.description = document.getElementById('wb-desc').value.trim();
    editable.focus = document.getElementById('wb-focus').value.trim();

    return {
      id: editable.id || undefined,
      name: editable.name,
      description: editable.description,
      focus: editable.focus,
      inputs: editable.inputs,
      steps: editable.steps.map((s, i) => {
        let params = {};
        const raw = (s.params || '').trim();
        if (raw) {
          try { params = JSON.parse(raw); }
          catch (err) { throw new Error(`Step ${i + 1} params is not valid JSON: ${err.message}`); }
        }
        return {
          id: s.id || `step${i + 1}`,
          tool: s.tool,
          label: s.label,
          params,
        };
      }),
    };
  }

  async function doSave() {
    try {
      const payload = collect();
      if (!payload.name) throw new Error('Name is required');
      const res = await fetch('/api/wf/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast(`Saved "${payload.name}"`);
      await wfLoadWorkflows();
      return data;
    } catch (err) {
      showToast('Save failed: ' + err.message);
      return null;
    }
  }

  document.getElementById('wb-save').addEventListener('click', doSave);

  document.getElementById('wb-save-run').addEventListener('click', async () => {
    const saved = await doSave();
    if (!saved) return;
    const wf = WF.workflows.find((w) => w.id === saved.id);
    if (wf) wfStartRun(wf.id, {}, wf);
  });

  document.getElementById('wb-run-once').addEventListener('click', () => {
    try {
      const payload = collect();
      if (!payload.name) payload.name = 'Ad-hoc';
      // Start an ad-hoc run — backend accepts a full spec under `workflow`
      const spec = {
        name: payload.name,
        description: payload.description,
        focus: payload.focus,
        inputs: payload.inputs,
        steps: payload.steps,
      };
      wfStartRun('_adhoc', {}, spec, spec);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('wb-cancel').addEventListener('click', () => {
    wfShowPlaceholder();
  });
}

function wfShowPlaceholder() {
  const header = document.getElementById('wf-main-header');
  const stream = document.getElementById('wf-stream');
  header.innerHTML = `<div class="wf-main__title">Select a workflow to begin</div>`;
  stream.innerHTML = `
    <div class="wf-placeholder">
      <div class="wf-placeholder__icon">◆</div>
      <div class="wf-placeholder__text">
        Pick a workflow on the left, describe one in natural language,
        or click <strong>+ New workflow</strong> to build one step by step.
      </div>
    </div>
  `;
}

/* ─────────────────────────────────────────────────────────────────
   Run start + SSE stream
   ───────────────────────────────────────────────────────────────── */

async function wfStartRun(workflowId, inputs, wfMeta, adHocSpec = null, mode = 'auto') {
  WF.workflowName = wfMeta?.name || workflowId;
  WF.focus = wfMeta?.focus || '';
  WF.renderedSteps = {};
  WF.stepResults = {};
  WF.finalReport = null;
  WF.followTail = true;
  WF.runStartedAt = Date.now();
  wfApplyLayoutClass();

  const body = adHocSpec
    ? { workflow: adHocSpec, inputs, mode }
    : { workflow_id: workflowId, inputs, mode };

  if (window.User?.llm_keys) body.llm_keys = window.User.llm_keys;

  // Inject per-run user context. The W tool reads this via a
  // contextvar on the backend, so the LLM never sees the watchlist
  // as a callable parameter — it's ambient state.
  const watchlist = (window.state?.watchlist || []).map((t) => ({
    symbol:   t.symbol,
    exchange: t.exchange,
    name:     t.name,
  }));
  body.user_context = {
    watchlist,
    display_name: window.auth?.user?.user_metadata?.display_name
      || window.auth?.user?.email
      || '',
  };

  try {
    const res = await fetch('/api/wf/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      wfShowError(data.error);
      return;
    }
    WF.currentRun = data.run_id;
    wfInitStreamUI(wfMeta);
    wfConnectSSE(data.run_id);
  } catch (err) {
    wfShowError(String(err));
  }
}

function wfInitStreamUI(wfMeta) {
  const stream = document.getElementById('wf-stream');
  stream.innerHTML = `
    <div class="wf-run-active">
      <div class="wf-run-active__header">
        <span class="wf-run-dot" id="wf-run-dot"></span>
        <span id="wf-run-state">Running</span>
        <span>·</span>
        <span>${escHtml(wfMeta?.name || 'workflow')}</span>
        <span class="wf-run-active__elapsed" id="wf-run-elapsed"></span>
      </div>
      <div id="wf-events" class="wf-events"></div>
    </div>
  `;
}

// Update the run header to reflect the final state. Called on the
// SSE ``done`` event (success) or ``error`` (failure). The ``state``
// arg is a short label — "Completed" or "Failed" — and ``cls`` is
// the css modifier on the dot so color matches.
function wfUpdateRunHeader(state, cls) {
  const dot = document.getElementById('wf-run-dot');
  const label = document.getElementById('wf-run-state');
  const elapsed = document.getElementById('wf-run-elapsed');
  if (dot) {
    dot.classList.remove('wf-run-dot--done', 'wf-run-dot--error');
    dot.classList.add(cls);
  }
  if (label) label.textContent = state;
  if (elapsed && WF.runStartedAt) {
    const ms = Date.now() - WF.runStartedAt;
    const s = ms / 1000;
    elapsed.textContent = `(${s < 10 ? s.toFixed(1) : Math.round(s)}s)`;
  }
}

function wfConnectSSE(runId) {
  const es = new EventSource(`/api/wf/stream/${runId}`);

  es.addEventListener('workflow_start', (e) => {
    const data = JSON.parse(e.data);
    wfAppendThought(`Starting (${data.mode} mode)…`);
  });

  es.addEventListener('step_start', (e) => {
    wfAppendStepStart(JSON.parse(e.data));
  });

  es.addEventListener('step_result', (e) => {
    wfAppendStepResult(JSON.parse(e.data));
  });

  es.addEventListener('agent_thought', (e) => {
    wfAppendThought(JSON.parse(e.data).text);
  });

  es.addEventListener('final_report', (e) => {
    const data = JSON.parse(e.data);
    WF.finalReport = data;
    // Now that we have a report, make the right pane visible
    wfApplyLayoutClass();
    wfRenderReport(data);
  });

  // Track whether any step / error has marked the run as failed —
  // used so ``done`` can flip the header to the correct final state.
  let runHadError = false;

  es.addEventListener('error', (e) => {
    try {
      const data = JSON.parse(e.data);
      wfAppendThought('⚠ ' + (data.message || 'error'), 'error');
      runHadError = true;
    } catch { /* ignore */ }
  });

  es.addEventListener('done', () => {
    es.close();
    wfUpdateRunHeader(
      runHadError ? 'Failed' : 'Completed',
      runHadError ? 'wf-run-dot--error' : 'wf-run-dot--done',
    );
    wfScrollToBottom();
  });

  es.onerror = () => {
    es.close();
    wfAppendThought('Connection closed.', 'error');
  };
}

/* ─────────────────────────────────────────────────────────────────
   Stream append + follow-tail autoscroll
   ───────────────────────────────────────────────────────────────── */

function wfScrollToBottom() {
  const stream = document.getElementById('wf-stream');
  if (!stream) return;
  // Two rAFs — first one lets the DOM layout settle, second does the
  // actual scroll so we land at the true bottom, not a stale height.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (WF.followTail) {
        stream.scrollTop = stream.scrollHeight;
      }
    });
  });
}

function wfAppendThought(text, kind = 'thought') {
  const root = document.getElementById('wf-events');
  if (!root) return;
  const div = document.createElement('div');
  div.className = `wf-event wf-event--${kind}`;
  div.innerHTML = `<div class="wf-event__text">${escHtml(text)}</div>`;
  root.appendChild(div);
  wfScrollToBottom();
}

function wfAppendStepStart(data) {
  const root = document.getElementById('wf-events');
  if (!root) return;
  const id = `wf-step-${data.step_id}`;
  if (document.getElementById(id)) return;

  const div = document.createElement('div');
  div.id = id;
  div.className = 'wf-event wf-event--step wf-event--step-running';
  div.innerHTML = `
    <div class="wf-step__head">
      <span class="wf-step__spinner"></span>
      <span class="wf-step__tool">${escHtml(data.tool)}</span>
      <span class="wf-step__label">${escHtml(data.label || '')}</span>
      <span class="wf-step__params">${escHtml(JSON.stringify(data.params || {}))}</span>
    </div>
    <div class="wf-step__body" id="${id}-body"></div>
  `;
  root.appendChild(div);
  wfScrollToBottom();
}

async function wfAppendStepResult(data) {
  const id = `wf-step-${data.step_id}`;
  const div = document.getElementById(id);
  if (!div) return;
  const result = data.result || {};
  WF.stepResults[data.step_id] = result;

  div.classList.remove('wf-event--step-running');
  div.classList.add(result.error ? 'wf-event--step-error' : 'wf-event--step-done');

  const body = document.getElementById(`${id}-body`);
  if (!body) return;

  if (result.error) {
    body.innerHTML = `<div class="wf-step__error">${escHtml(result.error)}</div>`;
    wfScrollToBottom();
    return;
  }

  const summary = result.summary || '';
  const meta = result.metadata || {};
  body.innerHTML = `
    <div class="wf-step__summary">${escHtml(summary)}</div>
    <div class="wf-step__meta">${meta.elapsed_ms || 0}ms</div>
    <div class="wf-widget" data-step-id="${escHtml(data.step_id)}"></div>
  `;
  const widgetDiv = body.querySelector('.wf-widget');
  if (result.widget) {
    wfRenderWidget(widgetDiv, result.widget);
    WF.renderedSteps[data.step_id] = widgetDiv;
  }
  wfScrollToBottom();
}

/* ─────────────────────────────────────────────────────────────────
   Widget renderers — structured render-spec → DOM
   ───────────────────────────────────────────────────────────────── */

function wfRenderWidget(el, widget) {
  if (!widget || !widget.type) return;

  const title = widget.title ? `<div class="wf-widget__title">${escHtml(widget.title)}</div>` : '';

  switch (widget.type) {
    case 'table': {
      const rows = widget.rows || [];
      let cols = widget.columns;
      if (!cols || !cols.length) {
        const sample = rows[0] || {};
        cols = Object.keys(sample).slice(0, 8).map((k) => ({
          key: k, semantic: '', display: wfTitleCase(k),
        }));
      } else if (typeof cols[0] === 'string') {
        cols = cols.map((k) => ({ key: k, semantic: '', display: wfTitleCase(k) }));
      }

      el.innerHTML = title + `
        <div class="wf-table-wrap">
          <table class="wf-table">
            <thead><tr>${cols.map((c) => `<th>${escHtml(c.display)}</th>`).join('')}</tr></thead>
            <tbody>
              ${rows.slice(0, 15).map((r) => `
                <tr>
                  ${cols.map((c) => `<td class="${wfCellClass(c, r[c.key])}">${escHtml(wfFormatValue(r[c.key], c))}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${rows.length > 15 ? `<div class="wf-table__more">+${rows.length - 15} more rows</div>` : ''}
        </div>
      `;
      break;
    }
    case 'info': {
      const p = widget.payload || {};
      el.innerHTML = title + `
        <div class="wf-info-grid">
          ${[
            ['Price', p.currentPrice ? '$' + p.currentPrice : 'n/a'],
            ['Market cap', wfFormatCap(p.marketCap)],
            ['P/E (TTM)', p.trailingPE ?? 'n/a'],
            ['Fwd P/E', p.forwardPE ?? 'n/a'],
            ['Beta', p.beta ?? 'n/a'],
            ['Sector', p.sector || 'n/a'],
            ['Next earnings', p.nextEarningsDate || 'n/a'],
            ['52w range', p.fiftyTwoWeekLow && p.fiftyTwoWeekHigh
              ? `$${p.fiftyTwoWeekLow} — $${p.fiftyTwoWeekHigh}` : 'n/a'],
          ].map(([k, v]) => `
            <div class="wf-info-cell">
              <div class="wf-info-cell__k">${escHtml(k)}</div>
              <div class="wf-info-cell__v">${escHtml(String(v))}</div>
            </div>
          `).join('')}
        </div>
      `;
      break;
    }
    case 'news': {
      const articles = widget.articles || [];
      el.innerHTML = title + `
        <ul class="wf-news-list">
          ${articles.slice(0, 6).map((a) => `
            <li>
              <div class="wf-news-list__title">${escHtml(a.title || '')}</div>
              <div class="wf-news-list__meta">${escHtml(a.publisher || '')}</div>
            </li>
          `).join('')}
        </ul>
      `;
      break;
    }
    case 'candles': {
      const candles = widget.candles || [];
      if (!candles.length) { el.innerHTML = title; break; }
      const closes = candles.map((c) => c.close);
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const range = max - min || 1;
      const w = 320, h = 80;
      const pts = candles.map((c, i) => {
        const x = (i / (candles.length - 1)) * w;
        const y = h - ((c.close - min) / range) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const isUp = closes[closes.length - 1] >= closes[0];
      const color = isUp ? '#26a69a' : '#ef5350';
      el.innerHTML = title + `
        <svg class="wf-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
          <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
        </svg>
        <div class="wf-spark__range">
          ${escHtml(candles[0].time)} — ${escHtml(candles[candles.length - 1].time)}
          · ${closes[0].toFixed(2)} → ${closes[closes.length - 1].toFixed(2)}
        </div>
      `;
      break;
    }
    case 'omon': {
      const p = widget.payload || {};
      const s = p.summary || {};
      el.innerHTML = title + `
        <div class="wf-info-grid">
          ${[
            ['Underlying', p.underlyingPrice ? '$' + p.underlyingPrice : 'n/a'],
            ['Expiration', p.expiration || 'n/a'],
            ['Days', p.daysToExpiry ?? 'n/a'],
            ['Call vol', (s.callVolume || 0).toLocaleString()],
            ['Put vol', (s.putVolume || 0).toLocaleString()],
            ['P/C ratio', s.pcRatio ?? 'n/a'],
          ].map(([k, v]) => `
            <div class="wf-info-cell">
              <div class="wf-info-cell__k">${escHtml(k)}</div>
              <div class="wf-info-cell__v">${escHtml(String(v))}</div>
            </div>
          `).join('')}
        </div>
      `;
      break;
    }
    case 'ivol': {
      const p = widget.payload || {};
      const curves = p.curves || [];
      const w = 320, h = 100;
      const allPts = curves.flatMap((c) => (c.points || []));
      if (!allPts.length) { el.innerHTML = title; break; }
      const ivs = allPts.map((pt) => pt.iv);
      const min = Math.min(...ivs);
      const max = Math.max(...ivs);
      const range = max - min || 1;
      const colors = ['#ff8c00', '#26a69a', '#5e7cff', '#c678dd'];
      const lines = curves.slice(0, 4).map((c, i) => {
        const points = c.points || [];
        if (points.length < 2) return '';
        const strikes = points.map((pt) => pt.strike);
        const minS = Math.min(...strikes);
        const maxS = Math.max(...strikes);
        const rangeS = maxS - minS || 1;
        const pts = points.map((pt) => {
          const x = ((pt.strike - minS) / rangeS) * w;
          const y = h - ((pt.iv - min) / range) * h;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${colors[i]}" stroke-width="1.2" />`;
      }).join('');
      el.innerHTML = title + `
        <svg class="wf-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${lines}</svg>
        <div class="wf-spark__range">
          ${curves.slice(0, 4).map((c, i) =>
            `<span style="color:${colors[i]}">${escHtml(c.label || c.expiration || '')}</span>`
          ).join(' · ')}
        </div>
      `;
      break;
    }
    case 'search': {
      const results = widget.results || [];
      el.innerHTML = title + `
        <ul class="wf-news-list">
          ${results.slice(0, 8).map((r) => `
            <li>
              <div class="wf-news-list__title">${escHtml(r.symbol || '')} — ${escHtml(r.name || '')}</div>
              <div class="wf-news-list__meta">${escHtml(r.exchange || '')}</div>
            </li>
          `).join('')}
        </ul>
      `;
      break;
    }
    default:
      el.innerHTML = title + `<pre class="wf-raw">${escHtml(JSON.stringify(widget, null, 2).slice(0, 800))}</pre>`;
  }
}

/* ─────────────────────────────────────────────────────────────────
   Smart value formatting (schema-aware)
   ───────────────────────────────────────────────────────────────── */

function wfFormatValue(v, col) {
  if (v == null || v === '') return '—';
  const semantic = col && col.semantic ? col.semantic : '';
  const key = (col && col.key ? col.key : '').toLowerCase();

  switch (semantic) {
    case 'PRICE':
    case 'HIGH': case 'LOW': case 'OPEN':
      return typeof v === 'number' ? `$${v.toFixed(2)}` : String(v);
    case 'CHANGE_PCT':
      return typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : String(v);
    case 'CHANGE_ABS':
      return typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : String(v);
    case 'MARKET_CAP':
      return wfFormatCap(v);
    case 'VOLUME':
      return typeof v === 'number' ? v.toLocaleString() : String(v);
    case 'REL_VOLUME':
      return typeof v === 'number' ? `${v.toFixed(2)}×` : String(v);
    case 'EPS_EST':
      return typeof v === 'number' ? `$${v.toFixed(2)}` : String(v);
    case 'DATE':
    case 'TIME':
      return String(v).replace(/^time-/, '').replace(/-/g, ' ');
    case 'SYMBOL':
    case 'NAME':
    case 'SECTOR':
    case 'INDUSTRY':
    case 'COUNTRY':
    case 'EXCHANGE':
    case 'FISCAL_Q':
      return String(v);
  }

  if (typeof v === 'number') {
    if (/cap|enterprise/i.test(key)) return wfFormatCap(v);
    if (/pct|percent|change|chg|return|growth|margin|yield|payout/i.test(key))
      return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    if (/price|close|open|high|low|last|ask|bid|strike/i.test(key))
      return `$${v.toFixed(2)}`;
    if (/vol(?!atility)/i.test(key))
      return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
    if (/ratio|pe|eps|beta/i.test(key))
      return v.toFixed(2);
    if (Math.abs(v) >= 1e9) return wfFormatCap(v);
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toFixed(2);
  }
  return String(v);
}

function wfCellClass(col, v) {
  if (typeof v !== 'number') return '';
  const semantic = col && col.semantic ? col.semantic : '';
  const key = (col && col.key ? col.key : '').toLowerCase();
  const isChange =
    semantic === 'CHANGE_PCT' ||
    semantic === 'CHANGE_ABS' ||
    /pct|change|chg|return/i.test(key);
  if (!isChange) return '';
  if (v > 0) return 'wf-cell--up';
  if (v < 0) return 'wf-cell--down';
  return '';
}

function wfTitleCase(key) {
  if (!key) return '';
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function wfFormatCell(v) { return wfFormatValue(v, null); }

function wfFormatCap(n) {
  if (!n) return 'n/a';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n)}`;
}

/* ─────────────────────────────────────────────────────────────────
   Final report (right pane) + export
   ───────────────────────────────────────────────────────────────── */

async function wfRenderReport(data) {
  const body = document.getElementById('wf-report-body');
  if (!body) return;

  const text = data.text || '';
  const formatted = wfFormatMarkdown(text);
  body.innerHTML = `
    <div class="wf-report-text">${formatted}</div>
    <div class="wf-report__section">Widget snapshots</div>
    <div class="wf-report-shots" id="wf-report-shots">
      <div class="wf-empty-inline">capturing…</div>
    </div>
  `;

  const shotsEl = document.getElementById('wf-report-shots');
  shotsEl.innerHTML = '';
  try {
    const h2c = await wfLoadHtml2Canvas();
    for (const [stepId, el] of Object.entries(WF.renderedSteps)) {
      try {
        const canvas = await h2c(el, {
          backgroundColor: null, scale: 1.5, logging: false,
        });
        const img = document.createElement('img');
        img.className = 'wf-report-shot';
        img.src = canvas.toDataURL('image/png');
        img.alt = stepId;
        const wrap = document.createElement('div');
        wrap.className = 'wf-report-shot-wrap';
        wrap.innerHTML = `<div class="wf-report-shot-label">${escHtml(stepId)}</div>`;
        wrap.appendChild(img);
        shotsEl.appendChild(wrap);
      } catch (err) { console.warn('html2canvas failed for', stepId, err); }
    }
    document.getElementById('wf-export-btn').disabled = false;
  } catch (err) {
    shotsEl.innerHTML = `<div class="wf-empty-inline">Screenshot capture unavailable</div>`;
    document.getElementById('wf-export-btn').disabled = false;
  }
}

async function wfExportReport() {
  if (!WF.finalReport) { showToast('No report to export yet'); return; }

  const btn = document.getElementById('wf-export-btn');
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }

  const shots = [];
  try {
    const h2c = await wfLoadHtml2Canvas();
    for (const [stepId, el] of Object.entries(WF.renderedSteps)) {
      try {
        const canvas = await h2c(el, {
          backgroundColor: '#ffffff', scale: 2, logging: false,
        });
        shots.push({
          stepId,
          label: (WF.stepResults[stepId] && WF.stepResults[stepId].metadata
            && WF.stepResults[stepId].metadata.tool) || stepId,
          dataUrl: canvas.toDataURL('image/png'),
        });
      } catch (err) { console.warn('html2canvas failed for', stepId, err); }
    }
  } catch (err) { console.warn('html2canvas unavailable:', err); }

  const html = wfBuildReportHtml(shots);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(WF.workflowName || 'workflow').replace(/\s+/g, '_')}_${Date.now()}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    showToast('Popup blocked — downloaded instead');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  if (btn) { btn.disabled = false; btn.textContent = prev || 'Export'; }
}

function wfBuildReportHtml(shots) {
  const textHtml = wfFormatMarkdown(WF.finalReport.text || '');
  const shotsHtml = shots.map((s) => `
    <figure>
      <figcaption>${escHtml(s.label)}</figcaption>
      <img src="${s.dataUrl}" alt="${escHtml(s.label)}" />
    </figure>
  `).join('');

  const stepBlocks = (WF.finalReport.steps || []).map((s) => {
    const r = s.result || {};
    const meta = r.metadata || {};
    const elapsed = meta.elapsed_ms ? `${meta.elapsed_ms}ms` : '';
    const toolName = meta.tool || s.step_id;
    return `
      <div class="step">
        <div class="step-head">
          <span class="step-tool">${escHtml(toolName)}</span>
          <span class="step-id">${escHtml(s.step_id)}</span>
          <span class="step-time">${escHtml(elapsed)}</span>
        </div>
        <div class="step-summary">${escHtml(r.summary || '')}</div>
        ${r.error ? `<div class="step-error">Error: ${escHtml(r.error)}</div>` : ''}
      </div>
    `;
  }).join('');

  const title = `${WF.workflowName || 'Workflow'} — Report`;
  const timestamp = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
  :root { --orange: #ff8c00; --text: #1a1a1f; --muted: #6a6f78; --border: #e0e0e5; --panel: #f8f8fa; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: var(--text);
         padding: 48px; max-width: 880px; margin: 0 auto; line-height: 1.55; font-size: 13px; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 16px 48px; margin: -48px -48px 24px;
             border-bottom: 1px solid var(--border); display: flex; justify-content: space-between;
             align-items: center; z-index: 10; }
  .toolbar h1 { margin: 0; font-size: 15px; color: var(--orange); font-family: 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.05em; }
  .btn { background: var(--orange); color: #fff; border: none; padding: 9px 18px; font-size: 12px; font-weight: 600;
         border-radius: 3px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: #e67e00; }
  .btn-secondary { background: transparent; color: var(--muted); border: 1px solid var(--border); margin-right: 8px; }
  h1.doc-title { font-size: 28px; margin: 0 0 4px; color: var(--text); font-weight: 700; }
  .meta { color: var(--muted); font-size: 11px; margin-bottom: 20px; font-family: 'JetBrains Mono', ui-monospace, monospace; }
  .focus { background: #fff8ee; border-left: 3px solid var(--orange); padding: 12px 16px; margin: 16px 0 28px;
           font-style: italic; color: #5a4a20; border-radius: 0 3px 3px 0; }
  h2 { color: var(--orange); margin: 36px 0 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
       border-bottom: 1px solid var(--border); padding-bottom: 6px; font-family: 'JetBrains Mono', ui-monospace, monospace; }
  h3 { font-size: 13px; margin: 20px 0 8px; color: var(--text); }
  strong { color: var(--text); }
  code { background: var(--panel); padding: 2px 6px; border-radius: 2px; font-size: 11px; color: #c05000;
         font-family: 'JetBrains Mono', ui-monospace, monospace; }
  ul { padding-left: 22px; } li { margin: 4px 0; }
  .step { background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--orange);
          padding: 12px 14px; margin: 10px 0; border-radius: 0 3px 3px 0; break-inside: avoid; }
  .step-head { display: flex; gap: 10px; align-items: baseline; font-family: 'JetBrains Mono', ui-monospace, monospace;
               font-size: 10px; margin-bottom: 6px; }
  .step-tool { color: var(--orange); font-weight: 700; letter-spacing: 0.05em; }
  .step-id { color: var(--muted); } .step-time { color: var(--muted); margin-left: auto; }
  .step-summary { font-size: 12px; color: var(--text); }
  .step-error { color: #c62828; font-size: 11px; margin-top: 6px; }
  figure { margin: 16px 0; border: 1px solid var(--border); padding: 10px; background: #fff; border-radius: 3px; break-inside: avoid; }
  figcaption { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9px; color: var(--muted);
               text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
  figure img { max-width: 100%; display: block; border-radius: 2px; }
  @media print {
    body { padding: 0; max-width: none; font-size: 11px; }
    .toolbar { display: none; }
    h2 { page-break-after: avoid; }
    .step, figure { page-break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
  @page { margin: 1.5cm; size: A4; }
</style></head>
<body>
  <div class="toolbar">
    <h1>${escHtml(WF.workflowName || 'Workflow')} — REPORT</h1>
    <div>
      <button class="btn btn-secondary" onclick="window.close()">Close</button>
      <button class="btn" onclick="window.print()">Save as PDF</button>
    </div>
  </div>
  <h1 class="doc-title">${escHtml(WF.workflowName || 'Workflow')}</h1>
  <div class="meta">Generated ${escHtml(timestamp)} · Run complete</div>
  ${WF.focus ? `<div class="focus"><strong>Focus:</strong> ${escHtml(WF.focus)}</div>` : ''}
  <h2>Analysis</h2>
  <div class="analysis">${textHtml}</div>
  <h2>Step Results</h2>
  ${stepBlocks || '<p>No steps recorded.</p>'}
  <h2>Captured Widgets</h2>
  ${shotsHtml || '<p>No widget snapshots available.</p>'}
  <script>
    window.addEventListener('load', function() {
      var b = document.querySelector('.toolbar .btn:not(.btn-secondary)');
      if (b) b.focus();
    });
  </script>
</body></html>`;
}

function wfFormatMarkdown(text) {
  return escHtml(text)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '<br><br>');
}

function wfShowError(msg) {
  const stream = document.getElementById('wf-stream');
  if (stream) {
    stream.innerHTML = `<div class="wf-placeholder wf-placeholder--error">Error: ${escHtml(msg)}</div>`;
  } else {
    showToast('WF error: ' + msg);
  }
}

/* ─────────────────────────────────────────────────────────────────
   NL compile — compiles a description, then opens the builder with
   the result prefilled so the user can tweak before running.
   ───────────────────────────────────────────────────────────────── */

async function wfCompileFromNL() {
  const inp = document.getElementById('wf-nl-input');
  const text = inp.value.trim();
  if (!text) return;
  const btn = document.getElementById('wf-nl-btn');
  btn.disabled = true;
  btn.textContent = 'Compiling…';
  try {
    const bodyObj = { text };
    if (window.User?.llm_keys) bodyObj.llm_keys = window.User.llm_keys;
    const res = await fetch('/api/wf/nl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const data = await res.json();
    if (data.error) { showToast('NL compile: ' + data.error); return; }

    // Open the compiled spec in the builder — user can edit, then save or run
    wfShowBuilder(data.spec);
  } catch (err) {
    showToast('NL compile failed: ' + err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Compile → Edit';
  }
}

// Expose for app.js
window.renderWorkflowHub = renderWorkflowHub;
window.wfUpdateAgentLabel = wfUpdateAgentLabel;
