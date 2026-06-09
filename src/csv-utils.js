// lib/csv-utils.js
// CSV parsing, validation and template generation
// Field types aligned with UdfMeta DTO v20 CloudDataType enum:
// STRING, INT, FLOAT, DATE, TIME, DATETIME, PERCENTAGE, UNIT,
// MONETARYAMOUNT, SELECTIONLIST, SELECTIONLISTWITHFREETEXT, BOOLEAN, UUID

const CSV_UTILS = {
  // ─── Parse CSV ─────────────────────────────────────────────────────────────

  parse(csvText) {
    const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row.");

    const headers = CSV_UTILS._parseLine(lines[0]);
    if (headers.length === 0) throw new Error("CSV header row is empty.");

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = CSV_UTILS._parseLine(line);
      const record = {};
      headers.forEach((h, idx) => {
        record[h.trim()] = (values[idx] || "").trim();
      });
      records.push(record);
    }
    return { headers, records };
  },

  _parseLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        result.push(current); current = "";
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  },

  // ─── Validate & coerce against UdfMeta field definitions ──────────────────

  validateAndCoerce(record, fieldDefs, rowNum) {
    const errors = [];
    const coerced = {};

    for (const field of fieldDefs) {
      const name = field.name;
      const type = (field.dataType || field.type || "STRING").toUpperCase();
      const required = field.mandatory === true;
      const allowedValues = field.allowedValues; // [{key, label}] or null
      const value = record[name];

      if (value === undefined || value === "") {
        if (required) errors.push(`Row ${rowNum}: Required field "${name}" is missing.`);
        continue;
      }

      switch (type) {
        case "INT":
          const n = parseInt(value, 10);
          if (isNaN(n)) errors.push(`Row ${rowNum}: "${name}" expects an integer, got "${value}".`);
          else coerced[name] = n;
          break;

        case "FLOAT":
        case "PERCENTAGE":
        case "UNIT":
        case "MONETARYAMOUNT":
          const f = parseFloat(value);
          if (isNaN(f)) errors.push(`Row ${rowNum}: "${name}" expects a decimal number, got "${value}".`);
          else coerced[name] = f;
          break;

        case "BOOLEAN":
          const lower = value.toLowerCase();
          if (!["true", "false", "1", "0", "yes", "no"].includes(lower)) {
            errors.push(`Row ${rowNum}: "${name}" expects true/false, got "${value}".`);
          } else {
            coerced[name] = ["true", "1", "yes"].includes(lower);
          }
          break;

        case "DATE":
        case "TIME":
        case "DATETIME":
          const d = new Date(value);
          if (isNaN(d.getTime())) {
            errors.push(`Row ${rowNum}: "${name}" expects an ISO 8601 date/time, got "${value}".`);
          } else {
            coerced[name] = d.toISOString();
          }
          break;

        case "SELECTIONLIST":
          if (allowedValues && allowedValues.length > 0) {
            const keys = allowedValues.map((v) => v.key);
            if (!keys.includes(value)) {
              errors.push(`Row ${rowNum}: "${name}" must be one of [${keys.join(", ")}], got "${value}".`);
            } else {
              coerced[name] = value;
            }
          } else {
            coerced[name] = value;
          }
          break;

        case "SELECTIONLISTWITHFREETEXT":
          // Warn if there are allowed values and the input doesn't match, but still accept it
          coerced[name] = value;
          break;

        case "UUID":
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRe.test(value)) {
            errors.push(`Row ${rowNum}: "${name}" expects a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got "${value}".`);
          } else {
            coerced[name] = value;
          }
          break;

        case "STRING":
        default:
          coerced[name] = value;
          break;
      }
    }

    return { coerced, errors };
  },

  // ─── Generate CSV template from UdfMeta field definitions ─────────────────

  generateTemplate(objectName, fieldDefs) {
    const systemFields = ["id", "createDateTime", "lastChanged", "createPerson", "lastChangedBy"];
    const usable = fieldDefs.filter((f) => !systemFields.includes(f.name));

    const headers = usable.map((f) => f.name);

    const typeHints = usable.map((f) => {
      const type = f.dataType || f.type || "STRING";
      const req = f.mandatory ? "*REQUIRED*" : "optional";
      const allowed = f.allowedValues && f.allowedValues.length
        ? ` [${f.allowedValues.map((v) => v.key).join("|")}]`
        : "";
      return `[${type}${allowed}] ${req}`;
    });

    const examples = usable.map((f) => {
      const type = (f.dataType || f.type || "STRING").toUpperCase();
      const fieldName = f.name || "";

      // SELECTIONLIST: show all allowed keys so user knows exact valid values
      if (f.allowedValues && f.allowedValues.length) {
        return f.allowedValues.map(v => v.key).join(" | ");
      }

      switch (type) {
        case "INT":            return "42";
        case "FLOAT":
        case "PERCENTAGE":     return "3.14";
        case "UNIT":           return "1.0";
        case "MONETARYAMOUNT": return "100.00";
        case "BOOLEAN":        return "true";
        case "DATE":           return "2024-01-15";
        case "TIME":           return "10:00:00";
        case "DATETIME":       return "2024-01-15T10:00:00Z";
        case "UUID":           return "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
        case "STRING":
        default: {
          // Derive a sensible example from the field name
          const lower = fieldName.toLowerCase();
          if (lower.includes("email"))       return "user@example.com";
          if (lower.includes("phone"))       return "+1-555-000-0000";
          if (lower.includes("date"))        return "2024-01-15";
          if (lower.includes("name"))        return "John Smith";
          if (lower.includes("description") || lower.includes("comment") || lower.includes("note")) return "Enter description here";
          if (lower.includes("id"))          return "REF-001";
          if (lower.includes("address"))     return "123 Main St";
          if (lower.includes("city"))        return "New York";
          if (lower.includes("country"))     return "US";
          if (lower.includes("zip") || lower.includes("postal")) return "10001";
          if (lower.includes("url") || lower.includes("link"))   return "https://example.com";
          return `sample_${fieldName}`;
        }
      }
    });

    const esc = (v) => (String(v).includes(",") ? `"${v}"` : v);

    return [
      `# SAP FSM Data Uploader — Template for: ${objectName}`,
      `# Delete ALL rows starting with # before uploading`,
      `# Row below: type hints — delete before uploading`,
      headers.map(esc).join(","),
      typeHints.map(esc).join(","),
      examples.map(esc).join(","),
    ].join("\n");
  },

  downloadCsv(filename, content) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

if (typeof module !== "undefined") {
  module.exports = CSV_UTILS;
} else {
  window.CSV_UTILS = CSV_UTILS;
}
