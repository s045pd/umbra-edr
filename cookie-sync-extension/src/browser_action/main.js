import {
  buildCloneConfirmation,
  buildRestoreConfirmation,
  createCloneDialogModel,
  createSyncDialogModel,
  formatJobResult,
  operationErrorText,
  syncCategorySelection,
  syncResultRows,
} from './dialogs.js';
import { JobClient } from './job-client.js';
import { buildArchiveExport, buildBackupRows, filterArchivePage } from './archive-view.js';

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  const viewLogin = $('view-login');
  const viewMain = $('view-main');
  const viewTools = $('view-tools');
  const viewCA = $('view-ca');

  // Where Tools view should return to when its back arrow is clicked.
  // 'login' or 'main' depending on entry point. Persisted in memory only.
  let toolsReturnTo = 'login';

  // Storage keys (kept in sync with sw.js)
  const PROXY_CREDS_KEY = 'shadowlink_proxy_creds';
  const PROXY_STATUS_KEY = 'shadowlink_proxy_status';

  // State
  let serverOrigin = '';
  let adminCreds = { username: '', password: '' };
  let bots = [];
  // Tracks which bot id is currently providing the active proxy.
  // Persisted so the popup can re-render the inline button state on
  // every reopen.
  let activeProxy = null; // { botId, botName, host, port } | null
  const jobClient = new JobClient(chrome);
  const LAST_JOB_KEY = 'shadowlink_last_job_id';
  let operationState = null;
  let backupRows = [];
  let archiveState = { kind: 'history', records: [], query: '', page: 1, pageSize: 10 };

  // --- View helpers ---
  function showView(view) {
    [viewLogin, viewMain, viewTools, viewCA].forEach(v => v.style.display = 'none');
    view.style.display = 'block';
  }

  // --- API ---
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || `HTTP ${res.status}`);
    return json.result;
  }

  // --- Cookie helpers ---
  function cookieUrl(cookie) {
    const proto = cookie.secure ? 'https' : 'http';
    let host = cookie.domain;
    if (host.startsWith('.')) host = host.substring(1);
    return `${proto}://${host}${cookie.path}`;
  }

  function setCookie(params) {
    return new Promise((resolve, reject) => {
      chrome.cookies.set(params, (r) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(r);
      });
    });
  }

  function removeCookie(url, name) {
    return new Promise((resolve, reject) => {
      chrome.cookies.remove({ url, name }, (r) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(r);
      });
    });
  }

  function getAllCookies() {
    return new Promise(resolve => chrome.cookies.getAll({}, resolve));
  }

  async function importCookies(cookies) {
    if (!Array.isArray(cookies)) throw new Error('Expected an array of cookies');
    const existing = await getAllCookies();
    await Promise.all(existing.map(c => removeCookie(cookieUrl(c), c.name).catch(() => {})));
    let imported = 0;
    for (const c of cookies) {
      try {
        await setCookie({
          url: cookieUrl(c),
          domain: c.domain,
          expirationDate: c.expirationDate,
          httpOnly: c.httpOnly,
          name: c.name,
          path: c.path,
          sameSite: c.sameSite === 'unspecified' ? 'lax' : (c.sameSite || 'lax'),
          secure: c.secure,
          value: c.value,
        });
        imported++;
      } catch (_) {}
    }
    return { total: cookies.length, imported };
  }

  // --- Message display ---
  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = `msg msg-${type}`;
    el.style.display = 'block';
  }

  function setBtnLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('loading', loading);
    btn.disabled = loading;
  }

  // --- Proxy state helpers (chrome.storage-backed) ---
  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function randomJobId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }

  function persistLastJob(jobId) {
    return new Promise(resolve => chrome.storage.local.set({ [LAST_JOB_KEY]: jobId }, resolve));
  }

  function readLastJobId() {
    return new Promise(resolve => chrome.storage.local.get([LAST_JOB_KEY], out => resolve(out[LAST_JOB_KEY] || '')));
  }

  function operationCategoriesHTML(categories, prefix) {
    return categories.map(category => `
      <label class="operation-category">
        <input type="checkbox" data-${prefix}-category="${category.id}"
          ${category.checked ? 'checked' : ''} ${category.disabled ? 'disabled' : ''}>
        <span>${escHtml(category.label)}</span>
      </label>
    `).join('');
  }

  function updateSyncSelectAllState() {
    const all = document.querySelector('[data-sync-select-all]');
    if (!all) return;
    const inputs = [...document.querySelectorAll('[data-sync-category]')];
    const checked = inputs.filter(input => input.checked).length;
    all.checked = inputs.length > 0 && checked === inputs.length;
    all.indeterminate = checked > 0 && checked < inputs.length;
  }

  function configureOperationModal({ stage, title, body, confirmLabel = 'Continue', confirmDisabled = false, data = {} }) {
    operationState = { stage, ...data };
    $('operation-modal-title').textContent = title;
    $('operation-modal-body').innerHTML = body;
    $('operation-modal-status').style.display = 'none';
    $('btn-operation-confirm').textContent = confirmLabel;
    $('btn-operation-confirm').disabled = confirmDisabled;
    $('btn-operation-confirm').style.display = 'inline-flex';
    $('btn-operation-cancel').textContent = 'Close';
    $('operation-modal').style.display = 'flex';
  }

  function closeOperationModal() {
    $('operation-modal').style.display = 'none';
    operationState = null;
  }

  function operationError(error) {
    const code = typeof error?.code === 'string' ? error.code : 'background_job_failed';
    showMsg($('operation-modal-status'), operationErrorText(code), 'err');
  }

  function renderOperationResult(job) {
    operationState = { stage: 'result', jobId: job?.job_id || '' };
    const state = job?.state || job?.result?.state || 'unknown';
    $('operation-modal-title').textContent = 'Operation result';
    const resultRows = syncResultRows(job);
    const syncDetails = resultRows.some(row => row.status !== 'not_selected')
      ? `<div class="operation-section">
          <div class="operation-section-title">Category details</div>
          ${resultRows.map(row => `
            <div class="operation-result-row" data-result-category="${row.id}">
              <span>${escHtml(row.label)}</span>
              <strong>${escHtml(row.status)}</strong>
              <code>A ${row.applied} · S ${row.skipped} · F ${row.failed}${row.errorCode ? ` · ${escHtml(row.errorCode)}` : ''}</code>
            </div>
          `).join('')}
        </div>`
      : '';
    $('operation-modal-body').innerHTML = `
      <div class="operation-section">
        <div class="operation-section-title">Durable status</div>
        <div class="job-state-line">${escHtml(state)}</div>
        <p class="desc-sub">${escHtml(formatJobResult(job))}</p>
      </div>
      ${syncDetails}
    `;
    $('btn-operation-confirm').style.display = 'none';
    $('btn-operation-cancel').textContent = 'Close';
    const type = ['COMPLETE', 'COMPLETE_WITH_ACCEPTED_OMISSIONS', 'sync_complete'].includes(state)
      ? 'ok'
      : state === 'ROLLED_BACK'
        ? 'info'
        : 'err';
    showMsg($('operation-modal-status'), formatJobResult(job), type);
  }

  function openSyncDialog(bot) {
    const model = createSyncDialogModel();
    const ranges = model.historyRanges.map(range =>
      `<option value="${range.value}" ${range.value === model.historyRange ? 'selected' : ''}>${escHtml(range.label)}</option>`
    ).join('');
    configureOperationModal({
      stage: 'sync-config',
      title: `Sync — ${bot.name || bot.id}`,
      confirmLabel: model.confirmLabel,
      data: { bot },
      body: `
        <p class="desc">${escHtml(model.description)}</p>
        <div class="operation-section">
          <div class="operation-section-title">Choose data to merge</div>
          <label class="operation-category operation-category-all">
            <input type="checkbox" data-sync-select-all>
            <span>Select all</span>
          </label>
          ${operationCategoriesHTML(model.categories, 'sync')}
        </div>
        <div class="operation-section">
          <label for="sync-history-range">History capture range</label>
          <select id="sync-history-range" class="operation-select">${ranges}</select>
        </div>
        <div class="operation-warning">The source may be online or served from one trusted cached snapshot. Sync never clears destination-only data.</div>
      `,
    });
    updateSyncSelectAllState();
  }

  function openCloneDialog(bot) {
    const model = createCloneDialogModel({});
    configureOperationModal({
      stage: 'clone-preflight',
      title: `Clone — ${bot.name || bot.id}`,
      confirmLabel: 'Run preflight & create backup',
      data: { bot },
      body: `
        <p class="desc">${escHtml(model.description)}</p>
        <div class="operation-section">
          <div class="operation-section-title">Required source categories</div>
          ${operationCategoriesHTML(model.categories, 'clone')}
        </div>
        <div class="operation-danger">Clone is destructive only after a complete local backup, read-back verification, freshness recheck, and a second confirmation.</div>
        <div class="operation-warning">Native history timestamps and native download entries cannot be recreated by Chrome. ShadowLink preserves their full records in local archives.</div>
        <label class="operation-ack">
          <input id="clone-accept-omissions" type="checkbox">
          <span>If preflight lists unsupported items, allow only those listed items to be omitted and finish as COMPLETE_WITH_ACCEPTED_OMISSIONS.</span>
        </label>
      `,
    });
  }

  function showCloneConfirmation(job) {
    const model = createCloneDialogModel(job);
    const rows = model.rows.map(row => `
      <div class="operation-category">
        <span>${escHtml(row.label)}</span>
        <span class="operation-category-meta">${row.count} · ${escHtml(row.status)}</span>
      </div>
    `).join('');
    const unsupported = model.unsupported.length
      ? `<div class="operation-warning">${escHtml(model.acceptedOmissionsNotice)}</div>`
      : '';
    configureOperationModal({
      stage: 'clone-confirm',
      title: 'Final destructive Clone confirmation',
      confirmLabel: model.acceptedOmissions ? 'Confirm Clone with omissions' : 'Confirm & Clone',
      confirmDisabled: true,
      data: { job },
      body: `
        <div class="operation-section">
          <div class="operation-source-row"><span>Source</span><strong>${escHtml(model.sourceLabel)}</strong></div>
          <div class="operation-source-row"><span>Captured</span><strong>${escHtml(model.captureTime || 'Not reported')}</strong></div>
          <div class="operation-source-row"><span>History</span><strong>${escHtml(model.historyCoverage || 'Unknown')}</strong></div>
          <div class="operation-source-row"><span>Backup ID</span><strong>${escHtml(job.backup_id)}</strong></div>
          <div class="operation-source-row"><span>Backup digest</span><strong>${escHtml(job.backup_manifest_sha256)}</strong></div>
        </div>
        <div class="operation-section">${rows}</div>
        ${unsupported}
        <div class="operation-danger">The destination will now be replaced in order: cookies, history, bookmarks, download archive, then tabs. A critical failure triggers rollback from the verified backup above.</div>
        <label class="operation-ack">
          <input type="checkbox" data-final-ack="clone">
          <span>I verified the backup ID/digest and understand the browser-history/download limitations.</span>
        </label>
      `,
    });
  }

  function openRestoreDialog(row) {
    configureOperationModal({
      stage: 'restore-preflight',
      title: row.isUndoRestore ? 'Undo Restore' : 'Restore verified backup',
      confirmLabel: 'Create recovery backup',
      data: { backup: row },
      body: `
        <div class="operation-section">
          <div class="operation-source-row"><span>Restore source</span><strong>${escHtml(row.backupId)}</strong></div>
          <div class="operation-source-row"><span>Saved items</span><strong>${row.totalCount}</strong></div>
        </div>
        <div class="operation-danger">Restore replaces supported local state. ShadowLink first creates a separate, complete recovery backup of the current browser and never overwrites this source.</div>
        <label class="operation-ack">
          <input id="restore-accept-omissions" type="checkbox">
          <span>Allow only explicitly listed unsupported items to be omitted.</span>
        </label>
      `,
    });
  }

  function showRestoreConfirmation(job) {
    configureOperationModal({
      stage: 'restore-confirm',
      title: 'Final destructive Restore confirmation',
      confirmLabel: 'Confirm & Restore',
      confirmDisabled: true,
      data: { job },
      body: `
        <div class="operation-section">
          <div class="operation-source-row"><span>Restore source</span><strong>${escHtml(job.restore_source_backup_id)}</strong></div>
          <div class="operation-source-row"><span>Source digest</span><strong>${escHtml(job.restore_source_manifest_sha256)}</strong></div>
          <div class="operation-source-row"><span>Recovery backup</span><strong>${escHtml(job.restore_recovery_backup_id)}</strong></div>
          <div class="operation-source-row"><span>Recovery digest</span><strong>${escHtml(job.restore_recovery_manifest_sha256)}</strong></div>
        </div>
        <div class="operation-danger">A Restore failure rolls back only from the recovery backup. Both IDs remain retained if rollback is incomplete.</div>
        <label class="operation-ack">
          <input type="checkbox" data-final-ack="restore">
          <span>I verified both backup roles and understand that native history timestamps/download entries cannot be recreated.</span>
        </label>
      `,
    });
  }

  function showDurableJob(job) {
    if (!job) return;
    if (job.state === 'AWAITING_DESTRUCTIVE_CONFIRMATION') {
      showCloneConfirmation(job);
      return;
    }
    if (job.state === 'AWAITING_RESTORE_CONFIRMATION') {
      showRestoreConfirmation(job);
      return;
    }
    const terminal = new Set([
      'COMPLETE', 'COMPLETE_WITH_ACCEPTED_OMISSIONS', 'ROLLED_BACK',
      'FAILED_BEFORE_MUTATION', 'ROLLBACK_INCOMPLETE',
      'sync_complete', 'sync_complete_with_errors', 'sync_failed_before_apply',
    ]);
    if (terminal.has(job.state)) {
      renderOperationResult(job);
      return;
    }
    configureOperationModal({
      stage: 'job-refresh',
      title: 'Background job progress',
      confirmLabel: 'Refresh',
      data: { jobId: job.job_id },
      body: `
        <div class="operation-section">
          <div class="operation-section-title">Durable state</div>
          <div class="job-state-line">${escHtml(job.state || 'unknown')}</div>
          <p class="desc-sub">Closing this popup does not cancel the background job.</p>
        </div>
      `,
    });
  }

  async function resumeLastJob() {
    const jobId = await readLastJobId();
    if (!jobId) return;
    try {
      const job = await jobClient.getJob(jobId);
      if (!job) return;
      const status = $('bot-action-status');
      if (status && ['COMPLETE', 'COMPLETE_WITH_ACCEPTED_OMISSIONS', 'sync_complete'].includes(job.state)) {
        showMsg(status, formatJobResult(job), 'ok');
      } else if (!['FAILED_BEFORE_MUTATION', 'ROLLED_BACK', 'ROLLBACK_INCOMPLETE', 'sync_complete_with_errors', 'sync_failed_before_apply'].includes(job.state)) {
        showDurableJob(job);
      }
    } catch (_) {}
  }

  function botJobRequest(bot, jobId) {
    return {
      jobId,
      serverOrigin,
      username: bot.proxy_username,
      password: bot.proxy_password,
    };
  }

  async function handleOperationConfirm() {
    if (!operationState) return;
    const stateAtStart = operationState;
    const btn = $('btn-operation-confirm');
    setBtnLoading(btn, true);
    try {
      if (stateAtStart.stage === 'sync-config') {
        const selected = {};
        document.querySelectorAll('[data-sync-category]').forEach(input => {
          selected[input.dataset.syncCategory] = input.checked;
        });
        if (!Object.values(selected).some(Boolean)) throw Object.assign(new Error('selection'), { code: 'no_sync_categories_selected' });
        const jobId = randomJobId('sync');
        await persistLastJob(jobId);
        showMsg($('operation-modal-status'), 'Sync is running in the background…', 'info');
        const result = await jobClient.startSync({
          ...botJobRequest(stateAtStart.bot, jobId),
          options: {
            selected,
            historyRange: $('sync-history-range').value,
          },
        });
        renderOperationResult({
          job_id: jobId,
          state: result.state,
          sync_results: result.categories,
          result,
        });
        return;
      }

      if (stateAtStart.stage === 'clone-preflight') {
        const jobId = randomJobId('clone');
        await persistLastJob(jobId);
        showMsg($('operation-modal-status'), 'Fetching one complete snapshot and verifying the local backup…', 'info');
        const job = await jobClient.startClonePreflight({
          ...botJobRequest(stateAtStart.bot, jobId),
          acceptedOmissions: $('clone-accept-omissions').checked,
        });
        if (job.state === 'AWAITING_DESTRUCTIVE_CONFIRMATION') showCloneConfirmation(job);
        else renderOperationResult(job);
        return;
      }

      if (stateAtStart.stage === 'clone-confirm') {
        const payload = buildCloneConfirmation(stateAtStart.job);
        showMsg($('operation-modal-status'), 'Freshness recheck and Clone are running. Do not edit local browser data…', 'info');
        const job = await jobClient.confirmClone(payload.jobId, payload.confirmation);
        renderOperationResult(job);
        void loadRecoveryTools();
        return;
      }

      if (stateAtStart.stage === 'restore-preflight') {
        const jobId = randomJobId('restore');
        await persistLastJob(jobId);
        showMsg($('operation-modal-status'), 'Validating source and creating a separate recovery backup…', 'info');
        const job = await jobClient.startRestorePreflight({
          jobId,
          restoreSourceBackupId: stateAtStart.backup.backupId,
          acceptedOmissions: $('restore-accept-omissions').checked,
        });
        if (job.state === 'AWAITING_RESTORE_CONFIRMATION') showRestoreConfirmation(job);
        else renderOperationResult(job);
        return;
      }

      if (stateAtStart.stage === 'restore-confirm') {
        const payload = buildRestoreConfirmation(stateAtStart.job);
        showMsg($('operation-modal-status'), 'Freshness recheck and Restore are running…', 'info');
        const job = await jobClient.confirmRestore(payload.jobId, payload.confirmation);
        renderOperationResult(job);
        void loadRecoveryTools();
        return;
      }

      if (stateAtStart.stage === 'delete-backup') {
        await jobClient.deleteBackup(stateAtStart.backupId);
        closeOperationModal();
        await loadRecoveryTools();
        showMsg($('backup-status'), 'Backup deleted.', 'ok');
        return;
      }

      if (stateAtStart.stage === 'job-refresh') {
        const job = await jobClient.getJob(stateAtStart.jobId);
        showDurableJob(job);
      }
    } catch (error) {
      operationError(error);
    } finally {
      if (operationState === stateAtStart) setBtnLoading(btn, false);
    }
  }

  $('btn-operation-confirm').addEventListener('click', () => void handleOperationConfirm());
  $('btn-operation-cancel').addEventListener('click', closeOperationModal);
  $('btn-operation-close').addEventListener('click', closeOperationModal);
  $('operation-modal').addEventListener('click', event => {
    if (event.target?.dataset?.modalClose === 'true') closeOperationModal();
  });
  $('operation-modal-body').addEventListener('change', event => {
    if (event.target?.matches?.('[data-sync-select-all]')) {
      const selection = syncCategorySelection(event.target.checked);
      document.querySelectorAll('[data-sync-category]').forEach(input => {
        input.checked = selection[input.dataset.syncCategory];
      });
      updateSyncSelectAllState();
    } else if (event.target?.matches?.('[data-sync-category]')) {
      updateSyncSelectAllState();
    }
    if (event.target?.dataset?.finalAck) {
      $('btn-operation-confirm').disabled = !event.target.checked;
    }
  });

  function loadProxyStatus() {
    return new Promise(resolve => {
      chrome.storage.local.get([PROXY_STATUS_KEY], (out) => {
        const v = out[PROXY_STATUS_KEY];
        if (v && v.active && v.botId) {
          activeProxy = {
            botId: v.botId,
            botName: v.botName || '',
            host: v.host || '',
            port: v.port || 8080,
          };
        } else {
          activeProxy = null;
        }
        resolve(activeProxy);
      });
    });
  }

  function renderProxyBanner() {
    const banner = $('proxy-banner');
    if (!activeProxy) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';
    $('proxy-banner-bot').textContent = activeProxy.botName || activeProxy.botId.slice(0, 8);
    $('proxy-banner-host').textContent = `${activeProxy.host}:${activeProxy.port}`;
  }

  async function enableProxyFor(bot) {
    const host = new URL(serverOrigin).hostname;
    const port = 8080;
    const config = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: 'http', host, port },
        bypassList: ['localhost', '127.0.0.1'],
      },
    };
    // Write creds + status BEFORE applying the proxy so the very first
    // request through the new proxy already has them in cache.
    await new Promise(resolve => chrome.storage.local.set({
      [PROXY_CREDS_KEY]: {
        username: bot.proxy_username,
        password: bot.proxy_password,
      },
      [PROXY_STATUS_KEY]: {
        active: true,
        botId: bot.id,
        botName: bot.name || bot.browser_id,
        host, port,
      },
    }, resolve));
    await new Promise(resolve =>
      chrome.proxy.settings.set({ value: config, scope: 'regular' }, resolve)
    );
    activeProxy = { botId: bot.id, botName: bot.name || bot.browser_id, host, port };
  }

  async function disableProxy() {
    await new Promise(resolve =>
      chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }, resolve)
    );
    // Clear creds AFTER going direct so we don't accidentally hand
    // them to a still-pending proxy auth challenge.
    await new Promise(resolve =>
      chrome.storage.local.remove([PROXY_CREDS_KEY], resolve)
    );
    await new Promise(resolve =>
      chrome.storage.local.set({ [PROXY_STATUS_KEY]: { active: false } }, resolve)
    );
    activeProxy = null;
  }

  // --- LOGIN ---
  $('btn-login').addEventListener('click', async () => {
    const url = $('server-url').value.trim();
    const user = $('login-user').value.trim();
    const pass = $('login-pass').value;
    const remember = $('remember-me').checked;
    const errEl = $('login-error');
    errEl.style.display = 'none';

    if (!url) { showMsg(errEl, 'Server URL is required', 'err'); return; }
    if (!user || !pass) { showMsg(errEl, 'Username and password are required', 'err'); return; }

    const btn = $('btn-login');
    setBtnLoading(btn, true);

    try {
      const origin = new URL(url).origin;
      const result = await apiPost(`${origin}/api/v1/ext/login`, { username: user, password: pass });
      serverOrigin = origin;
      adminCreds = { username: user, password: pass };
      bots = result.bots || [];

      if (remember) {
        chrome.storage.local.set({
          SHADOWLINK_CREDS: JSON.stringify({ url: origin, username: user, password: pass }),
          SHADOWLINK_REMEMBER: true,
        });
      } else {
        chrome.storage.local.remove(['SHADOWLINK_CREDS']);
        chrome.storage.local.set({ SHADOWLINK_REMEMBER: false });
      }

      await loadProxyStatus();
      renderProxyBanner();
      renderBotList();
      showView(viewMain);
      void resumeLastJob();
    } catch (e) {
      showMsg(errEl, e.message, 'err');
    } finally {
      setBtnLoading(btn, false);
    }
  });

  // --- LOGOUT ---
  $('btn-logout').addEventListener('click', () => {
    chrome.storage.local.remove(['SHADOWLINK_CREDS', 'SHADOWLINK_REMEMBER', 'COOKIE_SYNC_CONFIG']);
    serverOrigin = '';
    adminCreds = { username: '', password: '' };
    bots = [];
    $('server-url').value = '';
    $('login-user').value = '';
    $('login-pass').value = '';
    $('remember-me').checked = true;
    showView(viewLogin);
  });

  function formatBackupTime(value) {
    if (!Number.isFinite(value)) return 'Unknown time';
    try { return new Date(value).toLocaleString(); } catch (_) { return 'Unknown time'; }
  }

  function renderBackupList() {
    const list = $('backup-list');
    if (backupRows.length === 0) {
      list.innerHTML = '<div class="empty-list compact">No verified backups yet</div>';
      return;
    }
    list.innerHTML = backupRows.map(row => {
      const counts = Object.entries(row.categoryCounts)
        .map(([category, count]) => `${category}: ${count}`)
        .join(' · ');
      return `
        <div class="backup-card${row.state === 'active' ? ' backup-card-active' : ''}${row.isUndoRestore ? ' backup-card-undo' : ''}">
          <div class="backup-card-top">
            <div class="backup-card-id" title="${escHtml(row.backupId)}">${escHtml(row.backupId)}</div>
            <span class="backup-badge">${escHtml(row.state)}</span>
            ${row.isUndoRestore ? '<span class="backup-badge backup-badge-undo">Undo Restore</span>' : ''}
          </div>
          <div class="backup-card-meta">${escHtml(row.purpose)} · ${escHtml(formatBackupTime(row.createdAt))} · ${row.totalCount} items</div>
          <div class="backup-card-counts">${escHtml(counts)}</div>
          <div class="backup-card-actions">
            <button class="btn-mini" data-backup-act="restore" data-backup-id="${escHtml(row.backupId)}" ${row.canRestore ? '' : 'disabled'}>${row.isUndoRestore ? 'Undo Restore' : 'Restore'}</button>
            <button class="btn-mini" data-backup-act="delete" data-backup-id="${escHtml(row.backupId)}" ${row.canDelete ? '' : 'disabled'}>Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderArchiveList() {
    const page = filterArchivePage(archiveState.records, archiveState);
    archiveState.page = page.page;
    const list = $('archive-list');
    if (page.records.length === 0) {
      list.innerHTML = '<div class="empty-list compact">No matching archive records</div>';
    } else {
      list.innerHTML = page.records.map(record => {
        const title = record.title || record.filename || record.url || 'Archive record';
        const meta = [record.url, record.filename, record.startTime].filter(Boolean).join(' · ');
        return `
          <div class="archive-record">
            <div class="archive-record-title">${escHtml(String(title))}</div>
            <div class="archive-record-meta">${escHtml(String(meta))}</div>
          </div>
        `;
      }).join('');
    }
    $('archive-page-label').textContent = `Page ${page.page} / ${page.totalPages} · ${page.total} records`;
    $('btn-archive-prev').disabled = page.page <= 1;
    $('btn-archive-next').disabled = page.page >= page.totalPages;
    $('btn-export-archive').disabled = archiveState.records.length === 0;
  }

  async function loadArchive(kind = archiveState.kind) {
    archiveState.kind = kind;
    archiveState.page = 1;
    document.querySelectorAll('.archive-tab').forEach(tab =>
      tab.classList.toggle('active', tab.dataset.archiveKind === kind));
    try {
      const archive = kind === 'history'
        ? await jobClient.listHistoryArchive()
        : await jobClient.listDownloadArchive();
      archiveState.records = Array.isArray(archive?.records) ? archive.records : [];
    } catch (_) {
      archiveState.records = [];
    }
    renderArchiveList();
  }

  async function loadRecoveryTools() {
    try {
      const [manifests, jobs] = await Promise.all([
        jobClient.listBackups(),
        jobClient.listJobs(),
      ]);
      const undoJob = jobs.find(job => typeof job.undo_restore_backup_id === 'string');
      backupRows = buildBackupRows(manifests, {
        undoRestoreBackupId: undoJob?.undo_restore_backup_id || '',
      });
      renderBackupList();
      $('backup-status').style.display = 'none';
    } catch (error) {
      backupRows = [];
      renderBackupList();
      showMsg($('backup-status'), `Could not read local backups (${error.code || 'background_unavailable'}).`, 'err');
    }
    await loadArchive(archiveState.kind);
  }

  // --- TOOLS view entry / exit ---
  $('btn-open-tools-from-login').addEventListener('click', () => {
    toolsReturnTo = 'login';
    showView(viewTools);
    void loadRecoveryTools();
  });
  $('btn-open-tools-from-main').addEventListener('click', () => {
    toolsReturnTo = 'main';
    showView(viewTools);
    void loadRecoveryTools();
  });
  $('btn-tools-back').addEventListener('click', () => {
    showView(toolsReturnTo === 'main' ? viewMain : viewLogin);
  });

  $('btn-refresh-backups').addEventListener('click', () => void loadRecoveryTools());
  $('backup-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-backup-act]');
    if (!button) return;
    const row = backupRows.find(item => item.backupId === button.dataset.backupId);
    if (!row) return;
    if (button.dataset.backupAct === 'restore') {
      openRestoreDialog(row);
    } else if (button.dataset.backupAct === 'delete') {
      configureOperationModal({
        stage: 'delete-backup',
        title: 'Delete local backup',
        confirmLabel: 'Delete backup',
        data: { backupId: row.backupId },
        body: `
          <div class="operation-danger">Delete backup <strong>${escHtml(row.backupId)}</strong>? This cannot be undone. Backups referenced by active recovery work are protected automatically.</div>
        `,
      });
    }
  });
  document.querySelectorAll('.archive-tab').forEach(tab => {
    tab.addEventListener('click', () => void loadArchive(tab.dataset.archiveKind));
  });
  $('archive-search').addEventListener('input', event => {
    archiveState.query = event.target.value;
    archiveState.page = 1;
    renderArchiveList();
  });
  $('btn-archive-prev').addEventListener('click', () => {
    archiveState.page -= 1;
    renderArchiveList();
  });
  $('btn-archive-next').addEventListener('click', () => {
    archiveState.page += 1;
    renderArchiveList();
  });
  $('btn-export-archive').addEventListener('click', () => {
    const exported = buildArchiveExport(archiveState.kind, archiveState.records);
    const blob = new Blob([exported.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // --- CA view ---
  // Build the OS-specific install commands using the *currently
  // logged-in* server URL so the user doesn't have to think about
  // where the cert came from.
  function rebuildCACommands() {
    const filename = 'Umbra-CA.crt';
    // We don't know the absolute path on the user's machine, but we
    // can use the standard browser default — same on all 3 platforms.
    const macPath = `~/Downloads/${filename}`;
    const winPath = `$HOME\\Downloads\\${filename}`;
    const linuxPath = `~/Downloads/${filename}`;

    $('cmd-mac').textContent =
      `sudo security add-trusted-cert -d -r trustRoot \\\n  -k /Library/Keychains/System.keychain \\\n  ${macPath}`;
    $('cmd-win').textContent =
      `Import-Certificate -FilePath "${winPath}" \`\n  -CertStoreLocation Cert:\\LocalMachine\\Root`;
    $('cmd-linux').textContent =
      `sudo cp ${linuxPath} /usr/local/share/ca-certificates/umbra-edr-mitm.crt && \\\nsudo update-ca-certificates`;

    // Source host shown in the download section.
    try {
      const host = serverOrigin ? new URL(serverOrigin).host : 'unknown';
      $('ca-source-host').textContent = host;
    } catch (_) {
      $('ca-source-host').textContent = serverOrigin || 'unknown';
    }
  }

  $('btn-open-ca').addEventListener('click', () => {
    rebuildCACommands();
    showView(viewCA);
  });
  $('btn-ca-back').addEventListener('click', () => {
    showView(viewMain);
  });

  // Platform-tab toggle inside CA view.
  document.querySelectorAll('.platform-tab').forEach(t => {
    t.addEventListener('click', () => {
      const os = t.dataset.os;
      document.querySelectorAll('.platform-tab').forEach(x =>
        x.classList.toggle('active', x.dataset.os === os));
      document.querySelectorAll('.platform-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.os === os));
    });
  });

  // CA download — fetch the public /ca.crt from the server we logged
  // into, then trigger a real browser download via Blob + <a> click.
  // Going through Blob (rather than a direct GET) lets us guarantee
  // the saved filename and avoids leaving the popup if the server
  // sends a non-attachment Content-Disposition.
  $('btn-ca-download').addEventListener('click', async () => {
    const btn = $('btn-ca-download');
    const status = $('ca-download-status');
    if (!serverOrigin) {
      showMsg(status, 'Sign in first so we know which server to fetch the CA from.', 'err');
      return;
    }
    setBtnLoading(btn, true);
    try {
      const res = await fetch(`${serverOrigin}/ca.crt`, { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Umbra-CA.crt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke after a short delay so the download has time to start.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showMsg(status, 'Downloaded — now run the trust command below.', 'ok');
    } catch (e) {
      showMsg(status, `Download failed: ${e.message}`, 'err');
    } finally {
      setBtnLoading(btn, false);
    }
  });

  // Copy buttons — capture data-copy="<id of <pre>>" and put its
  // textContent on the clipboard.
  document.querySelectorAll('button[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = $(btn.dataset.copy);
      if (!target) return;
      const text = target.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = original; }, 1200);
      } catch (_) {
        // Clipboard permission denied — fall back to a manual select.
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  // --- BOT LIST (with inline action buttons) ---
  function renderBotList(filter = '') {
    const list = $('bot-list');
    const filtered = filter
      ? bots.filter(b => (b.name + b.browser_id + (b.user_agent || ''))
          .toLowerCase().includes(filter.toLowerCase()))
      : bots;

    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-list">No bots found</div>';
      return;
    }

    list.innerHTML = filtered.map(b => {
      const isActiveProxy = activeProxy && activeProxy.botId === b.id;
      const proxyLabel = isActiveProxy ? 'Proxy: ON' : 'Proxy';
      const proxyClass = isActiveProxy ? 'btn-row btn-row-proxy-on' : 'btn-row btn-row-proxy';
      const meta = b.user_agent ? b.user_agent.substring(0, 60) : b.browser_id;
      return `
        <div class="bot-item${isActiveProxy ? ' bot-item-active-proxy' : ''}" data-id="${b.id}">
          <div class="bot-dot ${b.is_online ? 'online' : 'offline'}"></div>
          <div class="bot-item-info">
            <div class="bot-item-name">${escHtml(b.name)}</div>
            <div class="bot-item-meta">${escHtml(meta)}</div>
          </div>
          <div class="bot-actions">
            <button class="btn-row btn-row-sync" data-act="sync" data-id="${b.id}">Sync</button>
            <button class="btn-row btn-row-clone" data-act="clone" data-id="${b.id}">Clone</button>
            <button class="${proxyClass}" data-act="proxy" data-id="${b.id}">${proxyLabel}</button>
          </div>
        </div>
      `;
    }).join('');
  }

  $('bot-search').addEventListener('input', (e) => renderBotList(e.target.value));

  $('btn-refresh-bots').addEventListener('click', async () => {
    const btn = $('btn-refresh-bots');
    setBtnLoading(btn, true);
    try {
      const result = await apiPost(`${serverOrigin}/api/v1/ext/login`, adminCreds);
      bots = result.bots || [];
      renderBotList($('bot-search').value);
    } catch (_) {}
    setBtnLoading(btn, false);
  });

  // Inline action delegation: handle Sync / Proxy without leaving the
  // bot list. Status messages render below the list.
  $('bot-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const bot = bots.find(b => b.id === id);
    if (!bot) return;
    const status = $('bot-action-status');

    if (act === 'sync') {
      openSyncDialog(bot);
      return;
    }

    if (act === 'clone') {
      openCloneDialog(bot);
      return;
    }

    if (act === 'proxy') {
      const isCurrent = activeProxy && activeProxy.botId === id;
      setBtnLoading(btn, true);
      try {
        if (isCurrent) {
          await disableProxy();
          showMsg(status, `Proxy disabled — ${bot.name} no longer routing your traffic`, 'info');
        } else {
          await enableProxyFor(bot);
          showMsg(status, `Proxy enabled via ${bot.name} (${activeProxy.host}:${activeProxy.port})`, 'ok');
        }
        renderProxyBanner();
        renderBotList($('bot-search').value);
      } catch (err) {
        showMsg(status, `Proxy toggle failed: ${err.message}`, 'err');
      } finally {
        setBtnLoading(btn, false);
      }
      return;
    }
  });

  // Disable button on the active-proxy banner
  $('btn-proxy-disable').addEventListener('click', async () => {
    if (!activeProxy) return;
    const status = $('bot-action-status');
    const btn = $('btn-proxy-disable');
    setBtnLoading(btn, true);
    try {
      const wasName = activeProxy.botName;
      await disableProxy();
      renderProxyBanner();
      renderBotList($('bot-search').value);
      showMsg(status, `Proxy disabled — ${wasName} no longer routing your traffic`, 'info');
    } finally {
      setBtnLoading(btn, false);
    }
  });

  // --- MANUAL IMPORT ---
  $('btn-import').addEventListener('click', async () => {
    const text = $('cookie-json').value.trim();
    const status = $('import-status');
    if (!text) { showMsg(status, 'Paste cookie JSON first', 'err'); return; }

    const btn = $('btn-import');
    setBtnLoading(btn, true);
    try {
      const cookies = JSON.parse(text);
      const { total, imported } = await importCookies(cookies);
      showMsg(status, `Imported ${imported}/${total} cookies`, 'ok');
      $('cookie-json').value = '';
    } catch (e) {
      showMsg(status, `Import failed: ${e.message}`, 'err');
    } finally {
      setBtnLoading(btn, false);
    }
  });

  // --- CLEAR ---
  $('btn-clear-cookies').addEventListener('click', async () => {
    const btn = $('btn-clear-cookies');
    const status = $('clear-status');
    setBtnLoading(btn, true);
    try {
      const all = await getAllCookies();
      await Promise.all(all.map(c => removeCookie(cookieUrl(c), c.name).catch(() => {})));
      showMsg(status, `Cleared ${all.length} cookies`, 'ok');
    } catch (e) {
      showMsg(status, `Failed: ${e.message}`, 'err');
    }
    setBtnLoading(btn, false);
  });

  $('btn-clear-all').addEventListener('click', () => {
    const status = $('clear-status');
    chrome.browsingData.remove({ since: 0 }, {
      appcache: true, cache: true, cacheStorage: true, cookies: true,
      downloads: true, fileSystems: true, formData: true, history: true,
      indexedDB: true, passwords: true, serviceWorkers: true, webSQL: true,
    }, () => {
      showMsg(status, 'All browsing data cleared', 'ok');
    });
  });

  // Live updates: if status changes from another popup or from the SW,
  // re-render so the banner / inline button stays correct.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[PROXY_STATUS_KEY]) return;
    void loadProxyStatus().then(() => {
      renderProxyBanner();
      if (viewMain.style.display !== 'none') {
        renderBotList($('bot-search').value);
      }
    });
  });

  // Sensible local-dev defaults. Filled into any field that ends up
  // empty after loading saved creds — saves typing on every popup
  // open while still letting saved (real) creds win.
  const DEFAULTS = {
    url: 'http://127.0.0.1:8118',
    username: 'admin',
    password: 'admin',
  };
  function fillEmptyWithDefaults() {
    if (!$('server-url').value) $('server-url').value = DEFAULTS.url;
    if (!$('login-user').value) $('login-user').value = DEFAULTS.username;
    if (!$('login-pass').value) $('login-pass').value = DEFAULTS.password;
  }

  // --- LOAD SAVED CONFIG ---
  chrome.storage.local.get(['SHADOWLINK_CREDS', 'SHADOWLINK_REMEMBER', 'COOKIE_SYNC_CONFIG'], async (result) => {
    const remember = result.SHADOWLINK_REMEMBER !== false;
    $('remember-me').checked = remember;

    let raw = result.SHADOWLINK_CREDS || result.COOKIE_SYNC_CONFIG;
    if (!raw) {
      fillEmptyWithDefaults();
      return;
    }

    try {
      const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
      $('server-url').value = config.url || '';
      $('login-user').value = config.username || '';
      $('login-pass').value = config.password || '';
      // Saved values may be partial (or someone hand-edited storage);
      // patch missing pieces with defaults so the form is never blank.
      fillEmptyWithDefaults();

      if (!remember) return;

      const origin = new URL(config.url).origin;
      const data = await apiPost(`${origin}/api/v1/ext/login`, {
        username: config.username, password: config.password,
      });
      serverOrigin = origin;
      adminCreds = { username: config.username, password: config.password };
      bots = data.bots || [];
      await loadProxyStatus();
      renderProxyBanner();
      renderBotList();
      showView(viewMain);
      void resumeLastJob();
    } catch (_) {
      fillEmptyWithDefaults();
    }
  });

  // Enter key on login form
  [$('server-url'), $('login-user'), $('login-pass')].forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-login').click();
    });
  });
});
