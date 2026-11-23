// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: MIT

'use strict';
'require dom';
'require poll';
'require rpc';
'require ui';
'require view';

const POLL_INTERVAL = 5;

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
const readSettings = rpc.declare({ object: 'mimogate', method: 'read_settings', reject: true });
const saveSettings = rpc.declare({
	object: 'mimogate',
	method: 'save_settings',
	params: [ 'panel_enabled', 'panel_port', 'panel_secret', 'quic_reject', 'ipv6_support' ],
	reject: true
});
const getHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const updateCn = rpc.declare({ object: 'mimogate', method: 'update_cn', reject: true });
const serviceAction = rpc.declare({
	object: 'mimogate',
	method: 'service_action',
	params: [ 'action' ],
	reject: true
});

const STATUS_CSS = `
:root {
	--mimogate-text: #000000;
	--mimogate-muted: #6b7280;
}
html[data-darkmode="true"] {
	--mimogate-text: #e0e0e0;
	--mimogate-muted: #9ca3af;
}
.mimogate-status-bar {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 40px;
	padding: 10px 0;
}
.mimogate-status-bar .status-item .k {
	font-size: 12px;
	color: var(--mimogate-muted);
}
.mimogate-status-bar .status-item .v {
	font-size: 14px;
	font-weight: bold;
	color: var(--mimogate-text);
	margin-top: 2px;
}
.mimogate-dot {
	display: inline-block;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	margin-right: 6px;
	vertical-align: baseline;
}
.mimogate-dot.success { background: #16a34a; }
.mimogate-dot.danger { background: #dc2626; }
.mimogate-dot.muted { background: #9ca3af; }
.mimogate-text.success { color: #16a34a; }
.mimogate-text.danger { color: #dc2626; }
.mimogate-text.muted { color: var(--mimogate-muted); }
`;

