// app.js — Custom Objects Manager
// Follows the exact pattern of the SAP with-shell-navigation sample:
// https://github.com/SAP-samples/fsm-extension-sample/tree/main/samples/with-shell-navigation
//
// Key points from the real sample (now confirmed from source):
//   - FSMShell global (not window.ShellSdk) → const { ShellSdk, SHELL_EVENTS } = FSMShell
//   - ShellSdk.init(parent, '*')
//   - hideSideNavAndTopBar() when inside Shell
//   - GET_STORAGE_ITEM with 'Cockpit_SelectedLocale' for language
//   - LuigiClient.linkManager() for internal navigation when inside Shell
//   - Hash-based routing (#/objects, #/records, #/detail)
//   - window.addEventListener('hashchange', router) + popstate when inside Shell

(function () {
  'use strict';

  // Global error trap — surface any uncaught JS error on the loading screen
  window.addEventListener('error', function (ev) {
    var el = document.getElementById('boot-log');
    if (el) {
      var line = document.createElement('div');
      line.style.color = '#feb2b2';
      line.textContent = '✗ JS ERROR: ' + ev.message + ' @ ' + (ev.filename || '').split('/').pop() + ':' + ev.lineno;
      el.appendChild(line);
    }
  });

  // Debug module — createDBG is a hoisted function declaration (defined below),
  // so this assignment works even though the definition appears later in the file.
  var DBG = createDBG();
  window.DBG = DBG;

  // ── Routes ─────────────────────────────────────────────────────────────
  const ROUTES = [
    { path: '/objects',        id: 'section-objects' },
    { path: '/records',        id: 'section-records' },
    { path: '/detail',         id: 'section-detail'  },
  ];

  // Convert location.hash to a path, same as sample's parseLocation()
  function parseLocation() {
    return location.hash.slice(1).toLowerCase() || '/objects';
  }

  function determineSectionID(path) {
    const route = ROUTES.find(r => r.path === path);
    return route ? route.id : 'section-not-found';
  }

  // Router — show/hide sections based on hash, same pattern as sample
  function router() {
    const path      = parseLocation();
    const sectionId = determineSectionID(path);
    const main      = document.getElementById('app-main');

    main.querySelectorAll('section').forEach(s => {
      s.classList.add('section-hidden');
      s.classList.remove('section-shown');
    });

    const target = document.getElementById(sectionId);
    if (target) {
      target.classList.remove('section-hidden');
      target.classList.add('section-shown');
    }
  }

  window.addEventListener('hashchange', router);
  window.addEventListener('load', router);

  // Navigate internally — uses LuigiClient when inside Shell (exactly as sample)
  function navigateTo(path) {
    if (window.ShellSdk && window.FSMShell) {
      const { ShellSdk } = FSMShell;
      if (ShellSdk.isInsideShell() && window.LuigiClient) {
        LuigiClient.linkManager().withoutSync().fromClosestContext().navigate(path);
      }
    }
    location.hash = '#' + path;
  }

  // Hide own top bar + side nav when inside Shell (Shell provides its own)
  function hideSideNavAndTopBar() {
    const topBar = document.getElementById('top-bar');
    const sideNav = document.getElementById('side-nav');
    if (topBar)  topBar.style.display  = 'none';
    if (sideNav) sideNav.style.display = 'none';
  }

  // ── App state ─────────────────────────────────────────────────────────
  let apiConfig  = null;
  let authToken  = null;
  let allObjects = [];
  let selectedObj = null;
  let fieldDefs  = [];
  let fieldIdToName = {};   // maps UdfMeta id → field name, for column display
  let allRecords = [];
  let filteredRecs = [];
  let editingRec = null;

  let sortCol    = null;
  let sortDir    = 'asc';
  let colOrder   = [];
  let colWidths  = {};
  let hiddenCols = new Set();
  let dragSrcIdx = null;

  // ── Shell SDK init — exact pattern from the sample ────────────────────
  const { ShellSdk, SHELL_EVENTS } = FSMShell;

  // Visible boot log — writes to the loading screen so the handshake is always visible
  function bootLog(msg, color) {
    var el = document.getElementById('boot-log');
    if (!el) return;
    var time = new Date().toLocaleTimeString();
    var line = document.createElement('div');
    line.style.color = color || '#cbd5e0';
    line.textContent = time + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log('[boot]', msg);
  }

  DBG.init();

  bootLog('Script loaded. FSMShell present: ' + (!!window.FSMShell));
  bootLog('isInsideShell(): ' + ShellSdk.isInsideShell());

  if (ShellSdk.isInsideShell()) {
    // Hide own navigation — Shell provides navigation via Luigi
    hideSideNavAndTopBar();

    // Listen to popstate for Luigi-driven route changes
    window.addEventListener('popstate', router);

    // Init ShellSDK
    const SHELL_SDK = ShellSdk.init(parent, '*');

    var ctxReceived  = false;
    var gotContext   = false;
    var gotToken     = false;

    // ── Register ALL listeners BEFORE emitting ────────────────────────────

    SHELL_SDK.on(SHELL_EVENTS.ERROR, function (err) {
      console.error('[Custom Objects] Shell error:', err);
      DBG.logError('SHELL ERROR: ' + JSON.stringify(err));
    });

    SHELL_SDK.on(SHELL_EVENTS.Version1.GET_STORAGE_ITEM, function (locale) {
      console.log('[Custom Objects] Shell locale:', locale);
    });

    // 1) REQUIRE_CONTEXT → gives us cloudHost / account / company.
    //    NOTE: for EXTENSIONS the Shell does NOT return a token here.
    //    The token must be requested separately via REQUIRE_AUTHENTICATION.
    SHELL_SDK.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, function (ctx) {
      ctxReceived = true;
      bootLog('✓ REQUIRE_CONTEXT response received', '#9ae6b4');
      if (typeof ctx === 'string') {
        try { ctx = JSON.parse(ctx); } catch (e) { /* ignore */ }
      }

      apiConfig = {
        clusterHost: ctx.cloudHost,
        account:     ctx.account,
        company:     ctx.company,
        // FSM API requires X-Client-ID. Use our extension's clientIdentifier.
        clientId:    'fsm-custom-objects-manager',
      };
      gotContext = true;
      bootLog('  cloudHost=' + ctx.cloudHost + ' account=' + ctx.account + ' company=' + ctx.company);

      DBG.setCtx(ctx);
      console.log('[Custom Objects] Context:', {
        cloudHost: ctx.cloudHost, account: ctx.account,
        company: ctx.company, user: ctx.user,
      });

      // A token may already be present (apps), use it if so
      var t = (ctx.auth && ctx.auth.access_token) || ctx.authToken || null;
      if (t) { authToken = t; gotToken = true; bootLog('✓ Token present in context', '#9ae6b4'); }

      maybeStart();

      // Extensions: explicitly request a restricted token
      if (!gotToken) {
        bootLog('→ Requesting token via REQUIRE_AUTHENTICATION…', '#faf089');
        SHELL_SDK.emit(SHELL_EVENTS.Version1.REQUIRE_AUTHENTICATION, { response_type: 'token' });
      }
    });

    // 2) REQUIRE_AUTHENTICATION → gives us the access_token for the extension
    SHELL_SDK.on(SHELL_EVENTS.Version1.REQUIRE_AUTHENTICATION, function (auth) {
      bootLog('✓ REQUIRE_AUTHENTICATION response received', '#9ae6b4');
      if (typeof auth === 'string') {
        try { auth = JSON.parse(auth); } catch (e) { /* ignore */ }
      }
      var t = (auth && auth.access_token) ||
              (auth && auth.auth && auth.auth.access_token) || null;
      if (t) {
        authToken = t;
        gotToken = true;
        bootLog('✓ Token acquired (expires_in=' + (auth.expires_in || '?') + ')', '#9ae6b4');
        maybeStart();
      } else {
        bootLog('✗ No access_token in response: ' + JSON.stringify(auth), '#feb2b2');
        DBG.logError('REQUIRE_AUTHENTICATION returned no access_token: ' + JSON.stringify(auth));
      }
    });

    // Start only once we have BOTH the env context AND a token
    function maybeStart() {
      if (gotContext && gotToken && apiConfig && apiConfig.clusterHost && authToken) {
        bootLog('✓ Handshake complete — loading objects', '#9ae6b4');
        document.getElementById('loading-overlay').style.display = 'none';
        bindUI();
        loadObjects();
      }
    }

    // ── Now emit (listeners are in place) ─────────────────────────────────
    bootLog('→ Emitting GET_STORAGE_ITEM + REQUIRE_CONTEXT…', '#faf089');
    SHELL_SDK.emit(SHELL_EVENTS.Version1.GET_STORAGE_ITEM, 'Cockpit_SelectedLocale');

    // For extensions, REQUIRE_CONTEXT takes only clientIdentifier (per SAP sample).
    // Do NOT pass auth here — the token comes from REQUIRE_AUTHENTICATION.
    SHELL_SDK.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
      clientIdentifier: 'fsm-custom-objects-manager',
    });

    // Diagnostic timeout
    setTimeout(function () {
      if (!gotContext || !gotToken) {
        bootLog('✗ TIMEOUT after 8s — gotContext=' + gotContext + ' gotToken=' + gotToken, '#feb2b2');
        if (!gotContext) {
          bootLog('  The Shell never responded to REQUIRE_CONTEXT.', '#feb2b2');
          bootLog('  postMessage handshake is not reaching the Shell host.', '#feb2b2');
        } else if (!gotToken) {
          bootLog('  Got env context but REQUIRE_AUTHENTICATION gave no token.', '#feb2b2');
        }
      }
    }, 8000);

  } else {
    // Standalone (dev) mode — show own nav and top bar
    console.warn('[Custom Objects] Running outside Shell — dev mode');
    document.getElementById('load-msg').textContent =
      'Running outside Shell. Open via FSM extension outlet for live data.';

    DBG.setCtx({
      _status:  'NOT_INSIDE_SHELL',
      _message: 'ShellSdk.isInsideShell() returned false.',
      _hint:    'Register this extension in FSM (Foundational Services → Extensions → Installed) and open it from the Shell outlet.',
    });

    document.getElementById('loading-overlay').style.display = 'none';
    bindUI();
    renderObjList([], '');
  }

  // ── Load objects ─────────────────────────────────────────────────────
  function loadObjects() {
    var list = document.getElementById('obj-list');
    list.innerHTML = '<div class="co-loading-row"><div class="co-spinner"></div>Loading objects…</div>';

    FSM_API.getCustomObjects(apiConfig, authToken)
      .then(function (objects) {
        allObjects = objects;
        FSM_API._cachedObjects = objects;
        renderObjList(objects, document.getElementById('obj-search').value);
      })
      .catch(function (err) {
        list.innerHTML = '<div class="co-list-err">' + esc(err.message) + '</div>';
      });
  }

  function renderObjList(objects, filter) {
    filter = filter || '';
    var list  = document.getElementById('obj-list');
    var shown = filter
      ? objects.filter(function (o) { return (o.name || '').toLowerCase().includes(filter.toLowerCase()); })
      : objects;

    if (!shown.length) {
      list.innerHTML = '<div class="co-list-msg">' +
        (filter ? 'No results for "' + esc(filter) + '"' : 'No custom objects found.') +
        '</div>';
      return;
    }

    list.innerHTML = shown.map(function (obj) {
      var name = obj.name || obj.id || '—';
      var abbr = name.substring(0, 2).toUpperCase();
      return '<div class="co-obj-item" data-id="' + esc(obj.id) + '">' +
        '<div class="co-obj-avatar">' + abbr + '</div>' +
        '<div class="co-obj-info">' +
          '<div class="co-obj-name">' + esc(name) + '</div>' +
          '<div class="co-obj-id">' + esc(obj.id || '') + '</div>' +
        '</div>' +
        '<svg class="co-obj-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none">' +
          '<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.co-obj-item').forEach(function (el) {
      el.addEventListener('click', function () { selectObject(el.dataset.id); });
    });
  }

  // ── Select object → records ──────────────────────────────────────────
  function selectObject(id) {
    selectedObj = allObjects.find(function (o) { return o.id === id; });
    if (!selectedObj) return;

    renderObjList(allObjects, document.getElementById('obj-search').value);

    allRecords = []; filteredRecs = []; colOrder = [];
    sortCol = null; sortDir = 'asc'; hiddenCols = new Set();
    document.getElementById('rec-title').textContent   = selectedObj.name;
    document.getElementById('rec-count').textContent   = '—';
    document.getElementById('t-head').innerHTML        = '';
    document.getElementById('t-body').innerHTML        = '';
    document.getElementById('tbl-empty').style.display = 'none';
    document.getElementById('rec-filter').value        = '';

    navigateTo('/records');

    // Load records IMMEDIATELY (don't wait for field metadata).
    loadRecords();

    // Load field metadata in PARALLEL. When it arrives, build the id→name map
    // and re-render so columns show friendly names. Records keep their raw-ID
    // keys; translation happens at render time (order-independent, no race).
    FSM_API.getCustomObjectFields(apiConfig, authToken, selectedObj.id)
      .then(function (fields) {
        fieldDefs = fields || [];
        fieldIdToName = {};
        fieldDefs.forEach(function (f) { if (f.id && f.name) fieldIdToName[f.id] = f.name; });
        if (fieldDefs.length) {
          buildColOrder();
          renderTable();
        }
      })
      .catch(function (err) {
        console.warn('[Custom Objects] getCustomObjectFields failed (non-fatal):', err.message);
        fieldDefs = [];
        fieldIdToName = {};
      });
  }

  // Display name for a column key: friendly field name if known, else the key.
  function colLabel(key) {
    return fieldIdToName[key] || key;
  }

  // ── Load records ─────────────────────────────────────────────────────
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
          '<tr><td colspan="99" style="padding:12px;color:#bb0000;">' + esc(err.message) + '</td></tr>';
      })
      .finally(function () { loading.style.display = 'none'; });
  }

  // ── Column order ─────────────────────────────────────────────────────
  // Build columns from the KEYS PRESENT IN THE RECORDS (these hold the data).
  // Field metadata is used only to translate the key to a display name, not
  // to add columns — otherwise we'd get empty columns for fields no record uses.
  function buildColOrder() {
    var sys = ['id','createDateTime','lastChanged','createPerson','lastChangedBy','__id','__lastChanged'];
    colOrder = [];
    allRecords.forEach(function (rec) {
      Object.keys(rec).forEach(function (k) {
        if (!sys.includes(k) && colOrder.indexOf(k) === -1) colOrder.push(k);
      });
    });
  }

  // ── Filter / sort ─────────────────────────────────────────────────────
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

  // ── Render table ──────────────────────────────────────────────────────
  // For SELECTIONLIST fields, translate a stored key (e.g. "brown") to its
  // display label (e.g. "Brown"). Other values pass through unchanged.
  function displayValue(colKey, raw) {
    if (raw == null || raw === '') return raw;
    var def = fieldDefs.find(function (f) { return (f.id || f.name) === colKey || f.name === colKey; });
    if (def && def.allowedValues && def.allowedValues.length) {
      var match = def.allowedValues.find(function (av) { return av.key === raw; });
      if (match) return match.label;
    }
    return raw;
  }

  function renderTable() {
    var vis    = colOrder.filter(function (c) { return !hiddenCols.has(c); });
    var sorted = applySorted(filteredRecs);

    document.getElementById('t-head').innerHTML = '<tr>' + vis.map(function (col, ci) {
      var w = colWidths[col] || 140, isc = sortCol === col;
      return '<th style="width:' + w + 'px;min-width:60px" data-col="' + esc(col) + '" data-ci="' + ci + '" draggable="true">' +
        '<div class="th-inner">' +
          '<span class="drag-grip"><svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">' +
            '<circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>' +
            '<circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>' +
            '<circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>' +
          '</svg></span>' +
          '<span class="th-label" title="' + esc(colLabel(col)) + '">' + esc(colLabel(col)) + '</span>' +
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
        var disp = displayValue(col, v);
        var cell;
        if (v === null || v === undefined || v === '') cell = '<span class="cell-nil">—</span>';
        else if (v === true  || v === 'true')  cell = '<span class="cell-t">✓ true</span>';
        else if (v === false || v === 'false') cell = '<span class="cell-f">false</span>';
        else cell = esc(String(disp));
        return '<td title="' + esc(String(disp == null ? '' : disp)) + '">' + cell + '</td>';
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

  function bindColDrag() {
    var ths = document.querySelectorAll('#t-head th');
    ths.forEach(function (th) {
      th.addEventListener('dragstart', function (e) { dragSrcIdx = parseInt(th.dataset.ci, 10); th.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; });
      th.addEventListener('dragend',   function () { th.classList.remove('is-dragging'); ths.forEach(function (t) { t.classList.remove('drag-target'); }); });
      th.addEventListener('dragover',  function (e) { e.preventDefault(); ths.forEach(function (t) { t.classList.remove('drag-target'); }); th.classList.add('drag-target'); });
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

  function bindColResize() {
    document.querySelectorAll('.col-resizer').forEach(function (handle) {
      handle.addEventListener('mousedown', function (e) {
        e.stopPropagation(); e.preventDefault();
        var col = handle.dataset.col, th = handle.closest('th');
        var sx = e.clientX, sw = colWidths[col] || th.offsetWidth;
        handle.classList.add('on');
        function onMove(mv) { colWidths[col] = Math.max(60, sw + mv.clientX - sx); th.style.width = colWidths[col] + 'px'; }
        function onUp() { handle.classList.remove('on'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ── Open / new record ─────────────────────────────────────────────────
  function openRecord(rec) {
    editingRec = rec;
    var rid = rec.__id || rec.id;
    document.getElementById('rec-title-detail').textContent = rid ? 'Record: ' + String(rid).substring(0, 16) + '…' : 'Record';
    var badge = document.getElementById('rec-badge');
    badge.textContent = 'EXISTING'; badge.className = 'co-rec-badge is-existing';
    document.getElementById('btn-delete').style.display = 'inline-flex';
    hideSaveBar();
    renderForm(rec);
    navigateTo('/detail');
  }

  function openNewRecord() {
    editingRec = {};
    document.getElementById('rec-title-detail').textContent = 'New Record';
    var badge = document.getElementById('rec-badge');
    badge.textContent = 'NEW'; badge.className = 'co-rec-badge is-new';
    document.getElementById('btn-delete').style.display = 'none';
    hideSaveBar();
    renderForm({});
    navigateTo('/detail');
  }

  // ── Render form ───────────────────────────────────────────────────────
  // Record values are keyed by UdfMeta id (that's how getUdoValues flattens
  // them). Look up by id first, then fall back to name.
  function recVal(rec, f) {
    if (f.id != null && rec[f.id] !== undefined) return rec[f.id];
    if (f.name != null && rec[f.name] !== undefined) return rec[f.name];
    return undefined;
  }

  function renderForm(rec) {
    var SYS      = ['id','createDateTime','lastChanged','createPerson','lastChangedBy'];
    var editable = fieldDefs.filter(function (f) { return !SYS.includes(f.name); });
    var sysShown = fieldDefs.filter(function (f) { return SYS.includes(f.name) && recVal(rec, f) !== undefined; });
    var html = '';

    editable.forEach(function (f) {
      var rv   = recVal(rec, f);
      var val  = rv != null ? rv : (f.defaultValue != null ? f.defaultValue : '');
      var type = (f.dataType || f.type || 'STRING').toUpperCase();
      var long = type === 'STRING' && /description|note|comment/i.test(f.name);
      html += '<div class="co-fld' + (long ? ' full' : '') + '">' +
        '<label class="co-fld-lbl">' +
          esc(f.label || f.name) +
          (f.mandatory ? '<span class="co-fld-req">*</span>' : '') +
          '<span class="co-fld-type">' + type + '</span>' +
        '</label>' +
        buildInput(f, val) +
      '</div>';
    });

    if (!editable.length) {
      Object.keys(rec).forEach(function (k) {
        if (SYS.includes(k)) return;
        html += '<div class="co-fld"><label class="co-fld-lbl">' + esc(colLabel(k)) + '</label>' +
          '<input class="co-fld-ctrl" data-field="' + esc(k) + '" type="text" value="' + esc(String(rec[k] == null ? '' : rec[k])) + '"></div>';
      });
    }

    if (sysShown.length) {
      html += '<div class="co-sys-sep"><div class="co-sys-sep-label">System Fields</div></div>';
      sysShown.forEach(function (f) {
        var rv = recVal(rec, f);
        html += '<div class="co-fld"><label class="co-fld-lbl">' + esc(f.name) + '</label>' +
          '<div class="co-fld-ro">' + esc(String(rv == null ? '' : rv)) + '</div></div>';
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
    // data-field MUST be the field id — the save API maps values by UdfMeta id.
    var n = f.id || f.name, v = String(val == null ? '' : val);
    if (type === 'BOOLEAN') {
      var chk = val === true || v === 'true' || v === '1' || v === 'yes';
      return '<div class="co-bool-row"><input class="co-fld-ctrl" type="checkbox" data-field="' + esc(n) + '"' + (chk ? ' checked' : '') + '><span>' + (chk ? 'True' : 'False') + '</span></div>';
    }
    if (type === 'SELECTIONLIST' && f.allowedValues && f.allowedValues.length) {
      return '<select class="co-fld-ctrl" data-field="' + esc(n) + '"><option value="">— select —</option>' +
        f.allowedValues.map(function (av) { return '<option value="' + esc(av.key) + '"' + (v === av.key ? ' selected' : '') + '>' + esc(av.label || av.key) + '</option>'; }).join('') +
      '</select>';
    }
    if (type === 'SELECTIONLISTWITHFREETEXT') {
      var lid = 'dl_' + n;
      return '<input class="co-fld-ctrl" list="' + lid + '" data-field="' + esc(n) + '" value="' + esc(v) + '">' +
        '<datalist id="' + lid + '">' + (f.allowedValues || []).map(function (av) { return '<option value="' + esc(av.key) + '">' + esc(av.label || av.key) + '</option>'; }).join('') + '</datalist>';
    }
    if (type === 'DATE')     return '<input class="co-fld-ctrl" type="date" data-field="' + esc(n) + '" value="' + esc(v.substring(0,10)) + '">';
    if (type === 'DATETIME') return '<input class="co-fld-ctrl" type="datetime-local" data-field="' + esc(n) + '" value="' + esc(v.substring(0,16)) + '">';
    if (type === 'TIME')     return '<input class="co-fld-ctrl" type="time" data-field="' + esc(n) + '" value="' + esc(v) + '">';
    if (type === 'INT')      return '<input class="co-fld-ctrl" type="number" step="1" data-field="' + esc(n) + '" value="' + esc(v) + '">';
    if (['FLOAT','PERCENTAGE','UNIT','MONETARYAMOUNT'].includes(type))
      return '<input class="co-fld-ctrl" type="number" step="any" data-field="' + esc(n) + '" value="' + esc(v) + '">';
    // Use the field NAME (not the id) to detect long-text fields.
    if (/description|note|comment/i.test(f.name || ''))
      return '<textarea class="co-fld-ctrl" data-field="' + esc(n) + '">' + esc(v) + '</textarea>';
    return '<input class="co-fld-ctrl" type="text" data-field="' + esc(n) + '" value="' + esc(v) + '">';
  }

  function collectForm() {
    var rec = {};
    document.getElementById('rec-form').querySelectorAll('[data-field]').forEach(function (el) {
      rec[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return rec;
  }

  // ── Save ──────────────────────────────────────────────────────────────
  function saveRecord() {
    var btn = document.getElementById('btn-save');
    btn.setAttribute('disabled', '');

    // collectForm returns { <fieldId>: value } keyed by the input's data-field
    var valuesById = collectForm();

    // If editing an existing record we have its id + lastChanged (preserved as
    // __id / __lastChanged) → PATCH update. Otherwise → POST create.
    var existingId  = editingRec && editingRec.__id ? editingRec.__id : null;
    var lastChanged = editingRec && editingRec.__lastChanged != null ? editingRec.__lastChanged : null;

    FSM_API.saveUdoValue(apiConfig, authToken, selectedObj.id, valuesById, existingId, lastChanged)
      .then(function () {
        showSaveBar('ok', existingId ? '✓ Updated successfully' : '✓ Created successfully');
        navigateTo('/records');
        return loadRecords();
      })
      .catch(function (err) {
        var msg = err.message || String(err);
        // A 423 / CA-28 that survives forceUpdate is a real platform sync block
        // (record has syncStatus BLOCKED from an ERP connector), not something
        // the API client can override.
        if (/\b423\b|CA-28|blocked/i.test(msg)) {
          showSaveBar('err', '✗ This record is locked by FSM (sync in progress or ERP block). It can\'t be edited until FSM unblocks it.');
        } else {
          showSaveBar('err', '✗ ' + msg);
        }
      })
      .finally(function () { btn.removeAttribute('disabled'); });
  }

  // ── Delete ────────────────────────────────────────────────────────────
  function deleteRecord() {
    if (!editingRec) return;
    showConfirm('Delete Record', 'Are you sure you want to permanently delete this record?').then(function (ok) {
      if (!ok) return;
      var recId = (editingRec && editingRec.__id) || editingRec.id;
      if (!recId) { showSaveBar('err', '✗ Record has no ID.'); return; }
      var url = 'https://' + apiConfig.clusterHost + '/api/data/v4/UdoValue/' + recId +
        '?account=' + encodeURIComponent(apiConfig.account) +
        '&company=' + encodeURIComponent(apiConfig.company) + '&dtos=UdoValue.10';
      var cid = DBG.startCallSync('DELETE', url, { Authorization: 'Bearer …' }, null);
      fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + authToken, 'Accept': 'application/json', 'X-Client-ID': (apiConfig.clientId || 'fsm-custom-objects-manager'), 'X-Client-Version': '1.0' }
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error('Delete failed (' + res.status + '): ' + t); });
        DBG.endCall(cid, res.status, 'OK', null, null);
        navigateTo('/records');
        return loadRecords();
      }).catch(function (err) {
        DBG.endCall(cid, 0, 'Error', null, err.message);
        showSaveBar('err', '✗ ' + err.message);
      });
    });
  }

  // ── Export CSV ────────────────────────────────────────────────────────
  function exportCsv() {
    if (!filteredRecs.length) return;
    var cols = colOrder.filter(function (c) { return !hiddenCols.has(c); });
    if (!cols.length) return;

    var header = cols.map(function (c) {
      var name = colLabel(c);
      return (name.indexOf(',') >= 0 || name.indexOf('"') >= 0)
        ? '"' + name.replace(/"/g, '""') + '"' : name;
    }).join(',');
    var rows = filteredRecs.map(function (r) {
      return cols.map(function (c) {
        var v = String(displayValue(c, r[c]) == null ? '' : displayValue(c, r[c]));
        return (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0)
          ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    });
    var csv = [header].concat(rows).join('\n');
    var filename = (selectedObj ? selectedObj.name : 'records') + '_export.csv';
    showExportModal(filename, csv);
  }

  function showExportModal(filename, csv) {
    var ov = document.createElement('div');
    ov.className = 'co-overlay';
    ov.innerHTML =
      '<div class="co-dialog" style="max-width:560px;width:96vw">' +
        '<h3 style="margin-bottom:6px">Export: ' + esc(filename) + '</h3>' +
        '<p style="margin-bottom:10px;font-size:12px;color:#4a5568">' +
          'The CSV is selected below — press <kbd style="background:#f3f4f6;border:1px solid #d9dbe0;' +
          'border-radius:4px;padding:1px 5px;font-family:monospace;font-size:11px">Ctrl+C</kbd> ' +
          '(or <kbd style="background:#f3f4f6;border:1px solid #d9dbe0;border-radius:4px;padding:1px 5px;' +
          'font-family:monospace;font-size:11px">⌘C</kbd>) to copy, then paste into Excel or a .csv file.' +
        '</p>' +
        '<textarea id="_csv-area" readonly style="width:100%;height:200px;font-family:monospace;' +
          'font-size:11px;padding:8px;border:1px solid #d9dbe0;border-radius:6px;' +
          'background:#f5f6f8;resize:vertical;color:#1d2129;outline:none;line-height:1.5">' +
          esc(csv) +
        '</textarea>' +
        '<div class="co-dialog-btns" style="margin-top:12px">' +
          '<button class="co-btn co-btn--ghost" id="_csv-copy">Copy CSV</button>' +
          '<button class="co-btn co-btn--primary" id="_csv-close">Done</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    // Auto-select the textarea content immediately
    var area = ov.querySelector('#_csv-area');
    setTimeout(function () { area.focus(); area.select(); }, 80);

    // Copy button uses execCommand (works in sandboxed iframes unlike Clipboard API)
    ov.querySelector('#_csv-copy').addEventListener('click', function () {
      area.focus();
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
      var btn = ov.querySelector('#_csv-copy');
      btn.textContent = ok ? '✓ Copied!' : 'Select all → Ctrl+C';
      setTimeout(function () { btn.textContent = 'Copy CSV'; }, 2000);
    });

    ov.querySelector('#_csv-close').addEventListener('click', function () { ov.remove(); });
  }

  // ── Save bar / confirm ────────────────────────────────────────────────
  function showSaveBar(type, msg) {
    var bar = document.getElementById('save-bar');
    bar.className = 'co-save-bar ' + type; bar.textContent = msg; bar.style.display = 'flex';
    if (type === 'ok') setTimeout(function () { bar.style.display = 'none'; }, 3000);
  }
  function hideSaveBar() { document.getElementById('save-bar').style.display = 'none'; }

  function showConfirm(title, msg) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div'); ov.className = 'co-overlay';
      ov.innerHTML = '<div class="co-dialog"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' +
        '<div class="co-dialog-btns"><button class="co-btn co-btn--ghost" id="_no">Cancel</button>' +
        '<button class="co-btn co-btn--danger" id="_yes">Delete</button></div></div>';
      document.body.appendChild(ov);
      ov.querySelector('#_no').addEventListener('click',  function () { ov.remove(); resolve(false); });
      ov.querySelector('#_yes').addEventListener('click', function () { ov.remove(); resolve(true);  });
    });
  }

  // ── Bind UI ───────────────────────────────────────────────────────────
  function bindUI() {
    document.getElementById('obj-search').addEventListener('input', function (e) {
      renderObjList(allObjects, e.target.value);
    });
    document.getElementById('btn-refresh').addEventListener('click', function () {
      allObjects = []; selectedObj = null; fieldDefs = []; allRecords = []; filteredRecs = [];
      navigateTo('/objects');
      if (apiConfig) loadObjects();
    });
    document.getElementById('btn-back-to-objects').addEventListener('click', function () { navigateTo('/objects'); });
    document.getElementById('rec-filter').addEventListener('input', function (e) {
      filteredRecs = applyFilter(allRecords, e.target.value);
      renderTable();
      var tot = allRecords.length, vis = filteredRecs.length;
      document.getElementById('rec-count').textContent = vis === tot ? tot + ' record' + (tot !== 1 ? 's' : '') : vis + ' of ' + tot;
    });
    document.getElementById('btn-new-rec').addEventListener('click', openNewRecord);
    document.getElementById('btn-export').addEventListener('click',  exportCsv);
    document.getElementById('btn-back-to-records').addEventListener('click', function () { navigateTo('/records'); });
    document.getElementById('btn-save').addEventListener('click',   saveRecord);
    document.getElementById('btn-delete').addEventListener('click', deleteRecord);

    // Patch FSM_API for debug logging
    patchFsmApi();
  }

  function patchFsmApi() {
    if (!window.FSM_API) return;

    // Fix selection-list parsing. FSM returns selectionKeyValues as a PLAIN
    // object { "green": "Green", "blue": "Blue", ... } for SELECTIONLIST /
    // SELECTIONLISTWITHFREETEXT fields. The original parser only handled arrays
    // or a .keyValues wrapper, so dropdowns came back empty. Handle all shapes.
    FSM_API._extractAllowedValues = function (skv) {
      if (!skv) return null;
      // Array of {key,value} or {key,label}
      if (Array.isArray(skv)) {
        if (!skv.length) return null;
        return skv.map(function (kv) { return { key: kv.key, label: kv.value || kv.label || kv.key }; });
      }
      // Wrapper { keyValues: [...] }
      if (skv.keyValues && Array.isArray(skv.keyValues)) {
        return skv.keyValues.map(function (kv) { return { key: kv.key, label: kv.value || kv.label || kv.key }; });
      }
      // Plain map { key: label, ... }  ← the real FSM format
      var keys = Object.keys(skv);
      if (!keys.length) return null;
      return keys.map(function (k) { return { key: k, label: skv[k] != null ? String(skv[k]) : k }; });
    };

    // Clean reimplementation of _query: correct headers (no broken X-Client-ID),
    // proper Authorization, and a fetch timeout so we fail fast instead of hanging.
    FSM_API._query = function (config, token, sql, dtos) {
      var url = 'https://' + config.clusterHost + '/api/query/v1' +
        '?account=' + encodeURIComponent(config.account) +
        '&company=' + encodeURIComponent(config.company) +
        '&dtos='    + encodeURIComponent(dtos);

      var headers = {
        'Authorization':    'Bearer ' + token,
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'X-Client-ID':      config.clientId || 'fsm-custom-objects-manager',
        'X-Client-Version': '1.0',
      };
      // NOTE: Do NOT send X-Account-Name / X-Company-Name headers — the FSM
      // Query API CORS policy does not allow them. account & company are in the URL.
      // X-Client-ID + X-Client-Version ARE required by the FSM API.

      var body = JSON.stringify({ query: sql });

      // Log for debug panel (Authorization shown truncated)
      var dispHeaders = {};
      Object.keys(headers).forEach(function (k) {
        dispHeaders[k] = (k === 'Authorization')
          ? 'Bearer ' + String(token).substring(0, 16) + '…(' + String(token).length + ' chars)'
          : headers[k];
      });
      var cid = DBG.startCallSync('POST', url, dispHeaders, body);

      // Fetch with a 20s timeout
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 20000);

      return fetch(url, { method: 'POST', headers: headers, body: body, signal: controller.signal })
        .then(function (res) {
          clearTimeout(timer);
          return res.text().then(function (text) {
            var parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
            if (!res.ok) {
              DBG.endCall(cid, res.status, 'Error', parsed, 'HTTP ' + res.status + ': ' + text.substring(0, 300));
              throw new Error('Query failed (' + res.status + '): ' + text.substring(0, 300));
            }
            DBG.endCall(cid, res.status, 'OK', parsed, null);
            return parsed;
          });
        })
        .catch(function (err) {
          clearTimeout(timer);
          var msg = err.name === 'AbortError'
            ? 'Request timed out after 20s (no response from FSM API)'
            : err.message;
          DBG.endCall(cid, 0, 'Error', null, msg);
          throw new Error(msg);
        });
    };

    // Clean reimplementation of upsertRecord: same body structure as fsm-api.js
    // but CORS-safe headers (no X-Account-Name / X-Company-Name) and a timeout.
    FSM_API.upsertRecord = function (config, token, objectName, record, fieldMetaMap, udoMetaId) {
      var udfValues = Object.keys(record)
        .filter(function (k) { var v = record[k]; return v !== null && v !== undefined && v !== ''; })
        .map(function (fieldName) {
          var fm = fieldMetaMap && fieldMetaMap[fieldName];
          var udfId = fm && fm.id ? fm.id : null;
          return { meta: udfId ? { id: udfId } : { externalId: fieldName }, value: String(record[fieldName]) };
        });
      var body = JSON.stringify({
        meta: udoMetaId ? { id: udoMetaId } : { name: objectName },
        udfValues: udfValues,
      });
      var url = 'https://' + config.clusterHost + '/api/data/v4/UdoValue' +
        '?account=' + encodeURIComponent(config.account) +
        '&company=' + encodeURIComponent(config.company) + '&dtos=UdoValue.10';
      var headers = {
        'Authorization':    'Bearer ' + token,
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'X-Client-ID':      config.clientId || 'fsm-custom-objects-manager',
        'X-Client-Version': '1.0',
      };

      var dispHeaders = {};
      Object.keys(headers).forEach(function (k) {
        dispHeaders[k] = (k === 'Authorization') ? 'Bearer ' + String(token).substring(0, 16) + '…' : headers[k];
      });
      var cid = DBG.startCallSync('POST', url, dispHeaders, body);

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 20000);

      return fetch(url, { method: 'POST', headers: headers, body: body, signal: controller.signal })
        .then(function (res) {
          clearTimeout(timer);
          return res.text().then(function (text) {
            var parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
            if (!res.ok) {
              var msg = (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || text.substring(0, 300);
              DBG.endCall(cid, res.status, 'Error', parsed, 'HTTP ' + res.status + ': ' + msg);
              throw new Error('Upload failed (' + res.status + '): ' + msg);
            }
            DBG.endCall(cid, res.status, 'OK', parsed, null);
            return parsed;
          });
        })
        .catch(function (err) {
          clearTimeout(timer);
          var msg = err.name === 'AbortError' ? 'Upload timed out after 20s' : err.message;
          DBG.endCall(cid, 0, 'Error', null, msg);
          throw new Error(msg);
        });
    };

    // Override getUdoValues to PRESERVE each record's own id + lastChanged
    // (needed for updates). fsm-api.js drops them when flattening; we keep them
    // under reserved keys __id / __lastChanged so they don't collide with fields.
    FSM_API.getUdoValues = function (config, token, udoMetaId, defs, onProgress) {
      var PAGE = 1000, MAX = 100000, all = [], offset = 0;
      function fetchPage() {
        return FSM_API._query(
          config, token,
          "SELECT u FROM UdoValue u WHERE u.meta = '" + udoMetaId + "' LIMIT " + PAGE + " OFFSET " + offset,
          'UdoValue.10'
        ).then(function (raw) {
          var rows = FSM_API._unwrapRows(raw.data || []);
          if (!rows.length) return all;
          rows.forEach(function (row) {
            var flat = {};
            (row.udfValues || []).forEach(function (uv) {
              var metaId = typeof uv.meta === 'string' ? uv.meta : (uv.meta && uv.meta.id);
              if (metaId) flat[metaId] = uv.value;
            });
            // reserved metadata for updates
            flat.__id = row.id;
            flat.__lastChanged = row.lastChanged;
            all.push(flat);
          });
          if (onProgress) onProgress(all.length);
          if (rows.length < PAGE || all.length >= MAX) return all;
          offset += PAGE;
          return fetchPage();
        });
      }
      return fetchPage();
    };

    // Create-or-update a UdoValue record.
    //   existingId + lastChanged present → PATCH /UdoValue/<id>  (UPDATE)
    //   otherwise                        → POST  /UdoValue       (CREATE)
    FSM_API.saveUdoValue = function (config, token, udoMetaId, valuesById, existingId, lastChanged) {
      var udfValues = Object.keys(valuesById)
        .filter(function (k) { var v = valuesById[k]; return v !== null && v !== undefined && v !== ''; })
        .map(function (fieldId) { return { meta: { id: fieldId }, value: String(valuesById[fieldId]) }; });

      var isUpdate = !!existingId;
      // On UPDATE we use forceUpdate=true (below) to bypass the optimistic-lock
      // / blocked state. With forceUpdate, lastChanged must be OMITTED — sending
      // both a force flag and a version key conflicts and FSM keeps the block.
      var body = isUpdate
        ? { id: existingId, udfValues: udfValues }
        : { meta: { id: udoMetaId }, udfValues: udfValues };

      var base = 'https://' + config.clusterHost + '/api/data/v4/UdoValue';
      var url = (isUpdate ? base + '/' + existingId : base) +
        '?account=' + encodeURIComponent(config.account) +
        '&company=' + encodeURIComponent(config.company) + '&dtos=UdoValue.10';
      // forceUpdate=true tells FSM to overwrite without the optimistic-lock check.
      if (isUpdate) url += '&forceUpdate=true';
      var method = isUpdate ? 'PATCH' : 'POST';

      var headers = {
        'Authorization':    'Bearer ' + token,
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'X-Client-ID':      config.clientId || 'fsm-custom-objects-manager',
        'X-Client-Version': '1.0',
      };

      var bodyStr = JSON.stringify(body);
      var dispHeaders = {}; Object.keys(headers).forEach(function (k) {
        dispHeaders[k] = (k === 'Authorization') ? 'Bearer ' + String(token).substring(0, 16) + '…' : headers[k];
      });
      var cid = DBG.startCallSync(method, url, dispHeaders, bodyStr);

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 20000);

      return fetch(url, { method: method, headers: headers, body: bodyStr, signal: controller.signal })
        .then(function (res) {
          clearTimeout(timer);
          return res.text().then(function (text) {
            var parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
            if (!res.ok) {
              var msg = (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || text.substring(0, 300);
              DBG.endCall(cid, res.status, 'Error', parsed, 'HTTP ' + res.status + ': ' + msg);
              throw new Error((isUpdate ? 'Update' : 'Create') + ' failed (' + res.status + '): ' + msg);
            }
            DBG.endCall(cid, res.status, 'OK', parsed, null);
            return parsed;
          });
        })
        .catch(function (err) {
          clearTimeout(timer);
          var msg = err.name === 'AbortError' ? 'Save timed out after 20s' : err.message;
          DBG.endCall(cid, 0, 'Error', null, msg);
          throw new Error(msg);
        });
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Debug module ──────────────────────────────────────────────────────
  // NOTE: hoisted function declaration so DBG (assigned near the top of the
  // IIFE) is ready before any code that calls DBG.init() / DBG.setCtx().
  function createDBG() {
    var entries = [], ctxData = null, counter = 0;

    function init() {
      var btn = document.getElementById('dbg-btn'), panel = document.getElementById('dbg-panel');
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
      var panel = document.getElementById('dbg-panel');
      if (panel) panel.classList.add('open');
    }

    function logError(msg) { entries.unshift({ type: 'error', message: msg }); render(); }

    function startCallSync(method, url, headers, body) {
      var id = ++counter;
      entries.unshift({ id: id, method: method, url: url, headers: headers, body: body, status: null, response: null, error: null, startMs: Date.now(), ms: null });
      render(); return id;
    }

    function endCall(id, status, statusText, response, error) {
      var e = entries.find(function (x) { return x.id === id; });
      if (!e) return;
      e.status = status; e.response = response; e.error = error; e.ms = Date.now() - e.startMs;
      render();
    }

    function render() {
      var log = document.getElementById('dbg-log'); if (!log) return;
      var html = '';
      if (ctxData) {
        html += '<div class="ctx-block"><div class="ctx-lbl">🔑 Shell Context (REQUIRE_CONTEXT response)</div>' +
          '<div class="de-pre">' + escHtml(JSON.stringify(ctxData, null, 2)) + '</div></div>';
      }
      if (!entries.length && !ctxData) { log.innerHTML = '<div class="dbg-empty">No API calls yet…</div>'; return; }
      html += entries.map(function (e, i) {
        if (e.type === 'error') return '<div class="de"><div class="de-hdr"><span class="ds err">ERROR</span><span class="de-url">' + escHtml(e.message) + '</span></div></div>';
        var sc = e.status === null ? 'pend' : (e.status >= 200 && e.status < 300 ? 'ok' : 'err');
        var sl = e.status === null ? 'pending…' : String(e.status);
        var su = e.url.replace(/https?:\/\/[^/]+/, '');
        var rs = e.response ? JSON.stringify(e.response, null, 2) : '';
        if (rs.length > 3000) rs = rs.substring(0, 3000) + '\n…truncated';
        return '<div class="de"><div class="de-hdr" onclick="document.getElementById(\'deb'+i+'\').classList.toggle(\'open\')">' +
          '<span class="dm ' + e.method + '">' + e.method + '</span>' +
          '<span class="ds ' + sc + '">' + sl + '</span>' +
          '<span class="de-url" title="' + escHtml(e.url) + '">' + escHtml(su) + '</span>' +
          '<span class="de-ms">' + (e.ms !== null ? e.ms + 'ms' : '…') + '</span>' +
        '</div><div class="de-body" id="deb' + i + '">' +
          '<div class="de-sec"><div class="de-sec-lbl">🌐 URL</div><div class="de-pre">' + escHtml(e.url) + '</div></div>' +
          '<div class="de-sec"><div class="de-sec-lbl">📤 Headers</div><div class="de-pre">' + escHtml(JSON.stringify(e.headers, null, 2)) + '</div></div>' +
          '<div class="de-sec"><div class="de-sec-lbl">📦 Body</div><div class="de-pre">' + escHtml(String(e.body || '(empty)')) + '</div></div>' +
          (e.error ? '<div class="de-sec"><div class="de-sec-lbl">❌ Error</div><div class="de-pre" style="color:#FEB2B2">' + escHtml(e.error) + '</div></div>' : '') +
          (rs ? '<div class="de-sec"><div class="de-sec-lbl">📥 Response</div><div class="de-pre">' + escHtml(rs) + '</div></div>' : '') +
        '</div></div>';
      }).join('');
      log.innerHTML = html;
    }

    function escHtml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    return { init: init, setCtx: setCtx, logError: logError, startCallSync: startCallSync, endCall: endCall };
  }

})();
