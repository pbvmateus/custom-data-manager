// src/app.js
// SAP FSM Custom Objects Manager
// Runs as a Shell SDK extension inside the FSM Shell home screen.
//
// Auth: No credentials needed here. The user is already logged into the Shell.
// We simply emit REQUIRE_CONTEXT and the Shell returns the active session token
// along with cloudHost, account, company — everything we need to call the FSM APIs.

'use strict';

// ── App State ──────────────────────────────────────────────────────────────
let shellCtx     = null;
let apiConfig    = null;   // { clusterHost, account, company }
let authToken    = null;   // Bearer token from the Shell's active session

let allObjects   = [];
let selectedObj  = null;
let fieldDefs    = [];
let allRecords   = [];
let filteredRecs = [];
let editingRec   = null;
let isNew        = false;

// Table state
let sortCol    = null;
let sortDir    = 'asc';
let colOrder   = [];
let colWidths  = {};
let hiddenCols = new Set();
let dragSrcIdx = null;

// ── Shell SDK Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const { ShellSdk, SHELL_EVENTS } = window;

  if (!ShellSdk || !ShellSdk.isInsideShell()) {
    // Running outside Shell (local dev). Show UI without data.
    console.warn('[FSM-Ext] Not inside Shell — dev mode.');
    document.getElementById('loadMsg').textContent = 'Running outside Shell (dev mode)';
    setTimeout(() => {
      document.getElementById('loadingScreen').style.display = 'none';
      document.getElementById('app').classList.add('ready');
      setConn('err', 'Dev mode — no Shell session');
      bindEvents();
      renderObjList([]);
    }, 600);
    return;
  }

  const sdk = ShellSdk.init(window.parent, '*');

  sdk.on(SHELL_EVENTS.ERROR, (err) => {
    console.error('[FSM-Ext] Shell error:', err);
    document.getElementById('loadMsg').textContent = `Shell error: ${err}`;
  });

  // Ask the Shell for the current session context.
  // The Shell owns authentication — no credentials are sent from here.
  // It responds with the active user's token and environment details.
  sdk.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
    auth: { response_type: 'token' }
  });

  sdk.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, (ctx) => {
    shellCtx  = ctx;

    // Extensions receive the token under ctx.auth.access_token
    authToken = ctx.auth?.access_token || ctx.authToken || null;

    apiConfig = {
      clusterHost: ctx.cloudHost,
      account:     ctx.account,
      company:     ctx.company,
    };

    console.log('[FSM-Ext] Shell context received:', {
      cloudHost: ctx.cloudHost,
      account:   ctx.account,
      company:   ctx.company,
      user:      ctx.user,
      hasToken:  !!authToken,
    });

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('app').classList.add('ready');
    setConn('ok', `${ctx.company} · ${ctx.cloudHost}`);
    bindEvents();
    loadObjects();
  });
});

// ── Connection status ──────────────────────────────────────────────────────
function setConn(state, label) {
  const dot = document.getElementById('connDot');
  const lbl = document.getElementById('connLabel');
  dot.className = 'dot ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'busy');
  lbl.textContent = label || '';
}

// ── Panel helpers ──────────────────────────────────────────────────────────
function showPanel(id) {
  ['panelEmpty', 'panelRecords', 'panelDetail'].forEach(p => {
    document.getElementById(p).classList.toggle('show', p === id);
  });
}

// ── Load Custom Objects ────────────────────────────────────────────────────
async function loadObjects() {
  const list = document.getElementById('objList');
  list.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading objects…</div>';
  try {
    allObjects = await FSM_API.getCustomObjects(apiConfig, authToken);
    FSM_API._cachedObjects = allObjects;
    renderObjList(allObjects, document.getElementById('objSearch').value);
  } catch (e) {
    list.innerHTML = `<div style="padding:10px 8px;font-size:11px;color:var(--red)">${esc(e.message)}</div>`;
  }
}

