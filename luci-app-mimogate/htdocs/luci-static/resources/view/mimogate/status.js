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
.mimogate-conn-bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 10px 26px;
	padding: 10px 14px;
}
.mimogate-conn-item {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}
.mimogate-conn-status {
	display: inline-block;
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
.mimogate-log-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 10px;
}
.mimogate-log-tabs {
	display: inline-flex;
	flex-wrap: wrap;
	gap: 6px;
}
.mimogate-log-error:empty {
	display: none;
}
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
		const logSources = {
			mimogate: { label: _('MimoGate log'), file: MIMOGATE_LOG_FILE, clearAction: 'clear_log' },
			mihomo: { label: _('Mihomo log'), file: MIHOMO_LOG_FILE, clearAction: 'clear_mihomo_log' }
		};

		let activeKey = 'mimogate';
		let pending = null;

		const errorEl = E('p', { 'class': 'mimogate-log-error', 'role': 'status' });
		const textareaEl = E('textarea', {
			'class': 'cbi-input-textarea',
			'readonly': 'readonly',
			'wrap': 'off',
			'rows': 22,
			'style': 'width:100%; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; line-height:1.45'
		});

		const renderText = (text, forceBottom) => {
			const nextText = text || _('No log entries yet.');
			if (!forceBottom && textareaEl.value === nextText)
				return;

			const atBottom = forceBottom || (textareaEl.scrollHeight - textareaEl.scrollTop - textareaEl.clientHeight < 20);
			textareaEl.value = nextText;
			if (atBottom)
				textareaEl.scrollTop = textareaEl.scrollHeight;
		};

		const syncActiveLog = (forceBottom = false) => {
			if (pending && !forceBottom)
				return pending;

			const request = readLogFile(logSources[activeKey].file).then(text => {
				if (pending === request) {
					dom.content(errorEl, '');
					renderText(text, forceBottom);
				}
			}).catch(error => {
				if (pending === request) {
					const message = _('Unable to read the log.');
					textareaEl.value = '';
					dom.content(errorEl, error.message ? message + ' ' + error.message : message);
				}
			}).finally(() => {
				if (pending === request)
					pending = null;
			});
			pending = request;
			return request;
		};

		const tabBtns = Object.entries(logSources).map(([ key, meta ]) => E('button', {
			'type': 'button',
			'class': 'btn cbi-button' + (key === activeKey ? ' cbi-button-action' : ''),
			'data-log-key': key,
			'click': () => {
				if (activeKey === key)
					return;
				activeKey = key;
				pending = null;
				dom.content(errorEl, '');
				textareaEl.value = '';
				for (const btn of tabBtns)
					btn.classList.toggle('cbi-button-action', btn.dataset.logKey === activeKey);
				syncActiveLog(true);
			}
		}, meta.label));

		const clearBtn = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-negative',
			'click': ui.createHandlerFn(this, async () => {
				try {
					const res = await serviceAction(logSources[activeKey].clearAction);
					if (!res?.ok)
						throw new Error([ res?.message ? _(res.message) : _('Service action failed.'), res?.detail ].filter(Boolean).join('\n'));
					pending = null;
					await syncActiveLog(true);
				}
				catch (e) {
					ui.addNotification(null, E('p', e.message), 'danger');
				}
			})
		}, _('Clear log'));

		const connItem = (label, site) => {
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
			}, _('Check', 'Connection check'));

			return E('div', { 'class': 'mimogate-conn-item' }, [
				E('span', {}, label),
				btn,
				statusEl
			]);
		};

		window.setTimeout(() => syncActiveLog(true), 0);
		poll.add(() => document.hidden ? Promise.resolve() : syncActiveLog(false), POLL_INTERVAL);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', [ STATUS_CSS ]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Connectivity')),
				E('div', { 'class': 'cbi-section-node mimogate-conn-bar' }, [
					connItem(_('Baidu'), 'baidu'),
					connItem(_('Google'), 'google')
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('MimoGate Logs')),
				E('div', { 'class': 'cbi-section-node', 'style': 'padding: 1em' }, [
					E('div', { 'class': 'mimogate-log-toolbar' }, [
						E('div', { 'class': 'mimogate-log-tabs' }, tabBtns),
						clearBtn
					]),
					errorEl,
					textareaEl,
					E('div', { 'style': 'margin-top: 6px; text-align: right' },
						E('small', {}, _('Refresh every %d seconds.').format(POLL_INTERVAL)))
				])
			])
		]);
	}
});
