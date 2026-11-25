// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require dom';
'require fs';
'require poll';
'require rpc';
'require ui';
'require view';

const POLL_INTERVAL = 5;
const MIMOGATE_LOG_FILE = '/var/log/mimogate/mimogate.log';
const MIHOMO_LOG_FILE = '/var/log/mimogate/mihomo.log';
const LOG_CONTROL_RE = /\x1b\[[0-9;]*m|[\x00-\x08\x0b-\x1f\x7f]/g;

const checkConn = rpc.declare({
	object: 'mimogate',
	method: 'connection_check',
	params: [ 'site' ],
	reject: true
});
const serviceAction = rpc.declare({
	object: 'mimogate',
	method: 'service_action',
	params: [ 'action' ],
	reject: true
});

const STATUS_CSS = `
.mimogate-status-page {
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.mimogate-conn-status {
	display: inline-block;
	margin-left: .6em;
	padding: 2px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: 600;
	vertical-align: middle;
}
.mimogate-conn-status.success { color: #15803d; background: rgba(22, 163, 74, .12); }
.mimogate-conn-status.danger { color: #b91c1c; background: rgba(220, 38, 38, .12); }
.mimogate-conn-status.muted { color: #6b7280; background: rgba(107, 114, 128, .12); }
html[data-darkmode="true"] .mimogate-conn-status.success { color: #4ade80; background: rgba(74, 222, 128, .15); }
html[data-darkmode="true"] .mimogate-conn-status.danger { color: #f87171; background: rgba(248, 113, 113, .15); }
html[data-darkmode="true"] .mimogate-conn-status.muted { color: #9ca3af; background: rgba(156, 163, 175, .15); }
`;

async function readLogFile(path) {
	try {
		const text = await fs.read_direct(path, 'text');
		return text.replace(LOG_CONTROL_RE, '').trimEnd();
	}
	catch (error) {
		if (error.name === 'NotFoundError')
			return '';

		throw error;
	}
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	render() {
		const createLogSection = (title, filePath, clearAction) => {
			const errorEl = E('p', { 'role': 'status' });
			const textareaEl = E('textarea', {
				'class': 'cbi-input-textarea',
				'readonly': 'readonly',
				'wrap': 'off',
				'rows': 15,
				'style': 'width:100%; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; line-height:1.45'
			});

			const renderText = (text) => {
				const nextText = text || _('No log entries yet.');
				if (textareaEl.value === nextText)
					return;

				const atBottom = textareaEl.scrollHeight - textareaEl.scrollTop - textareaEl.clientHeight < 20;
				textareaEl.value = nextText;
				if (atBottom)
					textareaEl.scrollTop = textareaEl.scrollHeight;
			};

			let pending;
			const sync = () => {
				if (pending)
					return pending;

				const request = readLogFile(filePath).then(text => {
					if (pending === request) {
						dom.content(errorEl, '');
						renderText(text);
					}
				}).catch(error => {
					if (pending === request) {
						const message = _('Unable to read the log.');
						dom.content(errorEl, error.message ? message + ' ' + error.message : message);
					}
				}).finally(() => {
					if (pending === request)
						pending = null;
				});
				pending = request;
				return request;
			};

			const clearBtn = E('button', {
				'type': 'button',
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(this, async () => {
					try {
						const res = await serviceAction(clearAction);
						if (!res?.ok)
							throw new Error([ res?.message ? _(res.message) : _('Service action failed.'), res?.detail ].filter(Boolean).join('\n'));
						pending = null;
						await sync();
					}
					catch (e) {
						ui.addNotification(null, E('p', e.message), 'danger');
					}
				})
			}, _('Clear log'));

			const section = E('div', { 'class': 'cbi-map' }, [
				E('h3', { 'name': 'content', 'style': 'align-items: center; display: flex; gap: .5em' }, [
					title,
					clearBtn
				]),
				E('div', { 'class': 'cbi-section' }, [
					errorEl,
					textareaEl,
					E('div', { 'style': 'text-align:right' },
						E('small', {}, _('Refresh every %d seconds.').format(POLL_INTERVAL)))
				])
			]);

			return { section, sync };
		};

		const mimogateLog = createLogSection(_('MimoGate log'), MIMOGATE_LOG_FILE, 'clear_log');
		const mihomoLog = createLogSection(_('Mihomo log'), MIHOMO_LOG_FILE, 'clear_mihomo_log');

		const syncAllLogs = () => Promise.all([
			mimogateLog.sync(),
			mihomoLog.sync()
		]);

		const connRow = (label, site) => {
			const statusEl = E('span', { 'class': 'mimogate-conn-status muted' }, _('unchecked'));
			const btn = E('button', {
				'type': 'button',
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, async () => {
					btn.disabled = true;
					statusEl.className = 'mimogate-conn-status muted';
					dom.content(statusEl, _('Checking...'));
					try {
						const res = await checkConn(site);
						if (!res?.ok)
							throw new Error(res?.message ? _(res.message) : _('failed'));
						statusEl.className = 'mimogate-conn-status ' + (res.result ? 'success' : 'danger');
						dom.content(statusEl, res.result ? _('passed') : _('failed'));
					}
					catch (e) {
						statusEl.className = 'mimogate-conn-status danger';
						dom.content(statusEl, _('failed'));
					}
					finally {
						btn.disabled = false;
					}
				})
			}, _('Check'));

			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [ btn, statusEl ])
			]);
		};

		window.setTimeout(() => syncAllLogs(), 0);
		poll.add(() => document.hidden ? Promise.resolve() : syncAllLogs(), POLL_INTERVAL);

		return E('div', { 'class': 'cbi-map mimogate-status-page' }, [
			E('style', [ STATUS_CSS ]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Connection check')),
				E('div', { 'class': 'cbi-section-node' }, [
					connRow(_('Baidu'), 'baidu'),
					connRow(_('Google'), 'google')
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					mimogateLog.section,
					mihomoLog.section
				])
			])
		]);
	}
});
