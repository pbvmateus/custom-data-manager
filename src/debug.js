// src/debug.js — API call debug overlay
// Shows every request/response with headers, body, URL, status, timing.
// Toggle with the 🐛 button. Safe to ship; remove <script src="src/debug.js">
// from index.html when you no longer need it.

'use strict';

const DBG = {
  entries: [],

  init() {
    const toggle = document.getElementById('debugToggle');
    const panel  = document.getElementById('debugPanel');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => panel.classList.toggle('open'));
    document.getElementById('dbgClear').addEventListener('click', () => {
      DBG.entries = [];
      DBG._renderAll();
    });
    document.getElementById('dbgCopyAll').addEventListener('click', () => {
      const text = DBG.entries.map(e => JSON.stringify(e, null, 2)).join('\n\n---\n\n');
      navigator.clipboard.writeText(text).then(() => {
        document.getElementById('dbgCopyAll').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('dbgCopyAll').textContent = 'Copy All'; }, 1500);
      });
    });
  },

  // Call this BEFORE the fetch to get an entry id back
  startCall(method, url, headers, body) {
    const id = Date.now() + Math.random();
    const entry = {
      id,
      method,
      url,
      headers: { ...headers },
      body,
      status: null,
      statusText: null,
      response: null,
      error: null,
      startMs: Date.now(),
      durationMs: null,
    };
    // Redact auth header for display
    if (entry.headers.Authorization) {
      const parts = entry.headers.Authorization.split(' ');
      if (parts[1]) entry.headers.Authorization = `${parts[0]} ${parts[1].substring(0, 8)}…[redacted]`;
    }
    DBG.entries.unshift(entry);
    DBG._renderAll();
    return id;
  },

  // Call this AFTER the fetch resolves
  endCall(id, status, statusText, responseBody, error) {
    const entry = DBG.entries.find(e => e.id === id);
    if (!entry) return;
    entry.status     = status;
    entry.statusText = statusText;
    entry.response   = responseBody;
    entry.error      = error;
    entry.durationMs = Date.now() - entry.startMs;
    DBG._renderAll();
  },

  // Also log shell context when received
  logContext(ctx) {
    const safe = { ...ctx };
    if (safe.authToken)       safe.authToken       = safe.authToken.substring(0, 12) + '…[redacted]';
    if (safe.auth?.access_token) safe.auth = { ...safe.auth, access_token: safe.auth.access_token.substring(0, 12) + '…[redacted]' };
    DBG._ctxData = safe;
    DBG._renderAll();
  },

  _renderAll() {
    const log = document.getElementById('debugLog');
    if (!log) return;

    let html = '';

    // Shell context block
    if (DBG._ctxData) {
      html += `<div class="dbg-context">
        <div class="dbg-context-label">🔑 Shell Context (REQUIRE_CONTEXT response)</div>
        <div class="dbg-pre">${DBG._syntaxHL(JSON.stringify(DBG._ctxData, null, 2))}</div>
      </div>`;
    }

    if (DBG.entries.length === 0 && !DBG._ctxData) {
      html = '<div class="dbg-empty">No API calls yet…</div>';
    }

    html += DBG.entries.map((e, idx) => {
      const statusClass = e.status === null ? 'pending' : (e.status >= 200 && e.status < 300 ? 'ok' : 'err');
      const statusLabel = e.status === null ? 'pending…' : `${e.status} ${e.statusText || ''}`;
      const dur         = e.durationMs !== null ? `${e.durationMs}ms` : '…';
      const shortUrl    = e.url.replace(/https?:\/\/[^/]+/, '');
      const bodyStr     = typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2);
      const respStr     = typeof e.response === 'string'
        ? e.response.substring(0, 4000) + (e.response.length > 4000 ? '\n…truncated' : '')
        : JSON.stringify(e.response, null, 2);

      return `
        <div class="dbg-entry" id="dbge_${idx}">
          <div class="dbg-entry-hdr" onclick="DBG._toggle(${idx})">
            <span class="dbg-method ${e.method}">${e.method}</span>
            <span class="dbg-status ${statusClass}">${statusLabel}</span>
            <span class="dbg-url" title="${DBG._esc(e.url)}">${DBG._esc(shortUrl)}</span>
            <span class="dbg-time">${dur}</span>
          </div>
          <div class="dbg-body" id="dbgb_${idx}">
            <div class="dbg-section">
              <div class="dbg-section-label">🌐 Full URL</div>
              <div class="dbg-pre">${DBG._esc(e.url)}</div>
            </div>
            <div class="dbg-section">
              <div class="dbg-section-label">📤 Request Headers</div>
              <div class="dbg-pre">${DBG._syntaxHL(JSON.stringify(e.headers, null, 2))}</div>
            </div>
            <div class="dbg-section">
              <div class="dbg-section-label">📦 Request Body</div>
              <div class="dbg-pre">${DBG._syntaxHL(bodyStr || '(empty)')}</div>
            </div>
            ${e.error ? `
            <div class="dbg-section">
              <div class="dbg-section-label">❌ Error</div>
              <div class="dbg-pre" style="color:#FEB2B2">${DBG._esc(e.error)}</div>
            </div>` : ''}
            ${e.response !== null ? `
            <div class="dbg-section">
              <div class="dbg-section-label">📥 Response (${e.status})</div>
              <div class="dbg-pre">${DBG._syntaxHL(respStr)}</div>
            </div>` : ''}
          </div>
        </div>`;
    }).join('');

    log.innerHTML = html;
  },

  _toggle(idx) {
    const body = document.getElementById(`dbgb_${idx}`);
    if (body) body.classList.toggle('open');
  },

  _syntaxHL(str) {
    return DBG._esc(str)
      .replace(/(&quot;[^&]*&quot;)\s*:/g, '<span class="key">$1</span>:')
      .replace(/:\s*(&quot;[^&]*&quot;)/g, ': <span class="str">$1</span>')
      .replace(/:\s*(\d+\.?\d*)/g,       ': <span class="num">$1</span>')
      .replace(/:\s*(true|false|null)/g,  ': <span class="bool">$1</span>');
  },

  _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },
};

