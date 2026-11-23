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

const getStatus = rpc.declare({ object: 'mimogate', method: 'status', reject: true });
const getVersion = rpc.declare({ object: 'mimogate', method: 'version', reject: true });
const getBootStatus = rpc.declare({ object: 'mimogate', method: 'boot_status', reject: true });
const readPorts = rpc.declare({ object: 'mimogate', method: 'read_ports', reject: true });
const applyPorts = rpc.declare({
	object: 'mimogate', method: 'apply_ports', params: [ 'ports' ], reject: true
});
const readAcl = rpc.declare({ object: 'mimogate', method: 'read_acl', reject: true });
const saveAcl = rpc.declare({
	object: 'mimogate', method: 'save_acl', params: [ 'mode', 'entries' ], reject: true
});
const getHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const updateCn = rpc.declare({ object: 'mimogate', method: 'update_cn', reject: true });

function formatMtime(epoch) {
	const d = new Date(epoch * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return '%d-%s-%s %s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}
const serviceAction = rpc.declare({
	object: 'mimogate',
	method: 'service_action',
	params: [ 'action' ],
	reject: true
});

async function runInit(action) {
	const res = await serviceAction(action);

	if (!res?.ok)
		throw new Error([ res?.message ? _(res.message) : _('Service action failed.'), res?.detail ].filter(Boolean).join('\n'));
}

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
		const stateEl = E('strong', {}, '—');
		const pidEl = E('span');
		const versionEl = E('span', {}, '—');
		const cnStateEl = E('span', {}, '—');
		const logErrorEl = E('p', { 'role': 'status' });
		const logEl = E('textarea', {
			'class': 'cbi-input-textarea',
			'readonly': 'readonly',
			'wrap': 'off',
			'rows': 20,
			'style': 'width:100%; font-family:monospace; font-size:12px'
		});

		const renderStatus = (st) => {
			dom.content(stateEl, st == null ? _('Unknown') : st.running ? _('Running') : _('Stopped'));
			stateEl.style.color = st == null ? '' : st.running ? 'green' : 'red';
			dom.content(pidEl, st?.running && st.pid ? ' (PID %d)'.format(st.pid) : '');
			dom.content(cnStateEl, st == null ? '—' : st.cn_cached && st.cn_mtime
				? '%s · %s'.format(_('Cached'), formatMtime(st.cn_mtime))
				: _('Bundled snapshot'));
		};

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
		const syncStatus = () =>
			L.resolveDefault(getStatus(), null).then(st => renderStatus(st?.ok ? st : null));

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

		const refresh = () => Promise.all([
			syncStatus(),
			syncLog()
		]);

		let controlling = false;
		const control = (action) => ui.createHandlerFn(this, async () => {
			if (controlling)
				return;

			controlling = true;
			try {
				await runInit(action);
				// Give procd a moment so a crash right after start is visible.
				await new Promise((resolve) => window.setTimeout(resolve, 1500));
				await refresh();
			}
			catch (e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			}
			finally {
				controlling = false;
			}
		});

		const clear = ui.createHandlerFn(this, async () => {
			try {
				await runInit('clear_log');
				logRequest = null;
				await syncLog();
			}
			catch (e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			}
		});

		const bootBox = E('input', { 'type': 'checkbox' });
		bootBox.disabled = true;
		bootBox.addEventListener('change', async () => {
			const want = bootBox.checked;
			bootBox.disabled = true;

			try {
				await runInit(want ? 'enable' : 'disable');
			}
			catch (e) {
				bootBox.checked = !want;
				ui.addNotification(null, E('p', e.message), 'danger');
			}
			finally {
				bootBox.disabled = false;
			}
		});

		const row = (title, content) => E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, title),
			E('div', { 'class': 'cbi-value-field' }, content)
		]);

		const portsInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'aria-label': _('Intercepted ports'),
			'disabled': 'disabled'
		});
		const portsApply = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-apply',
			'disabled': 'disabled',
			'click': ui.createHandlerFn(this, async () => {
				portsInput.disabled = true;
				const res = await applyPorts(portsInput.value).catch(error => ({ message: error.message }));
				portsInput.disabled = false;
				if (!res?.ok) {
					ui.addNotification(null, E('p', [ res?.message ? _(res.message) : _('Unable to apply port bypass.'), res?.detail ]
						.filter(Boolean).join('\n')), 'danger');
					return;
				}
				portsInput.value = res.ports;
				ui.addNotification(null, E('p', res.deferred
					? _('Saved. Takes effect the next time MimoGate starts.')
					: _('Port bypass applied.')), 'info');
				await syncLog();
			})
		}, _('Apply'));

		const aclMode = E('select', { 'class': 'cbi-input-select', 'disabled': 'disabled' }, [
			E('option', { 'value': 'all' }, _('All LAN devices')),
			E('option', { 'value': 'bypass' }, _('Bypass listed devices')),
			E('option', { 'value': 'proxy' }, _('Proxy listed devices only'))
		]);
		const aclPicker = E('select', { 'class': 'cbi-input-select', 'disabled': 'disabled' }, [
			E('option', { 'value': '' }, _('-- Add online device (MAC / IP) --'))
		]);
		const aclInput = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 2,
			'placeholder': 'aa:bb:cc:dd:ee:ff, 192.168.1.50',
			'style': 'width:100%; font-family:monospace; margin-top:.5em',
			'disabled': 'disabled'
		});
		const syncAclState = (enabled) => {
			const listEnabled = enabled && aclMode.value !== 'all';
			aclMode.disabled = !enabled;
			aclSave.disabled = !enabled;
			aclInput.disabled = !listEnabled;
			aclPicker.disabled = !listEnabled || aclPicker.options.length <= 1;
		};
		aclMode.addEventListener('change', () => syncAclState(true));
		aclPicker.addEventListener('change', () => {
			const val = aclPicker.value;
			aclPicker.value = '';
			if (!val)
				return;
			const cur = aclInput.value.split(/[\s,]+/).filter(Boolean);
			if (!cur.some(x => x.toLowerCase() === val.toLowerCase()))
				cur.push(val);
			aclInput.value = cur.join(', ');
		});
		const aclSave = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-save',
			'disabled': 'disabled',
			'click': ui.createHandlerFn(this, async () => {
				syncAclState(false);
				const res = await saveAcl(aclMode.value, aclInput.value).catch(error => ({ message: error.message }));
				syncAclState(true);
				if (!res?.ok) {
					ui.addNotification(null, E('p', [ res?.message ? _(res.message) : _('Unable to save access control settings.'), res?.detail ]
						.filter(Boolean).join('\n')), 'danger');
					return;
				}
				aclMode.value = res.mode;
				aclInput.value = res.entries;
				syncAclState(true);
				ui.addNotification(null, E('p', _('Saved. Takes effect the next time MimoGate starts.')), 'info');
				await syncLog();
			})
		}, _('Save'));

		const updateCnBtn = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, async () => {
				updateCnBtn.disabled = true;
				try {
					const res = await updateCn();
					if (!res?.ok)
						throw new Error([ res?.message ? _(res.message) : _('Unable to update mainland China IP list.'), res?.detail ].filter(Boolean).join('\n'));
					ui.addNotification(null, E('p', res.unchanged
						? _('Mainland China IP list is already up to date.')
						: _('Mainland China IP list updated. Restart MimoGate to apply it.')), 'info');
					await refresh();
				}
				catch (e) {
					ui.addNotification(null, E('p', e.message), 'danger');
				}
				finally {
					updateCnBtn.disabled = false;
				}
			})
		}, _('Update list'));

		window.setTimeout(() => {
			L.resolveDefault(getVersion(), null).then(result =>
				dom.content(versionEl, result?.ok ? result.version.split('\n')[0] || _('Not found') : _('Unknown')));
			L.resolveDefault(getBootStatus(), null).then(result => {
				if (result?.ok) {
					bootBox.checked = result.enabled;
					bootBox.disabled = false;
				}
			});
			L.resolveDefault(readPorts(), null).then(result => {
				if (result?.ok) {
					portsInput.value = result.ports;
				}
				else {
					ui.addNotification(null, E('p', result?.message ? _(result.message) : _('Unable to read the port list.')), 'danger');
				}
				if (result != null)
					portsInput.disabled = portsApply.disabled = false;
			});
			Promise.all([
				L.resolveDefault(readAcl(), null),
				L.resolveDefault(getHostHints(), {})
			]).then(([ aclRes, hosts ]) => {
				const entries = Object.entries(hosts || {}).sort((a, b) =>
					String(a[1]?.name || a[0]).localeCompare(String(b[1]?.name || b[0])));
				for (const [ mac, info ] of entries) {
					const label = info?.name ? info.name + ' — ' : '';
					if (mac)
						aclPicker.appendChild(E('option', { 'value': mac.toLowerCase() }, '%s%s (MAC)'.format(label, mac.toLowerCase())));
					for (const ip of (info?.ipaddrs || []))
						aclPicker.appendChild(E('option', { 'value': ip }, '%s%s'.format(label, ip)));
					for (const ip6 of (info?.ip6addrs || []))
						if (!/^fe80:/i.test(ip6))
							aclPicker.appendChild(E('option', { 'value': ip6 }, '%s%s'.format(label, ip6)));
				}
				if (aclRes?.ok) {
					aclMode.value = aclRes.mode;
					aclInput.value = aclRes.entries;
				}
				else if (aclRes != null) {
					ui.addNotification(null, E('p', aclRes?.message ? _(aclRes.message) : _('Unable to read access control settings.')), 'danger');
				}
				if (aclRes != null)
					syncAclState(true);
			});
			refresh();
		}, 0);

		poll.add(() => document.hidden ? syncStatus() : refresh(), POLL_INTERVAL);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', 'MimoGate'),
			E('div', { 'class': 'cbi-section' }, [
				row(_('Service'), [ stateEl, pidEl ]),
				row(_('Mihomo version'), versionEl),
				row(_('Start on boot'), bootBox),
				row(_('Firewall port bypass'), [
					E('div', { 'style': 'display:flex; gap:.5em; flex-wrap:wrap' }, [ portsInput, portsApply ]),
					E('div', { 'class': 'cbi-value-description' },
						_('TCP and UDP destination ports outside this list bypass Mihomo. Separate ports with commas (,).'))
				]),
				row(_('Access control'), [
					E('div', { 'style': 'display:flex; gap:.5em; flex-wrap:wrap' }, [ aclMode, aclPicker, aclSave ]),
					aclInput,
					E('div', { 'class': 'cbi-value-description' },
						_('Control which LAN devices use Mihomo by MAC, IPv4, IPv6, or CIDR. Changes take effect the next time MimoGate starts.'))
				]),
				row(_('Mainland China IP'), [
					E('div', { 'style': 'display:flex; align-items:center; gap:.75em; flex-wrap:wrap' }, [ cnStateEl, updateCnBtn ]),
					E('div', { 'class': 'cbi-value-description' },
						_('Updates are saved to cache and take effect the next time MimoGate starts.'))
				]),
				row(_('Control'), E('div', { 'style': 'display:flex; gap:.5em; flex-wrap:wrap' }, [
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-positive', 'click': control('start') }, _('Start')),
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative', 'click': control('stop') }, _('Stop')),
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-action', 'click': control('restart') }, _('Restart'))
				]))
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'display:flex; align-items:center; justify-content:space-between; gap:.5em; margin-bottom:.5em' }, [
					E('h3', { 'style': 'margin:0' }, _('Log')),
					E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-negative', 'click': clear }, _('Clear log'))
				]),
				logErrorEl,
				logEl
			])
		]);
	}
});
