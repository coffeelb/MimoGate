// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require dom';
'require form';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';
'require tools.firewall as fwtool';

const POLL_INTERVAL = 5;

const getStatus = rpc.declare({ object: 'mimogate', method: 'status', reject: true });
const getVersion = rpc.declare({ object: 'mimogate', method: 'version', reject: true });
const getHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const getNetworkDevices = rpc.declare({ object: 'luci-rpc', method: 'getNetworkDevices', expect: { '': {} } });
const dumpInterfaces = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
const updateCn = rpc.declare({ object: 'mimogate', method: 'update_cn', reject: true });
const serviceAction = rpc.declare({
	object: 'mimogate', method: 'service_action', params: [ 'action' ], reject: true
});

const STATUS_CSS = `
.mimogate-state-ok { color: #15803d; font-weight: 700; }
.mimogate-state-stop { color: #b91c1c; font-weight: 700; }
.mimogate-muted { color: #6b7280; }
html[data-darkmode="true"] .mimogate-state-ok { color: #4ade80; }
html[data-darkmode="true"] .mimogate-state-stop { color: #f87171; }
html[data-darkmode="true"] .mimogate-muted { color: #9ca3af; }
`;

function formatMtime(epoch) {
	const d = new Date(epoch * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return '%d-%s-%s %s:%s'.format(d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()));
}

function shortVersion(raw) {
	const line = (raw || '').split('\n')[0].trim();
	const m = line.match(/v\d+\.\d+\.\d+\S*/i);
	return m ? m[0] : line;
}

function rpcError(res, fallback) {
	return [ res?.message ? _(res.message) : fallback, res?.detail ].filter(Boolean).join('\n');
}

function filterRouterHosts(hosts, devices) {
	const local = new Set();
	for (const d of Object.values(devices || {})) {
		if (d?.mac) local.add(d.mac.toUpperCase());
		for (const a of [ ...(d?.ipaddrs || []), ...(d?.ip6addrs || []) ])
			if (a?.address) local.add(a.address.toLowerCase());
	}
	return Object.fromEntries(Object.entries(hosts || {}).flatMap(([ mac, info ]) => {
		if (local.has(mac.toUpperCase())) return [];
		const ipaddrs = (info?.ipaddrs || []).filter(ip => !local.has(ip.toLowerCase()));
		const ip6addrs = (info?.ip6addrs || []).filter(ip => !local.has(ip.toLowerCase()));
		if ((info?.ipaddrs?.length || info?.ip6addrs?.length) && !ipaddrs.length && !ip6addrs.length) return [];
		return [[ mac, Object.assign({}, info, { ipaddrs, ip6addrs }) ]];
	}));
}