// ── Monkey-patch FSM_API._query and FSM_API.upsertRecord to log calls ──────
// We wait for DOM ready so FSM_API is already defined
document.addEventListener('DOMContentLoaded', () => {
  DBG.init();

  if (!window.FSM_API) return;

  // Patch _query
  const _origQuery = FSM_API._query.bind(FSM_API);
  FSM_API._query = async function(config, token, coreSQL, dtos) {
    const { clusterHost, account, company } = config;
    const url = `https://${clusterHost}/api/query/v1?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=${encodeURIComponent(dtos)}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Account-Name': account,
      'X-Company-Name': company,
      'X-Client-ID': config.clientId || '(none)',
      'X-Client-Version': '1.0',
    };
    const body = JSON.stringify({ query: coreSQL });
    const id = DBG.startCall('POST', url, headers, body);
    try {
      const result = await _origQuery(config, token, coreSQL, dtos);
      DBG.endCall(id, 200, 'OK', result, null);
      return result;
    } catch (err) {
      // Try to extract status from error message
      const match = err.message.match(/\((\d+)\)/);
      const status = match ? parseInt(match[1]) : 0;
      DBG.endCall(id, status, 'Error', null, err.message);
      throw err;
    }
  };

  // Patch upsertRecord
  const _origUpsert = FSM_API.upsertRecord.bind(FSM_API);
  FSM_API.upsertRecord = async function(config, token, objectName, record, fieldMetaMap, udoMetaId) {
    const { clusterHost, account, company } = config;
    const url = `https://${clusterHost}/api/data/v4/UdoValue?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=UdoValue.10`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Account-Name': account,
      'X-Company-Name': company,
      'X-Client-ID': config.clientId || '(none)',
      'X-Client-Version': '1.0',
    };
    const id = DBG.startCall('POST', url, headers, '(building body…)');
    try {
      const result = await _origUpsert(config, token, objectName, record, fieldMetaMap, udoMetaId);
      DBG.endCall(id, 200, 'OK', result, null);
      return result;
    } catch (err) {
      const match = err.message.match(/\((\d+)\)/);
      const status = match ? parseInt(match[1]) : 0;
      DBG.endCall(id, status, 'Error', null, err.message);
      throw err;
    }
  };
});

window.DBG = DBG;