function renderObjList(objects, filter = '') {
  const list   = document.getElementById('objList');
  const shown  = filter
    ? objects.filter(o => (o.name || '').toLowerCase().includes(filter.toLowerCase()))
    : objects;

  if (shown.length === 0) {
    list.innerHTML = `<div style="padding:10px 8px;font-size:11px;color:var(--muted)">
      ${filter ? `No results for "${esc(filter)}"` : 'No custom objects found.'}
    </div>`;
    return;
  }

  list.innerHTML = shown.map(obj => {
    const name   = obj.name || obj.id || '—';
    const abbr   = name.substring(0, 2).toUpperCase();
    const active = selectedObj && selectedObj.id === obj.id;
    return `
      <div class="obj-item ${active ? 'active' : ''}" data-id="${esc(obj.id)}">
        <div class="obj-avatar">${abbr}</div>
        <div style="min-width:0">
          <div class="obj-name">${esc(name)}</div>
          <div class="obj-sub">${esc(obj.id || '')}</div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.obj-item').forEach(el => {
    el.addEventListener('click', () => selectObject(el.dataset.id));
  });
}

// ── Select Object ──────────────────────────────────────────────────────────
async function selectObject(id) {
  selectedObj = allObjects.find(o => o.id === id);
  if (!selectedObj) return;

  renderObjList(allObjects, document.getElementById('objSearch').value);

  allRecords = []; filteredRecs = []; colOrder = [];
  sortCol = null; sortDir = 'asc'; hiddenCols = new Set();
  showPanel('panelRecords');
  document.getElementById('recTitle').textContent     = selectedObj.name;
  document.getElementById('recCount').textContent     = '—';
  document.getElementById('tHead').innerHTML          = '';
  document.getElementById('tBody').innerHTML          = '';
  document.getElementById('tableEmpty').style.display = 'none';

  try {
    fieldDefs = await FSM_API.getCustomObjectFields(apiConfig, authToken, selectedObj.id);
  } catch (e) {
    console.warn('[FSM-Ext] getCustomObjectFields failed:', e.message);
    fieldDefs = [];
  }

  await loadRecords();
}

// ── Load Records ───────────────────────────────────────────────────────────
async function loadRecords() {
  const loading = document.getElementById('recLoading');
  const label   = document.getElementById('recLoadLabel');
  loading.style.display = 'flex';
  document.getElementById('tableEmpty').style.display = 'none';

  try {
    allRecords = await FSM_API.getUdoValues(
      apiConfig, authToken, selectedObj.id, fieldDefs,
      (n) => { label.textContent = `Loading records… ${n} fetched`; }
    );
    buildColOrder();
    filteredRecs = applyFilter(allRecords, document.getElementById('recSearch').value);
    renderTable();
    const tot = allRecords.length;
    document.getElementById('recCount').textContent = `${tot} record${tot !== 1 ? 's' : ''}`;
  } catch (e) {
    document.getElementById('tBody').innerHTML =
      `<tr><td colspan="99" style="padding:12px;color:var(--red)">${esc(e.message)}</td></tr>`;
  } finally {
    loading.style.display = 'none';
  }
}

// ── Column Order ───────────────────────────────────────────────────────────
function buildColOrder() {
  const sys  = ['id', 'createDateTime', 'lastChanged', 'createPerson', 'lastChangedBy'];
  colOrder   = fieldDefs.filter(f => !sys.includes(f.name)).map(f => f.name);
  if (allRecords.length > 0) {
    Object.keys(allRecords[0]).forEach(k => {
      if (!sys.includes(k) && !colOrder.includes(k)) colOrder.push(k);
    });
  }
}

// ── Filter / Sort ──────────────────────────────────────────────────────────
function applyFilter(recs, q) {
  if (!q) return recs;
  const lq = q.toLowerCase();
  return recs.filter(r =>
    Object.values(r).some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(lq))
  );
}

function applySorted(recs) {
  if (!sortCol) return recs;
  return [...recs].sort((a, b) => {
    const av = a[sortCol] ?? '', bv = b[sortCol] ?? '';
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

// ── Render Table ───────────────────────────────────────────────────────────
function renderTable() {
  const vis    = colOrder.filter(c => !hiddenCols.has(c));
  const sorted = applySorted(filteredRecs);

  document.getElementById('tHead').innerHTML = `<tr>${
    vis.map((col, ci) => {
      const w   = colWidths[col] || 140;
      const isc = sortCol === col;
      return `
        <th style="width:${w}px;min-width:60px" data-col="${esc(col)}" data-ci="${ci}" draggable="true">
          <div class="th-inner">
            <span class="grip" title="Drag to reorder">
              <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
                <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
                <circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>
                <circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>
              </svg>
            </span>
            <span class="th-label" title="${esc(col)}">${esc(col)}</span>
            <span class="sort-arrows ${isc ? sortDir : ''}">
              <svg class="arr-up"   width="7" height="5" viewBox="0 0 7 5"><path d="M3.5 0L7 5H0z" fill="currentColor"/></svg>
              <svg class="arr-down" width="7" height="5" viewBox="0 0 7 5"><path d="M3.5 5L0 0h7z" fill="currentColor"/></svg>
            </span>
          </div>
          <div class="resizer" data-col="${esc(col)}"></div>
        </th>`;
    }).join('')
  }</tr>`;

  if (sorted.length === 0) {
    document.getElementById('tBody').innerHTML = '';
    document.getElementById('tableEmpty').style.display = 'flex';
    return;
  }
  document.getElementById('tableEmpty').style.display = 'none';

  document.getElementById('tBody').innerHTML = sorted.map((rec, ri) => `
    <tr data-ri="${ri}">${
      vis.map(col => {
        const v = rec[col];
        let cell;
        if (v === null || v === undefined || v === '') {
          cell = '<span class="cell-nil">—</span>';
        } else if (v === true || v === 'true') {
          cell = '<span class="badge-bool-t">✓ true</span>';
        } else if (v === false || v === 'false') {
          cell = '<span class="badge-bool-f">false</span>';
        } else {
          cell = esc(String(v));
        }
        return `<td title="${esc(String(v ?? ''))}">${cell}</td>`;
      }).join('')
    }</tr>`).join('');

  document.getElementById('tBody').querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openRecord(sorted[parseInt(tr.dataset.ri, 10)]));
  });

  document.getElementById('tHead').querySelectorAll('.th-inner').forEach(inner => {
    inner.addEventListener('click', e => {
      if (e.target.closest('.grip')) return;
      const col = inner.closest('th').dataset.col;
      sortDir   = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      sortCol   = col;
      renderTable();
    });
  });

  bindColDrag();
  bindColResize();
}

// ── Column Drag-to-Reorder ─────────────────────────────────────────────────
function bindColDrag() {
  const ths = document.querySelectorAll('#tHead th');
  ths.forEach(th => {
    th.addEventListener('dragstart', e => {
      dragSrcIdx = parseInt(th.dataset.ci, 10);
      th.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragend', () => {
      th.classList.remove('dragging');
      ths.forEach(t => t.classList.remove('drag-over'));
    });
    th.addEventListener('dragover', e => {
      e.preventDefault();
      ths.forEach(t => t.classList.remove('drag-over'));
      th.classList.add('drag-over');
    });
    th.addEventListener('drop', e => {
      e.preventDefault();
      const dest = parseInt(th.dataset.ci, 10);
      if (dragSrcIdx !== null && dragSrcIdx !== dest) {
        const vis     = colOrder.filter(c => !hiddenCols.has(c));
        const srcName = vis[dragSrcIdx];
        const dstName = vis[dest];
        const si = colOrder.indexOf(srcName);
        const di = colOrder.indexOf(dstName);
        colOrder.splice(si, 1);
        colOrder.splice(di, 0, srcName);
        renderTable();
      }
      dragSrcIdx = null;
    });
  });
}

// ── Column Resize ──────────────────────────────────────────────────────────
function bindColResize() {
  document.querySelectorAll('.resizer').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      const col = handle.dataset.col;
      const th  = handle.closest('th');
      const sx  = e.clientX;
      const sw  = colWidths[col] || th.offsetWidth;
      handle.classList.add('active');
      const move = mv => {
        colWidths[col]  = Math.max(60, sw + (mv.clientX - sx));
        th.style.width  = colWidths[col] + 'px';
      };
      const up = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

// ── Open / New Record ──────────────────────────────────────────────────────
function openRecord(rec) {
  editingRec = rec; isNew = false;
  document.getElementById('detailTitle').textContent = rec.id
    ? `Record: ${String(rec.id).substring(0, 12)}…`
    : 'Record Detail';
  const badge     = document.getElementById('detailBadge');
  badge.textContent = 'EXISTING';
  badge.className   = 'hero-badge existing';
  document.getElementById('deleteBtn').style.display = 'inline-flex';
  hideSaveBar();
  renderDetailForm(rec);
  showPanel('panelDetail');
}

function openNewRecord() {
  editingRec = {}; isNew = true;
  document.getElementById('detailTitle').textContent = 'New Record';
  const badge     = document.getElementById('detailBadge');
  badge.textContent = 'NEW';
  badge.className   = 'hero-badge';
  document.getElementById('deleteBtn').style.display = 'none';
  hideSaveBar();
  renderDetailForm({});
  showPanel('panelDetail');
}

// ── Render Detail Form ─────────────────────────────────────────────────────
function renderDetailForm(rec) {
  const SYS      = ['id', 'createDateTime', 'lastChanged', 'createPerson', 'lastChangedBy'];
  const editable = fieldDefs.filter(f => !SYS.includes(f.name));
  const sysShown = fieldDefs.filter(f => SYS.includes(f.name) && rec[f.name] !== undefined);

  let html = '';

  editable.forEach(f => {
    const val    = rec[f.name] ?? f.defaultValue ?? '';
    const lbl    = f.label || f.name;
    const type   = (f.dataType || f.type || 'STRING').toUpperCase();
    const isLong = type === 'STRING' && /description|note|comment/i.test(f.name);
    html += `<div class="field-wrap${isLong ? ' full' : ''}" data-fname="${esc(f.name)}">
      <label class="field-lbl">
        ${esc(lbl)}
        ${f.mandatory ? '<span class="req-star">*</span>' : ''}
        <span class="type-tag">${type}</span>
      </label>
      ${buildInput(f, val)}
    </div>`;
  });

  // Fallback: no fieldDefs — show raw record keys
  if (editable.length === 0) {
    Object.entries(rec).forEach(([k, v]) => {
      if (SYS.includes(k)) return;
      html += `<div class="field-wrap" data-fname="${esc(k)}">
        <label class="field-lbl">${esc(k)}</label>
        <input class="field-ctrl" data-field="${esc(k)}" type="text" value="${esc(String(v ?? ''))}">
      </div>`;
    });
  }

  if (sysShown.length > 0) {
    html += `<div class="sys-divider"><div class="sys-label">System Fields</div></div>`;
    sysShown.forEach(f => {
      html += `<div class="field-wrap">
        <label class="field-lbl">${esc(f.name)}</label>
        <div class="field-ro">${esc(String(rec[f.name] ?? ''))}</div>
      </div>`;
    });
  }

  const form = document.getElementById('detailForm');
  form.innerHTML = html;

  // Boolean checkbox label sync
  form.querySelectorAll('input[type="checkbox"][data-field]').forEach(cb => {
    const span = cb.nextElementSibling;
    if (span) cb.addEventListener('change', () => { span.textContent = cb.checked ? 'True' : 'False'; });
  });
}

function buildInput(f, val) {
  const type = (f.dataType || f.type || 'STRING').toUpperCase();
  const name = f.name;

  if (type === 'BOOLEAN') {
    const chk = val === true || val === 'true' || val === '1' || val === 'yes';
    return `<div class="bool-row">
      <input class="field-ctrl" type="checkbox" data-field="${esc(name)}" ${chk ? 'checked' : ''}>
      <span>${chk ? 'True' : 'False'}</span>
    </div>`;
  }
  if (type === 'SELECTIONLIST' && f.allowedValues?.length) {
    const opts = f.allowedValues.map(av =>
      `<option value="${esc(av.key)}" ${val === av.key ? 'selected' : ''}>${esc(av.label || av.key)}</option>`
    ).join('');
    return `<select class="field-ctrl" data-field="${esc(name)}"><option value="">— select —</option>${opts}</select>`;
  }
  if (type === 'SELECTIONLISTWITHFREETEXT') {
    const lid  = `dl_${name}`;
    const opts = (f.allowedValues || []).map(av => `<option value="${esc(av.key)}">`).join('');
    return `<input class="field-ctrl" list="${lid}" data-field="${esc(name)}" value="${esc(String(val ?? ''))}">
      <datalist id="${lid}">${opts}</datalist>`;
  }
  if (type === 'DATE')     return `<input class="field-ctrl" type="date"           data-field="${esc(name)}" value="${esc(String(val ?? '').substring(0, 10))}">`;
  if (type === 'DATETIME') return `<input class="field-ctrl" type="datetime-local"  data-field="${esc(name)}" value="${esc(String(val ?? '').substring(0, 16))}">`;
  if (type === 'TIME')     return `<input class="field-ctrl" type="time"           data-field="${esc(name)}" value="${esc(String(val ?? ''))}">`;
  if (type === 'INT')      return `<input class="field-ctrl" type="number" step="1" data-field="${esc(name)}" value="${esc(String(val ?? ''))}">`;
  if (['FLOAT','PERCENTAGE','UNIT','MONETARYAMOUNT'].includes(type))
    return `<input class="field-ctrl" type="number" step="any" data-field="${esc(name)}" value="${esc(String(val ?? ''))}">`;
  if (/description|note|comment/i.test(name))
    return `<textarea class="field-ctrl" data-field="${esc(name)}">${esc(String(val ?? ''))}</textarea>`;

  return `<input class="field-ctrl" type="text" data-field="${esc(name)}" value="${esc(String(val ?? ''))}">`;
}

// ── Collect Form ───────────────────────────────────────────────────────────
function collectForm() {
  const record = {};
  document.getElementById('detailForm').querySelectorAll('[data-field]').forEach(el => {
    record[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return record;
}

// ── Save ───────────────────────────────────────────────────────────────────
async function saveRecord() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  try {
    const values       = collectForm();
    const fieldMetaMap = {};
    fieldDefs.forEach(f => { if (f.name) fieldMetaMap[f.name] = { id: f.id, name: f.name }; });

    await FSM_API.upsertRecord(
      apiConfig, authToken,
      selectedObj.name, values,
      fieldMetaMap, selectedObj.id
    );
    showSaveBar('ok', '✓ Saved successfully');
    await loadRecords();
  } catch (e) {
    showSaveBar('err', `✗ ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
async function deleteRecord() {
  if (!editingRec) return;
  const ok = await showConfirm('Delete Record', 'Are you sure you want to permanently delete this record?');
  if (!ok) return;

  const recId = editingRec.id;
  if (!recId) { showSaveBar('err', '✗ Record has no ID — cannot delete.'); return; }

  try {
    const { clusterHost, account, company } = apiConfig;
    const url = `https://${clusterHost}/api/data/v4/UdoValue/${recId}?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=UdoValue.10`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization:    `Bearer ${authToken}`,
        'X-Account-Name': account,
        'X-Company-Name': company,
        'X-Client-Version': '1.0',
      },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Delete failed (${res.status}): ${err}`);
    }
    showPanel('panelRecords');
    await loadRecords();
  } catch (e) {
    showSaveBar('err', `✗ ${e.message}`);
  }
}

// ── Export CSV ─────────────────────────────────────────────────────────────
function exportCsv() {
  if (!filteredRecs.length) return;
  const cols   = colOrder.filter(c => !hiddenCols.has(c));
  const header = cols.join(',');
  const rows   = filteredRecs.map(r =>
    cols.map(c => {
      const v = String(r[c] ?? '');
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')
  );
  CSV_UTILS.downloadCsv(`${selectedObj.name}_records.csv`, [header, ...rows].join('\n'));
}

// ── Save bar ───────────────────────────────────────────────────────────────
function showSaveBar(type, msg) {
  const bar = document.getElementById('saveBar');
  bar.className    = `save-bar ${type}`;
  bar.textContent  = msg;
  bar.style.display = 'flex';
  if (type === 'ok') setTimeout(() => { bar.style.display = 'none'; }, 3000);
}
function hideSaveBar() {
  document.getElementById('saveBar').style.display = 'none';
}

// ── Confirm dialog ─────────────────────────────────────────────────────────
function showConfirm(title, msg) {
  return new Promise(res => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="dialog">
        <h3>${esc(title)}</h3>
        <p>${esc(msg)}</p>
        <div class="dialog-acts">
          <button class="btn btn-ghost" id="_cfmNo">Cancel</button>
          <button class="btn btn-danger" id="_cfmYes">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#_cfmNo').addEventListener('click',  () => { ov.remove(); res(false); });
    ov.querySelector('#_cfmYes').addEventListener('click', () => { ov.remove(); res(true);  });
  });
}

// ── Bind Events ────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('objSearch').addEventListener('input', e => {
    renderObjList(allObjects, e.target.value);
  });
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    selectedObj = null; fieldDefs = []; allRecords = []; filteredRecs = [];
    showPanel('panelEmpty');
    await loadObjects();
  });
  document.getElementById('recSearch').addEventListener('input', e => {
    filteredRecs = applyFilter(allRecords, e.target.value);
    renderTable();
    const tot = allRecords.length, vis = filteredRecs.length;
    document.getElementById('recCount').textContent =
      vis === tot ? `${tot} record${tot !== 1 ? 's' : ''}` : `${vis} of ${tot}`;
  });
  document.getElementById('newRecBtn').addEventListener('click',  () => openNewRecord());
  document.getElementById('exportBtn').addEventListener('click',  () => exportCsv());
  document.getElementById('backBtn').addEventListener('click',    () => showPanel('panelRecords'));
  document.getElementById('saveBtn').addEventListener('click',    () => saveRecord());
  document.getElementById('deleteBtn').addEventListener('click',  () => deleteRecord());
}

// ── Utils ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
