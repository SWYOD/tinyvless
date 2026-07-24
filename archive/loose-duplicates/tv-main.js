'use strict';
'require view';
'require fs';
'require ui';
'require poll';

var CFG = '/etc/tinyvless/config';
var DIRECT = '/etc/tinyvless/direct_domains.list';
var TUNNEL = '/etc/tinyvless/tunnel_domains.list';

function parseConfig(txt) {
	var o = { link: '', mode: 'selective' };
	(txt || '').split('\n').forEach(function (l) {
		var m;
		if ((m = l.match(/^\s*VLESS_LINK\s*=\s*['"]?([^'"]*)['"]?\s*$/))) o.link = m[1];
		else if ((m = l.match(/^\s*MODE\s*=\s*['"]?(\w+)['"]?/))) o.mode = m[1];
	});
	return o;
}

function setKV(txt, key, val) {
	var lines = (txt || '').split('\n');
	var re = new RegExp('^\\s*' + key + '\\s*=');
	var found = false;
	for (var i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) { lines[i] = key + "='" + val + "'"; found = true; break; }
	}
	if (!found) lines.push(key + "='" + val + "'");
	return lines.filter(function (l) { return l.length || true; }).join('\n');
}

function fmtBytes(n) {
	n = n || 0;
	var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

var prev = null, prevT = 0;

return view.extend({
	load: function () {
		return Promise.all([
			fs.read(CFG).catch(function () { return ''; }),
			fs.read(DIRECT).catch(function () { return ''; }),
			fs.read(TUNNEL).catch(function () { return ''; })
		]);
	},

	render: function (data) {
		var cfg = parseConfig(data[0]);
		var rawCfg = data[0] || '';
		var self = this;

		// --- индикатор статуса ---
		var elState = E('span', { style: 'font-weight:bold' }, '…');
		var elIP = E('span', {}, '—');
		var elDown = E('span', {}, '—');
		var elUp = E('span', {}, '—');
		var elActive = E('span', {}, '—');
		var elServer = E('span', {}, '—');

		var statusBox = E('div', { 'class': 'cbi-section', style: 'border:1px solid #2ea043;border-radius:8px;padding:12px;background:transparent' }, [
			E('h3', { style: 'margin-top:0' }, '📡 Статус подключения'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td', style: 'width:160px' }, 'Состояние'), E('td', { 'class': 'td' }, elState)]),
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, 'Сервер'), E('td', { 'class': 'td' }, elServer)]),
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, 'Внешний IP (через туннель)'), E('td', { 'class': 'td' }, elIP)]),
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, 'Скорость ↓'), E('td', { 'class': 'td' }, elDown)]),
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, 'Скорость ↑'), E('td', { 'class': 'td' }, elUp)]),
				E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, 'Активных соединений'), E('td', { 'class': 'td' }, elActive)])
			])
		]);

		poll.add(function () {
			return fs.exec('/etc/tinyvless/api.sh', ['status']).then(function (res) {
				var s;
				try { s = JSON.parse((res.stdout || '').trim()); } catch (e) { s = null; }
				if (!s || !s.running) {
					elState.textContent = '⛔ не запущен'; elState.style.color = '#c00';
					elIP.textContent = '—'; elDown.textContent = '—'; elUp.textContent = '—'; elActive.textContent = '—';
					prev = null; return;
				}
				elState.textContent = '✅ работает'; elState.style.color = '#0a0';
				elServer.textContent = s.server || '—';
				elIP.textContent = s.exit_ip || '(проверяется…)';
				elActive.textContent = '' + (s.active || 0) + ' (всего ' + (s.total || 0) + ')';
				var now = Date.now();
				if (prev && now > prevT) {
					var dt = (now - prevT) / 1000;
					elDown.textContent = fmtBytes((s.down_bytes - prev.down_bytes) / dt) + '/с';
					elUp.textContent = fmtBytes((s.up_bytes - prev.up_bytes) / dt) + '/с';
				}
				prev = s; prevT = now;
			});
		}, 3);

		// --- форма конфигурации ---
		var inLink = E('textarea', { style: 'width:100%;height:70px;font-family:monospace', rows: 3 }, cfg.link);
		var selMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'selective' }, 'Селективный (RU напрямую, зарубеж в туннель)'),
			E('option', { value: 'full' }, 'Всё в туннель (обход белых списков)'),
			E('option', { value: 'off' }, 'Выключено (обычный роутер)')
		]);
		selMode.value = cfg.mode;

		var taDirect = E('textarea', { style: 'width:100%;height:120px;font-family:monospace' }, data[1] || '');
		var taTunnel = E('textarea', { style: 'width:100%;height:100px;font-family:monospace' }, data[2] || '');

		var applyMsg = E('span', { style: 'margin-left:12px' }, '');

		var btnApply = E('button', {
			'class': 'cbi-button cbi-button-apply',
			click: ui.createHandlerFn(this, function () {
				var newCfg = setKV(setKV(rawCfg, 'VLESS_LINK', inLink.value.trim()), 'MODE', selMode.value);
				applyMsg.textContent = ' Применяю… (перезапуск ~20с)';
				return Promise.all([
					fs.write(CFG, newCfg),
					fs.write(DIRECT, taDirect.value),
					fs.write(TUNNEL, taTunnel.value)
				]).then(function () {
					return fs.exec('/etc/tinyvless/api.sh', ['apply']);
				}).then(function () {
					rawCfg = newCfg;
					applyMsg.textContent = ' ✅ Применено';
					prev = null;
					ui.addNotification(null, E('p', 'Настройки применены, сервис перезапущен'), 'info');
				}).catch(function (e) {
					applyMsg.textContent = ' ⛔ ошибка: ' + e;
				});
			})
		}, 'Сохранить и применить');

		var configBox = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '⚙️ Конфигурация'),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, 'VLESS-ссылка'),
				E('div', { 'class': 'cbi-value-field' }, [inLink,
					E('div', { 'class': 'cbi-value-description' }, 'Вставь строку vless://… (транспорт ws, security tls)')])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, 'Режим'),
				E('div', { 'class': 'cbi-value-field' }, [selMode])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, 'Домены НАПРЯМУЮ'),
				E('div', { 'class': 'cbi-value-field' }, [taDirect,
					E('div', { 'class': 'cbi-value-description' }, 'По одному в строке. Эти домены идут в обход туннеля (# — комментарий)')])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, 'Домены В ТУННЕЛЬ'),
				E('div', { 'class': 'cbi-value-field' }, [taTunnel,
					E('div', { 'class': 'cbi-value-description' }, 'По одному в строке. Принудительно через туннель (приоритет)')])
			]),
			E('div', { style: 'margin-top:10px' }, [btnApply, applyMsg])
		]);

		var proxyOn = (cfg.mode !== 'off');
		var btnToggle = E('button', {
			'class': 'cbi-button ' + (proxyOn ? 'cbi-button-reset' : 'cbi-button-save'),
			style: 'font-size:15px;padding:8px 22px;font-weight:bold',
			click: ui.createHandlerFn(this, function () {
				var newMode = proxyOn ? 'off' : (selMode.value !== 'off' ? selMode.value : 'selective');
				rawCfg = setKV(rawCfg, 'MODE', newMode);
				return fs.write(CFG, rawCfg).then(function () {
					return fs.exec('/etc/tinyvless/api.sh', ['apply']);
				}).then(function () {
					ui.addNotification(null, E('p', 'Переключаю… (~20с)'), 'info');
					window.setTimeout(function () { location.reload(); }, 22000);
				});
			})
		}, proxyOn ? '⛔ Выключить проксирование' : '✅ Включить проксирование');

		return E('div', {}, [
			E('h2', {}, 'tinyvless — VLESS роутер'),
			E('div', { style: 'margin-bottom:14px' }, [btnToggle]),
			statusBox,
			configBox
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
