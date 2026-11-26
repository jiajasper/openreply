// Client half of @local/dsh-openreply: an "OpenReply" sidebar entry and its page.
// Hand-written (no build step): DSH's module envelope around one React page that reads the
// Host's owner-only, read-only /api/openreply/* routes. There are no start/stop buttons on
// purpose: PM2 owns the processes, so closing the app never touches them.
window.__ModuleLoader__.load({
  id: '@local/dsh-openreply',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'dsh-openreply';

    async function call(path, body) {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${res.status})`);
      return payload;
    }

    const errText = (e) => (e instanceof Error ? e.message : String(e));

    function ago(ms) {
      if (!ms || ms < 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      const hr = Math.floor(m / 60);
      if (hr < 48) return `${hr}h ${m % 60}m`;
      return `${Math.floor(hr / 24)}d ${hr % 24}h`;
    }

    function bytes(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1048576).toFixed(1)} MB`;
    }

    function cell(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }

    let stylesReady = false;
    function ensureStyles() {
      if (stylesReady || typeof document === 'undefined') return;
      stylesReady = true;
      const el = document.createElement('style');
      el.id = 'dsh-openreply-styles';
      el.textContent = `
        .dsho { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary, inherit); font-size: 13px; line-height: 1.5; }
        .dsho-inner { max-width: 1100px; margin: 0 auto; padding: 32px 24px 48px; }
        .dsho h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
        .dsho-sub { color: var(--dsw-alias-label-secondary, #646a73); }
        .dsho-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
        .dsho-tabs { display: flex; gap: 6px; margin: 18px 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); }
        .dsho-tab { background: none; border: 0; border-bottom: 2px solid transparent; padding: 6px 10px; font: inherit; color: var(--dsw-alias-label-secondary, #646a73); cursor: pointer; margin-bottom: -1px; }
        .dsho-tab.on { color: inherit; border-bottom-color: currentColor; font-weight: 600; }
        .dsho-rows { border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); }
        .dsho-row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); }
        .dsho-row b { font-weight: 600; }
        .dsho-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; background: #9aa0a6; }
        .dsho-dot.on { background: #22a559; } .dsho-dot.wait { background: #f5a524; } .dsho-dot.bad { background: var(--dsw-alias-state-error-primary, #ef4444); }
        .dsho-h2 { font-weight: 600; margin: 22px 0 6px; }
        .dsho-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
        .dsho-btn, .dsho-select {
          height: 28px; padding: 0 10px; border-radius: 7px; font: inherit; cursor: pointer;
          border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); background: transparent; color: inherit;
        }
        .dsho-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
        .dsho-btn:disabled { opacity: 0.5; cursor: default; }
        .dsho-log { margin: 0; padding: 12px; border-radius: 8px; max-height: 65vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
          background: var(--dsw-alias-bg-l2, rgba(128,128,128,0.08)); font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; line-height: 1.45; }
        .dsho-db { display: grid; grid-template-columns: 220px 1fr; gap: 16px; align-items: start; }
        .dsho-tlist { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); border-radius: 8px; overflow: hidden; }
        .dsho-titem { display: flex; justify-content: space-between; gap: 8px; background: none; border: 0; padding: 6px 10px; font: inherit; color: inherit; cursor: pointer; text-align: left; }
        .dsho-titem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }
        .dsho-titem.on { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18)); font-weight: 600; }
        .dsho-titem span:last-child { color: var(--dsw-alias-label-tertiary, #8c93a3); font-variant-numeric: tabular-nums; }
        .dsho-grid { overflow: auto; max-height: 68vh; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22)); border-radius: 8px; }
        .dsho-grid table { border-collapse: collapse; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
        .dsho-grid th, .dsho-grid td { padding: 5px 9px; text-align: left; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18)); white-space: nowrap; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
        .dsho-grid th { position: sticky; top: 0; background: var(--dsw-alias-bg-base, #fff); font-weight: 600; }
        .dsho-err { margin: 10px 0; font-size: 12px; color: var(--dsw-alias-state-error-primary, #ef4444); word-break: break-word; }
        .dsho-note { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
      `;
      document.head.appendChild(el);
    }

    function PulseIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('path', { d: 'M4 5h16v11H9l-5 4z' }),
      h('path', { d: 'M8 10.5h2l1.5-2.5 2 5 1.5-2.5h1' }));
    }

    // ------------------------------------------------------------------ Status tab
    function StatusTab() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          setStatus((await call('/api/openreply/status')).status);
          setError('');
        } catch (e) {
          setError(errText(e));
        }
      }, []);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, 5000);
        return () => clearInterval(timer);
      }, [refresh]);

      if (!status) return h('div', { className: error ? 'dsho-err' : 'dsho-sub' }, error || 'Loading…');

      const tone = (s) => (s === 'online' ? 'on' : s === 'launching' || s === 'stopping' ? 'wait' : 'bad');
      const health = status.health;
      const pub = status.public;
      const pubOk = pub.httpStatus >= 200 && pub.httpStatus < 400;
      const queue = health.checks?.queue;

      return h(React.Fragment, null,
        !status.repoFound ? h('div', { className: 'dsho-err' }, `The openreply checkout was not found at ${status.repo}. Set OPENREPLY_REPO or ~/.dsh/openreply/repo-root.`) : null,
        h('div', { className: 'dsho-h2' }, 'Processes (PM2)'),
        status.pm2.error ? h('div', { className: 'dsho-err' }, status.pm2.error) : null,
        h('div', { className: 'dsho-rows' },
          status.pm2.procs.length === 0 && !status.pm2.error
            ? h('div', { className: 'dsho-row dsho-sub' }, 'No PM2 processes.')
            : null,
          ...status.pm2.procs.map((p) => h('div', { className: 'dsho-row', key: p.name },
            h('span', null, h('span', { className: `dsho-dot ${tone(p.status)}` }), h('b', null, p.name), ' ',
              h('span', { className: 'dsho-sub' }, p.status)),
            h('span', { className: 'dsho-sub dsho-mono' },
              `up ${ago(p.uptimeMs)} · ↺ ${p.restarts} · ${p.cpu}% cpu · ${p.memoryMb} MB · pid ${p.pid || '—'}`)))),
        h('div', { className: 'dsho-h2' }, 'Health'),
        h('div', { className: 'dsho-rows' },
          h('div', { className: 'dsho-row' },
            h('span', null, h('span', { className: `dsho-dot ${health.status === 'ok' ? 'on' : health.reachable ? 'wait' : 'bad'}` }), 'Web app ',
              h('span', { className: 'dsho-sub dsho-mono' }, '/api/health')),
            h('span', null, health.status)),
          health.checks ? h('div', { className: 'dsho-row' },
            h('span', null, h('span', { className: `dsho-dot ${health.checks.worker ? 'on' : 'bad'}` }), 'Worker heartbeat'),
            h('span', null, health.checks.worker ? `fresh (${ago(health.checks.workerAgeMs)} ago)` : 'stale')) : null,
          health.checks ? h('div', { className: 'dsho-row' },
            h('span', null, h('span', { className: `dsho-dot ${health.checks.database === 'ok' && health.checks.redis === 'ok' ? 'on' : 'bad'}` }), 'Postgres / Redis'),
            h('span', null, `${health.checks.database} / ${health.checks.redis}`)) : null,
          queue ? h('div', { className: 'dsho-row' },
            h('span', null, h('span', { className: `dsho-dot ${queue.failed ? 'wait' : 'on'}` }), 'DM queue'),
            h('span', { className: 'dsho-mono' }, `waiting ${queue.waiting} · active ${queue.active} · delayed ${queue.delayed} · failed ${queue.failed}`)) : null,
          h('div', { className: 'dsho-row' },
            h('span', null, h('span', { className: `dsho-dot ${pubOk ? 'on' : 'bad'}` }), 'Public URL ',
              h('span', { className: 'dsho-sub dsho-mono' }, pub.url || '—')),
            h('span', null, pub.httpStatus ? `HTTP ${pub.httpStatus}` : (pub.error || 'no answer')))),
        error ? h('div', { className: 'dsho-err' }, error) : null,
        h('div', { className: 'dsho-note' },
          `Checked ${new Date(status.checkedAt).toLocaleTimeString()} · refreshes every 5s · read-only: PM2 keeps these running when this app is closed.`));
    }

    // ------------------------------------------------------------------ Logs tab
    function LogsTab() {
      const [files, setFiles] = React.useState([]);
      const [name, setName] = React.useState('');
      const [lines, setLines] = React.useState(200);
      const [follow, setFollow] = React.useState(true);
      const [log, setLog] = React.useState(null);
      const [error, setError] = React.useState('');
      const preRef = React.useRef(null);

      React.useEffect(() => {
        call('/api/openreply/logs').then(({ files: list }) => {
          setFiles(list);
          setName((current) => current || (list.find((f) => f.name === 'worker-out.log') ?? list[0])?.name || '');
        }).catch((e) => setError(errText(e)));
      }, []);

      const load = React.useCallback(async () => {
        if (!name) return;
        try {
          setLog((await call('/api/openreply/log', { name, lines })).log);
          setError('');
        } catch (e) {
          setError(errText(e));
        }
      }, [name, lines]);

      React.useEffect(() => {
        void load();
        if (!follow) return undefined;
        const timer = setInterval(() => { void load(); }, 3000);
        return () => clearInterval(timer);
      }, [load, follow]);

      React.useEffect(() => {
        if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
      }, [log, follow]);

      return h(React.Fragment, null,
        h('div', { className: 'dsho-bar' },
          h('select', { className: 'dsho-select', value: name, onChange: (e) => setName(e.target.value) },
            ...files.map((f) => h('option', { key: f.name, value: f.name }, `${f.name} (${bytes(f.size)})`))),
          h('select', { className: 'dsho-select', value: lines, onChange: (e) => setLines(Number(e.target.value)) },
            ...[100, 200, 500, 1000].map((n) => h('option', { key: n, value: n }, `last ${n} lines`))),
          h('label', { className: 'dsho-sub' },
            h('input', { type: 'checkbox', checked: follow, onChange: (e) => setFollow(e.target.checked) }), ' follow'),
          h('button', { type: 'button', className: 'dsho-btn', onClick: () => void load() }, 'Refresh')),
        error ? h('div', { className: 'dsho-err' }, error) : null,
        files.length === 0 && !error ? h('div', { className: 'dsho-sub' }, 'No log files yet.') : null,
        log ? h('pre', { className: 'dsho-log', ref: preRef }, log.text || '(empty)') : null);
    }

    // ------------------------------------------------------------------ Database tab
    function DatabaseTab() {
      const [tables, setTables] = React.useState(null);
      const [name, setName] = React.useState('');
      const [page, setPage] = React.useState(0);
      const [data, setData] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const loadTables = React.useCallback(() => {
        call('/api/openreply/db/tables').then(({ tables: list }) => { setTables(list); setError(''); })
          .catch((e) => setError(errText(e)));
      }, []);
      React.useEffect(() => { loadTables(); }, [loadTables]);

      const loadTable = React.useCallback(async () => {
        if (!name) return;
        setBusy(true);
        try {
          setData((await call('/api/openreply/db/table', { name, page })).table);
          setError('');
        } catch (e) {
          setError(errText(e));
        } finally {
          setBusy(false);
        }
      }, [name, page]);
      React.useEffect(() => { void loadTable(); }, [loadTable]);

      if (!tables) return h('div', { className: error ? 'dsho-err' : 'dsho-sub' }, error || 'Loading…');

      const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

      return h('div', { className: 'dsho-db' },
        h('div', { className: 'dsho-tlist' },
          ...tables.map((t) => h('button', {
            key: t.name, type: 'button', className: `dsho-titem${t.name === name ? ' on' : ''}`,
            onClick: () => { setName(t.name); setPage(0); },
          }, h('span', null, t.name), h('span', null, t.rows)))),
        h('div', null,
          error ? h('div', { className: 'dsho-err' }, error) : null,
          !name ? h('div', { className: 'dsho-sub' }, 'Pick a table. Rows are newest first; token, secret and key columns are masked. Read-only.') : null,
          data && data.name === name ? h(React.Fragment, null,
            h('div', { className: 'dsho-bar' },
              h('b', null, data.name),
              h('span', { className: 'dsho-sub' }, `${data.total} rows · page ${data.page + 1} of ${pages}`),
              h('button', { type: 'button', className: 'dsho-btn', disabled: busy || page === 0, onClick: () => setPage(page - 1) }, '‹ Newer'),
              h('button', { type: 'button', className: 'dsho-btn', disabled: busy || page + 1 >= pages, onClick: () => setPage(page + 1) }, 'Older ›'),
              h('button', { type: 'button', className: 'dsho-btn', disabled: busy, onClick: () => { void loadTable(); loadTables(); } }, 'Refresh'),
              data.masked.length ? h('span', { className: 'dsho-sub' }, `masked: ${data.masked.join(', ')}`) : null),
            data.rows.length === 0
              ? h('div', { className: 'dsho-sub' }, 'No rows.')
              : h('div', { className: 'dsho-grid' }, h('table', null,
                h('thead', null, h('tr', null, ...data.columns.map((c) => h('th', { key: c }, c)))),
                h('tbody', null, ...data.rows.map((row, i) => h('tr', { key: i },
                  ...data.columns.map((c) => {
                    const text = cell(row[c]);
                    return h('td', { key: c, title: text }, text);
                  }))))))) : null));
    }

    // ------------------------------------------------------------------ page
    function OpenReplyPage() {
      ensureStyles();
      const [tab, setTab] = React.useState('status');
      const tabs = [['status', 'Status'], ['logs', 'Logs'], ['db', 'Database']];
      return h('div', { className: 'dsho' }, h('div', { className: 'dsho-inner' },
        h('h1', null, 'OpenReply'),
        h('div', { className: 'dsho-sub' }, 'Mixbash Auto Reply on this Mac: PM2 processes, health, logs and the database. View only.'),
        h('div', { className: 'dsho-tabs' },
          ...tabs.map(([id, label]) => h('button', {
            key: id, type: 'button', className: `dsho-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id),
          }, label))),
        tab === 'status' ? h(StatusTab) : tab === 'logs' ? h(LogsTab) : h(DatabaseTab)));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slot = (name, fn) => {
          try {
            return ctx.slots.inject(name, () => {
              try { return fn(); } catch (err) { console.warn(`[dsh-openreply] slot "${name}" failed:`, err); return undefined; }
            });
          } catch (err) {
            console.warn(`[dsh-openreply] slot inject "${name}" failed:`, err);
            return undefined;
          }
        };
        slot('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 85,
          label: 'OpenReply',
        }, () => h(PulseIcon, { size: 18 })));
        slot('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, OpenReplyPage));
      },
    };
  },
});
