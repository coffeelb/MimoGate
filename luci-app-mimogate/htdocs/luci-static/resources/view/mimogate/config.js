// Copyright (C) 2026 COFFEELB
// SPDX-License-Identifier: MIT

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
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return readConfig(false).catch(error => ({ ok: false, message: error.message }));
	},

	render(result) {
		const editor = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 30,
			'wrap': 'off',
			'spellcheck': 'false',
			'style': 'width:100%; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; line-height:1.45; tab-size:2'
		});
		editor.value = result?.ok ? result.content : '';

		const output = E('div', { 'style': 'margin-top:1em', 'aria-live': 'polite' });

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

		const restoreDefaults = guarded(async () => {
			const defaults = await readConfig(true);

			if (!defaults?.ok)
				throw new Error(errorText(defaults));

			editor.value = defaults.content;
			showResult(true, _('Default configuration loaded. Save to apply it.'));
		});

		const check = guarded(async () => {
			const res = await checkConfig(editorText(editor.value));

			showResult(res?.ok, res?.ok ? _('Configuration is valid.') : errorText(res));
		});

		const save = (restart) => guarded(async () => {
			const text = editorText(editor.value);
			const res = await saveConfig(text);

			if (!res?.ok) {
				const prefix = res?.invalid ? _('Not saved: the configuration is invalid.') + '\n\n' : '';
				showResult(false, prefix + errorText(res));
				return;
			}

			editor.value = text;
			if (!restart) {
				showResult(true, _('Saved. Restart the service to apply the changes.'));
				return;
			}

			try {
				const st = await getStatus();
				if (!st?.ok)
					throw new Error(errorText(st));
				if (!st.running) {
					showResult(true, _('Saved. Enable the proxy switch on the Settings page to start the service.'));
					return;
				}
				const result = await serviceAction('restart');
				if (!result?.ok)
					throw new Error(errorText(result));
			}
			catch (e) {
				throw new Error(_('Saved, but the service failed to restart:') + '\n' + e.message);
			}

			showResult(true, _('Saved. The service was restarted.'));
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h3', _('MimoGate configuration management')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Edit the Mihomo YAML configuration directly. It is validated with "mihomo -t" before it is saved.')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node', 'style': 'padding: 1em' }, [
					editor,
					output
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', { 'type': 'button', 'class': 'btn cbi-button', 'click': restoreDefaults }, _('Restore defaults')),
				' ',
				E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-action', 'click': check }, _('Check')),
				' ',
				E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-save', 'click': save(false) }, _('Save')),
				' ',
				E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-positive', 'click': save(true) }, _('Save and restart'))
			])
		]);
	}
});
