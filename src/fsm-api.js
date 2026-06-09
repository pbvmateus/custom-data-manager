// lib/fsm-api.js
// SAP FSM API wrapper
//
// config.clusterHost → all endpoints (e.g. us.fsm.cloud.sap)
//
// Auth  : POST https://<clusterHost>/api/oauth2/v2/token
// Query : POST https://<clusterHost>/api/query/v1?account=X&company=Y&dtos=A.1;B.2
//         body: { "query": "SELECT u FROM UdoMeta u" }
//         NOTE: FSM wraps each row under the SELECT alias, e.g. { "u": { ...obj... } }
// Data  : POST https://<clusterHost>/api/data/v4/<Object>?account=X&company=Y&dtos=Obj.1

const FSM_API = {

  // ─── Query API ─────────────────────────────────────────────────────────────

  async _query(config, token, coreSQL, dtos) {
    const { clusterHost, account, company } = config;
    const url = `https://${clusterHost}/api/query/v1?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=${encodeURIComponent(dtos)}`;

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Account-Name": account,
      "X-Company-Name": company,
      "X-Client-ID": config.clientId,
      "X-Client-Version": "1.0",
    };
    const body = JSON.stringify({ query: coreSQL });

    FSM_API._lastRequest = {
      method: "POST",
      url,
      headers: { ...headers, Authorization: "Bearer [redacted]" },
      body,
    };

    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Query failed (${res.status}): ${err}`);
    }
    return await res.json();
  },

  // ─── Unwrap Query API alias ────────────────────────────────────────────────
  // FSM Query API wraps each row under the SELECT alias.
  // "SELECT u FROM UdoMeta u" → [{ "u": { name: "...", ... } }, ...]
  // This unwraps the alias so we get the raw object directly.

  _unwrapRows(data) {
    if (!Array.isArray(data)) return [];
    return data.map((row) => {
      const keys = Object.keys(row);
      if (keys.length === 1 && row[keys[0]] !== null && typeof row[keys[0]] === "object") {
        return row[keys[0]]; // unwrap e.g. { "u": {...} } → {...}
      }
      return row;
    });
  },

  // ─── Custom Objects ────────────────────────────────────────────────────────

  async getCustomObjects(config, token) {
    const raw = await FSM_API._query(config, token, "SELECT u FROM UdoMeta u", "UdoMeta.10");
    const rows = FSM_API._unwrapRows(raw.data || []);
    console.log("[FSM] UdoMeta first row (unwrapped):", JSON.stringify(rows[0]));
    return rows.map((obj) => ({
      ...obj,
      name:  obj.name || obj.id || "Unknown",
      label: obj.name || obj.id || "Unknown",
      // udfMetas is a list of bare UdfMeta ID strings in UdoMeta.10
      // Store them so getCustomObjectFields can query them directly by ID
      udfMetaIds: (obj.udfMetas || []).filter(v => typeof v === "string"),
    }));
  },

  // ─── Fields for a specific UdoMeta ────────────────────────────────────────

  async getCustomObjectFields(config, token, udoMetaId) {
    // Find the parent UdoMeta object so we can get its udfMetaIds list
    const parentObj = FSM_API._cachedObjects
      ? FSM_API._cachedObjects.find(o => o.id === udoMetaId)
      : null;

    const ids = parentObj && parentObj.udfMetaIds && parentObj.udfMetaIds.length > 0
      ? parentObj.udfMetaIds
      : null;

    let rows = [];

    if (ids && ids.length > 0) {
      // Query UdfMeta by the exact IDs we know belong to this object
      const idList = ids.map(id => `'${id}'`).join(", ");
      const raw = await FSM_API._query(
        config, token,
        `SELECT u FROM UdfMeta u WHERE u.id IN (${idList})`,
        "UdfMeta.20"
      );
      rows = FSM_API._unwrapRows(raw.data || []);
    } else {
      // Fallback: fetch all UdfMeta with objectType UDOMETA
      const raw = await FSM_API._query(
        config, token,
        "SELECT u FROM UdfMeta u WHERE u.objectType = 'UDOMETA'",
        "UdfMeta.20"
      );
      rows = FSM_API._unwrapRows(raw.data || []);
    }

    console.log("[FSM] UdfMeta rows:", rows.length, "first:", JSON.stringify(rows[0]));
    return rows.map(FSM_API._normaliseField);
  },

  // ─── Normalise UdfMeta DTO v20 ─────────────────────────────────────────────

  _normaliseField(f) {
    return {
      ...f,
      name:         f.name,
      label:        f.description || f.name,
      dataType:     f.type, // STRING|INT|FLOAT|DATE|TIME|DATETIME|PERCENTAGE|
                            // UNIT|MONETARYAMOUNT|SELECTIONLIST|
                            // SELECTIONLISTWITHFREETEXT|BOOLEAN|UUID
      mandatory:    f.mandatory || false,
      defaultValue: f.defaultValue || null,
      allowedValues: FSM_API._extractAllowedValues(f.selectionKeyValues),
      multipleValues: f.multipleValues || false,
    };
  },

  _extractAllowedValues(skv) {
    if (!skv) return null;
    const list = Array.isArray(skv) ? skv : (skv.keyValues || null);
    if (!list) return null;
    return list.map((kv) => ({ key: kv.key, label: kv.value || kv.key }));
  },

  // ─── Query existing UdoValue records ──────────────────────────────────────

  async getUdoValues(config, token, udoMetaId, fieldDefs, onProgress) {
    // Paginate through ALL UdoValue records for a given UdoMeta id.
    // FSM Query API limits: max 1,000 per page, max 100,000 total.
    const PAGE_SIZE = 1000;
    const MAX_RECORDS = 100000;

    // Build id->name map from fieldDefs for readable column headers
    const idToName = {};
    (fieldDefs || []).forEach(f => { if (f.id && f.name) idToName[f.id] = f.name; });

    const allRows = [];
    let offset = 0;

    while (true) {
      const raw = await FSM_API._query(
        config, token,
        `SELECT u FROM UdoValue u WHERE u.meta = '${udoMetaId}' LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        "UdoValue.10"
      );
      const rows = FSM_API._unwrapRows(raw.data || []);
      if (rows.length === 0) break;

      allRows.push(...rows);
      if (onProgress) onProgress(allRows.length);
      console.log(`[FSM] Downloaded ${allRows.length} records so far…`);

      if (rows.length < PAGE_SIZE || allRows.length >= MAX_RECORDS) break;
      offset += PAGE_SIZE;
    }

    console.log("[FSM] Total UdoValue rows fetched:", allRows.length);

    // Convert each row into a flat { fieldName: value } object
    return allRows.map(row => {
      const flat = {};
      (row.udfValues || []).forEach(udfVal => {
        const metaId = typeof udfVal.meta === "string" ? udfVal.meta : (udfVal.meta && udfVal.meta.id);
        const colName = (metaId && idToName[metaId]) || metaId || udfVal.key || "unknown";
        flat[colName] = udfVal.value;
      });
      return flat;
    });
  },

  // ─── Data API — write UdoValue record ─────────────────────────────────────
  // Custom Object records in SAP FSM are stored as UdoValue.
  // Endpoint: POST /api/data/v4/UdoValue
  // Body structure:
  // {
  //   "udoMeta": { "name": "<objectName>" },
  //   "udfValues": [
  //     { "meta": { "name": "<fieldName>" }, "value": "<value>" },
  //     ...
  //   ]
  // }

  async upsertRecord(config, token, objectName, record, fieldMetaMap, udoMetaId) {
    const { clusterHost, account, company } = config;

    // fieldMetaMap: { "<fieldName>": { id, name } } for resolving UdfMeta references
    //
    // Real UdoValue record structure (CONFIRMED from query of an existing record):
    //   udfValues[N].key   = null
    //   udfValues[N].meta  = <UdfMeta id> (the UUID, as an Identifier reference)
    //   udfValues[N].value = the actual data value
    //
    // Map each CSV column (by field name) to its UdfMeta id, placed in "meta".
    const udfValues = Object.entries(record)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([fieldName, value]) => {
        const fm = fieldMetaMap && fieldMetaMap[fieldName];
        const udfId = fm && fm.id ? fm.id : null;
        return {
          meta: udfId ? { id: udfId } : { externalId: fieldName },
          value: String(value),
        };
      });

    // UdoValue DTO v10:
    //   meta       → Identifier to UdoMeta (the custom object definition)
    //   udfValues  → array of { key: <fieldName>, meta: { id }, value }
    const body = {
      meta: udoMetaId ? { id: udoMetaId } : { name: objectName },
      udfValues,
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Account-Name": account,
      "X-Company-Name": company,
      "X-Client-ID": config.clientId,
      "X-Client-Version": "1.0",
    };

    // UdoValue DTO v10 is the correct version for custom object records
    const url = `https://${clusterHost}/api/data/v4/UdoValue?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=UdoValue.10`;

    const debugInfo = {
      method: "POST",
      url,
      headers: { ...headers, Authorization: "Bearer [redacted]" },
      body,
    };
    FSM_API._lastUpsertRequest = debugInfo;
    console.log("[FSM] upsertRecord request:", JSON.stringify(debugInfo, null, 2));

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const errText = await res.text();
      console.log("[FSM] upsertRecord RAW error response:", errText);
      let msg;
      try { const p = JSON.parse(errText); msg = p.error?.message || p.message || errText; }
      catch { msg = errText; }
      // Attach full request AND raw response to error so the UI can display them
      const err = new Error(`Upload failed (${res.status}): ${msg}`);
      err.requestDebug = debugInfo;
      err.rawResponse = errText;
      throw err;
    }
    return await res.json();
  },

  // ─── Batch upload ──────────────────────────────────────────────────────────

  async uploadRecords(config, token, objectName, records, onProgress, fieldMetaMap, udoMetaId) {
    const results = { success: 0, failed: 0, errors: [] };
    for (let i = 0; i < records.length; i++) {
      try {
        await FSM_API.upsertRecord(config, token, objectName, records[i], fieldMetaMap, udoMetaId);
        results.success++;
      } catch (err) {
        results.failed++;
        results.errors.push({ row: i + 2, data: records[i], error: err.message });
      }
      if (onProgress) onProgress(i + 1, records.length, results);
    }
    return results;
  },
};

if (typeof module !== "undefined") module.exports = FSM_API;
else window.FSM_API = FSM_API;
