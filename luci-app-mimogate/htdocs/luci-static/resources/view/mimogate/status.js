// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: MIT

'use strict';
'require dom';
'require fs';
'require poll';
'require rpc';
'require ui';
'require view';

const POLL_INTERVAL = 5;
const LOG_FILE = '/var/log/mimogate/mimogate.log';
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
.mimogate-conn-status { font-weight: bold; margin-left: .5em; }
.mimogate-conn-status.success { color: #16a34a; }
.mimogate-conn-status.danger { color: #dc2626; }
.mimogate-conn-status.muted { color: #6b7280; }
html[data-darkmode="true"] .mimogate-conn-status.muted { color: #9ca3af; }
`;

async function getLog() {
	try {
		const text = await fs.read_direct(LOG_FILE, 'text');
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
		const logErrorEl = E('p', { 'role': 'status' });
		const logEl = E('textarea', {
			'class': 'cbi-input-textarea',
			'readonly': 'readonly',
			'wrap': 'off',
			'rows': 22,
			'style': 'width:100%; font-family:monospace; font-size:12px'
		});

		const renderLog = (text) => {
			const nextText = text || _('No log entries yet.');
			if (logEl.value === nextText)
				return;

			const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
			logEl.value = nextText;
			if (atBottom)
				logEl.scrollTop = logEl.scrollHeight;
		};

		let logRequest;
		const syncLog = () => {
			if (logRequest)
				return logRequest;

			const request = getLog().then(text => {
				if (logRequest === request) {
					dom.content(logErrorEl, '');
					renderLog(text);
				}
			}).catch(error => {
				if (logRequest === request) {
					const message = _('Unable to read the log.');
					dom.content(logErrorEl, error.message ? message + ' ' + error.message : message);
				}
			}).finally(() => {
				if (logRequest === request)
					logRequest = null;
			});
			logRequest = request;
			return request;
		};

		const clear = ui.createHandlerFn(this, async () => {
			try {
				const res = await serviceAction('clear_log');
				if (!res?.ok)
					throw new Error([ res?.message ? _(res.message) : _('Service action failed.'), res?.detail ].filter(Boolean).join('\n'));
				logRequest = null;
				await syncLog();
			}
			catch (e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			}
		});

		const connRow = (label, site) => {
			const statusEl = E('strong', { 'class': 'mimogate-conn-status muted' }, _('unchecked'));
			const btn = E('button', {
				'type': 'button',
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, async () => {
					try {
						const res = await checkConn(site);
						if (!res?.ok)
							throw new Error(res?.message ? _(res.message) : _('failed'));
						const latency = res.ms != null ? ' · %d ms'.format(res.ms) : '';
						statusEl.className = 'mimogate-conn-status ' + (res.result ? 'success' : 'danger');
						dom.content(statusEl, (res.result ? _('passed') : _('failed')) + latency);
					}
					catch (e) {
						statusEl.className = 'mimogate-conn-status danger';
						dom.content(statusEl, _('failed'));
					}
				})
			}, _('Check'));

			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [ btn, statusEl ])
			]);
		};

		window.setTimeout(() => syncLog(), 0);
		poll.add(() => document.hidden ? Promise.resolve() : syncLog(), POLL_INTERVAL);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', [ STATUS_CSS ]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Connection check')),
				E('div', { 'class': 'cbi-section-node' }, [
					connRow(_('Baidu'), 'baidu'),
					connRow(_('Google'), 'google')
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'display:flex; align-items:center; justify-content:space-between; gap:.5em; margin-bottom:.5em' }, [
					E('h3', { 'style': 'margin:0' }, _('Runtime log')),
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative', 'click': clear }, _('Clear log'))
				]),
				logErrorEl,
				logEl,
				E('div', { 'style': 'text-align:right; margin-top:.25em' },
					E('small', {}, _('Refresh every %d seconds.').format(POLL_INTERVAL)))
			])
		]);
	}
});
