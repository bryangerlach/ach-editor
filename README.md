# ACH Studio

A local, dependency-free NACHA/ACH file viewer and editor. It breaks every record into labeled fields with byte positions, validates the file as you type, and recalculates entry hashes, debit/credit totals, record counts, block counts, and padding automatically.

Everything runs in the browser. Files are never uploaded.

## Quick start

Open `index.html` directly in a modern browser. No installation, build step, or server is required.

For a local preview server (recommended while developing, and useful if your browser restricts `file://` features):

```powershell
node tools/serve.mjs 4173
# http://localhost:4173/
```

### Docker

The included Compose setup serves the static app with nginx:

```powershell
docker compose up -d --build
```

Open <http://localhost:8080> (or `http://<server-ip>:8080`).

The published port defaults to `8080` and is read directly from `docker-compose.yml`. Override it with the `ACH_STUDIO_PORT` environment variable, or copy `.env.example` to `.env` and change the value:

```powershell
$env:ACH_STUDIO_PORT=9000; docker compose up -d
```

```dotenv
ACH_STUDIO_PORT=9000
```

Useful commands:

```powershell
docker compose ps
docker compose logs -f
docker compose down
```

### Published image

The workflow in `.github/workflows/docker.yml` runs the core tests and publishes the image to GitHub Container Registry on every push to `main` and on `v*.*.*` tags. Pull requests build the image without pushing it.

```text
ghcr.io/OWNER/ach-editor:latest
ghcr.io/OWNER/ach-editor:sha-<commit>
ghcr.io/OWNER/ach-editor:<version>   # from a vX.Y.Z tag
```

On a server, copy the example environment file, point it at the published image, and pull:

```bash
cp .env.example .env
# Edit .env:
#   ACH_STUDIO_IMAGE=ghcr.io/OWNER/ach-editor:latest
#   ACH_STUDIO_PORT=8080

docker login ghcr.io          # only needed if the package is private
docker compose pull
docker compose up -d
```

Make the GHCR package public in the repository's package settings if you want to pull it without credentials.

The container includes a health check. If you expose the app over plain HTTP on a non-localhost address, browsers disable the File System Access API, so **Save** falls back to a normal download. Put the app behind HTTPS (for example, a reverse proxy) to enable the save-file picker.

## Features

- **Open and edit ACH files.** Use the toolbar, `Ctrl+O`, or drag and drop a file onto the window.
- **Every field labeled.** File header, batch headers, entry details, addenda, batch controls, file control, and padding records are shown as individual fields with their NACHA positions, descriptions, and hints.
- **Live recalculation.** Editing an entry amount, transaction code, or addenda immediately updates the batch and file control totals, entry hash, counts, block count, and padding.
- **Validation.** Checks routing numbers and check digits, required fields, service class conflicts, prenote amounts, addenda counts, fixed values, and stale control values.
- **Record editing.** Add or delete batches, entries, and addenda; convert addenda types between `05`, `98`, and `99`.
- **Layout awareness.** Uses the standard entry layout, plus CTX/ATX/ENR and CIE/MTE layouts based on the batch's Standard Entry Class code. Addenda types `05`, `98`, and `99` get dedicated layouts; other addenda types fall back to a raw record view.
- **File map and diagnostics.** A visual map shows record order and padding; the diagnostics panel lists errors and warnings by field.
- **Raw views.** Inspect the generated file and each record as fixed-width text, with an option to display spaces as dots.
- **Safe saving.** Supports the File System Access API when available and falls back to a normal download. Line endings (CRLF/LF) and the final newline are configurable.
- **Local backup.** Unsaved work is mirrored to `localStorage`, so a reload or accidental close can offer to restore the last edit.
- **Responsive UI.** Sidebar summary, file map, diagnostics, and field cards adapt from wide desktop layouts down to a single column.

## Derived fields and manual mode

Fields marked **AUTO** are derived from the entries:

- Batch and file entry/addenda counts
- Batch and file entry hashes
- Batch and file debit and credit totals
- File batch count, block count, and padding

With **Protect derived fields** enabled (the default), these fields are read-only and update as you edit. Turn it off in the settings menu (gear icon) to edit them manually; stale values are then flagged as warnings until recalculated.

The **Recalculate** button (`F9`) applies all computed values once, even when protection is off.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save as |
| `F9` | Recalculate controls |
| `Esc` | Close the current dialog or settings menu |

## Supported records

- File header (`1`)
- Batch header (`5`)
- Entry detail (`6`), including CTX/ATX/ENR and CIE/MTE field layouts
- Addenda (`7`) types `05`, `98`, and `99`, with raw fallback for other types
- Batch control (`8`)
- File control (`9`)
- Padding records (all-nines, 94 characters)

Records must be exactly 94 characters. Malformed or short records are reported in diagnostics and preserved through the raw fallback where possible.

## Project layout

```text
index.html                 App shell
css/styles.css             Theme and responsive layout
js/core.js                 Parsing, serialization, totals, validation (UMD)
js/app.js                  UI rendering and interactions
js/sample.js               Embedded sample file
samples/payroll.ach        Generated sample ACH file
tools/make-samples.mjs     Sample generator
tools/test-core.mjs        Core test suite
tools/serve.mjs            Local static preview server
tools/preview-wide.html    Development-only wide-layout preview harness
Dockerfile                 nginx-based static image
docker-compose.yml         Compose service with configurable port
.env.example               Example Compose port and image settings
.dockerignore              Keeps the image build context small
.github/workflows/docker.yml  Test, build, and publish to GHCR
```

`js/core.js` is UMD-style so the same code runs in the browser as `window.ACHCore` and in Node for tests.

## Generate and test

```powershell
# Regenerate samples/payroll.ach and js/sample.js
node tools/make-samples.mjs

# Run the core test suite
node tools/test-core.mjs

# Syntax checks
node --check js/core.js
node --check js/app.js
```

The test suite covers field continuity (94 characters per record), sample parsing and totals, byte-for-byte round-trip serialization, control recalculation, stale-control detection, validation rules, check digits, addenda `98`/`99`, CTX layout positions, block padding, amount formatting, and field overflow.

## Notes

- The app works offline and makes no network requests. Open, save, and backup all happen on the local machine.
- Saving with validation errors requires confirmation, so incomplete edits can still be exported.
- The settings and backup are stored under `ach-studio.settings.v1` and `ach-studio.backup.v1` in `localStorage`.
- `tools/preview-wide.html` is only for development screenshots and is not needed to use the app.
