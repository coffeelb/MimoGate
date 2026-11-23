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
	if (index([ 'start', 'stop', 'restart', 'enable', 'disable', 'clear_log' ], action) < 0)
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
		connection_check: { args: { site: '' }, call: rootOnly(connectionCheck) },
		update_cn: { call: rootOnly(updateCn) },
		read_config: { args: { defaults: false }, call: rootOnly(readConfig) },
		check_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, false)) },
		save_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, true)) },
		service_action: { args: { action: '' }, call: rootOnly(serviceAction) }
	}
};
