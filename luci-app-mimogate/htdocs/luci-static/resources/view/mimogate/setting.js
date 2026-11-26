// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require dom';
'require form';
'require poll';
'require rpc';
'require ui';
'require view';
'require tools.firewall as fwtool';

const POLL_INTERVAL = 5;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

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
	load() {
		return Promise.all([
			L.resolveDefault(getStatus(), null),
			L.resolveDefault(getVersion(), null),
			L.resolveDefault(getBootStatus(), null),
			L.resolveDefault(readPorts(), null),
			L.resolveDefault(readSettings(), null),
			L.resolveDefault(readAcl(), null),
			L.resolveDefault(getHostHints(), {})
		]);
	},

	render([ statusRes, verRes, bootRes, portsRes, setRes, aclRes, hosts ]) {
		const barStateEl = E('div', { 'class': 'v' }, '—');
		const barPanelEl = E('div', { 'class': 'v' }, '—');
		const barCnEl = E('div', { 'class': 'v' }, '—');
		const barVerEl = E('div', { 'class': 'v' }, verRes?.ok ? shortVersion(verRes.version) : _('Unknown'));
		const cnStateEl = E('span', {}, '—');

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

		let loadOk = true;
		if (!bootRes?.ok) {
			loadOk = false;
			ui.addNotification(null, E('p', rpcError(bootRes, _('Unable to read service boot status.'))), 'danger');
		}
		if (!portsRes?.ok) {
			loadOk = false;
			ui.addNotification(null, E('p', rpcError(portsRes, _('Unable to read the port list.'))), 'danger');
		}
		if (!setRes?.ok) {
			loadOk = false;
			ui.addNotification(null, E('p', rpcError(setRes, _('Unable to read settings.'))), 'danger');
		}
		if (!aclRes?.ok) {
			loadOk = false;
			ui.addNotification(null, E('p', rpcError(aclRes, _('Unable to read access control settings.'))), 'danger');
		}

		const aclEntries = (aclRes?.ok ? aclRes.entries : '').split(/[\s,]+/).filter(Boolean);
		const data = {
			settings: {
				enabled: bootRes?.ok && bootRes.enabled ? '1' : '0',
				ports: portsRes?.ok ? portsRes.ports : '',
				panel_enabled: !setRes?.ok || setRes.panel_enabled ? '1' : '0',
				panel_port: setRes?.ok ? setRes.panel_port : '9090',
				panel_secret: setRes?.ok ? setRes.panel_secret : '666V888c',
				ipv6_support: !setRes?.ok || setRes.ipv6_support ? '1' : '0',
				quic_reject: !setRes?.ok || setRes.quic_reject ? '1' : '0',
				acl_mode: aclRes?.ok ? aclRes.mode : 'all',
				acl_mac: aclEntries.filter(x => MAC_RE.test(x)),
				acl_ipv4: aclEntries.filter(x => !MAC_RE.test(x) && !x.includes(':')),
				acl_ipv6: aclEntries.filter(x => !MAC_RE.test(x) && x.includes(':'))
			}
		};

		renderStatus(statusRes?.ok ? statusRes : null);
		renderPanelBar(setRes?.ok ? !!setRes.panel_enabled : false);

		const updateCnBtn = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, async () => {
				updateCnBtn.disabled = true;
				try {
					const res = await updateCn();
					if (!res?.ok)
						throw new Error(rpcError(res, _('Unable to update mainland China IP list.')));
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

		const m = new form.JSONMap(data, 'MimoGate', 'minimal LuCI app for Mihomo');
		m.readonly = !loadOk;

		const s = m.section(form.NamedSection, 'settings', 'settings');
		s.tab('general', _('General'));
		s.tab('access', _('Access control'));

		let o;
		o = s.taboption('general', form.Flag, 'enabled', _('Proxy switch'),
			_('Enable MimoGate and start on boot.'));
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'ports', _('Routing ports'),
			_('Specify ports to proxy, separated by commas.'));

		o = s.taboption('general', form.Flag, 'panel_enabled', _('Enable panel'),
			_('Dashboard assets are downloaded automatically on first use.'));
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'panel_port', _('Panel port'));
		o.datatype = 'port';
		o.placeholder = '9090';
		o.rmempty = false;
		o.depends('panel_enabled', '1');

		o = s.taboption('general', form.Value, 'panel_secret', _('Panel secret'),
			_('Used to authenticate panel API access. It is recommended to set a custom secret instead of the default.'));
		o.password = true;
		o.depends('panel_enabled', '1');

		o = s.taboption('general', form.Button, '_open_panel', _('Open Panel'));
		o.inputstyle = 'action';
		o.inputtitle = _('Open Zashboard');
		o.depends('panel_enabled', '1');
		o.onclick = function(ev, section_id) {
			const port = (this.section.formvalue(section_id, 'panel_port') || '9090').trim();
			window.open('http://' + location.hostname + ':' + port + '/ui/');
		};

		o = s.taboption('general', form.Flag, 'ipv6_support', _('IPv6 support'),
			_('Flexibly handle IPv6 traffic together with your configuration.'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'quic_reject', _('Reject QUIC'),
			_('Rejects proxied QUIC (UDP 80/443) so applications fall back to TCP immediately. Direct traffic is unaffected.'));
		o.rmempty = false;

		o = s.taboption('general', form.DummyValue, '_update_cn', _('Mainland China IP'),
			_('Updates are saved to cache and take effect the next time MimoGate starts.'));
		o.cfgvalue = () => E('div', { 'style': 'display:flex; align-items:center; gap:.75em; flex-wrap:wrap' }, [ updateCnBtn, cnStateEl ]);

		o = s.taboption('access', form.ListValue, 'acl_mode', _('Access control mode'),
			_('Control which LAN devices use Mihomo by MAC, IPv4, IPv6, or CIDR. Changes take effect the next time MimoGate starts.'));
		o.value('all', _('All LAN devices'));
		o.value('bypass', _('Bypass listed devices'));
		o.value('proxy', _('Proxy listed devices only'));
		o.rmempty = false;

		o = fwtool.addMACOption(s, 'access', 'acl_mac', _('MAC addresses'), null, hosts || {});
		o.modalonly = false;
		o.depends('acl_mode', /^(bypass|proxy)$/);

		o = fwtool.addIPOption(s, 'access', 'acl_ipv4', _('IPv4 addresses'), null, 'ipv4', hosts || {}, true);
		o.datatype = 'or(ip4addr, cidr4)';
		o.modalonly = false;
		o.depends('acl_mode', /^(bypass|proxy)$/);

		o = fwtool.addIPOption(s, 'access', 'acl_ipv6', _('IPv6 addresses'), null, 'ipv6', hosts || {}, true);
		o.datatype = 'or(ip6addr, cidr6)';
		o.modalonly = false;
		o.depends({ 'acl_mode': /^(bypass|proxy)$/, 'ipv6_support': '1' });

		let busy = false;
		const saveAll = async (apply) => {
			if (m.readonly || busy)
				return;

			busy = true;
			if (apply) {
				ui.showModal(_('Applying configuration changes'), [
					E('p', { 'class': 'spinning' }, _('Waiting for changes to be applied...'))
				]);
			}
			try {
				await m.save();
				const d = data.settings;

				const portRes = await applyPorts(d.ports || '');
				if (!portRes?.ok)
					throw new Error(rpcError(portRes, _('Unable to apply port bypass.')));
				d.ports = portRes.ports;

				const setRes = await saveSettings(
					d.panel_enabled === '1',
					d.panel_port || '9090',
					d.panel_secret || '',
					d.quic_reject === '1',
					d.ipv6_support === '1'
				);
				if (!setRes?.ok)
					throw new Error(rpcError(setRes, _('Unable to save settings.')));
				d.panel_enabled = setRes.panel_enabled ? '1' : '0';
				d.panel_port = setRes.panel_port;
				d.panel_secret = setRes.panel_secret;
				d.quic_reject = setRes.quic_reject ? '1' : '0';
				d.ipv6_support = setRes.ipv6_support ? '1' : '0';
				renderPanelBar(!!setRes.panel_enabled);

				const entriesStr = [
					...L.toArray(d.acl_mac),
					...L.toArray(d.acl_ipv4),
					...L.toArray(d.acl_ipv6)
				].join(', ');
				const aclRes = await saveAcl(d.acl_mode || 'all', entriesStr);
				if (!aclRes?.ok)
					throw new Error(rpcError(aclRes, _('Unable to save access control settings.')));
				d.acl_mode = aclRes.mode;
				const savedEntries = aclRes.entries.split(/[\s,]+/).filter(Boolean);
				d.acl_mac = savedEntries.filter(x => MAC_RE.test(x));
				d.acl_ipv4 = savedEntries.filter(x => !MAC_RE.test(x) && !x.includes(':'));
				d.acl_ipv6 = savedEntries.filter(x => !MAC_RE.test(x) && x.includes(':'));

				const wantEnabled = d.enabled === '1';
				await runInit(wantEnabled ? 'enable' : 'disable');

				if (!apply) {
					ui.addNotification(null, E('p', _('Saved. Restart MimoGate to apply changes.')), 'info');
					return;
				}

				await runInit(wantEnabled ? 'restart' : 'stop');
				await new Promise((resolve) => window.setTimeout(resolve, wantEnabled ? 1200 : 600));
				await syncStatus();
				ui.showModal(_('Applying configuration changes'), [
					E('p', {}, _('Configuration changes have been applied.'))
				]);
				await new Promise((resolve) => window.setTimeout(resolve, 1000));
			}
			catch (e) {
				ui.addNotification(null, E('p', e.message), 'danger');
			}
			finally {
				if (apply)
					ui.hideModal();
				busy = false;
			}
		};

		this.handleSave = () => saveAll(false);
		this.handleSaveApply = () => saveAll(true);
		this.handleReset = () => m.reset();

		poll.add(() => syncStatus(), POLL_INTERVAL);

		return m.render().then((mapEl) => {
			const firstSection = mapEl.querySelector('.cbi-section');
			const statusSection = E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					E('div', { 'class': 'mimogate-status-bar' }, [
						statusItem(_('Running status'), barStateEl),
						statusItem(_('Panel'), barPanelEl),
						statusItem(_('Mainland China IP'), barCnEl),
						statusItem(_('Mihomo version'), barVerEl)
					])
				])
			]);
			mapEl.insertBefore(E('style', [ STATUS_CSS ]), mapEl.firstChild);
			mapEl.insertBefore(statusSection, firstSection);
			return mapEl;
		});
	}
});
