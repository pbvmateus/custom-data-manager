// app.js — Custom Objects Manager
// Follows the "with-shell-navigation" sample pattern from:
// https://github.com/SAP-samples/fsm-extension-sample/tree/main/samples/with-shell-navigation
//
// Key pattern:
//   1. ShellSdk.init(parent, '*')
//   2. emit REQUIRE_CONTEXT with clientIdentifier (identifies this extension to the Shell)
//   3. on REQUIRE_CONTEXT → receive token + env, start app
//   4. emit SET_TITLE whenever the user navigates to update the Shell top bar
//   5. on BACK_BUTTON → handle internal back navigation

(function () {
  'use strict';

  // ── Shell SDK setup ──────────────────────────────────────────────────────
  const { ShellSdk, SHELL_EVENTS } = window;

  let shellSdk   = null;
  let apiConfig  = null;
  let authToken  = null;

  // ── Navigation stack ─────────────────────────────────────────────────────
  // Each entry: { viewId: string, title: string }
  const stack = [];

  function navigate(viewId, title) {
    stack.push({ viewId, title });
    _applyNav();
  }

  function goBack() {
    if (stack.length <= 1) return;
    stack.pop();
    _applyNav();
  }

  function _applyNav() {
    const current = stack[stack.length - 1];
    if (!current) return;

    // Show the correct view
    document.querySelectorAll('.view').forEach(v =>
      v.classList.toggle('active', v.id === current.viewId)
    );

    // Tell the Shell what page we're on — it updates its title bar
    if (shellSdk) {
      shellSdk.emit(SHELL_EVENTS.Version1.SET_TITLE, current.title);
    }
  }

  // ── App state ─────────────────────────────────────────────────────────────
  let allObjects   = [];
  let selectedObj  = null;
  let fieldDefs    = [];
  let allRecords   = [];
  let filteredRecs = [];
  let editingRec   = null;

  // Table state
  let sortCol    = null;
  let sortDir    = 'asc';
  let colOrder   = [];
  let colWidths  = {};
  let hiddenCols = new Set();
  let dragSrcIdx = null;

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    DBG.init();

    if (!ShellSdk || !ShellSdk.isInsideShell()) {
      // Running outside Shell (local dev / GitHub Pages direct access)
      console.warn('[Custom Objects] Not inside Shell — dev mode');
      document.getElementById('load-msg').textContent =
        'Not inside Shell. Open via FSM extension outlet.';
      DBG.setCtx({
        _status:  'NOT_INSIDE_SHELL',
        _message: 'ShellSdk.isInsideShell() returned false.',
        _hint:    'This extension must be opened from within the FSM Shell outlet, not directly in a browser.',
      });
      // Still show the UI so the layout is visible
      document.getElementById('loading').style.display = 'none';
      document.getElementById('app').classList.add('show');
      navigate('view-list', 'Custom Objects');
      bindUI();
      renderObjList([]);
      return;
    }

    // Init Shell SDK — parent window is the Shell host
    shellSdk = ShellSdk.init(parent, '*');

    // Error handler — highly recommended by SAP to avoid infinite retry loops
    shellSdk.on(SHELL_EVENTS.ERROR, function (err) {
      console.error('[Custom Objects] Shell error:', err);
      DBG.logError(err);
    });

    // Shell back button → our internal back navigation
    shellSdk.on(SHELL_EVENTS.Version1.BACK_BUTTON, function () {
      goBack();
    });

    // Request context from Shell.
    // clientIdentifier tells the Shell which extension this is.
    // The Shell returns the active session token — no separate OAuth needed.
    shellSdk.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
      clientIdentifier: 'fsm-custom-objects-manager',
      auth: { response_type: 'token' },
    });

    shellSdk.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, function (ctx) {
      // Extensions receive the token under auth.access_token
      authToken = (ctx.auth && ctx.auth.access_token) || ctx.authToken || null;

      apiConfig = {
        clusterHost: ctx.cloudHost,
        account:     ctx.account,
        company:     ctx.company,
      };

      DBG.setCtx(ctx);
      console.log('[Custom Objects] Context:', {
        cloudHost: ctx.cloudHost,
        account:   ctx.account,
        company:   ctx.company,
        user:      ctx.user,
        hasToken:  !!authToken,
      });

      // Hide loading, show app
      document.getElementById('loading').style.display = 'none';
      document.getElementById('app').classList.add('show');

      // Start at object list — SET_TITLE sets the Shell top-bar title
      navigate('view-list', 'Custom Objects');
      bindUI();
      loadObjects();
    });
  });

  // ── Load objects ──────────────────────────────────────────────────────────
  function loadObjects() {
    var list = document.getElementById('obj-list');
    list.innerHTML = '<div class="loading-row"><div class="spinner"></div>Loading objects…</div>';

    FSM_API.getCustomObjects(apiConfig, authToken)
      .then(function (objects) {
        allObjects = objects;
        FSM_API._cachedObjects = objects;
        renderObjList(objects, document.getElementById('obj-search').value);
      })
      .catch(function (err) {
        list.innerHTML = '<div class="list-err">' + esc(err.message) + '</div>';
      });
  }

  function renderObjList(objects, filter) {
    filter = filter || '';
    var list   = document.getElementById('obj-list');
    var shown  = filter
      ? objects.filter(function (o) { return (o.name || '').toLowerCase().includes(filter.toLowerCase()); })
      : objects;

    if (!shown.length) {
      list.innerHTML = '<div class="list-msg">' +
        (filter ? 'No results for "' + esc(filter) + '"' : 'No custom objects found.') +
        '</div>';
      return;
    }

    list.innerHTML = shown.map(function (obj) {
      var name   = obj.name || obj.id || '—';
      var abbr   = name.substring(0, 2).toUpperCase();
      var active = selectedObj && selectedObj.id === obj.id ? ' selected' : '';
      return '<div class="obj-item' + active + '" data-id="' + esc(obj.id) + '">' +
        '<div class="obj-avatar">' + abbr + '</div>' +
        '<div class="obj-info">' +
          '<div class="obj-name">' + esc(name) + '</div>' +
          '<div class="obj-id">'  + esc(obj.id || '') + '</div>' +
        '</div>' +
        '<svg class="obj-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none">' +
          '<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.obj-item').forEach(function (el) {
      el.addEventListener('click', function () { selectObject(el.dataset.id); });
    });
  }

  // ── Select object → navigate to records ───────────────────────────────────
  function selectObject(id) {
    selectedObj = allObjects.find(function (o) { return o.id === id; });
    if (!selectedObj) return;

    renderObjList(allObjects, document.getElementById('obj-search').value);

    // Reset records state
    allRecords = []; filteredRecs = []; colOrder = [];
    sortCol = null; sortDir = 'asc'; hiddenCols = new Set();
    document.getElementById('rec-title').textContent  = selectedObj.name;
    document.getElementById('rec-count').textContent  = '—';
    document.getElementById('t-head').innerHTML       = '';
    document.getElementById('t-body').innerHTML       = '';
    document.getElementById('tbl-empty').style.display = 'none';
    document.getElementById('rec-filter').value       = '';

    // SET_TITLE: Shell title bar shows the object name
    navigate('view-records', selectedObj.name);

    FSM_API.getCustomObjectFields(apiConfig, authToken, selectedObj.id)
      .then(function (fields) { fieldDefs = fields; })
      .catch(function (err) {
        console.warn('[Custom Objects] getCustomObjectFields failed:', err.message);
        fieldDefs = [];
      })
      .finally(function () { loadRecords(); });
  }

  // ── Load records ──────────────────────────────────────────────────────────
  function loadRecords() {
    var loading = document.getElementById('rec-loading');
    var lbl     = document.getElementById('rec-load-lbl');
    loading.style.display = 'flex';
    document.getElementById('tbl-empty').style.display = 'none';

    FSM_API.getUdoValues(apiConfig, authToken, selectedObj.id, fieldDefs, function (n) {
      lbl.textContent = 'Loading… ' + n + ' records fetched';
    })
      .then(function (records) {
        allRecords   = records;
        buildColOrder();
        filteredRecs = applyFilter(records, document.getElementById('rec-filter').value);
        renderTable();
        var tot = records.length;
        document.getElementById('rec-count').textContent = tot + ' record' + (tot !== 1 ? 's' : '');
      })
      .catch(function (err) {
        document.getElementById('t-body').innerHTML =
          '<tr><td colspan="99" style="padding:12px;color:var(--sap-red)">' + esc(err.message) + '</td></tr>';
      })
      .finally(function () { loading.style.display = 'none'; });
  }

  // ── Column order ──────────────────────────────────────────────────────────
  function buildColOrder() {
    var sys = ['id','createDateTime','lastChanged','createPerson','lastChangedBy'];
    colOrder = fieldDefs.filter(function (f) { return !sys.includes(f.name); }).map(function (f) { return f.name; });
    if (allRecords.length) {
      Object.keys(allRecords[0]).forEach(function (k) {
        if (!sys.includes(k) && !colOrder.includes(k)) colOrder.push(k);
      });
    }
  }

  // ── Filter / sort ─────────────────────────────────────────────────────────
  function applyFilter(recs, q) {
    if (!q) return recs;
    var lq = q.toLowerCase();
    return recs.filter(function (r) {
      return Object.values(r).some(function (v) {
        return v !== null && v !== undefined && String(v).toLowerCase().includes(lq);
      });
    });
  }

  function applySorted(recs) {
    if (!sortCol) return recs;
    return recs.slice().sort(function (a, b) {
      var cmp = String(a[sortCol] || '').localeCompare(String(b[sortCol] || ''), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // ── Render table ──────────────────────────────────────────────────────────
  function renderTable() {
    var vis    = colOrder.filter(function (c) { return !hiddenCols.has(c); });
    var sorted = applySorted(filteredRecs);

    document.getElementById('t-head').innerHTML = '<tr>' + vis.map(function (col, ci) {
      var w   = colWidths[col] || 140;
      var isc = sortCol === col;
      return '<th style="width:' + w + 'px;min-width:60px" data-col="' + esc(col) + '" data-ci="' + ci + '" draggable="true">' +
        '<div class="th-inner">' +
          '<span class="drag-grip" title="Drag to reorder">' +
            '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">' +
              '<circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>' +
              '<circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>' +
              '<circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>' +
            '</svg>' +
          '</span>' +
          '<span class="th-label" title="' + esc(col) + '">' + esc(col) + '</span>' +
          '<span class="sort-ico ' + (isc ? sortDir : '') + '">' +
            '<svg class="arr-u" width="7" height="5" viewBox="0 0 7 5"><path d="M3.5 0L7 5H0z" fill="currentColor"/></svg>' +
            '<svg class="arr-d" width="7" height="5" viewBox="0 0 7 5"><path d="M3.5 5L0 0h7z" fill="currentColor"/></svg>' +
          '</span>' +
        '</div>' +
        '<div class="col-resizer" data-col="' + esc(col) + '"></div>' +
      '</th>';
    }).join('') + '</tr>';

    if (!sorted.length) {
      document.getElementById('t-body').innerHTML = '';
      document.getElementById('tbl-empty').style.display = 'flex';
      return;
    }
    document.getElementById('tbl-empty').style.display = 'none';

    document.getElementById('t-body').innerHTML = sorted.map(function (rec, ri) {
      return '<tr data-ri="' + ri + '">' + vis.map(function (col) {
        var v = rec[col];
        var cell;
        if (v === null || v === undefined || v === '') cell = '<span class="cell-nil">—</span>';
        else if (v === true  || v === 'true')  cell = '<span class="cell-t">✓ true</span>';
        else if (v === false || v === 'false') cell = '<span class="cell-f">false</span>';
        else cell = esc(String(v));
        return '<td title="' + esc(String(v == null ? '' : v)) + '">' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('');

    document.getElementById('t-body').querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () { openRecord(sorted[parseInt(tr.dataset.ri, 10)]); });
    });

    document.getElementById('t-head').querySelectorAll('.th-inner').forEach(function (inner) {
      inner.addEventListener('click', function (e) {
        if (e.target.closest('.drag-grip')) return;
        var col = inner.closest('th').dataset.col;
        sortDir = sortCol === col ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
        sortCol = col;
        renderTable();
      });
    });

    bindColDrag();
    bindColResize();
  }

  // ── Column drag-to-reorder ────────────────────────────────────────────────
  function bindColDrag() {
    var ths = document.querySelectorAll('#t-head th');
    ths.forEach(function (th) {
      th.addEventListener('dragstart', function (e) {
        dragSrcIdx = parseInt(th.dataset.ci, 10);
        th.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      th.addEventListener('dragend', function () {
        th.classList.remove('is-dragging');
        ths.forEach(function (t) { t.classList.remove('drag-target'); });
      });
      th.addEventListener('dragover', function (e) {
        e.preventDefault();
        ths.forEach(function (t) { t.classList.remove('drag-target'); });
        th.classList.add('drag-target');
      });
      th.addEventListener('drop', function (e) {
        e.preventDefault();
        var dest = parseInt(th.dataset.ci, 10);
        if (dragSrcIdx !== null && dragSrcIdx !== dest) {
          var vis = colOrder.filter(function (c) { return !hiddenCols.has(c); });
          var si  = colOrder.indexOf(vis[dragSrcIdx]);
          var di  = colOrder.indexOf(vis[dest]);
          colOrder.splice(si, 1);
          colOrder.splice(di, 0, vis[dragSrcIdx]);
          renderTable();
        }
        dragSrcIdx = null;
      });
    });
  }

  // ── Column resize ─────────────────────────────────────────────────────────
  function bindColResize() {
    document.querySelectorAll('.col-resizer').forEach(function (handle) {
      handle.addEventListener('mousedown', function (e) {
        e.stopPropagation(); e.preventDefault();
        var col = handle.dataset.col;
        var th  = handle.closest('th');
        var sx  = e.clientX;
        var sw  = colWidths[col] || th.offsetWidth;
        handle.classList.add('on');
        function onMove(mv) {
          colWidths[col]  = Math.max(60, sw + mv.clientX - sx);
          th.style.width  = colWidths[col] + 'px';
        }
        function onUp() {
          handle.classList.remove('on');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ── Open / new record ─────────────────────────────────────────────────────
  function openRecord(rec) {
    editingRec = rec;
    var label  = rec.id ? 'Record: ' + String(rec.id).substring(0, 12) + '…' : 'Record';
    document.getElementById('rec-title-detail').textContent = label;
    var badge = document.getElementById('rec-badge');
    badge.textContent = 'EXISTING'; badge.className = 'rec-badge is-existing';
    document.getElementById('btn-delete').style.display = 'inline-flex';
    hideSaveBar();
    renderForm(rec);
    // SET_TITLE: Shell title shows object + record
    navigate('view-detail', selectedObj.name + ' — Record');
  }

  function openNewRecord() {
    editingRec = {};
    document.getElementById('rec-title-detail').textContent = 'New Record';
    var badge = document.getElementById('rec-badge');
    badge.textContent = 'NEW'; badge.className = 'rec-badge is-new';
    document.getElementById('btn-delete').style.display = 'none';
    hideSaveBar();
    renderForm({});
    navigate('view-detail', selectedObj.name + ' — New Record');
  }

  // ── Render form ───────────────────────────────────────────────────────────
  function renderForm(rec) {
    var SYS      = ['id','createDateTime','lastChanged','createPerson','lastChangedBy'];
    var editable = fieldDefs.filter(function (f) { return !SYS.includes(f.name); });
    var sysShown = fieldDefs.filter(function (f) { return SYS.includes(f.name) && rec[f.name] !== undefined; });
    var html     = '';

    editable.forEach(function (f) {
      var val    = rec[f.name] != null ? rec[f.name] : (f.defaultValue != null ? f.defaultValue : '');
      var type   = (f.dataType || f.type || 'STRING').toUpperCase();
      var isLong = type === 'STRING' && /description|note|comment/i.test(f.name);
      html += '<div class="fld' + (isLong ? ' full' : '') + '">' +
        '<label class="fld-lbl">' +
          esc(f.label || f.name) +
          (f.mandatory ? '<span class="fld-req">*</span>' : '') +
          '<span class="fld-type">' + type + '</span>' +
        '</label>' +
        buildInput(f, val) +
      '</div>';
    });

    // Fallback: no fieldDefs
    if (!editable.length) {
      Object.keys(rec).forEach(function (k) {
        if (SYS.includes(k)) return;
        html += '<div class="fld"><label class="fld-lbl">' + esc(k) + '</label>' +
          '<input class="fld-ctrl" data-field="' + esc(k) + '" type="text" value="' + esc(String(rec[k] == null ? '' : rec[k])) + '"></div>';
      });
    }

    if (sysShown.length) {
      html += '<div class="sys-sep"><div class="sys-sep-label">System Fields</div></div>';
      sysShown.forEach(function (f) {
        html += '<div class="fld"><label class="fld-lbl">' + esc(f.name) + '</label>' +
          '<div class="fld-ro">' + esc(String(rec[f.name] == null ? '' : rec[f.name])) + '</div></div>';
      });
    }

    var form = document.getElementById('rec-form');
    form.innerHTML = html;

    form.querySelectorAll('input[type="checkbox"][data-field]').forEach(function (cb) {
      var sp = cb.nextElementSibling;
      if (sp) cb.addEventListener('change', function () { sp.textContent = cb.checked ? 'True' : 'False'; });
    });
  }

  function buildInput(f, val) {
    var type = (f.dataType || f.type || 'STRING').toUpperCase();
    var n    = f.name;
    var v    = String(val == null ? '' : val);

    if (type === 'BOOLEAN') {
      var chk = val === true || v === 'true' || v === '1' || v === 'yes';
      return '<div class="bool-row"><input class="fld-ctrl" type="checkbox" data-field="' + esc(n) + '"' + (chk ? ' checked' : '') + '><span>' + (chk ? 'True' : 'False') + '</span></div>';
    }
    if (type === 'SELECTIONLIST' && f.allowedValues && f.allowedValues.length) {
      var opts = f.allowedValues.map(function (av) {
        return '<option value="' + esc(av.key) + '"' + (v === av.key ? ' selected' : '') + '>' + esc(av.label || av.key) + '</option>';
      }).join('');
      return '<select class="fld-ctrl" data-field="' + esc(n) + '"><option value="">— select —</option>' + opts + '</select>';
    }
    if (type === 'SELECTIONLISTWITHFREETEXT') {
      var lid  = 'dl_' + n;
      var dopts = (f.allowedValues || []).map(function (av) { return '<option value="' + esc(av.key) + '">'; }).join('');
      return '<input class="fld-ctrl" list="' + lid + '" data-field="' + esc(n) + '" value="' + esc(v) + '"><datalist id="' + lid + '">' + dopts + '</datalist>';
    }
    if (type === 'DATE')     return '<input class="fld-ctrl" type="date"           data-field="' + esc(n) + '" value="' + esc(v.substring(0,10)) + '">';
    if (type === 'DATETIME') return '<input class="fld-ctrl" type="datetime-local"  data-field="' + esc(n) + '" value="' + esc(v.substring(0,16)) + '">';
    if (type === 'TIME')     return '<input class="fld-ctrl" type="time"           data-field="' + esc(n) + '" value="' + esc(v) + '">';
    if (type === 'INT')      return '<input class="fld-ctrl" type="number" step="1" data-field="' + esc(n) + '" value="' + esc(v) + '">';
    if (['FLOAT','PERCENTAGE','UNIT','MONETARYAMOUNT'].includes(type))
      return '<input class="fld-ctrl" type="number" step="any" data-field="' + esc(n) + '" value="' + esc(v) + '">';
    if (/description|note|comment/i.test(n))
      return '<textarea class="fld-ctrl" data-field="' + esc(n) + '">' + esc(v) + '</textarea>';
    return '<input class="fld-ctrl" type="text" data-field="' + esc(n) + '" value="' + esc(v) + '">';
  }

  function collectForm() {
    var rec = {};
    document.getElementById('rec-form').querySelectorAll('[data-field]').forEach(function (el) {
      rec[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return rec;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  function saveRecord() {
    var btn = document.getElementById('btn-save');
    btn.disabled = true;
    var values       = collectForm();
    var fieldMetaMap = {};
    fieldDefs.forEach(function (f) { if (f.name) fieldMetaMap[f.name] = { id: f.id, name: f.name }; });

    FSM_API.upsertRecord(apiConfig, authToken, selectedObj.name, values, fieldMetaMap, selectedObj.id)
      .then(function () {
        showSaveBar('ok', '✓ Saved successfully');
        return loadRecords();
      })
      .catch(function (err) { showSaveBar('err', '✗ ' + err.message); })
      .finally(function () { btn.disabled = false; });
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  function deleteRecord() {
    if (!editingRec) return;
    showConfirm('Delete Record', 'Are you sure you want to permanently delete this record?').then(function (ok) {
      if (!ok) return;
      var recId = editingRec.id;
      if (!recId) { showSaveBar('err', '✗ Record has no ID.'); return; }

      var clusterHost = apiConfig.clusterHost;
      var account     = apiConfig.account;
      var company     = apiConfig.company;
      var url = 'https://' + clusterHost + '/api/data/v4/UdoValue/' + recId +
        '?account=' + encodeURIComponent(account) +
        '&company=' + encodeURIComponent(company) +
        '&dtos=UdoValue.10';

      DBG.startCall('DELETE', url, { Authorization: 'Bearer …', 'X-Account-Name': account, 'X-Company-Name': company }, null)
        .then(function (callId) {
          return fetch(url, {
            method: 'DELETE',
            headers: {
              Authorization:      'Bearer ' + authToken,
              'X-Account-Name':   account,
              'X-Company-Name':   company,
              'X-Client-Version': '1.0',
            }
          }).then(function (res) {
            if (!res.ok) return res.text().then(function (t) { throw new Error('Delete failed (' + res.status + '): ' + t); });
            DBG.endCall(callId, res.status, 'OK', null, null);
            goBack();
            return loadRecords();
          }).catch(function (err) {
            DBG.endCall(callId, 0, 'Error', null, err.message);
            throw err;
          });
        })
        .catch(function (err) { showSaveBar('err', '✗ ' + err.message); });
    });
  }

  // ── Export CSV ────────────────────────────────────────────────────────────
  function exportCsv() {
    if (!filteredRecs.length) return;
    var cols   = colOrder.filter(function (c) { return !hiddenCols.has(c); });
    var header = cols.join(',');
    var rows   = filteredRecs.map(function (r) {
      return cols.map(function (c) {
        var v = String(r[c] == null ? '' : r[c]);
        return (v.includes(',') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    });
    CSV_UTILS.downloadCsv(selectedObj.name + '_records.csv', [header].concat(rows).join('\n'));
  }

  // ── Save bar ──────────────────────────────────────────────────────────────
  function showSaveBar(type, msg) {
    var bar = document.getElementById('save-bar');
    bar.className   = 'save-bar ' + type;
    bar.textContent = msg;
    bar.style.display = 'flex';
    if (type === 'ok') setTimeout(function () { bar.style.display = 'none'; }, 3000);
  }
  function hideSaveBar() {
    document.getElementById('save-bar').style.display = 'none';
  }

  // ── Confirm dialog ────────────────────────────────────────────────────────
  function showConfirm(title, msg) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = '<div class="dialog"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
        '<div class="dialog-btns">' +
          '<button class="btn btn-ghost" id="_no">Cancel</button>' +
          '<button class="btn btn-danger" id="_yes">Delete</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      ov.querySelector('#_no').addEventListener('click',  function () { ov.remove(); resolve(false); });
      ov.querySelector('#_yes').addEventListener('click', function () { ov.remove(); resolve(true);  });
    });
  }

  // ── Bind UI events ────────────────────────────────────────────────────────
  function bindUI() {
    document.getElementById('obj-search').addEventListener('input', function (e) {
      renderObjList(allObjects, e.target.value);
    });
    document.getElementById('btn-refresh').addEventListener('click', function () {
      selectedObj = null; fieldDefs = []; allRecords = []; filteredRecs = [];
      stack.length = 0;
      navigate('view-list', 'Custom Objects');
      loadObjects();
    });
    document.getElementById('rec-filter').addEventListener('input', function (e) {
      filteredRecs = applyFilter(allRecords, e.target.value);
      renderTable();
      var tot = allRecords.length, vis = filteredRecs.length;
      document.getElementById('rec-count').textContent =
        vis === tot ? tot + ' record' + (tot !== 1 ? 's' : '') : vis + ' of ' + tot;
    });
    document.getElementById('btn-new-rec').addEventListener('click', openNewRecord);
    document.getElementById('btn-export').addEventListener('click',  exportCsv);
    document.getElementById('btn-save').addEventListener('click',    saveRecord);
    document.getElementById('btn-delete').addEventListener('click',  deleteRecord);
  }

  // ── Patch FSM_API for debug logging ──────────────────────────────────────
  // Wait for DOM so FSM_API is defined, then wrap _query and upsertRecord
  document.addEventListener('DOMContentLoaded', function () {
    if (!window.FSM_API) return;

    var _q = FSM_API._query.bind(FSM_API);
    FSM_API._query = function (config, token, sql, dtos) {
      var url = 'https://' + config.clusterHost + '/api/query/v1' +
        '?account=' + encodeURIComponent(config.account) +
        '&company=' + encodeURIComponent(config.company) +
        '&dtos='    + encodeURIComponent(dtos);
      var hdrs = {
        Authorization:  'Bearer ' + token.substring(0,12) + '…',
        'Content-Type': 'application/json',
        'X-Account-Name': config.account,
        'X-Company-Name': config.company,
      };
      var callId = DBG.startCallSync('POST', url, hdrs, JSON.stringify({ query: sql }));
      return _q(config, token, sql, dtos).then(function (r) {
        DBG.endCall(callId, 200, 'OK', r, null); return r;
      }).catch(function (err) {
        var m = err.message.match(/\((\d+)\)/);
        DBG.endCall(callId, m ? +m[1] : 0, 'Error', null, err.message);
        throw err;
      });
    };

    var _u = FSM_API.upsertRecord.bind(FSM_API);
    FSM_API.upsertRecord = function (config, token, objectName, record, fieldMetaMap, udoMetaId) {
      var url = 'https://' + config.clusterHost + '/api/data/v4/UdoValue' +
        '?account=' + encodeURIComponent(config.account) +
        '&company=' + encodeURIComponent(config.company) +
        '&dtos=UdoValue.10';
      var callId = DBG.startCallSync('POST', url, { 'Content-Type': 'application/json' }, '(building body…)');
      return _u(config, token, objectName, record, fieldMetaMap, udoMetaId).then(function (r) {
        DBG.endCall(callId, 200, 'OK', r, null); return r;
      }).catch(function (err) {
        var m = err.message.match(/\((\d+)\)/);
        DBG.endCall(callId, m ? +m[1] : 0, 'Error', null, err.message);
        throw err;
      });
    };
  });

  // ── Utility ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Debug module ──────────────────────────────────────────────────────────
  var DBG = (function () {
    var entries = [];
    var ctxData = null;

    function init() {
      var btn   = document.getElementById('dbg-btn');
      var panel = document.getElementById('dbg-panel');
      if (!btn) return;
      btn.addEventListener('click', function () { panel.classList.toggle('open'); });
      document.getElementById('dbg-clear').addEventListener('click', function () { entries = []; render(); });
      document.getElementById('dbg-copy').addEventListener('click', function () {
        var txt = (ctxData ? 'CONTEXT:\n' + JSON.stringify(ctxData, null, 2) + '\n\n' : '') +
          entries.map(function (e) { return JSON.stringify(e, null, 2); }).join('\n\n---\n\n');
        navigator.clipboard.writeText(txt).then(function () {
          document.getElementById('dbg-copy').textContent = 'Copied!';
          setTimeout(function () { document.getElementById('dbg-copy').textContent = 'Copy All'; }, 1500);
        });
      });
    }

    function setCtx(ctx) {
      var safe = JSON.parse(JSON.stringify(ctx));
      if (safe.authToken) safe.authToken = safe.authToken.substring(0,12) + '…[redacted]';
      if (safe.auth && safe.auth.access_token) safe.auth.access_token = safe.auth.access_token.substring(0,12) + '…[redacted]';
      ctxData = safe;
      render();
      document.getElementById('dbg-panel').classList.add('open');
    }

    function logError(err) {
      entries.unshift({ type: 'error', message: String(err), ts: Date.now() });
      render();
    }

    var _counter = 0;
    function startCallSync(method, url, headers, body) {
      var id = ++_counter;
      entries.unshift({ id: id, method: method, url: url, headers: headers, body: body,
        status: null, response: null, error: null, startMs: Date.now(), ms: null });
      render();
      return id;
    }

    // async version for delete (returns promise resolving to id)
    function startCall(method, url, headers, body) {
      return Promise.resolve(startCallSync(method, url, headers, body));
    }

    function endCall(id, status, statusText, response, error) {
      var e = entries.find(function (x) { return x.id === id; });
      if (!e) return;
      e.status   = status;
      e.response = response;
      e.error    = error;
      e.ms       = Date.now() - e.startMs;
      render();
    }

    function render() {
      var log = document.getElementById('dbg-log');
      if (!log) return;
      var html = '';

      if (ctxData) {
        html += '<div class="ctx-block"><div class="ctx-lbl">🔑 Shell Context (REQUIRE_CONTEXT response)</div>' +
          '<div class="de-pre">' + esc(JSON.stringify(ctxData, null, 2)) + '</div></div>';
      }

      if (!entries.length && !ctxData) {
        html = '<div class="dbg-empty">No API calls yet…</div>';
      }

      html += entries.map(function (e, i) {
        if (e.type === 'error') {
          return '<div class="de"><div class="de-hdr"><span class="ds err">ERROR</span><span class="de-url">' + esc(e.message) + '</span></div></div>';
        }
        var sc  = e.status === null ? 'pend' : (e.status >= 200 && e.status < 300 ? 'ok' : 'err');
        var sl  = e.status === null ? 'pending…' : String(e.status);
        var dur = e.ms !== null ? e.ms + 'ms' : '…';
        var su  = e.url.replace(/https?:\/\/[^/]+/, '');
        var rs  = e.response ? JSON.stringify(e.response, null, 2) : '';
        if (rs.length > 3000) rs = rs.substring(0, 3000) + '\n…truncated';
        return '<div class="de"><div class="de-hdr" onclick="document.getElementById(\'deb'+i+'\').classList.toggle(\'open\')">' +
          '<span class="dm ' + e.method + '">' + e.method + '</span>' +
          '<span class="ds ' + sc + '">' + sl + '</span>' +
          '<span class="de-url" title="' + esc(e.url) + '">' + esc(su) + '</span>' +
          '<span class="de-ms">' + dur + '</span>' +
        '</div>' +
        '<div class="de-body" id="deb' + i + '">' +
          '<div class="de-sec"><div class="de-sec-lbl">🌐 URL</div><div class="de-pre">' + esc(e.url) + '</div></div>' +
          '<div class="de-sec"><div class="de-sec-lbl">📤 Headers</div><div class="de-pre">' + esc(JSON.stringify(e.headers, null, 2)) + '</div></div>' +
          '<div class="de-sec"><div class="de-sec-lbl">📦 Body</div><div class="de-pre">' + esc(String(e.body || '(empty)')) + '</div></div>' +
          (e.error ? '<div class="de-sec"><div class="de-sec-lbl">❌ Error</div><div class="de-pre" style="color:#FEB2B2">' + esc(e.error) + '</div></div>' : '') +
          (rs ? '<div class="de-sec"><div class="de-sec-lbl">📥 Response</div><div class="de-pre">' + esc(rs) + '</div></div>' : '') +
        '</div></div>';
      }).join('');

      log.innerHTML = html;
    }

    return { init: init, setCtx: setCtx, logError: logError, startCallSync: startCallSync, startCall: startCall, endCall: endCall };
  })();

  window.DBG = DBG;

})();