return view.extend({
	handleSaveApply(ev, mode) {
		return this.handleSave(ev).then(() => {
			if (this._onApplied)
				document.removeEventListener('uci-applied', this._onApplied);
			this._onApplied = async () => {
				this._onApplied = null;
				try {
					uci.unload('mimogate');
					await uci.load('mimogate');
					if (uci.get('mimogate', 'config', 'enabled') === '1') {
						const st = await L.resolveDefault(getStatus(), null);
						if (!st?.running) {
							for (const action of [ 'start', 'enable' ]) {
								const res = await serviceAction(action);
								if (!res?.ok)
									throw new Error(rpcError(res, _('Service action failed.')));
							}
						}
					}
				}
				catch (e) {
					ui.addNotification(null, E('p', e.message), 'danger');
				}
				finally {
					this._syncStatus?.();
				}
			};
			document.addEventListener('uci-applied', this._onApplied, { once: true });
			ui.changes.apply(mode == '0');
		});
	},

	load() {
		return Promise.all([
			L.resolveDefault(getStatus(), null),
			L.resolveDefault(getVersion(), null),
			uci.load('mimogate'),
			L.resolveDefault(getHostHints(), {}),
			L.resolveDefault(getNetworkDevices(), {}),
			L.resolveDefault(dumpInterfaces(), [])
		]);
	},

	render([ statusRes, verRes, , rawHosts, devices, ifaces ]) {
		const hosts = filterRouterHosts(rawHosts, devices);
		const ver = verRes?.ok ? shortVersion(verRes.version) : '';
		const baseDescr = ver ? 'minimal LuCI app for Mihomo (%s)'.format(ver) : 'minimal LuCI app for Mihomo';
		const stateEl = E('span', { 'class': 'mimogate-muted' }, '—');
		const descrEl = E('span', { 'style': 'display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap' }, [
			E('span', {}, baseDescr),
			stateEl
		]);
		const cnStateEl = E('span', { 'class': 'mimogate-muted' }, '—');

		const renderStatus = (st) => {
			if (!st?.ok) {
				stateEl.className = 'mimogate-muted';
				dom.content(stateEl, _('Unknown'));
				dom.content(cnStateEl, '—');
				return;
			}
			if (st.running) {
				stateEl.className = 'mimogate-state-ok';
				dom.content(stateEl, st.pid ? '%s (PID %s)'.format(_('Running'), st.pid) : _('Running'));
			}
			else {
				stateEl.className = 'mimogate-state-stop';
				dom.content(stateEl, _('Stopped'));
			}
			dom.content(cnStateEl, st.cn_cached && st.cn_mtime
				? '%s · %s'.format(_('Cached'), formatMtime(st.cn_mtime))
				: _('Bundled snapshot'));
		};

		const syncStatus = () => L.resolveDefault(getStatus(), null).then(st => renderStatus(st));
		this._syncStatus = syncStatus;

		renderStatus(statusRes);

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

		const m = new form.Map('mimogate', 'MimoGate', descrEl);
		const s = m.section(form.NamedSection, 'config', 'mimogate');
		s.tab('general', _('Settings'));
		s.tab('access', _('Access control'));

		let o;
		o = s.taboption('general', form.Flag, 'enabled', _('Proxy switch'),
			_('Enable MimoGate and start on boot.'));
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'panel_enabled', _('Enable panel'),
			_('Dashboard assets are downloaded automatically on first use.'));
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'panel_port', _('Panel port'));
		o.datatype = 'port';
		o.placeholder = '9090';
		o.rmempty = false;
		o.retain = true;
		o.depends('panel_enabled', '1');

		o = s.taboption('general', form.Value, 'panel_secret', _('Panel secret'),
			_('Used to authenticate panel API access. It is recommended to set a custom secret instead of the default.'));
		o.password = true;
		o.retain = true;
		o.depends('panel_enabled', '1');

		o = s.taboption('general', form.Button, '_open_panel', _('Open Panel'));
		o.inputstyle = 'action';
		o.inputtitle = _('Open Zashboard');
		o.depends('panel_enabled', '1');
		o.onclick = function(ev, section_id) {
			const port = (this.section.formvalue(section_id, 'panel_port') || '9090').trim();
			window.open('http://' + location.hostname + ':' + port + '/ui/');
		};

		o = s.taboption('general', form.Value, 'ports', _('Routing ports'),
			_('Specify ports to proxy, separated by commas.'));
		o.rmempty = false;
		o.validate = (section_id, value) => {
			if (!section_id)
				return true;
			const parts = String(value || '').split(',').map(p => p.trim());
			if (!parts.length)
				return _('Enter ports from 1 to 65535 separated by ASCII commas (,).');
			for (const p of parts) {
				if (!/^\d+$/.test(p) || +p < 1 || +p > 65535)
					return _('Enter ports from 1 to 65535 separated by ASCII commas (,).');
			}
			return true;
		};
		o.write = (section_id, value) => {
			const ports = [ ...new Set(String(value || '').split(',').map(p => String(+p.trim()))) ];
			uci.set('mimogate', section_id, 'ports', ports.join(', '));
		};

		o = s.taboption('general', form.Flag, 'ipv6_support', _('IPv6 support'),
			_('Flexibly handle IPv6 traffic together with your configuration.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'quic_reject', _('Reject QUIC'),
			_('Rejects proxied QUIC (UDP 80/443) so applications fall back to TCP immediately. Direct traffic is unaffected.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', form.DummyValue, '_update_cn', _('Mainland China IP'),
			_('Updates are saved to cache and take effect the next time MimoGate starts.'));
		o.cfgvalue = () => E('div', { 'style': 'display:flex; align-items:center; gap:.75em; flex-wrap:wrap' }, [ updateCnBtn, cnStateEl ]);

		o = s.taboption('access', form.MultiValue, 'listen_interfaces', _('Listen interfaces'),
			_('Select LAN/VLAN interfaces to proxy.'));
		const seenDevs = new Set();
		for (const iface of ifaces || []) {
			const dev = iface?.l3_device || iface?.device;
			const name = iface?.interface || '';
			if (!dev || seenDevs.has(dev) || dev === 'lo' || dev === 'mimogate0' ||
			    name === 'loopback' || /^wan/i.test(name) ||
			    (iface?.route || []).some(r => r?.mask === 0))
				continue;
			seenDevs.add(dev);
			const label = name ? '%s (%s)'.format(dev, name) : dev;
			if (name === 'lan')
				o.default = dev;
			o.value(dev, label);
		}
		o.optional = false;
		o.rmempty = false;

		o = s.taboption('access', form.ListValue, 'acl_mode', _('Access control mode'),
			_('Control which LAN devices use Mihomo by MAC, IPv4, IPv6, or CIDR.'));
		o.value('all', _('All LAN devices'));
		o.value('bypass', _('Bypass listed devices'));
		o.value('proxy', _('Proxy listed devices only'));
		o.default = 'all';
		o.rmempty = false;

		o = fwtool.addMACOption(s, 'access', 'acl_mac', _('MAC addresses'), null, hosts || {});
		o.modalonly = false;
		o.retain = true;
		o.depends('acl_mode', /^(bypass|proxy)$/);

		o = fwtool.addIPOption(s, 'access', 'acl_ipv4', _('IPv4 addresses'), null, 'ipv4', hosts || {}, true);
		o.datatype = 'or(ip4addr, cidr4)';
		o.modalonly = false;
		o.retain = true;
		o.depends('acl_mode', /^(bypass|proxy)$/);

		o = fwtool.addIPOption(s, 'access', 'acl_ipv6', _('IPv6 addresses'), null, 'ipv6', hosts || {}, true);
		o.datatype = 'or(ip6addr, cidr6)';
		o.modalonly = false;
		o.retain = true;
		o.depends({ 'acl_mode': /^(bypass|proxy)$/, 'ipv6_support': '1' });

		poll.add(() => syncStatus(), POLL_INTERVAL);

		const origRenderContents = m.renderContents.bind(m);
		m.renderContents = () => origRenderContents().then((mapEl) => {
			mapEl.insertBefore(E('style', [ STATUS_CSS ]), mapEl.firstChild);
			return mapEl;
		});

		return m.render();
	}
});