function formatMtime(epoch) {
	const d = new Date(epoch * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return '%d-%s-%s %s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}

function formatShortMtime(epoch) {
	const d = new Date(epoch * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return '%s-%s %s:%s'.format(pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}

function shortVersion(raw) {
	const line = (raw || '').split('\n')[0].trim();
	if (!line)
		return _('Not found');
	const m = line.match(/v\d+\.\d+\.\d+\S*/i);
	return m ? m[0] : line;
}

function rpcError(res, fallback) {
	return [ res?.message ? _(res.message) : fallback, res?.detail ].filter(Boolean).join('\n');
}

async function runInit(action) {
	const res = await serviceAction(action);

	if (!res?.ok)
		throw new Error(rpcError(res, _('Service action failed.')));
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	render() {
		const barStateEl = E('div', { 'class': 'v' }, '—');
		const barPanelEl = E('div', { 'class': 'v' }, '—');
		const barCnEl = E('div', { 'class': 'v' }, '—');
		const barVerEl = E('div', { 'class': 'v' }, '—');
		const cnStateEl = E('span', {}, '—');

		const saved = {
			enabled: false,
			ports: '',
			aclMode: 'all',
			aclEntries: '',
			panelEnabled: true,
			panelPort: '9090',
			panelSecret: '666V888c',
			quicReject: true,
			ipv6Support: true
		};

		const statusItem = (label, valEl) => E('div', { 'class': 'status-item' }, [
			E('div', { 'class': 'k' }, label),
			valEl
		]);

		const renderPanelBar = (enabled) => {
			dom.content(barPanelEl, E('span', {
				'class': 'mimogate-text ' + (enabled ? 'success' : 'muted')
			}, enabled ? _('Enabled') : _('Disabled')));
		};

		const renderStatus = (st) => {
			if (st == null) {
				dom.content(barStateEl, [
					E('span', { 'class': 'mimogate-dot muted' }),
					E('span', { 'class': 'mimogate-text muted' }, _('Unknown'))
				]);
				dom.content(barCnEl, '—');
				dom.content(cnStateEl, '—');
				return;
			}
			const cls = st.running ? 'success' : 'danger';
			const text = st.running ? _('Running') : _('Stopped');
			dom.content(barStateEl, [
				E('span', { 'class': 'mimogate-dot ' + cls }),
				E('span', { 'class': 'mimogate-text ' + cls }, text)
			]);
			dom.content(barCnEl, st.cn_cached && st.cn_mtime
				? '%s · %s'.format(_('Cached'), formatShortMtime(st.cn_mtime))
				: _('Bundled snapshot'));
			dom.content(cnStateEl, st.cn_cached && st.cn_mtime
				? '%s · %s'.format(_('Cached'), formatMtime(st.cn_mtime))
				: _('Bundled snapshot'));
		};

		const syncStatus = () =>
			L.resolveDefault(getStatus(), null).then(st => renderStatus(st?.ok ? st : null));

		const row = (title, content) => E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, title),
			E('div', { 'class': 'cbi-value-field' }, content)
		]);

		const enableBox = E('input', { 'type': 'checkbox', 'disabled': 'disabled' });
		const portsInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'aria-label': _('Intercepted ports'),
			'disabled': 'disabled'
		});
		const panelBox = E('input', { 'type': 'checkbox', 'checked': 'checked', 'disabled': 'disabled' });
		const panelPortInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'value': '9090',
			'disabled': 'disabled'
		});
		const panelSecretInput = E('input', {
			'type': 'password',
			'class': 'cbi-input-password',
			'value': '666V888c',
			'disabled': 'disabled'
		});
		const panelSecretToggle = E('button', {
			'type': 'button',
			'class': 'cbi-button cbi-button-neutral',
			'title': _('Reveal/hide password'),
			'aria-label': _('Reveal/hide password'),
			'disabled': 'disabled',
			'click': () => {
				panelSecretInput.type = panelSecretInput.type === 'password' ? 'text' : 'password';
			}
		}, '*');
		const openPanelBtn = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'disabled': 'disabled',
			'click': () => {
				const port = (panelPortInput.value || '9090').trim();
				window.open('http://' + location.hostname + ':' + port + '/ui/');
			}
		}, _('Open Zashboard'));
		const quicBox = E('input', { 'type': 'checkbox', 'checked': 'checked', 'disabled': 'disabled' });
		const ipv6Box = E('input', { 'type': 'checkbox', 'checked': 'checked', 'disabled': 'disabled' });

		const panelPortRow = row(_('Panel port'), panelPortInput);
		const panelSecretRow = row(_('Panel secret'), [
			E('div', { 'class': 'control-group' }, [ panelSecretInput, panelSecretToggle ]),
			E('div', { 'class': 'cbi-value-description' },
				_('Used to authenticate panel API access. It is recommended to set a custom secret instead of the default.'))
		]);
		const openPanelRow = row(_('Open Panel'), openPanelBtn);

		const updateCnBtn = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, async () => {
				updateCnBtn.disabled = true;
				try {
					const res = await updateCn();
					if (!res?.ok)
						throw new Error(rpcError(res, _('Unable to update mainland China IP list.')));
					ui.addNotification(null, E('p', res.unchanged
						? _('Mainland China IP list is already up to date.')
						: _('Mainland China IP list updated. Restart MimoGate to apply it.')), 'info');
					await syncStatus();
				}
				catch (e) {
					ui.addNotification(null, E('p', e.message), 'danger');
				}
				finally {
					updateCnBtn.disabled = false;
				}
			})
		}, _('Update list'));

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
			'rows': 4,
			'placeholder': 'aa:bb:cc:dd:ee:ff, 192.168.1.50',
			'style': 'width:100%; font-family:monospace',
			'disabled': 'disabled'
		});

		let ready = false;
		let busy = false;
		const syncFormState = () => {
			const active = ready && !busy;
			const panelOn = panelBox.checked;
			const listEnabled = active && aclMode.value !== 'all';
			enableBox.disabled = !active;
			portsInput.disabled = !active;
			panelBox.disabled = !active;
			panelPortInput.disabled = !active || !panelOn;
			panelSecretInput.disabled = !active || !panelOn;
			panelSecretToggle.disabled = !active || !panelOn;
			openPanelBtn.disabled = !active || !panelOn;
			panelPortRow.style.display = panelOn ? '' : 'none';
			panelSecretRow.style.display = panelOn ? '' : 'none';
			openPanelRow.style.display = panelOn ? '' : 'none';
			quicBox.disabled = !active;
			ipv6Box.disabled = !active;
			aclMode.disabled = !active;
			aclInput.disabled = !listEnabled;
			aclPicker.disabled = !listEnabled || aclPicker.options.length <= 1;
			btnSaveApply.disabled = !active;
			btnSave.disabled = !active;
			btnReset.disabled = !active;
		};

		panelBox.addEventListener('change', syncFormState);
		aclMode.addEventListener('change', syncFormState);
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

		const saveAll = (apply) => ui.createHandlerFn(this, async () => {
			if (!ready || busy)
				return;

			busy = true;
			syncFormState();
			try {
				const portRes = await applyPorts(portsInput.value);
				if (!portRes?.ok)
					throw new Error(rpcError(portRes, _('Unable to apply port bypass.')));
				portsInput.value = portRes.ports;
				saved.ports = portRes.ports;

				const setRes = await saveSettings(
					panelBox.checked,
					panelPortInput.value,
					panelSecretInput.value,
					quicBox.checked,
					ipv6Box.checked
				);
				if (!setRes?.ok)
					throw new Error(rpcError(setRes, _('Unable to save settings.')));
				saved.panelEnabled = !!setRes.panel_enabled;
				saved.panelPort = setRes.panel_port;
				saved.panelSecret = setRes.panel_secret;
				saved.quicReject = !!setRes.quic_reject;
				saved.ipv6Support = !!setRes.ipv6_support;
				panelBox.checked = saved.panelEnabled;
				panelPortInput.value = saved.panelPort;
				panelSecretInput.value = saved.panelSecret;
				quicBox.checked = saved.quicReject;
				ipv6Box.checked = saved.ipv6Support;
				renderPanelBar(saved.panelEnabled);

				const aclRes = await saveAcl(aclMode.value, aclInput.value);
				if (!aclRes?.ok)
					throw new Error(rpcError(aclRes, _('Unable to save access control settings.')));
				aclMode.value = aclRes.mode;
				aclInput.value = aclRes.entries;
				saved.aclMode = aclRes.mode;
				saved.aclEntries = aclRes.entries;

				const wantEnabled = enableBox.checked;
				await runInit(wantEnabled ? 'enable' : 'disable');
				saved.enabled = wantEnabled;

				if (!apply) {
					ui.addNotification(null, E('p', _('Saved. Restart MimoGate to apply changes.')), 'info');
					return;
				}

				await runInit(wantEnabled ? 'restart' : 'stop');
				await new Promise((resolve) => window.setTimeout(resolve, wantEnabled ? 1200 : 600));
				await syncStatus();
				ui.addNotification(null, E('p', wantEnabled
					? _('Saved and applied.')
					: _('Saved. Service stopped.')), 'info');
			}
			catch (e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			}
			finally {
				busy = false;
				syncFormState();
			}
		});

		const resetAll = () => {
			if (!ready || busy)
				return;
			enableBox.checked = saved.enabled;
			portsInput.value = saved.ports;
			panelBox.checked = saved.panelEnabled;
			panelPortInput.value = saved.panelPort;
			panelSecretInput.value = saved.panelSecret;
			quicBox.checked = saved.quicReject;
			ipv6Box.checked = saved.ipv6Support;
			aclMode.value = saved.aclMode;
			aclInput.value = saved.aclEntries;
			syncFormState();
		};

		const btnSaveApply = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-apply',
			'disabled': 'disabled',
			'click': saveAll(true)
		}, _('Save & Apply'));
		const btnSave = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-save',
			'disabled': 'disabled',
			'click': saveAll(false)
		}, _('Save'));
		const btnReset = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-reset',
			'disabled': 'disabled',
			'click': resetAll
		}, _('Reset'));

		const generalPane = E('div', { 'class': 'cbi-tabcontainer' }, [
			row(_('Proxy switch'), [
				enableBox,
				E('div', { 'class': 'cbi-value-description' },
					_('Enable MimoGate and start on boot. Uncheck and click Save & Apply to stop the service.'))
			]),
			row(_('Routing ports'), [
				portsInput,
				E('div', { 'class': 'cbi-value-description' },
					_('TCP and UDP destination ports outside this list bypass Mihomo. Separate ports with commas (,).'))
			]),
			row(_('Enable panel'), [
				panelBox,
				E('div', { 'class': 'cbi-value-description' },
					_('Enables the Mihomo API and Zashboard web UI. The dashboard is downloaded on first use.'))
			]),
			panelPortRow,
			panelSecretRow,
			openPanelRow,
			row(_('Reject QUIC'), [
				quicBox,
				E('div', { 'class': 'cbi-value-description' },
					_('Rejects proxied QUIC (UDP 80/443) so applications fall back to TCP immediately. Direct traffic is unaffected.'))
			]),
			row(_('IPv6 support'), [
				ipv6Box,
				E('div', { 'class': 'cbi-value-description' },
					_('Enable IPv6 handling in Mihomo and the firewall. When disabled, IPv6 traffic bypasses Mihomo.'))
			]),
			row(_('Mainland China IP'), [
				E('div', { 'style': 'display:flex; align-items:center; gap:.75em; flex-wrap:wrap' }, [ cnStateEl, updateCnBtn ]),
				E('div', { 'class': 'cbi-value-description' },
					_('Updates are saved to cache and take effect the next time MimoGate starts.'))
			])
		]);

		const accessPane = E('div', { 'class': 'cbi-tabcontainer', 'style': 'display:none' }, [
			row(_('Access control mode'), aclMode),
			row(_('Add online device'), aclPicker),
			row(_('Device list'), [
				aclInput,
				E('div', { 'class': 'cbi-value-description' },
					_('Control which LAN devices use Mihomo by MAC, IPv4, IPv6, or CIDR. Changes take effect the next time MimoGate starts.'))
			])
		]);

		const tabGeneral = E('li', { 'class': 'cbi-tab' }, E('a', {
			'href': '#general',
			'click': (ev) => {
				ev.preventDefault();
				switchTab('general');
			}
		}, _('General')));
		const tabAccess = E('li', { 'class': 'cbi-tab-disabled' }, E('a', {
			'href': '#access',
			'click': (ev) => {
				ev.preventDefault();
				switchTab('access');
			}
		}, _('Access control')));

		const switchTab = (name) => {
			tabGeneral.className = name === 'general' ? 'cbi-tab' : 'cbi-tab-disabled';
			tabAccess.className = name === 'access' ? 'cbi-tab' : 'cbi-tab-disabled';
			generalPane.style.display = name === 'general' ? '' : 'none';
			accessPane.style.display = name === 'access' ? '' : 'none';
		};

		window.setTimeout(() => {
			L.resolveDefault(getVersion(), null).then(result =>
				dom.content(barVerEl, result?.ok ? shortVersion(result.version) : _('Unknown')));
			Promise.all([
				L.resolveDefault(getBootStatus(), null),
				L.resolveDefault(readPorts(), null),
				L.resolveDefault(readSettings(), null),
				L.resolveDefault(readAcl(), null),
				L.resolveDefault(getHostHints(), {})
			]).then(([ bootRes, portsRes, setRes, aclRes, hosts ]) => {
				if (bootRes?.ok) {
					saved.enabled = !!bootRes.enabled;
					enableBox.checked = saved.enabled;
				}
				if (portsRes?.ok) {
					saved.ports = portsRes.ports;
					portsInput.value = saved.ports;
				}
				else if (portsRes != null) {
					ui.addNotification(null, E('p', rpcError(portsRes, _('Unable to read the port list.'))), 'danger');
				}
				if (setRes?.ok) {
					saved.panelEnabled = !!setRes.panel_enabled;
					saved.panelPort = setRes.panel_port;
					saved.panelSecret = setRes.panel_secret;
					saved.quicReject = !!setRes.quic_reject;
					saved.ipv6Support = !!setRes.ipv6_support;
					panelBox.checked = saved.panelEnabled;
					panelPortInput.value = saved.panelPort;
					panelSecretInput.value = saved.panelSecret;
					quicBox.checked = saved.quicReject;
					ipv6Box.checked = saved.ipv6Support;
					renderPanelBar(saved.panelEnabled);
				}
				else {
					renderPanelBar(saved.panelEnabled);
				}
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
					saved.aclMode = aclRes.mode;
					saved.aclEntries = aclRes.entries;
					aclMode.value = saved.aclMode;
					aclInput.value = saved.aclEntries;
				}
				else if (aclRes != null) {
					ui.addNotification(null, E('p', rpcError(aclRes, _('Unable to read access control settings.'))), 'danger');
				}
				ready = true;
				syncFormState();
			});
			syncStatus();
		}, 0);

		poll.add(() => syncStatus(), POLL_INTERVAL);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', [ STATUS_CSS ]),
			E('h2', 'MimoGate'),
			E('div', { 'class': 'cbi-map-descr' }, 'minimal LuCI app for Mihomo'),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'mimogate-status-bar' }, [
						statusItem(_('Running status'), barStateEl),
						statusItem(_('Panel'), barPanelEl),
						statusItem(_('Mainland China IP'), barCnEl),
						statusItem(_('Mihomo version'), barVerEl)
					])
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('ul', { 'class': 'cbi-tabmenu' }, [ tabGeneral, tabAccess ]),
				E('div', { 'class': 'cbi-section-node cbi-section-node-tabbed' }, [
					generalPane,
					accessPane
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				btnSaveApply,
				' ',
				btnSave,
				' ',
				btnReset
			])
		]);
	}
});
