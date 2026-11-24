'use strict';

import * as fs from 'fs';
import { connect } from 'ubus';

const bus = connect();
const core = '/usr/bin/mihomo';
const init = '/etc/init.d/mimogate';
const directory = '/etc/mimogate';
const config = directory + '/config.yaml';
const portsFile = directory + '/proxy-ports';
const aclFile = directory + '/access-control';
const settingsFile = directory + '/settings';
const cnCache = directory + '/cn.nft';
const defaultPortsFile = '/usr/share/mimogate/proxy-ports.default';
const template = '/usr/share/mimogate/config.default.yaml';
const maxSize = 48 * 1024;
let saving = false;

function failure(message, detail) {
	return { ok: false, message, detail };
}

// RPC requests arrive through the LuCI session ACL. Require the root login
// before exposing configuration secrets or invoking the core as root.
function rootOnly(handler) {
	return function(request) {
		const denied = failure('This operation requires an OpenWrt root administrator session.');
		const sid = request.args.ubus_rpc_session;

		if (type(sid) != 'string' || !match(sid, /^[0-9a-f]{32}$/))
			return denied;

		return bus?.defer('session', 'get', {
			ubus_rpc_session: sid,
			keys: [ 'username' ]
		}, (code, result) => {
			if (code != 0 || result?.values?.username != 'root')
				request.reply(denied);
			else
				handler(request.args, result => request.reply(result));
		}) ?? denied;
	};
}

function exec(command, params, done) {
	if (!bus.defer('file', 'exec', { command, params }, (code, result) => done(code == 0 ? result : null)))
		done(null);
}

