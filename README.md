# Custom Objects Manager — SAP FSM Shell Extension

A Shell SDK extension that runs as a **home screen tile** inside SAP FSM. It lets you browse, filter, create, edit and delete Custom Object (UdoValue) records without leaving the Shell.

---

## Features

| Feature | Details |
|---|---|
| **Object browser** | Sidebar with live search lists all UdoMeta Custom Objects |
| **Records grid** | Full-text filter, sortable columns (click header), drag-to-reorder columns, drag-to-resize columns |
| **Record detail** | Dynamic form renders the correct input widget per FSM field type |
| **Create** | New Record → blank form → Save |
| **Edit** | Click any row → edit fields → Save |
| **Delete** | Confirm dialog → `DELETE /api/data/v4/UdoValue/{id}` |
| **Export CSV** | Downloads the current filtered view |

---

## File Structure

```
fsm-custom-objects/
├── index.html          ← Extension entry point (loaded by Shell in an iframe)
├── appconfig.json      ← FSM extension config (read by Shell during registration)
├── assets/
│   └── icon.svg
└── src/
    ├── app.js          ← Shell SDK init + all UI logic
    ├── fsm-api.js      ← SAP FSM Query + Data API wrapper
    └── csv-utils.js    ← CSV utilities
```

---

## Setup

### 1. Set your OAuth client credentials

Open `src/app.js` and replace the two constants near the top:

```js
const CLIENT_IDENTIFIER = 'YOUR_CLIENT_IDENTIFIER';
const CLIENT_SECRET     = 'YOUR_CLIENT_SECRET';
```

These are sent to the Shell via `REQUIRE_CONTEXT`. The Shell exchanges them for an auth token and returns it in the context response. The extension never calls the OAuth endpoint directly — the Shell handles auth.

### 2. Host the extension

Deploy the entire `fsm-custom-objects/` folder to any HTTPS host (e.g. GitHub Pages, SAP BTP, Nginx). The `index.html` must be publicly reachable.

### 3. Register in SAP FSM

1. In SAP FSM, go to **Foundational Services → Extensions → Installed**.
2. Click **Add Extension**.
3. Enter the URL of your hosted `index.html`.
4. Assign the extension to the **Home Screen** outlet.
5. Save and refresh the Shell — the tile will appear on the home screen.

---

## How Shell SDK Auth Works

```
Extension (iframe)                    Shell (parent window)
      │                                       │
      │  REQUIRE_CONTEXT {                    │
      │    clientIdentifier,                  │
      │    clientSecret,                      │
      │    auth: { response_type: 'token' }   │
      │  }                                    │
      │──────── postMessage ─────────────────>│
      │                                       │  (Shell fetches OAuth token)
      │<──────── postMessage ─────────────────│
      │  { auth: { access_token, … },         │
      │    cloudHost, account, company, … }   │
      │                                       │
      │  Uses access_token for all API calls  │
```

Extensions receive `auth.access_token` (not `authToken` — that is only for non-extension apps).

---

## API Endpoints Used

| Operation | Method | Endpoint |
|---|---|---|
| List Custom Objects | POST | `/api/query/v1` → `SELECT u FROM UdoMeta u` |
| List Fields | POST | `/api/query/v1` → `SELECT u FROM UdfMeta u WHERE u.id IN (…)` |
| List Records | POST | `/api/query/v1` → `SELECT u FROM UdoValue u WHERE u.meta = '…'` |
| Create Record | POST | `/api/data/v4/UdoValue` |
| Delete Record | DELETE | `/api/data/v4/UdoValue/{id}` |

---

## Development (standalone)

Open `index.html` directly in a browser (file:// or local server). The app detects it's outside the Shell (`ShellSdk.isInsideShell() === false`) and enters **dev-mock mode** — the loading screen clears and the UI renders, but no API calls are made until you supply a real token. You can temporarily hard-code `apiConfig` and `authToken` at the bottom of `src/app.js` for local testing.

---

## Dependencies

- [`fsm-shell`](https://www.npmjs.com/package/fsm-shell) — loaded from `unpkg.com` at runtime, no npm install required
- No other external dependencies
