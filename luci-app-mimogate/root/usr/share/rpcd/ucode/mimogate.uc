'use strict';

import * as fs from 'fs';
import { connect } from 'ubus';

const bus = connect();
const core = '/usr/bin/mihomo';
const init = '/etc/init.d/mimogate';
const directory = '/etc/mimogate';
const config = directory + '/config.yaml';
const cnCache = directory + '/cn.nft';
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

function readConfig(args, reply) {
	const saved = !args.defaults && fs.stat(config) != null;
	const content = fs.readfile(saved ? config : template, maxSize + 1);

	if (content == null)
		return reply(failure('Could not read the configuration file.'));
	if (length(content) > maxSize)
		return reply(failure('The configuration file exceeds the 48 KiB web editor limit.'));

	reply({ ok: true, content, saved });
}

function stripPanelKeys(text) {
	const out = [];
	let skip = false;
	let first = true;
	for (let line in split(text, '\n')) {
		let check = replace(line, /\r$/, '');
		if (first) {
			check = replace(check, /^\xef\xbb\xbf/, '');
			first = false;
		}
		if (match(check, /^(external-controller(-tls)?|external-ui(-url)?|secret):([ \t]|$)/)) {
			skip = true;
			continue;
		}
		if (skip) {
			if (match(check, /^[ \t]+/))
				continue;
			skip = false;
			if (check == '' && (!length(out) || replace(out[length(out) - 1], /\r$/, '') == ''))
				continue;
		}
		push(out, line);
	}
	return join('\n', out);
}

function validateInput(args, reply, save) {
	let content = args.content;
	if (saving)
		return reply(failure('Another configuration check is already in progress. Please try again shortly.'));
	if (type(content) != 'string' || !length(trim(content)) || index(content, chr(0)) >= 0)
		return reply(failure('Enter valid YAML text.'));
	if (length(content) > maxSize)
		return reply(failure('The configuration file exceeds the 48 KiB web editor limit.'));
	if (!fs.access(core, 'x'))
		return reply(failure('Mihomo core was not found.'));
	if (save)
		content = stripPanelKeys(content);

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

		finish(save ? { ok: true, content } : { ok: true });
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
		return reply(failure('Save a YAML configuration on the Config page first.'));

	run();
}

return {
	mimogate: {
		status: { call: rootOnly(status) },
		version: { call: rootOnly(version) },
		connection_check: { args: { site: '' }, call: rootOnly(connectionCheck) },
		update_cn: { call: rootOnly(updateCn) },
		read_config: { args: { defaults: false }, call: rootOnly(readConfig) },
		check_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, false)) },
		save_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, true)) },
		service_action: { args: { action: '' }, call: rootOnly(serviceAction) }
	}
};
