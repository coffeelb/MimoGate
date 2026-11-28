// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: GPL-3.0-only

'use strict';
'require dom';
'require rpc';
'require ui';
'require view';

const readConfig = rpc.declare({
	object: 'mimogate', method: 'read_config', params: [ 'defaults' ], reject: true
});
const checkConfig = rpc.declare({
	object: 'mimogate', method: 'check_config', params: [ 'content' ], reject: true
});
const saveConfig = rpc.declare({
	object: 'mimogate', method: 'save_config', params: [ 'content' ], reject: true
});
const serviceAction = rpc.declare({
	object: 'mimogate', method: 'service_action', params: [ 'action' ], reject: true
});
const getStatus = rpc.declare({
	object: 'mimogate', method: 'status', reject: true
});

function editorText(value) {
	const text = value.replace(/\r\n/g, '\n');
	const normalized = text.endsWith('\n') ? text : text + '\n';
	const encoder = new TextEncoder();

	if (encoder.encode(normalized).length > 48 * 1024 ||
	    encoder.encode(JSON.stringify(normalized)).length > 60 * 1024)
		throw new Error(_('The configuration exceeds the web editor size limit.'));

	return normalized;
}

function errorText(result) {
	return [ result?.message ? _(result.message) : _('Request failed.'), result?.detail ].filter(Boolean).join('\n');
}

return view.extend({
	load() {
		return readConfig(false).catch(error => ({ ok: false, message: error.message }));
	},

	render(result) {
		let savedContent = result?.ok ? result.content : '';

		const editor = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 30,
			'wrap': 'off',
			'spellcheck': 'false',
			'style': 'width:100%; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; line-height:1.45; tab-size:2'
		});
		editor.value = savedContent;

		const output = E('div', { 'style': 'margin-top:1em', 'aria-live': 'polite' });

		const clearOutput = () => dom.content(output, '');
		const showResult = (ok, message) => dom.content(output,
			E('div', { 'class': 'alert-message ' + (ok ? 'info' : 'danger') },
				E('pre', { 'style': 'white-space:pre-wrap; margin:0' }, message)));

		if (!result?.ok)
			showResult(false, errorText(result));

		let busy = false;
		const guarded = (fn) => ui.createHandlerFn(this, async () => {
			if (busy)
				return;

			busy = true;
			editor.readOnly = true;
			try {
				await fn();
			}
			catch (e) {
				showResult(false, e.message);
			}
			finally {
				editor.readOnly = false;
				busy = false;
			}
		});

		const loadDefaults = guarded(async () => {
			const defaults = await readConfig(true);

			if (!defaults?.ok)
				throw new Error(errorText(defaults));

			editor.value = defaults.content;
			showResult(true, _('Default configuration loaded.'));
		});

		const check = guarded(async () => {
			const res = await checkConfig(editorText(editor.value));

			showResult(res?.ok, res?.ok ? _('Configuration is valid.') : errorText(res));
		});

		const save = (apply) => guarded(async () => {
			clearOutput();
			let applyTimer = null;
			const stopApplyCountdown = () => {
				if (applyTimer != null) {
					window.clearTimeout(applyTimer);
					applyTimer = null;
				}
			};
			if (apply) {
				const deadline = Date.now() + (L.env.apply_rollback || 90) * 1000;
				let ts = Date.now();
				const tick = () => {
					const now = Date.now();
					ui.changes.displayStatus('notice spinning',
						E('p', _('Applying configuration changes… %ds')
							.format(Math.max(Math.floor((deadline - Date.now()) / 1000), 0))));
					if (now >= deadline)
						return;
					applyTimer = window.setTimeout(tick, Math.max(1000 - (now - ts), 0));
					ts = now;
				};
				tick();
			}
			try {
				const text = editorText(editor.value);
				const res = await saveConfig(text);

				if (!res?.ok) {
					const prefix = res?.invalid ? _('Not saved: the configuration is invalid.') + '\n\n' : '';
					showResult(false, prefix + errorText(res));
					return;
				}

				const finalText = typeof res.content === 'string' ? res.content : text;
				savedContent = finalText;
				editor.value = finalText;
				if (!apply) {
					showResult(true, _('Contents have been saved.'));
					return;
				}

				try {
					const st = await getStatus();
					if (!st?.ok)
						throw new Error(errorText(st));
					if (st.running) {
						const restartRes = await serviceAction('restart');
						if (!restartRes?.ok)
							throw new Error(errorText(restartRes));
					}
				}
				catch (e) {
					throw new Error(_('Saved, but the service failed to restart:') + '\n' + e.message);
				}

				stopApplyCountdown();
				ui.changes.displayStatus('notice',
					E('p', _('Configuration changes applied.')));
				await new Promise((resolve) => window.setTimeout(resolve, (L.env.apply_display || 1.5) * 1000));
			}
			finally {
				if (apply) {
					stopApplyCountdown();
					ui.changes.displayStatus(false);
				}
			}
		});

		const reset = () => {
			if (busy)
				return;
			editor.value = savedContent;
			clearOutput();
		};

		this.handleSave = save(false);
		this.handleSaveApply = save(true);
		this.handleReset = reset;

		return E('div', { 'class': 'cbi-map' }, [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Configuration editor')),
				E('div', { 'class': 'cbi-section-descr' },
					_('Edit the Mihomo YAML configuration directly. It is validated with "mihomo -t" before it is saved.')),
				E('div', { 'class': 'cbi-section-node', 'style': 'padding: 1em' }, [
					editor,
					output,
					E('div', { 'style': 'display:flex; gap:.5em; flex-wrap:wrap; margin-top:.75em' }, [
						E('button', { 'type': 'button', 'class': 'btn cbi-button', 'click': loadDefaults }, _('Load default config')),
						E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-action', 'click': check }, _('Check'))
					])
				])
			])
		]);
	}
});
