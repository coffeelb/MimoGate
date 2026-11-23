'use strict';

import * as fs from 'fs';
import { connect } from 'ubus';

const bus = connect();
const core = '/usr/bin/mihomo';
const init = '/etc/init.d/mimogate';
const directory = '/etc/mimogate';
const config = directory + '/config.yaml';
const portsFile = directory + '/proxy-ports';
const cnCache = directory + '/cn.list';
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
		const denied = failure('此操作需要 OpenWrt root 管理员会话。');
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
			return done(failure('无法执行 Mihomo 校验，或校验超时。'));

		if (result.code != 0 || index(result.stdout ?? '', ' test is successful') < 0) {
			const log = substr((result.stderr ?? '') + (result.stdout ?? ''), 0, 4096);
			const error = failure('Mihomo 配置校验失败。', replace(log, /\x1b\[[0-9;]*m/g, ''));
			error.invalid = true;
			return done(error);
		}

		done(null);
	});
}

function status(_, reply) {
	if (!bus.defer('service', 'list', { name: 'mimogate' }, (code, state) => {
		if (code != 0)
			return reply(failure('无法读取 procd 服务状态。'));

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
		reply(failure('无法读取 procd 服务状态。'));
}

function version(_, reply) {
	if (!fs.access(core, 'x'))
		return reply({ ok: true, version: '' });

	exec(core, [ '-v' ], result => {
		reply(result?.code == 0
			? { ok: true, version: trim(result.stdout ?? '') }
			: failure('无法读取 Mihomo 版本。'));
	});
}

function bootStatus(_, reply) {
	exec(init, [ 'enabled' ], result => {
		reply(result?.code == 0 || result?.code == 1
			? { ok: true, enabled: result.code == 0 }
			: failure('无法读取开机自启状态。'));
	});
}

function readConfig(args, reply) {
	const saved = !args.defaults && fs.stat(config) != null;
	const content = fs.readfile(saved ? config : template, maxSize + 1);

	if (content == null)
		return reply(failure('无法读取配置文件。'));
	if (length(content) > maxSize)
		return reply(failure('配置文件超过网页编辑器的 48 KiB 上限。'));

	reply({ ok: true, content, saved });
}

function validateInput(args, reply, save) {
	const content = args.content;
	if (saving)
		return reply(failure('有一份配置正在校验，请稍后再试。'));
	if (type(content) != 'string' || !length(trim(content)) || index(content, chr(0)) >= 0)
		return reply(failure('请输入有效的 YAML 文本。'));
	if (length(content) > maxSize)
		return reply(failure('配置文件超过网页编辑器的 48 KiB 上限。'));
	if (!fs.access(core, 'x'))
		return reply(failure('未找到 Mihomo 内核。'));

	if (!fs.stat(directory) && !fs.mkdir(directory, 0o700) && !fs.stat(directory))
		return reply(failure('无法创建配置目录。'));

	const temporary = fs.popen('/bin/mktemp -d /etc/mimogate/.stage.XXXXXX');
	if (!temporary)
		return reply(failure('无法创建临时目录。'));

	const staging = trim(temporary.read('line') ?? '');
	if (temporary.close() != 0 || !length(staging))
		return reply(failure('无法创建临时目录。'));

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
		return finish(failure('无法写入临时配置文件。'));

	saving = true;
	validateConfig(candidate, runtime, error => {
		if (error)
			return finish(error);

		if (save && !fs.rename(candidate, config))
			return finish(failure('无法保存配置文件。'));

		finish({ ok: true });
	});
}

function readPorts(_, reply) {
	const saved = fs.stat(portsFile) != null;
	const ports = trim(fs.readfile(saved ? portsFile : defaultPortsFile, 4097) ?? '');
	if (!ports || length(ports) > 4096)
		return reply(failure('无法读取已保存的接管端口。'));

	reply({ ok: true, ports, saved });
}

function applyPorts(args, reply) {
	const ports = args.ports;
	if (type(ports) != 'string' || length(ports) > 4096 || index(ports, chr(0)) >= 0)
		return reply(failure('接管端口输入无效或过长。'));

	exec(init, [ 'apply_ports', ports ], result => {
		if (result?.code != 0)
			return reply(failure('无法应用防火墙端口规则。', trim(result?.stderr ?? '')));
		const lines = split(trim(result.stdout ?? ''), '\n', 2);
		const response = { ok: true, ports: lines[0] };
		if (lines[1] == 'deferred')
			response.deferred = true;
		reply(response);
	});
}

function updateCn(_, reply) {
	exec(init, [ 'update_cn' ], result => {
		if (result?.code != 0)
			return reply(failure('无法更新中国大陆 IP 列表。', trim(result?.stderr ?? '')));
		reply({ ok: true, unchanged: trim(result.stdout ?? '') == 'unchanged' });
	});
}

function serviceAction(args, reply) {
	const action = args.action;
	if (index([ 'start', 'stop', 'restart', 'enable', 'disable', 'clear_log' ], action) < 0)
		return reply(failure('无效的服务操作。'));

	const run = () => exec(init, [ action ], result => {
		const detail = trim((result?.stderr ?? '') + (result?.stdout ?? ''));
		reply(result?.code == 0 ? { ok: true } : failure('服务操作失败。', substr(detail, 0, 4096)));
	});
	if (action != 'start' && action != 'restart')
		return run();
	if (!fs.access(core, 'x'))
		return reply(failure('未找到 Mihomo 内核。'));
	if (!fs.stat(config)?.size)
		return reply(failure('请先在配置文件页保存 YAML。'));

	run();
}

return {
	mimogate: {
		status: { call: rootOnly(status) },
		version: { call: rootOnly(version) },
		boot_status: { call: rootOnly(bootStatus) },
		read_ports: { call: rootOnly(readPorts) },
		apply_ports: { args: { ports: '' }, call: rootOnly(applyPorts) },
		update_cn: { call: rootOnly(updateCn) },
		read_config: { args: { defaults: false }, call: rootOnly(readConfig) },
		check_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, false)) },
		save_config: { args: { content: '' }, call: rootOnly((args, reply) => validateInput(args, reply, true)) },
		service_action: { args: { action: '' }, call: rootOnly(serviceAction) }
	}
};
