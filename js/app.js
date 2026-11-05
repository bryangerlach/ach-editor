/* ACH Studio — UI */
(function () {
  'use strict';

  var core = window.ACHCore;
  if (!core) return;

  var SETTINGS_KEY = 'ach-studio.settings.v1';
  var BACKUP_KEY = 'ach-studio.backup.v1';
  var STRIP_ZERO_KEYS = {
    entryAddendaCount: 1,
    batchCount: 1,
    blockCount: 1,
    batchNumber: 1,
    numberOfAddendaRecords: 1,
    addendaSequenceNumber: 1,
    entryDetailSequenceNumber: 1,
    totalDebitEntryDollarAmount: 1,
    totalCreditEntryDollarAmount: 1
  };

  var state = {
    doc: null,
    fileName: '',
    handle: null,
    dirty: false,
    autoFix: true,
    showSpaces: false,
    lineEnding: '\r\n',
    finalNewline: true,
    computed: null,
    issues: [],
    parseIssues: [],
    rawOpen: Object.create(null),
    backup: null,
    lastAction: 'Ready',
    modal: null,
    recordCounter: 0,
    savedAt: 0
  };

  var els = {};
  var backupTimer = null;

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeStore(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    var saved = readStore(SETTINGS_KEY);
    if (!saved) return;
    if (typeof saved.autoFix === 'boolean') state.autoFix = saved.autoFix;
    if (typeof saved.showSpaces === 'boolean') state.showSpaces = saved.showSpaces;
    if (saved.lineEnding === 'lf' || saved.lineEnding === 'crlf') {
      state.lineEnding = saved.lineEnding === 'lf' ? '\n' : '\r\n';
    }
    if (typeof saved.finalNewline === 'boolean') state.finalNewline = saved.finalNewline;
  }

  function saveSettings() {
    writeStore(SETTINGS_KEY, {
      autoFix: state.autoFix,
      showSpaces: state.showSpaces,
      lineEnding: state.lineEnding === '\n' ? 'lf' : 'crlf',
      finalNewline: state.finalNewline
    });
  }

  function formatClock(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    } catch (e) {
      return '';
    }
  }

  function centsToDollars(cents) {
    var s = String(cents == null ? '' : cents).trim();
    if (s === '') return '';
    if (!/^\d+$/.test(s)) return '';
    return (Number(s) / 100).toFixed(2);
  }

  function padHash(value) {
    return String(value == null ? 0 : value).padStart(10, '0');
  }

  /* ------------------------------------------------------------------ *
   * Toasts and modals
   * ------------------------------------------------------------------ */

  function toast(message, tone) {
    var host = $('toasts');
    if (!host) return;
    var node = document.createElement('div');
    node.className = 'toast' + (tone ? ' toast-' + tone : '');
    node.textContent = message;
    host.appendChild(node);
    window.setTimeout(function () {
      node.classList.add('toast-out');
      window.setTimeout(function () { node.remove(); }, 260);
    }, 3800);
  }

  function closeModal() {
    if (!state.modal) return;
    var onClose = state.modal.onClose;
    state.modal = null;
    var root = $('modalRoot');
    if (root) root.innerHTML = '';
    document.body.classList.remove('modal-open');
    if (typeof onClose === 'function') onClose();
  }

  function openModal(options) {
    if (state.modal) closeModal();
    var root = $('modalRoot');
    if (!root) return;
    var actions = options.actions || [];
    var actionHtml = actions.map(function (action, index) {
      var tone = action.tone ? ' btn-' + action.tone : '';
      return '<button type="button" class="btn' + tone + '" data-modal-index="' + index + '">' +
        esc(action.label) + '</button>';
    }).join('');
    root.innerHTML =
      '<div class="modal-backdrop" data-modal-backdrop="1">' +
        '<div class="modal' + (options.wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
          '<div class="modal-head">' +
            '<h2 id="modalTitle">' + esc(options.title || '') + '</h2>' +
            '<button type="button" class="icon-btn" data-modal-close="1" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="modal-body">' + (options.body || '') + '</div>' +
          (actionHtml ? '<div class="modal-foot">' + actionHtml + '</div>' : '') +
        '</div>' +
      '</div>';

    document.body.classList.add('modal-open');
    state.modal = { onClose: options.onClose };

    var backdrop = root.querySelector('[data-modal-backdrop]');
    if (backdrop) {
      backdrop.addEventListener('mousedown', function (event) {
        if (event.target === backdrop) closeModal();
      });
    }
    root.querySelectorAll('[data-modal-close]').forEach(function (button) {
      button.addEventListener('click', closeModal);
    });
    root.querySelectorAll('[data-modal-index]').forEach(function (button) {
      button.addEventListener('click', function () {
        var action = actions[Number(button.getAttribute('data-modal-index'))];
        if (!action) return;
        if (action.onClick) {
          var result = action.onClick();
          if (result === false) return;
        }
        if (action.close !== false) closeModal();
      });
    });

    var focusTarget = root.querySelector('[data-modal-autofocus]') || root.querySelector('.modal-foot .btn-accent, .modal-foot .btn-danger, .modal-foot .btn');
    if (focusTarget) focusTarget.focus();
  }

  function confirmModal(options) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      openModal({
        title: options.title,
        body: '<p class="modal-text">' + esc(options.message) + '</p>',
        onClose: function () { done(false); },
        actions: [
          {
            label: options.cancelLabel || 'Cancel',
            onClick: function () { done(false); }
          },
          {
            label: options.confirmLabel || 'Continue',
            tone: options.tone || 'accent',
            onClick: function () { done(true); }
          }
        ]
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function downloadText(text, name) {
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name || 'file.ach';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ------------------------------------------------------------------ *
   * Document lifecycle
   * ------------------------------------------------------------------ */

  function buildText() {
    if (!state.doc) return '';
    return core.buildFile(state.doc, {
      applyComputed: state.autoFix,
      lineEnding: state.lineEnding,
      finalNewline: state.finalNewline
    });
  }

  function markChanged(message) {
    state.dirty = true;
    if (message) state.lastAction = message;
    updateToolbar();
    scheduleBackup();
  }

  function scheduleBackup() {
    if (!state.doc) return;
    window.clearTimeout(backupTimer);
    backupTimer = window.setTimeout(persistBackup, 450);
  }

  function persistBackup() {
    if (!state.doc) return;
    var payload = {
      name: state.fileName || 'untitled.ach',
      text: buildText(),
      dirty: state.dirty,
      at: Date.now()
    };
    if (writeStore(BACKUP_KEY, payload)) {
      state.backup = payload;
    }
  }

  function clearBackup() {
    window.clearTimeout(backupTimer);
    removeStore(BACKUP_KEY);
    state.backup = null;
    renderRestoreCard();
  }

  function confirmDiscard() {
    if (!state.doc || !state.dirty) return Promise.resolve(true);
    return confirmModal({
      title: 'Discard unsaved changes?',
      message: 'The open file has unsaved changes. Opening another file will discard them.',
      confirmLabel: 'Discard changes',
      tone: 'danger'
    });
  }

  function loadFromText(text, name, options) {
    var parsed;
    try {
      parsed = core.parseFile(text);
    } catch (error) {
      toast(error && error.message ? error.message : 'Could not read that file.', 'error');
      return false;
    }
    var opts = options || {};
    state.doc = parsed.doc;
    state.parseIssues = parsed.issues || [];
    state.fileName = name || 'untitled.ach';
    state.handle = opts.handle || null;
    state.dirty = !!opts.dirty;
    state.lineEnding = parsed.lineEnding;
    state.finalNewline = parsed.finalNewline;
    state.rawOpen = Object.create(null);
    state.issues = [];
    state.recordCounter = 0;

    if (state.autoFix) core.applyComputed(state.doc);
    state.lastAction = 'Opened ' + state.fileName;

    if (els.optLineEnding) els.optLineEnding.value = state.lineEnding === '\n' ? 'lf' : 'crlf';
    if (els.optFinalNewline) els.optFinalNewline.checked = state.finalNewline;
    saveSettings();

    renderAll();
    scheduleBackup();
    if (state.parseIssues.length) {
      toast(state.parseIssues.length + ' parse note(s) — review validation for details.', 'warn');
    }
    return true;
  }

  function openFileDialog() {
    confirmDiscard().then(function (ok) {
      if (!ok) return;
      if (window.showOpenFilePicker) {
        window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'ACH files',
            accept: { 'text/plain': ['.ach', '.txt'] }
          }]
        }).then(function (handles) {
          var handle = handles && handles[0];
          if (!handle) return;
          return handle.getFile().then(function (file) {
            return file.text().then(function (text) {
              if (loadFromText(text, file.name, { handle: handle })) {
                toast('Opened ' + file.name, 'success');
              }
            });
          });
        }).catch(function (error) {
          if (error && error.name === 'AbortError') return;
          els.fileInput.value = '';
          els.fileInput.click();
        });
        return;
      }
      els.fileInput.value = '';
      els.fileInput.click();
    });
  }

  function writeToHandle(handle, text) {
    return handle.createWritable().then(function (writable) {
      return writable.write(text).then(function () {
        return writable.close();
      });
    });
  }

  function markSaved(action) {
    state.dirty = false;
    state.parseIssues = [];
    state.lastAction = action;
    clearBackup();
    renderAll();
  }

  function saveFile(forceAs) {
    if (!state.doc) return Promise.resolve();
    var errors = state.issues.filter(function (issue) { return issue.severity === 'error'; });
    var proceed = errors.length
      ? confirmModal({
          title: 'Save with validation errors?',
          message: errors.length + ' validation error(s) are still present. The file can be saved, but a processor may reject it.',
          confirmLabel: 'Save anyway',
          tone: 'danger'
        })
      : Promise.resolve(true);

    return proceed.then(function (ok) {
      if (!ok) return;
      if (state.autoFix) core.applyComputed(state.doc);
      var text = buildText();

      if (!forceAs && state.handle && state.handle.createWritable) {
        return writeToHandle(state.handle, text).then(function () {
          markSaved('Saved ' + state.fileName);
          toast('Saved ' + state.fileName, 'success');
        }, function () {
          toast('Could not write to that file. Use Save as instead.', 'error');
        });
      }

      if (window.showSaveFilePicker) {
        return window.showSaveFilePicker({
          suggestedName: state.fileName || 'file.ach',
          types: [{
            description: 'ACH files',
            accept: { 'text/plain': ['.ach', '.txt'] }
          }]
        }).then(function (handle) {
          return writeToHandle(handle, text).then(function () {
            state.handle = handle;
            state.fileName = handle.name || state.fileName;
            markSaved('Saved ' + state.fileName);
            toast('Saved ' + state.fileName, 'success');
          });
        }).catch(function (error) {
          if (error && error.name === 'AbortError') return;
          downloadText(text, state.fileName);
          markSaved('Downloaded ' + state.fileName);
          toast('Downloaded ' + state.fileName, 'success');
        });
      }

      downloadText(text, state.fileName);
      markSaved('Downloaded ' + state.fileName);
      toast('Downloaded ' + state.fileName, 'success');
    });
  }

  function loadSample() {
    confirmDiscard().then(function (ok) {
      if (!ok) return;
      var sample = window.ACH_SAMPLE;
      if (!sample || !sample.text) {
        toast('Sample file is not available.', 'error');
        return;
      }
      if (loadFromText(sample.text, sample.name, { dirty: false })) {
        toast('Loaded sample file.', 'success');
      }
    });
  }

  function restoreBackup() {
    var backup = state.backup || readStore(BACKUP_KEY);
    if (!backup || !backup.text) {
      toast('No saved session was found.', 'warn');
      return;
    }
    if (loadFromText(backup.text, backup.name || 'restored.ach', { dirty: true })) {
      state.lastAction = 'Restored unsaved session';
      if (els.statusLeft) els.statusLeft.textContent = state.lastAction;
      toast('Restored the last unsaved session.', 'success');
    }
  }

  function discardBackup() {
    clearBackup();
    toast('Saved session discarded.', 'success');
  }

  function recalculate() {
    if (!state.doc) return;
    core.applyComputed(state.doc);
    markChanged('Control totals recalculated');
    renderAll();
    toast('Hashes, totals, counts and padding recalculated.', 'success');
  }

  /* ------------------------------------------------------------------ *
   * Rendering — insights and chrome
   * ------------------------------------------------------------------ */

  function computeInsights() {
    if (!state.doc) {
      state.issues = [];
      state.computed = null;
      return { issues: [], map: Object.create(null), counts: { error: 0, warning: 0 }, computed: null };
    }
    var issues = core.validate(state.doc, { autoFix: state.autoFix });
    if (state.parseIssues && state.parseIssues.length) {
      issues = state.parseIssues.concat(issues);
    }
    state.issues = issues;
    var counts = { error: 0, warning: 0 };
    var map = Object.create(null);
    issues.forEach(function (issue) {
      if (issue.severity === 'error' || issue.severity === 'warning') {
        counts[issue.severity] = (counts[issue.severity] || 0) + 1;
      }
      if (issue.path && issue.path !== 'file' && issue.path !== 'padding') {
        if (!map[issue.path]) map[issue.path] = [];
        map[issue.path].push(issue);
      }
    });
    state.computed = core.computeTotals(state.doc);
    return { issues: issues, map: map, counts: counts, computed: state.computed };
  }

  function refreshInsights() {
    if (!state.doc) return;
    var insights = computeInsights();
    renderSummary(insights);
    renderDiagnostics(insights);
    renderBanner(insights);
    renderStatus(insights);
    applyIssueClasses(insights.map);
  }

  function updateToolbar() {
    if (!els.fileName) return;
    els.fileName.textContent = state.doc ? state.fileName : 'No file open';
    els.fileName.title = state.doc ? state.fileName : '';
    els.dirtyDot.hidden = !state.dirty || !state.doc;
    els.btnSave.disabled = !state.doc;
    els.btnSaveAs.disabled = !state.doc;
    els.btnRecalc.disabled = !state.doc;
    document.title = (state.doc ? (state.dirty ? '\u2022 ' : '') + state.fileName + ' — ' : '') + 'ACH Studio';
  }

  function updateDirtyDot() {
    els.dirtyDot.hidden = !state.dirty || !state.doc;
    updateToolbar();
  }

  function renderAll() {
    if (!state.doc) {
      renderEmpty();
      return;
    }
    els.emptyState.hidden = true;
    els.workspace.hidden = false;
    var main = els.main;
    var scrollTop = main ? main.scrollTop : 0;
    var insights = computeInsights();
    renderSummary(insights);
    renderOutline(insights);
    renderMap(insights);
    renderDiagnostics(insights);
    renderSections(insights.map);
    renderBanner(insights);
    renderStatus(insights);
    renderRestoreCard();
    updateToolbar();
    if (main) main.scrollTop = scrollTop;
  }

  function renderEmpty() {
    els.emptyState.hidden = false;
    els.workspace.hidden = true;
    els.banner.hidden = true;
    state.issues = [];
    state.computed = null;
    if (els.statusLeft) els.statusLeft.textContent = 'Ready';
    if (els.statusCenter) els.statusCenter.textContent = '';
    if (els.statusRight) els.statusRight.textContent = 'Local only · Nothing is uploaded';
    renderRestoreCard();
    updateToolbar();
  }

  function renderRestoreCard() {
    var host = els.restoreHost;
    if (!host) return;
    var backup = state.backup;
    if (!backup) {
      host.innerHTML = '';
      return;
    }
    var when = formatClock(backup.at);
    host.innerHTML =
      '<div class="restore-card">' +
        '<div class="restore-icon" aria-hidden="true">&#8635;</div>' +
        '<div class="restore-body">' +
          '<strong>Unsaved session found</strong>' +
          '<span>' + esc(backup.name || 'untitled.ach') + (when ? ' · ' + esc(when) : '') + '</span>' +
        '</div>' +
        '<div class="restore-actions">' +
          '<button type="button" class="btn btn-sm btn-accent" data-action="restore-backup">Restore</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="discard-backup">Discard</button>' +
        '</div>' +
      '</div>';
  }

  function renderSummary(insights) {
    var host = els.summaryHost;
    if (!host) return;
    var computed = insights.computed;
    if (!computed) { host.innerHTML = ''; return; }
    var entries = 0;
    var addenda = 0;
    state.doc.batches.forEach(function (batch) {
      entries += batch.entries.length;
      batch.entries.forEach(function (entry) { addenda += entry.addenda.length; });
    });
    var counts = insights.counts;
    var tone = counts.error ? 'bad' : (counts.warning ? 'warn' : 'ok');
    var validationText = counts.error
      ? counts.error + ' error' + (counts.error === 1 ? '' : 's')
      : (counts.warning ? counts.warning + ' warning' + (counts.warning === 1 ? '' : 's') : 'All checks pass');
    host.innerHTML =
      '<div class="summary-card">' +
        '<div class="summary-head"><span>File overview</span><span class="validation-pill ' + tone + '">' + esc(validationText) + '</span></div>' +
        '<div class="stat-grid">' +
          '<div class="stat"><span class="stat-label">Batches</span><span class="stat-value">' + computed.file.batchCount + '</span></div>' +
          '<div class="stat"><span class="stat-label">Entries</span><span class="stat-value">' + entries + '</span></div>' +
          '<div class="stat"><span class="stat-label">Debits</span><span class="stat-value neg">' + esc(core.formatCents(computed.file.debit)) + '</span></div>' +
          '<div class="stat"><span class="stat-label">Credits</span><span class="stat-value pos">' + esc(core.formatCents(computed.file.credit)) + '</span></div>' +
          '<div class="stat stat-wide"><span class="stat-label">Entry hash</span><span class="stat-value mono">' + padHash(computed.file.entryHash) + '</span></div>' +
          '<div class="stat"><span class="stat-label">Records</span><span class="stat-value">' + computed.file.totalRecords + '</span></div>' +
          '<div class="stat"><span class="stat-label">Blocks</span><span class="stat-value">' + computed.file.blockCount + '</span></div>' +
          '<div class="stat"><span class="stat-label">Padding</span><span class="stat-value">' + computed.file.padding + '</span></div>' +
          '<div class="stat"><span class="stat-label">Addenda</span><span class="stat-value">' + addenda + '</span></div>' +
        '</div>' +
        '<div class="summary-foot">' + (state.autoFix ? 'Controls recalculate automatically.' : 'Manual control mode — derived fields are editable.') + '</div>' +
      '</div>';
  }

  function renderOutline(insights) {
    var host = els.outline;
    if (!host) return;
    var html = '';
    html += '<button type="button" class="outline-item" data-action="jump" data-target="rec-fh"><span class="outline-dot type-1"></span><span class="outline-text">File header</span></button>';
    state.doc.batches.forEach(function (batch, bi) {
      var name = String(batch.header.fields.companyName || '').trim() || 'Batch ' + (bi + 1);
      html += '<button type="button" class="outline-item" data-action="jump" data-target="rec-b' + bi + '-h">' +
        '<span class="outline-dot type-5"></span><span class="outline-text">' + esc(name) + '</span>' +
        '<span class="outline-count">' + batch.entries.length + '</span></button>';
    });
    html += '<button type="button" class="outline-item" data-action="jump" data-target="rec-fc"><span class="outline-dot type-9"></span><span class="outline-text">File control</span></button>';
    html += '<button type="button" class="outline-item" data-action="jump" data-target="sec-padding"><span class="outline-dot type-pad"></span><span class="outline-text">Padding</span><span class="outline-count">' + insights.computed.file.padding + '</span></button>';
    host.innerHTML = html;
  }

  function mapChip(type, target, title) {
    var cls = type === '9p' ? 'pad' : type;
    return '<button type="button" class="map-chip type-' + cls + '" data-action="jump" data-target="' + target + '" title="' + esc(title) + '">' + (type === '9p' ? '9' : type) + '</button>';
  }

  function renderMap(insights) {
    var host = els.mapHost;
    if (!host) return;
    var computed = insights.computed;
    var parts = [];
    parts.push(mapChip('1', 'rec-fh', 'File header'));
    state.doc.batches.forEach(function (batch, bi) {
      parts.push(mapChip('5', 'rec-b' + bi + '-h', 'Batch ' + (bi + 1) + ' header'));
      batch.entries.forEach(function (entry, ei) {
        parts.push(mapChip('6', 'rec-b' + bi + '-e' + ei + '-d', 'Entry ' + (ei + 1) + ' in batch ' + (bi + 1)));
        entry.addenda.forEach(function (addenda, ai) {
          parts.push(mapChip('7', 'rec-b' + bi + '-e' + ei + '-a' + ai, 'Addenda ' + (ai + 1) + ' for entry ' + (ei + 1)));
        });
      });
      parts.push(mapChip('8', 'rec-b' + bi + '-c', 'Batch ' + (bi + 1) + ' control'));
    });
    parts.push(mapChip('9', 'rec-fc', 'File control'));
    var padding = computed.file.padding || 0;
    for (var i = 0; i < Math.min(padding, 12); i += 1) parts.push(mapChip('9p', 'sec-padding', 'Padding record ' + (i + 1)));
    if (padding > 12) parts.push('<span class="map-more">+' + (padding - 12) + '</span>');

    host.innerHTML =
      '<div class="map-panel">' +
        '<div class="map-head"><div><h2>File map</h2><span class="map-sub">' + computed.file.totalRecords + ' records + ' + padding + ' padding · ' + computed.file.blockCount + ' block' + (computed.file.blockCount === 1 ? '' : 's') + '</span></div>' +
        '<div class="map-legend"><span><i class="type-1"></i>File</span><span><i class="type-5"></i>Batch</span><span><i class="type-6"></i>Entry</span><span><i class="type-7"></i>Addenda</span><span><i class="type-9"></i>Control</span></div></div>' +
        '<div class="map-strip">' + parts.join('') + '</div>' +
      '</div>';
  }

  function issueTarget(path) {
    if (!path) return '';
    if (path === 'padding') return 'sec-padding';
    if (path === 'file') return 'diagnostics';
    if (path === 'fh' || path.indexOf('fh.') === 0) return 'rec-fh';
    if (path === 'fc' || path.indexOf('fc.') === 0) return 'rec-fc';
    var parts = path.split('.');
    var batch = parts[0] || '';
    if (!/^b\d+$/.test(batch)) return '';
    if (parts[1] === 'h') return 'rec-' + batch + '-h';
    if (parts[1] === 'c') return 'rec-' + batch + '-c';
    if (parts[1] && parts[1].charAt(0) === 'e') {
      var base = 'rec-' + batch + '-' + parts[1] + '-';
      if (parts[2] === 'd') return base + 'd';
      if (parts[2] && parts[2].charAt(0) === 'a') return base + parts[2];
    }
    return '';
  }

  function describePath(path) {
    if (!path) return '';
    if (path === 'file') return 'File';
    if (path === 'padding') return 'Padding';
    var parts = String(path).split('.');
    var bits = [];
    if (parts[0] === 'fh') bits.push('File header');
    else if (parts[0] === 'fc') bits.push('File control');
    else if (/^b\d+$/.test(parts[0])) {
      bits.push('Batch ' + (Number(parts[0].slice(1)) + 1));
      if (parts[1] === 'h') bits.push('header');
      else if (parts[1] === 'c') bits.push('control');
      else if (parts[1] && parts[1].charAt(0) === 'e') {
        bits.push('entry ' + (Number(parts[1].slice(1)) + 1));
        if (parts[2] === 'd') bits.push('detail');
        else if (parts[2] && parts[2].charAt(0) === 'a') bits.push('addenda ' + (Number(parts[2].slice(1)) + 1));
      }
    }
    var def = state.doc ? core.fieldDefForPath(state.doc, path) : null;
    if (def) bits.push(def.label);
    return bits.join(' · ');
  }

  function renderDiagnostics(insights) {
    var host = els.diagnosticsHost;
    if (!host) return;
    var counts = insights.counts;
    var issues = insights.issues.slice().sort(function (a, b) {
      if (a.severity === b.severity) return 0;
      return a.severity === 'error' ? -1 : 1;
    });
    var head = '<div class="panel-head"><div><h2>Validation</h2><span class="panel-sub">Checks routing digits, required fields, service classes and controls</span></div>' +
      '<div class="diag-counts">' +
        (counts.error ? '<span class="count-badge bad">' + counts.error + ' error' + (counts.error === 1 ? '' : 's') + '</span>' : '') +
        (counts.warning ? '<span class="count-badge warn">' + counts.warning + ' warning' + (counts.warning === 1 ? '' : 's') + '</span>' : '') +
        (!counts.error && !counts.warning ? '<span class="count-badge ok">No issues</span>' : '') +
      '</div></div>';

    var body;
    if (!issues.length) {
      body = '<div class="diag-empty"><span class="diag-ok" aria-hidden="true">&#10003;</span><div><strong>All checks passed</strong><span>Hashes, totals, counts and record layout match the entries.</span></div></div>';
    } else {
      body = '<ul class="diag-list">' + issues.map(function (issue) {
        var target = issueTarget(issue.path);
        var go = target ? '<button type="button" class="diag-go" data-action="jump" data-target="' + target + '">Go</button>' : '';
        return '<li class="diag-item ' + esc(issue.severity) + '">' +
          '<span class="diag-mark" aria-hidden="true">' + (issue.severity === 'error' ? '!' : 'i') + '</span>' +
          '<div class="diag-copy"><p>' + esc(issue.message) + '</p><span class="diag-path">' + esc(describePath(issue.path)) + '</span></div>' +
          go +
        '</li>';
      }).join('') + '</ul>';
    }
    host.innerHTML = '<section class="panel diag-panel" id="diagnostics">' + head + body + '</section>';
  }

  function renderBanner(insights) {
    var banner = els.banner;
    if (!banner) return;
    var counts = insights.counts;
    var show = counts.error > 0 || counts.warning > 0 || !state.autoFix;
    if (!show) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    var tone = counts.error ? 'error' : 'warn';
    banner.className = 'banner banner-' + tone;
    var title;
    var message;
    if (counts.error) {
      title = counts.error + ' validation error' + (counts.error === 1 ? '' : 's');
      message = counts.warning ? 'Also ' + counts.warning + ' warning' + (counts.warning === 1 ? '' : 's') + '. ' : '';
      message += 'Review the items below before sending this file.';
    } else if (counts.warning) {
      title = counts.warning + ' warning' + (counts.warning === 1 ? '' : 's');
      message = 'The file is readable, but these fields may be rejected by some processors.';
    } else {
      title = 'Manual control mode';
      message = 'Derived fields are editable and are not recalculated as you type.';
    }
    if (!state.autoFix && (counts.error || counts.warning)) {
      message = 'Manual control mode. ' + message;
    }
    els.bannerTitle.textContent = title;
    els.bannerMessage.textContent = message;
    els.bannerActions.innerHTML =
      '<button type="button" class="btn btn-sm" data-action="jump" data-target="diagnostics">Review</button>' +
      ((!state.autoFix || counts.error || counts.warning) ? '<button type="button" class="btn btn-sm btn-accent" data-action="recalc">Recalculate</button>' : '');
  }

  function renderStatus(insights) {
    if (!els.statusLeft) return;
    var computed = insights.computed;
    var entries = 0;
    if (state.doc) {
      state.doc.batches.forEach(function (batch) { entries += batch.entries.length; });
    }
    els.statusLeft.textContent = state.lastAction || 'Ready';
    els.statusCenter.textContent = computed
      ? computed.file.batchCount + ' batch' + (computed.file.batchCount === 1 ? '' : 'es') + ' · ' + entries + ' entr' + (entries === 1 ? 'y' : 'ies') + ' · ' + computed.file.totalRecords + ' records · ' + computed.file.blockCount + ' block' + (computed.file.blockCount === 1 ? '' : 's')
      : '';
    els.statusRight.textContent = (state.lineEnding === '\n' ? 'LF' : 'CRLF') + (state.finalNewline ? ' + final newline' : '') + ' · ' + (state.autoFix ? 'Auto-fix on' : 'Manual controls');
  }

  function applyIssueClasses(map) {
    if (!els.sections) return;
    els.sections.querySelectorAll('[data-field-path]').forEach(function (field) {
      var path = field.getAttribute('data-field-path');
      var list = map[path] || [];
      var hasError = false;
      list.forEach(function (issue) { if (issue.severity === 'error') hasError = true; });
      field.classList.toggle('has-error', hasError);
      field.classList.toggle('has-warning', !hasError && list.length > 0);
      var alert = field.querySelector('.field-issue');
      if (alert) {
        alert.textContent = list.length
          ? list[0].message + (list.length > 1 ? ' (+' + (list.length - 1) + ' more)' : '')
          : '';
      }
    });
  }

  function updateDerivedDom() {
    if (!state.autoFix || !state.computed || !els.sections) return;
    els.sections.querySelectorAll('input[data-derived="1"]').forEach(function (input) {
      var path = input.getAttribute('data-path');
      var expected = state.computed.paths[path];
      if (expected == null) return;
      var def = core.fieldDefForPath(state.doc, path);
      if (!def) return;
      input.value = fieldDisplayValue(def, expected);
    });
  }

  /* ------------------------------------------------------------------ *
   * Rendering — sections, records and fields
   * ------------------------------------------------------------------ */

  function recId(path) {
    return 'rec-' + String(path).replace(/\./g, '-');
  }

  function fieldDisplayValue(def, raw) {
    if (def.amount) {
      if (def.derived && state.autoFix) {
        var cents = String(raw == null ? '' : raw).trim();
        if (/^\d+$/.test(cents)) {
          return (Number(cents) / 100).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          });
        }
      }
      return centsToDollars(raw);
    }
    var value = String(raw == null ? '' : raw);
    if (def.numeric) {
      value = value.trim();
      if (def.derived && STRIP_ZERO_KEYS[def.key]) value = core.stripZeros(value);
      return value;
    }
    return value.replace(/\s+$/, '');
  }

  function datalistFor(def) {
    if (def.key === 'standardEntryClassCode') return 'dl-sec-codes';
    if (def.key === 'transactionCode') return 'dl-transaction-codes';
    if (def.key === 'addendaTypeCode') return 'dl-addenda-types';
    if (def.key === 'returnReasonCode') return 'dl-return-codes';
    if (def.key === 'changeCode') return 'dl-change-codes';
    if (def.key === 'serviceClassCode') return 'dl-service-classes';
    if (def.key === 'fileIDModifier') return 'dl-file-id';
    return '';
  }

  function fieldNote(def, fields, path) {
    var raw = String(fields[def.key] == null ? '' : fields[def.key]).trim();

    if (def.derived && !state.autoFix && state.computed && state.computed.paths[path] != null) {
      var expected = state.computed.paths[path];
      var equal;
      if (def.numeric) equal = core.stripZeros(raw) === core.stripZeros(expected);
      else equal = raw === String(expected).trim();
      if (!equal) {
        var shown = def.amount
          ? core.formatCents(expected)
          : (def.numeric && STRIP_ZERO_KEYS[def.key] ? core.stripZeros(expected) : String(expected).trim());
        return 'Calculated value: ' + shown;
      }
    }

    if (def.amount) {
      if (/^\d+$/.test(raw)) return core.formatCents(raw);
      return 'Amount in cents';
    }
    if (def.date) return core.formatDate6(raw) || 'YYMMDD';
    if (def.time) return core.formatTime4(raw) || 'HHMM';
    if (def.key === 'transactionCode') {
      var tc = core.TRANSACTION_CODES[raw];
      return tc ? tc.label : (raw ? 'Unknown transaction code' : 'e.g. 22 credit, 27 debit');
    }
    if (def.key === 'standardEntryClassCode') {
      return core.SEC_CODES[raw.toUpperCase()] || (raw ? 'Unrecognized SEC code' : 'e.g. PPD, CCD, CTX');
    }
    if (def.key === 'serviceClassCode') {
      return core.SERVICE_CLASSES[raw] || (raw ? 'Unknown service class' : '200, 220 or 225');
    }
    if (def.key === 'addendaTypeCode') {
      return core.ADDENDA_TYPES[raw] || (raw ? 'Raw layout' : '05, 98 or 99');
    }
    if (def.key === 'changeCode') {
      return core.CHANGE_CODES[raw] || (raw ? 'Unrecognized change code' : 'e.g. C01');
    }
    if (def.key === 'returnReasonCode') {
      return core.RETURN_CODES[raw] || (raw ? 'Unrecognized return code' : 'e.g. R01');
    }
    if (def.key === 'checkDigit' || def.key === 'receivingDFIIdentification') {
      var routing = core.routingWithCheckDigit(fields.receivingDFIIdentification, fields.checkDigit);
      if (routing) return routing.valid ? 'Check digit matches routing number' : 'Expected check digit ' + routing.computed;
    }
    if (def.key === 'recordType') return 'Fixed by NACHA';
    return def.hint || '';
  }

  function fieldHtml(record, recordPath, def, issueMap) {
    var path = recordPath + '.' + def.key;
    var stored = record.fields[def.key];
    var value = fieldDisplayValue(def, stored);
    var issues = issueMap[path] || [];
    var hasError = false;
    issues.forEach(function (issue) { if (issue.severity === 'error') hasError = true; });
    var readonly = !!(def.readonly || (def.derived && state.autoFix));
    var inputId = 'f_' + path.replace(/[^A-Za-z0-9_]/g, '_');
    var list = datalistFor(def);

    var classes = 'field';
    if (def.wide) classes += ' field-wide';
    if (def.derived) classes += ' field-derived';
    if (def.readonly) classes += ' field-fixed';
    if (readonly) classes += ' field-readonly';
    if (hasError) classes += ' has-error';
    else if (issues.length) classes += ' has-warning';

    var attrs = 'id="' + inputId + '" data-path="' + esc(path) + '" data-key="' + esc(def.key) + '"' +
      ' maxlength="' + (def.amount ? 14 : def.length) + '"' +
      ' autocomplete="off" spellcheck="false"';
    if (def.amount) attrs += ' data-money="1" inputmode="decimal" placeholder="0.00"';
    else if (def.numeric) attrs += ' inputmode="numeric"';
    if (def.derived) attrs += ' data-derived="1"';
    if (readonly) attrs += ' readonly aria-readonly="true"';
    if (list) attrs += ' list="' + list + '"';
    if (def.hint) attrs += ' title="' + esc(def.hint) + '"';

    var note = fieldNote(def, record.fields, path);
    var issueText = issues.length ? issues[0].message + (issues.length > 1 ? ' (+' + (issues.length - 1) + ' more)' : '') : '';
    var tag = def.derived ? '<span class="auto-badge">AUTO</span>' : '';

    return '<div class="' + classes + '" data-field-path="' + esc(path) + '">' +
      '<div class="field-head">' +
        '<label for="' + inputId + '">' + esc(def.label) + '</label>' +
        '<span class="field-tags">' + tag + '<span class="field-pos">' + def.start + '\u2013' + (def.start + def.length - 1) + '</span></span>' +
      '</div>' +
      '<div class="input-wrap' + (def.amount ? ' has-prefix' : '') + '">' +
        (def.amount ? '<span class="money-prefix">$</span>' : '') +
        '<input class="field-input" type="text" value="' + esc(value) + '" ' + attrs + '>' +
      '</div>' +
      '<div class="field-foot">' +
        '<span class="field-note"' + (def.hint ? ' title="' + esc(def.hint) + '"' : '') + '>' + esc(note) + '</span>' +
        '<span class="field-issue">' + esc(issueText) + '</span>' +
      '</div>' +
    '</div>';
  }

  function rawPreview(record, path) {
    var line = core.serializeRecord(record.kind, record.fields);
    var shown = state.showSpaces ? line.replace(/ /g, '\u00b7') : line;
    return '<div class="raw-preview">' +
      '<div class="raw-preview-head"><span>Raw record · ' + line.length + ' characters</span>' +
        '<button type="button" class="btn btn-xs" data-action="copy-raw-line" data-path="' + esc(path) + '">Copy</button>' +
      '</div>' +
      '<pre>' + esc(shown) + '</pre>' +
    '</div>';
  }

  function recordCard(record, path, options, issueMap) {
    var opts = options || {};
    var defs = core.FIELD_DEFS[record.kind] || [];
    var label = opts.label || core.RECORD_LABELS[record.kind] || record.kind;
    var line = core.serializeRecord(record.kind, record.fields);
    var type = line.charAt(0) || '?';
    var number = ++state.recordCounter;
    var rawOpen = !!state.rawOpen[path];
    var meta = opts.meta || ('Record ' + number + ' \u00b7 ' + defs.length + ' fields \u00b7 94 characters');

    return '<article class="record' + (opts.embedded ? ' record-embedded' : '') + '" id="' + recId(path) + '" data-record-path="' + esc(path) + '">' +
      '<div class="record-head">' +
        '<div class="record-ident">' +
          '<span class="rec-chip type-' + type + '">' + type + '</span>' +
          '<div><h3>' + esc(label) + '</h3><span class="record-meta">' + esc(meta) + '</span></div>' +
        '</div>' +
        '<div class="record-tools">' + (opts.tools || '') +
          '<button type="button" class="btn btn-xs btn-ghost" data-action="toggle-raw" data-path="' + esc(path) + '">' + (rawOpen ? 'Hide raw' : 'Raw') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="fields-grid">' + defs.map(function (def) {
        return fieldHtml(record, path, def, issueMap);
      }).join('') + '</div>' +
      (rawOpen ? rawPreview(record, path) : '') +
    '</article>';
  }

  function renderEntry(bi, ei, entry, issueMap) {
    var ep = 'b' + bi + '.e' + ei;
    var fields = entry.detail.fields;
    var name = String(fields.individualName || fields.receivingCompanyName || '').trim();
    var type = core.transactionType(fields.transactionCode);
    var amount = core.formatCents(fields.amount);
    var tc = String(fields.transactionCode || '').trim();
    var amountClass = type === 'credit' ? 'pos' : (type === 'debit' ? 'neg' : '');

    var html = '<div class="entry-block" id="entry-' + bi + '-' + ei + '">' +
      '<div class="entry-head">' +
        '<div class="entry-ident">' +
          '<span class="entry-num">' + (ei + 1) + '</span>' +
          '<div><h4>' + esc(name || 'Entry ' + (ei + 1)) + '</h4>' +
            '<span class="entry-meta">' + esc(tc || 'no code') + ' · <span class="' + amountClass + '">' + esc(amount) + '</span>' +
            ' · ' + entry.addenda.length + ' addenda</span></div>' +
        '</div>' +
        '<div class="entry-tools">' +
          '<button type="button" class="btn btn-xs" data-action="add-addenda" data-entry="' + ep + '">+ Addenda</button>' +
          '<button type="button" class="btn btn-xs btn-ghost" data-action="delete-entry" data-entry="' + ep + '">Delete</button>' +
        '</div>' +
      '</div>';

    html += recordCard(entry.detail, ep + '.d', { embedded: true }, issueMap);

    if (!entry.addenda.length) {
      html += '<div class="entry-empty-addenda">No addenda records. The addenda indicator is derived from this list.</div>';
    } else {
      html += entry.addenda.map(function (addenda, ai) {
        return recordCard(addenda, ep + '.a' + ai, {
          embedded: true,
          tools: '<button type="button" class="btn btn-xs btn-ghost" data-action="delete-addenda" data-addenda="' + ep + '.a' + ai + '">Delete</button>'
        }, issueMap);
      }).join('');
    }

    html += '</div>';
    return html;
  }

  function renderSections(issueMap) {
    if (!els.sections) return;
    state.recordCounter = 0;
    var doc = state.doc;
    var html = [];

    html.push('<section class="file-block" id="sec-file-header">' +
      '<div class="section-head"><div><span class="section-kicker">File</span><h2>File header</h2>' +
      '<p>Identifies the file, the receiving ACH operator and the originator. Values here apply to the whole file.</p></div></div>' +
      recordCard(doc.fileHeader, 'fh', {}, issueMap) +
    '</section>');

    doc.batches.forEach(function (batch, bi) {
      var header = batch.header.fields;
      var company = String(header.companyName || '').trim() || 'Untitled batch';
      var sec = String(header.standardEntryClassCode || '').trim().toUpperCase();
      var service = core.SERVICE_CLASSES[String(header.serviceClassCode || '').trim()] || '';
      var meta = [sec, service].filter(Boolean).join(' · ');

      html.push('<section class="batch-block" id="sec-batch-' + bi + '">' +
        '<div class="batch-head">' +
          '<div class="batch-ident">' +
            '<span class="batch-num">' + String(bi + 1).padStart(2, '0') + '</span>' +
            '<div><span class="section-kicker">Batch ' + (bi + 1) + '</span><h2>' + esc(company) + '</h2>' +
            (meta ? '<p>' + esc(meta) + '</p>' : '') + '</div>' +
          '</div>' +
          '<div class="batch-tools">' +
            '<button type="button" class="btn btn-sm btn-accent" data-action="add-entry" data-batch="' + bi + '">+ Entry</button>' +
            '<button type="button" class="btn btn-sm btn-ghost" data-action="delete-batch" data-batch="' + bi + '">Delete batch</button>' +
          '</div>' +
        '</div>' +
        recordCard(batch.header, 'b' + bi + '.h', {}, issueMap) +
        '<div class="entries-block">' +
          '<div class="entries-head"><h3>Entries</h3><span class="count-pill">' + batch.entries.length + '</span>' +
            '<span class="entries-note">Each entry may carry addenda records.</span></div>');

      if (!batch.entries.length) {
        html.push('<div class="entries-empty"><p>This batch has no entries yet.</p>' +
          '<button type="button" class="btn btn-sm btn-accent" data-action="add-entry" data-batch="' + bi + '">+ Add first entry</button></div>');
      } else {
        batch.entries.forEach(function (entry, ei) {
          html.push(renderEntry(bi, ei, entry, issueMap));
        });
      }

      html.push('</div>' +
        recordCard(batch.control, 'b' + bi + '.c', {}, issueMap) +
      '</section>');
    });

    html.push('<div class="add-batch-row">' +
      '<button type="button" class="btn btn-accent" data-action="add-batch">+ Add batch</button>' +
      '<span>Creates a new batch using the last batch\u2019s company details.</span>' +
    '</div>');

    html.push('<section class="file-block" id="sec-file-control">' +
      '<div class="section-head"><div><span class="section-kicker">File</span><h2>File control</h2>' +
      '<p>Closing totals for the whole file. With protection on, these are rewritten from the entries every time you edit.</p></div></div>' +
      recordCard(doc.fileControl, 'fc', {}, issueMap) +
    '</section>');

    var computed = state.computed || core.computeTotals(doc);
    var padding = computed.file.padding;
    html.push('<section class="file-block padding-block" id="sec-padding">' +
      '<div class="padding-card">' +
        '<span class="pad-glyph" aria-hidden="true">9</span>' +
        '<div class="padding-copy"><span class="section-kicker">Block padding</span><h2>' + padding + ' padding record' + (padding === 1 ? '' : 's') + '</h2>' +
        '<p>' + (padding
          ? 'The entries and controls fill ' + computed.file.totalRecords + ' records. ' + padding + ' lines of nines complete ' + computed.file.blockCount + ' block' + (computed.file.blockCount === 1 ? '' : 's') + ' of 10 records.'
          : 'The file already fills complete 10-record blocks, so no padding lines are needed.') + '</p></div>' +
        '<div class="padding-stats"><span><strong>' + computed.file.totalRecords + '</strong> data records</span><span><strong>' + computed.file.blockCount + '</strong> blocks</span></div>' +
      '</div>' +
    '</section>');

    els.sections.innerHTML = html.join('');
    applyIssueClasses(issueMap);
  }

  /* ------------------------------------------------------------------ *
   * Editing actions
   * ------------------------------------------------------------------ */

  function resolvePath(doc, path) {
    if (!doc) return null;
    var parts = String(path).split('.');
    if (parts[0] === 'fh') {
      return { record: doc.fileHeader, fields: doc.fileHeader.fields, kind: doc.fileHeader.kind };
    }
    if (parts[0] === 'fc') {
      return { record: doc.fileControl, fields: doc.fileControl.fields, kind: doc.fileControl.kind };
    }
    if (!/^b\d+$/.test(parts[0] || '')) return null;
    var bi = Number(parts[0].slice(1));
    var batch = doc.batches[bi];
    if (!batch) return null;
    if (parts[1] === 'h') {
      return { record: batch.header, fields: batch.header.fields, kind: batch.header.kind, batch: batch, batchIndex: bi };
    }
    if (parts[1] === 'c') {
      return { record: batch.control, fields: batch.control.fields, kind: batch.control.kind, batch: batch, batchIndex: bi };
    }
    if (!parts[1] || parts[1].charAt(0) !== 'e') return null;
    var ei = Number(parts[1].slice(1));
    var entry = batch.entries[ei];
    if (!entry) return null;
    if (parts[2] === 'd') {
      return {
        record: entry.detail, fields: entry.detail.fields, kind: entry.detail.kind,
        batch: batch, batchIndex: bi, entry: entry, entryIndex: ei
      };
    }
    if (!parts[2] || parts[2].charAt(0) !== 'a') return null;
    var ai = Number(parts[2].slice(1));
    var addenda = entry.addenda[ai];
    if (!addenda) return null;
    return {
      record: addenda, fields: addenda.fields, kind: addenda.kind,
      batch: batch, batchIndex: bi, entry: entry, entryIndex: ei,
      addenda: addenda, addendaIndex: ai
    };
  }

  function applyFieldValue(input) {
    var path = input.getAttribute('data-path');
    var key = input.getAttribute('data-key');
    var resolved = resolvePath(state.doc, path);
    if (!resolved) return { resolved: null, changed: false, invalid: false };
    var next = input.value;
    if (input.hasAttribute('data-money')) {
      var cents = core.parseDollarsToCents(next);
      if (cents === null) {
        input.classList.add('input-invalid');
        return { resolved: resolved, changed: false, invalid: true };
      }
      input.classList.remove('input-invalid');
      var previous = String(resolved.fields[key] == null ? '' : resolved.fields[key]);
      if (previous === cents) return { resolved: resolved, changed: false, invalid: false };
      resolved.fields[key] = cents;
      return { resolved: resolved, changed: true, invalid: false };
    }
    var old = String(resolved.fields[key] == null ? '' : resolved.fields[key]);
    if (old === next) return { resolved: resolved, changed: false, invalid: false };
    resolved.fields[key] = next;
    return { resolved: resolved, changed: true, invalid: false };
  }

  function onFieldInput(event) {
    if (!state.doc) return;
    var input = event.target.closest ? event.target.closest('input[data-path]') : null;
    if (!input) return;
    var result = applyFieldValue(input);
    if (!result.changed) return;
    markChanged('Unsaved changes');
    if (state.autoFix) core.applyComputed(state.doc);
    refreshInsights();
    updateDerivedDom();
  }

  function onFieldChange(event) {
    if (!state.doc) return;
    var input = event.target.closest ? event.target.closest('input[data-path]') : null;
    if (!input) return;
    var path = input.getAttribute('data-path');
    var key = input.getAttribute('data-key');
    var result = applyFieldValue(input);
    if (result.invalid) {
      toast('Enter an amount like 125.00 or 0.', 'error');
      renderAll();
      return;
    }
    var converted = false;
    if (result.resolved) {
      if (key === 'standardEntryClassCode' && result.resolved.batch) {
        var entryKind = core.entryKindForSec(result.resolved.fields[key]);
        result.resolved.batch.entries.forEach(function (entry) {
          if (entry.detail.kind !== entryKind) {
            entry.detail = core.convertEntryRecord(entry.detail, entryKind);
            converted = true;
          }
        });
      } else if (key === 'addendaTypeCode' && result.resolved.addendaIndex != null) {
        var addendaKind = core.addendaKindForType(result.resolved.fields[key]);
        if (result.resolved.addenda.kind !== addendaKind) {
          result.resolved.entry.addenda[result.resolved.addendaIndex] =
            core.convertAddendaRecord(result.resolved.addenda, addendaKind);
          converted = true;
        }
      }
    }
    if (result.changed) markChanged('Unsaved changes');
    if (state.autoFix) core.applyComputed(state.doc);
    renderAll();
    if (converted) toast('Record layout updated to match the new code.', 'success');
  }

  function nextTraceNumber(doc, batch) {
    var max = 0;
    doc.batches.forEach(function (b) {
      b.entries.forEach(function (entry) {
        var trace = String(entry.detail.fields.traceNumber || '').trim();
        if (/^\d{15}$/.test(trace)) max = Math.max(max, Number(trace.slice(-7)));
      });
    });
    var sequence = String(max + 1).padStart(7, '0');
    var odfi = String(batch.header.fields.originatingDFIIdentification || '').replace(/\D/g, '');
    if (odfi.length !== 8) {
      odfi = String(doc.fileHeader.fields.immediateOrigin || '').replace(/\D/g, '').slice(0, 8);
    }
    odfi = (odfi + '00000000').slice(0, 8);
    return odfi + sequence;
  }

  function renumberBatches() {
    state.doc.batches.forEach(function (batch, index) {
      var value = String(index + 1).padStart(7, '0');
      batch.header.fields.batchNumber = value;
      if (batch.control) batch.control.fields.batchNumber = value;
    });
  }

  function afterStructureChange(message) {
    markChanged(message);
    renumberBatches();
    if (state.autoFix) core.applyComputed(state.doc);
    renderAll();
  }

  function addEntry(batchIndex) {
    var doc = state.doc;
    var batch = doc.batches[batchIndex];
    if (!batch) return;
    var sec = batch.header.fields.standardEntryClassCode;
    var detail = core.createRecord(core.entryKindForSec(sec));
    detail.fields.transactionCode = String(batch.header.fields.serviceClassCode || '').trim() === '225' ? '27' : '22';
    detail.fields.amount = '0';
    detail.fields.traceNumber = nextTraceNumber(doc, batch);
    batch.entries.push({ detail: detail, addenda: [] });
    afterStructureChange('Entry added');
    var entryIndex = batch.entries.length - 1;
    scrollToTarget('rec-b' + batchIndex + '-e' + entryIndex + '-d', { focus: true });
    toast('Entry added to batch ' + (batchIndex + 1) + '.', 'success');
  }

  function deleteEntry(entryPath) {
    var resolved = resolvePath(state.doc, entryPath + '.d');
    if (!resolved) return;
    var name = String(resolved.fields.individualName || resolved.fields.receivingCompanyName || '').trim();
    confirmModal({
      title: 'Delete entry?',
      message: 'Delete ' + (name ? '"' + name + '"' : 'entry ' + (resolved.entryIndex + 1)) +
        ' and its ' + resolved.entry.addenda.length + ' addenda record(s)?',
      confirmLabel: 'Delete entry',
      tone: 'danger'
    }).then(function (ok) {
      if (!ok) return;
      resolved.batch.entries.splice(resolved.entryIndex, 1);
      afterStructureChange('Entry deleted');
      toast('Entry deleted.', 'success');
    });
  }

  function addAddenda(entryPath) {
    var resolved = resolvePath(state.doc, entryPath + '.d');
    if (!resolved) return;
    var sec = String(resolved.batch.header.fields.standardEntryClassCode || '').trim().toUpperCase();
    var type = sec === 'COR' ? '98' : (sec === 'DNE' ? '99' : '05');
    var kind = core.addendaKindForType(type);
    var record = core.createRecord(kind);
    record.fields.addendaTypeCode = type;
    if (kind === 'addenda98' || kind === 'addenda99') {
      record.fields.originalEntryTraceNumber = resolved.fields.traceNumber;
    }
    resolved.entry.addenda.push(record);
    afterStructureChange('Addenda added');
    var extraIndex = resolved.entry.addenda.length - 1;
    scrollToTarget('rec-b' + resolved.batchIndex + '-e' + resolved.entryIndex + '-a' + extraIndex);
    toast('Addenda record added.', 'success');
  }

  function deleteAddenda(addendaPath) {
    var resolved = resolvePath(state.doc, addendaPath);
    if (!resolved || resolved.addendaIndex == null) return;
    var type = String(resolved.fields.addendaTypeCode || '').trim();
    resolved.entry.addenda.splice(resolved.addendaIndex, 1);
    afterStructureChange('Addenda deleted');
    toast('Addenda record' + (type ? ' (' + type + ')' : '') + ' deleted.', 'success');
  }

  function todayYYMMDD() {
    var date = new Date();
    return String(date.getFullYear() % 100).padStart(2, '0') +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0');
  }

  function addBatch() {
    var doc = state.doc;
    var header = core.createRecord('batchHeader');
    var previous = doc.batches[doc.batches.length - 1];
    var fileHeader = doc.fileHeader.fields;

    if (previous) {
      Object.keys(header.fields).forEach(function (key) {
        if (previous.header.fields[key] != null) header.fields[key] = previous.header.fields[key];
      });
    } else {
      header.fields.companyName = (String(fileHeader.immediateOriginName || '').trim() || 'NEW COMPANY').slice(0, 16);
      header.fields.companyIdentification = (String(fileHeader.immediateOrigin || '').trim() || '0000000000').slice(0, 10);
      header.fields.standardEntryClassCode = 'PPD';
      header.fields.companyEntryDescription = 'PAYMENT';
      header.fields.effectiveEntryDate = /^\d{6}$/.test(String(fileHeader.fileCreationDate || '').trim())
        ? String(fileHeader.fileCreationDate).trim() : todayYYMMDD();
      header.fields.originatingDFIIdentification =
        (String(fileHeader.immediateOrigin || '').replace(/\D/g, '') + '00000000').slice(0, 8);
      header.fields.serviceClassCode = '200';
    }
    header.fields.batchNumber = String(doc.batches.length + 1).padStart(7, '0');
    doc.batches.push({ header: header, entries: [], control: core.createRecord('batchControl') });
    afterStructureChange('Batch added');
    scrollToTarget('rec-b' + (doc.batches.length - 1) + '-h', { focus: true });
    toast('Batch added.', 'success');
  }

  function deleteBatch(batchIndex) {
    var batch = state.doc.batches[batchIndex];
    if (!batch) return;
    var company = String(batch.header.fields.companyName || '').trim() || 'batch ' + (batchIndex + 1);
    confirmModal({
      title: 'Delete batch?',
      message: 'Delete "' + company + '" with ' + batch.entries.length + ' entry(s) and all of its addenda?',
      confirmLabel: 'Delete batch',
      tone: 'danger'
    }).then(function (ok) {
      if (!ok) return;
      state.doc.batches.splice(batchIndex, 1);
      afterStructureChange('Batch deleted');
      toast('Batch deleted.', 'success');
    });
  }

  function toggleRaw(path) {
    if (state.rawOpen[path]) delete state.rawOpen[path];
    else state.rawOpen[path] = true;
    renderAll();
  }

  function copyRawLine(path) {
    var resolved = resolvePath(state.doc, path);
    if (!resolved) return;
    var line = core.serializeRecord(resolved.kind, resolved.fields);
    copyText(line).then(function (ok) {
      toast(ok ? 'Raw record copied to the clipboard.' : 'Could not copy to the clipboard.', ok ? 'success' : 'error');
    });
  }

  function viewRawFile() {
    if (!state.doc) return;
    var text = buildText();
    var shown = state.showSpaces ? text.replace(/ /g, '\u00b7') : text;
    var lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    openModal({
      title: 'Raw ACH file',
      wide: true,
      body: '<div class="raw-toolbar">' +
          '<span>' + lines.length + ' lines · ' + (state.lineEnding === '\n' ? 'LF' : 'CRLF') +
          (state.finalNewline ? ' · final newline' : ' · no final newline') +
          (state.showSpaces ? ' · spaces shown as \u00b7' : '') + '</span>' +
          '<span class="raw-note">Preview respects the current settings.</span>' +
        '</div>' +
        '<pre class="raw-full" data-raw-file="1">' + esc(shown) + '</pre>',
      actions: [
        {
          label: 'Copy',
          onClick: function () {
            copyText(text).then(function (ok) {
              toast(ok ? 'File copied to the clipboard.' : 'Could not copy to the clipboard.', ok ? 'success' : 'error');
            });
            return false;
          }
        },
        {
          label: 'Download',
          onClick: function () {
            downloadText(text, state.fileName || 'file.ach');
            return false;
          }
        },
        { label: 'Close', tone: 'accent' }
      ]
    });
  }

  function scrollToTarget(id, options) {
    var target = document.getElementById(id);
    if (!target) return;
    var main = els.main;
    if (main && main.scrollTo) {
      var top = target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 18;
      main.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else if (target.scrollIntoView) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    window.setTimeout(function () { target.classList.remove('flash'); }, 1400);
    if (options && options.focus) {
      window.setTimeout(function () {
        var input = target.querySelector('input:not([readonly])');
        if (input) input.focus({ preventScroll: true });
      }, 380);
    }
  }

  function handleAction(action, element) {
    switch (action) {
      case 'jump':
        scrollToTarget(element.getAttribute('data-target'));
        break;
      case 'recalc':
        recalculate();
        break;
      case 'toggle-raw':
        toggleRaw(element.getAttribute('data-path'));
        break;
      case 'copy-raw-line':
        copyRawLine(element.getAttribute('data-path'));
        break;
      case 'add-entry':
        addEntry(Number(element.getAttribute('data-batch')));
        break;
      case 'delete-entry':
        deleteEntry(element.getAttribute('data-entry'));
        break;
      case 'add-addenda':
        addAddenda(element.getAttribute('data-entry'));
        break;
      case 'delete-addenda':
        deleteAddenda(element.getAttribute('data-addenda'));
        break;
      case 'add-batch':
        addBatch();
        break;
      case 'delete-batch':
        deleteBatch(Number(element.getAttribute('data-batch')));
        break;
      case 'restore-backup':
        restoreBackup();
        break;
      case 'discard-backup':
        discardBackup();
        break;
      case 'open-file':
        openFileDialog();
        break;
      case 'load-sample':
        loadSample();
        break;
      case 'view-raw':
        viewRawFile();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ *
   * Settings, datalists and wiring
   * ------------------------------------------------------------------ */

  function setSettingsOpen(open) {
    if (!els.settingsMenu) return;
    els.settingsMenu.hidden = !open;
    els.btnSettings.setAttribute('aria-expanded', String(open));
  }

  function updateSettingsUI() {
    if (!els.optAutoFix) return;
    els.optAutoFix.checked = state.autoFix;
    els.optWhitespace.checked = state.showSpaces;
    els.optLineEnding.value = state.lineEnding === '\n' ? 'lf' : 'crlf';
    els.optFinalNewline.checked = state.finalNewline;
  }

  function fillDatalist(datalist, items) {
    if (!datalist) return;
    datalist.innerHTML = items.map(function (item) {
      return '<option value="' + esc(item[0]) + '">' + esc(item[1]) + '</option>';
    }).join('');
  }

  function ensureDatalists() {
    var specs = [
      ['dl-sec-codes', Object.keys(core.SEC_CODES).map(function (key) { return [key, core.SEC_CODES[key]]; })],
      ['dl-transaction-codes', Object.keys(core.TRANSACTION_CODES).map(function (key) { return [key, core.TRANSACTION_CODES[key].label]; })],
      ['dl-addenda-types', Object.keys(core.ADDENDA_TYPES).map(function (key) { return [key, core.ADDENDA_TYPES[key]]; })],
      ['dl-service-classes', Object.keys(core.SERVICE_CLASSES).map(function (key) { return [key, core.SERVICE_CLASSES[key]]; })],
      ['dl-file-id', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(function (ch) { return [ch, ch]; })],
      ['dl-return-codes', Object.keys(core.RETURN_CODES).map(function (key) { return [key, core.RETURN_CODES[key]]; })],
      ['dl-change-codes', Object.keys(core.CHANGE_CODES).map(function (key) { return [key, core.CHANGE_CODES[key]]; })]
    ];
    specs.forEach(function (spec) {
      var datalist = $(spec[0]);
      if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = spec[0];
        document.body.appendChild(datalist);
      }
      fillDatalist(datalist, spec[1]);
    });
  }

  function bindStaticEvents() {
    els.btnOpen.addEventListener('click', openFileDialog);
    els.btnOpenEmpty.addEventListener('click', openFileDialog);
    els.btnSampleEmpty.addEventListener('click', loadSample);
    els.btnSave.addEventListener('click', function () { saveFile(false); });
    els.btnSaveAs.addEventListener('click', function () { saveFile(true); });
    els.btnRecalc.addEventListener('click', recalculate);
    els.btnRawFooter.addEventListener('click', viewRawFile);

    els.btnSettings.addEventListener('click', function (event) {
      event.stopPropagation();
      setSettingsOpen(els.settingsMenu.hidden);
    });

    els.optAutoFix.addEventListener('change', function () {
      state.autoFix = els.optAutoFix.checked;
      saveSettings();
      if (state.doc) {
        if (state.autoFix) {
          core.applyComputed(state.doc);
          markChanged('Protection enabled');
        } else {
          markChanged('Manual control mode');
        }
      }
      renderAll();
      toast(state.autoFix ? 'Derived fields will recalculate automatically.' : 'Manual control mode: derived fields are now editable.', state.autoFix ? 'success' : 'warn');
    });

    els.optWhitespace.addEventListener('change', function () {
      state.showSpaces = els.optWhitespace.checked;
      saveSettings();
      if (state.doc) renderAll();
    });

    els.optLineEnding.addEventListener('change', function () {
      state.lineEnding = els.optLineEnding.value === 'lf' ? '\n' : '\r\n';
      saveSettings();
      if (state.doc) {
        markChanged('Line ending changed');
        renderAll();
      }
    });

    els.optFinalNewline.addEventListener('change', function () {
      state.finalNewline = els.optFinalNewline.checked;
      saveSettings();
      if (state.doc) {
        markChanged('Final newline changed');
        renderAll();
      }
    });

    els.btnRawFile.addEventListener('click', function () {
      setSettingsOpen(false);
      viewRawFile();
    });
    els.btnLoadSampleMenu.addEventListener('click', function () {
      setSettingsOpen(false);
      loadSample();
    });

    els.fileInput.addEventListener('change', function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      if (!file) return;
      file.text().then(function (text) {
        if (loadFromText(text, file.name)) toast('Opened ' + file.name, 'success');
      }, function () {
        toast('Could not read that file.', 'error');
      });
      els.fileInput.value = '';
    });

    els.sections.addEventListener('input', onFieldInput);
    els.sections.addEventListener('change', onFieldChange);

    document.addEventListener('click', function (event) {
      var actionElement = event.target.closest ? event.target.closest('[data-action]') : null;
      if (actionElement) {
        handleAction(actionElement.getAttribute('data-action'), actionElement);
      }
      if (!event.target.closest || !event.target.closest('.menu-wrap')) {
        setSettingsOpen(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (state.modal) closeModal();
        else setSettingsOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        var key = String(event.key || '').toLowerCase();
        if (key === 'o') {
          event.preventDefault();
          openFileDialog();
        } else if (key === 's') {
          event.preventDefault();
          saveFile(!!event.shiftKey);
        }
      } else if (event.key === 'F9') {
        event.preventDefault();
        recalculate();
      }
    });

    window.addEventListener('beforeunload', function (event) {
      if (state.doc && state.dirty) {
        persistBackup();
        event.preventDefault();
        event.returnValue = '';
      }
    });

    bindDragAndDrop();
  }

  function bindDragAndDrop() {
    var depth = 0;
    function hasFiles(event) {
      var types = event.dataTransfer && event.dataTransfer.types;
      if (!types) return false;
      for (var i = 0; i < types.length; i += 1) {
        if (types[i] === 'Files') return true;
      }
      return false;
    }
    function showOverlay(show) {
      els.dropOverlay.hidden = !show;
    }
    window.addEventListener('dragenter', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      showOverlay(true);
    });
    window.addEventListener('dragover', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (event) {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) showOverlay(false);
    });
    window.addEventListener('drop', function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      showOverlay(false);
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      confirmDiscard().then(function (ok) {
        if (!ok) return;
        file.text().then(function (text) {
          if (loadFromText(text, file.name)) toast('Opened ' + file.name, 'success');
        }, function () {
          toast('Could not read that file.', 'error');
        });
      });
    });
  }

  function init() {
    els = {
      fileName: $('fileName'),
      dirtyDot: $('dirtyDot'),
      banner: $('banner'),
      bannerTitle: $('bannerTitle'),
      bannerMessage: $('bannerMessage'),
      bannerActions: $('bannerActions'),
      bannerInline: $('bannerInline'),
      emptyState: $('emptyState'),
      workspace: $('workspace'),
      summaryHost: $('summaryHost'),
      outline: $('outline'),
      mapHost: $('mapHost'),
      diagnosticsHost: $('diagnosticsHost'),
      sections: $('sections'),
      statusLeft: $('statusLeft'),
      statusCenter: $('statusCenter'),
      statusRight: $('statusRight'),
      dropOverlay: $('dropOverlay'),
      toasts: $('toasts'),
      modalRoot: $('modalRoot'),
      fileInput: $('fileInput'),
      restoreHost: $('restoreHost'),
      main: $('main'),
      btnOpen: $('btnOpen'),
      btnOpenEmpty: $('btnOpenEmpty'),
      btnSampleEmpty: $('btnSampleEmpty'),
      btnSave: $('btnSave'),
      btnSaveAs: $('btnSaveAs'),
      btnRecalc: $('btnRecalc'),
      btnSettings: $('btnSettings'),
      settingsMenu: $('settingsMenu'),
      optAutoFix: $('optAutoFix'),
      optWhitespace: $('optWhitespace'),
      optLineEnding: $('optLineEnding'),
      optFinalNewline: $('optFinalNewline'),
      btnRawFile: $('btnRawFile'),
      btnLoadSampleMenu: $('btnLoadSampleMenu'),
      btnRawFooter: $('btnRawFooter')
    };

    loadSettings();
    updateSettingsUI();
    ensureDatalists();
    state.backup = readStore(BACKUP_KEY);
    bindStaticEvents();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