function validateConfig(source, runtime, done) {
	exec('/bin/sh', [
		'-c', '. /etc/init.d/mimogate; check_runtime_config "$1" "$2"',
		'mimogate-config', source, runtime
	], result => {
		if (!result)
			return done(failure('Could not run Mihomo validation, or validation timed out.'));

		if (result.code != 0 || index(result.stdout ?? '', ' test is successful') < 0) {
			const log = substr((result.stderr ?? '') + (result.stdout ?? ''), 0, 4096);
			const error = failure('Mihomo configuration validation failed.', replace(log, /\x1b\[[0-9;]*m/g, ''));
			error.invalid = true;
			return done(error);
		}

		done(null);
	});
}

function status(_, reply) {
	if (!bus.defer('service', 'list', { name: 'mimogate' }, (code, state) => {
		if (code != 0)
			return reply(failure('Could not read procd service status.'));

		const instance = state?.mimogate?.instances?.main;
		const cnStat = fs.stat(cnCache);
		reply({
			ok: true,
			running: !!instance?.running,
			pid: instance?.running ? instance.pid : null,
			installed: fs.access(core, 'x'),
			configured: !!fs.stat(config)?.size,
			cn_cached: !!cnStat?.size,
			cn_mtime: cnStat?.size ? cnStat.mtime : null
		});
	}))
		reply(failure('Could not read procd service status.'));
}

function version(_, reply) {
	if (!fs.access(core, 'x'))
		return reply({ ok: true, version: '' });

	exec(core, [ '-v' ], result => {
		reply(result?.code == 0
			? { ok: true, version: trim(result.stdout ?? '') }
			: failure('Could not read Mihomo version.'));
	});
}

function bootStatus(_, reply) {
	exec(init, [ 'enabled' ], result => {
		reply(result?.code == 0 || result?.code == 1
			? { ok: true, enabled: result.code == 0 }
			: failure('Could not read boot status.'));
	});
}

function readConfig(args, reply) {
	const saved = !args.defaults && fs.stat(config) != null;
	const content = fs.readfile(saved ? config : template, maxSize + 1);

	if (content == null)
		return reply(failure('Could not read the configuration file.'));
	if (length(content) > maxSize)
		return reply(failure('The configuration file exceeds the 48 KiB web editor limit.'));

	reply({ ok: true, content, saved });
}

function validateInput(args, reply, save) {
	const content = args.content;
	if (saving)
		return reply(failure('Another configuration check is already in progress. Please try again shortly.'));
	if (type(content) != 'string' || !length(trim(content)) || index(content, chr(0)) >= 0)
		return reply(failure('Enter valid YAML text.'));
	if (length(content) > maxSize)
		return reply(failure('The configuration file exceeds the 48 KiB web editor limit.'));
	if (!fs.access(core, 'x'))
		return reply(failure('Mihomo core was not found.'));

	if (!fs.stat(directory) && !fs.mkdir(directory, 0o700) && !fs.stat(directory))
		return reply(failure('Could not create the configuration directory.'));

	const temporary = fs.popen('/bin/mktemp -d /etc/mimogate/.stage.XXXXXX');
	if (!temporary)
		return reply(failure('Could not create a temporary directory.'));

	const staging = trim(temporary.read('line') ?? '');
	if (temporary.close() != 0 || !length(staging))
		return reply(failure('Could not create a temporary directory.'));

	const candidate = staging + '/config.yaml';
	const runtime = staging + '/runtime.yaml';
	const finish = result => {
		fs.unlink(runtime);
		fs.unlink(candidate);
		fs.rmdir(staging);
		saving = false;
		reply(result);
	};

	if (fs.writefile(candidate, content) != length(content) || !fs.chmod(candidate, 0o600))
		return finish(failure('Could not write the temporary configuration file.'));

	saving = true;
	validateConfig(candidate, runtime, error => {
		if (error)
			return finish(error);

		if (save && !fs.rename(candidate, config))
			return finish(failure('Could not save the configuration file.'));

		finish({ ok: true });
	});
}

function readPorts(_, reply) {
	const saved = fs.stat(portsFile) != null;
	const ports = trim(fs.readfile(saved ? portsFile : defaultPortsFile, 4097) ?? '');
	if (!ports || length(ports) > 4096)
		return reply(failure('Could not read the saved interception ports.'));

	reply({ ok: true, ports, saved });
}

function applyPorts(args, reply) {
	const ports = args.ports;
	if (type(ports) != 'string' || length(ports) > 4096 || index(ports, chr(0)) >= 0)
		return reply(failure('Interception port input is invalid or too long.'));

	exec(init, [ 'apply_ports', ports ], result => {
		if (result?.code != 0)
			return reply(failure('Could not apply firewall port rules.', trim(result?.stderr ?? '')));
		const lines = split(trim(result.stdout ?? ''), '\n', 2);
		const response = { ok: true, ports: lines[0] };
		if (lines[1] == 'deferred')
			response.deferred = true;
		reply(response);
	});
}

function readAcl(_, reply) {
	if (fs.stat(aclFile) == null)
		return reply({ ok: true, mode: 'all', entries: '' });

	const raw = fs.readfile(aclFile, 4200);
	if (raw == null || length(raw) > 4160)
		return reply(failure('Could not read access control settings.'));

	const lines = split(trim(raw), '\n', 2);
	const mode = lines[0];
	if (index([ 'all', 'bypass', 'proxy' ], mode) < 0)
		return reply(failure('Could not read access control settings.'));

	reply({ ok: true, mode, entries: trim(lines[1] ?? '') });
}

function saveAcl(args, reply) {
	const mode = args.mode;
	const entries = args.entries ?? '';
	if (index([ 'all', 'bypass', 'proxy' ], mode) < 0)
		return reply(failure('Invalid access control mode.'));
	if (type(entries) != 'string' || length(entries) > 4096 || index(entries, chr(0)) >= 0)
		return reply(failure('Access control list is invalid or too long.'));

	exec(init, [ 'save_acl', mode, entries ], result => {
		if (result?.code != 0)
			return reply(failure('Could not save access control settings.', trim(result?.stderr ?? '')));
		const lines = split(trim(result.stdout ?? ''), '\n', 2);
		reply({ ok: true, mode: lines[0] || mode, entries: trim(lines[1] ?? '') });
	});
}

function parseYamlScalar(raw) {
	let s = trim(raw);
	if (substr(s, 0, 1) == '"' || substr(s, 0, 1) == "'") {
		const q = substr(s, 0, 1);
		s = substr(s, 1);
		const end = index(s, q);
		if (end >= 0)
			s = substr(s, 0, end);
		if (q == '"')
			s = replace(replace(s, /\\"/g, '"'), /\\\\/g, '\\');
		return s;
	}
	return trim(replace(s, /[ \t]*#.*$/, ''));
}

function readSettings(_, reply) {
	const out = {
		ok: true,
		panel_enabled: true,
		panel_port: '9090',
		panel_secret: '666V888c',
		quic_reject: true,
		ipv6_support: true
	};
	const setStat = fs.stat(settingsFile);
	if (setStat != null) {
		const raw = fs.readfile(settingsFile, 4096);
		if (raw == null)
			return reply(failure('Could not read settings.'));

		for (let line in split(raw, '\n')) {
			const idx = index(line, '=');
			if (idx <= 0)
				continue;
			const k = substr(line, 0, idx);
			const v = substr(line, idx + 1);
			if (k == 'panel_enabled')
				out.panel_enabled = (v != '0');
			else if (k == 'panel_port' && match(v, /^[0-9]+$/))
				out.panel_port = v;
			else if (k == 'panel_secret')
				out.panel_secret = v;
			else if (k == 'quic_reject')
				out.quic_reject = (v != '0');
			else if (k == 'ipv6_support')
				out.ipv6_support = (v != '0');
		}
	}

	const cfgStat = fs.stat(config);
	if (cfgStat?.size && (setStat == null || cfgStat.mtime > setStat.mtime)) {
		const cfgRaw = fs.readfile(config, maxSize);
		if (cfgRaw != null) {
			let first = true;
			let hasController = false;
			for (let line in split(cfgRaw, '\n')) {
				line = replace(line, /\r$/, '');
				if (first) {
					line = replace(line, /^\xef\xbb\xbf/, '');
					first = false;
				}
				if (match(line, /^external-controller:[ \t]*/)) {
					hasController = true;
					const v = parseYamlScalar(substr(line, 20));
					if (v == '' || v == 'null' || v == '~') {
						out.panel_enabled = false;
					}
					else {
						const m = match(v, /:([0-9]+)$/);
						if (m && int(m[1]) >= 1 && int(m[1]) <= 65535) {
							out.panel_enabled = true;
							out.panel_port = m[1];
						}
					}
				}
				else if (match(line, /^secret:[ \t]*/)) {
					out.panel_secret = parseYamlScalar(substr(line, 7));
				}
			}
			if (!hasController)
				out.panel_enabled = false;
		}
	}
	reply(out);
}

function saveSettings(args, reply) {
	const panelEnabled = args.panel_enabled ? '1' : '0';
	const panelPort = trim('' + (args.panel_port ?? '9090'));
	const panelSecret = '' + (args.panel_secret ?? '');
	const quicReject = args.quic_reject ? '1' : '0';
	const ipv6Support = args.ipv6_support ? '1' : '0';

	if (!match(panelPort, /^[0-9]+$/) || int(panelPort) < 1 || int(panelPort) > 65535)
		return reply(failure('Panel port must be between 1 and 65535.'));
	if (length(panelSecret) > 128 || index(panelSecret, '\n') >= 0 || index(panelSecret, '\r') >= 0 || index(panelSecret, chr(0)) >= 0)
		return reply(failure('Panel secret is invalid or too long.'));

	exec(init, [ 'save_settings', panelEnabled, panelPort, panelSecret, quicReject, ipv6Support ], result => {
		if (result?.code != 0)
			return reply(failure('Could not save settings.', trim(result?.stderr ?? '')));
		reply({
			ok: true,
			panel_enabled: panelEnabled == '1',
			panel_port: panelPort,
			panel_secret: panelSecret,
			quic_reject: quicReject == '1',
			ipv6_support: ipv6Support == '1'
		});
	});
}

function connectionCheck(args, reply) {
	const urls = {
		baidu: 'https://www.baidu.com',
		google: 'https://www.google.com/generate_204'
	};
	const url = urls[args.site];
	if (!url)
		return reply(failure('Invalid test target.'));

	const fetchBin = fs.access('/bin/uclient-fetch', 'x') ? '/bin/uclient-fetch' : '/usr/bin/uclient-fetch';
	const started = clock(true);
	exec(fetchBin, [ '-q', '-T', '5', '-O', '/dev/null', url ], result => {
		const finished = clock(true);
		const ms = int(((finished[0] - started[0]) * 1000) + ((finished[1] - started[1]) / 1000000));
		reply({ ok: true, result: result?.code == 0, ms: ms >= 0 ? ms : 0 });
	});
}

function updateCn(_, reply) {
	exec(init, [ 'update_cn' ], result => {
		if (result?.code != 0)
			return reply(failure('Could not update the mainland China IP list.', trim(result?.stderr ?? '')));
		reply({ ok: true, unchanged: trim(result.stdout ?? '') == 'unchanged' });
	});
}

function serviceAction(args, reply) {
	const action = args.action;
	if (index([ 'start', 'stop', 'restart', 'enable', 'disable', 'clear_log', 'clear_mihomo_log' ], action) < 0)
		return reply(failure('Invalid service action.'));

	const run = () => exec(init, [ action ], result => {
		const detail = trim((result?.stderr ?? '') + (result?.stdout ?? ''));
		reply(result?.code == 0 ? { ok: true } : failure('Service action failed.', substr(detail, 0, 4096)));
	});
	if (action != 'start' && action != 'restart')
		return run();
	if (!fs.access(core, 'x'))
		return reply(failure('Mihomo core was not found.'));
	if (!fs.stat(config)?.size)
		return reply(failure('Save a YAML configuration on the Configuration page first.'));

	run();
}

return {
	mimogate: {
		status: { call: rootOnly(status) },
		version: { call: rootOnly(version) },
		boot_status: { call: rootOnly(bootStatus) },
		read_ports: { call: rootOnly(readPorts) },
		apply_ports: { args: { ports: '' }, call: rootOnly(applyPorts) },
		read_acl: { call: rootOnly(readAcl) },
		save_acl: { args: { mode: '', entries: '' }, call: rootOnly(saveAcl) },
		read_settings: { call: rootOnly(readSettings) },
		save_settings: {
			args: { panel_enabled: true, panel_port: '', panel_secret: '', quic_reject: true, ipv6_support: true },
			call: rootOnly(saveSettings)
		},
		connection_check: { args: { site: '' }, call: rootOnly(connectionCheck) },
		update_cn: { call: rootOnly(updateCn) },
		read_config: { args: { defaults: false }, call: rootOnly(readConfig) },
		check_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, false)) },
		save_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, true)) },
		service_action: { args: { action: '' }, call: rootOnly(serviceAction) }
	}
};
