'use strict';
// MagnumOpusPlus V10 — страница микротюнинга /tinyvless/microtun/

var MT = '/etc/tinyvless/microtun.conf';
var MT_DEF = '/etc/tinyvless/microtun.defaults';
var UDP_LIST = '/etc/tinyvless/udp_tunnel_domains.list';
var CARD_ORDER_FILE = '/etc/tinyvless/card_order.json';
// тот же канонический список, что в app4.js (главная панель) — держать в синхроне вручную,
// это два независимых файла морды.
var CARD_DEFAULT_ORDER = ['status', 'net', 'control', 'speed', 'clients', 'prof', 'dom', 'dns', 'reach', 'system'];
var CARD_LABELS = {
	status: 'Мониторинг', net: 'Модем', control: 'Проксирование', speed: 'Speedtest',
	clients: 'Клиенты LAN', prof: 'Профили', dom: 'Домены маршрутизации', dns: 'DNS-резолв',
	reach: 'Проверка доступности', system: 'Система'
};
var SPEEDTEST_SOURCES_FILE = '/etc/tinyvless/speedtest_sources.json';
var POLL_INTERVAL_FILE = '/etc/tinyvless/poll_interval.json';
var POLL_INTERVAL_DEFAULT = 8;
var SPEEDTEST_SOURCES_DEFAULT = {
	tunnel: [{ label: 'Cloudflare', url: 'https://speed.cloudflare.com', type: 'cf' }, { label: 'Google', url: 'https://www.google.com', type: 'generic' }],
	direct: [{ label: 'Mail.ru', url: 'https://mail.ru', type: 'generic' }, { label: 'VK', url: 'https://vk.com', type: 'generic' }]
};

var BLOCKS = [
	{
		title: 'DNS и dnsmasq',
		hint: 'Лимиты резолвера. cachesize ≥ 300 — не снижать без причины (OOM-история).',
		keys: [
			{ k: 'DNS_FORWARD_MAX', label: 'dns-forward-max', type: 'number' },
			{ k: 'DNS_CACHESIZE', label: 'cachesize (UCI)', type: 'number' }
		]
	},
	{
		title: 'Порты проксирования',
		hint: 'REDIR — TCP, TPROXY — UDP. После смены нужен рестарт tinyvless.',
		keys: [
			{ k: 'REDIR_PORT', label: 'REDIR_PORT (TCP)', type: 'number' },
			{ k: 'TPROXY_PORT', label: 'TPROXY_PORT (UDP)', type: 'number' },
			{ k: 'LAN_IF', label: 'LAN интерфейс', type: 'text' },
			{ k: 'ROUTE_APPLY_DELAY', label: 'Задержка apply-route (с)', type: 'number' }
		]
	},
	{
		title: 'UDP fallback-порты',
		hint: 'При «Селективный UDP» — дополнительно к доменам из списка ниже.',
		keys: [
			{ k: 'UDP_DISCORD_PORT1', label: 'Диапазон 1', type: 'text' },
			{ k: 'UDP_DISCORD_PORT2', label: 'Диапазон 2', type: 'text' }
		]
	},
	{
		title: 'Система и watchdog',
		keys: [
			{ k: 'LOG_SIZE_KB', label: 'logd (KiB)', type: 'number' },
			{ k: 'DNS_WATCHDOG_INTERVAL', label: 'dns-watchdog (с)', type: 'number' },
			{ k: 'TINYVLESS_NICE', label: 'nice tinyvless', type: 'number' },
			{ k: 'PROCD_RESPAWN_THRESHOLD', label: 'procd respawn threshold', type: 'number' },
			{ k: 'PROCD_RESPAWN_TIMEOUT', label: 'procd respawn timeout', type: 'number' },
			{ k: 'PROCD_RESPAWN_RETRY', label: 'procd respawn retry', type: 'number' }
		]
	},
	{
		title: 'tinyvless binary (только чтение)',
		hint: 'Задаётся при сборке бинаря. Для справки.',
		readonly: true,
		keys: [
			{ k: 'DIAL_SEM', label: 'dialSem', type: 'number' },
			{ k: 'POOL_BUF_KB', label: 'poolBuf (KiB)', type: 'number' },
			{ k: 'TLS_CACHE', label: 'tlsSessionCache', type: 'number' },
			{ k: 'GO_MEM_LIMIT_MB', label: 'Go mem limit (MiB)', type: 'number' }
		]
	}
];

var STYLE = [
	'.tv { --acc:#3fb950; --acc-bd:#2ea043; --acc-bg:rgba(46,160,67,.13); --mut:#8b949e; --bd:rgba(139,148,158,.28); }',
	'.tv-wrap{ max-width:900px; margin:0 auto; padding-bottom:24px; }',
	'.tv-card{ border:1px solid var(--bd); border-radius:12px; padding:16px 18px; margin:0 0 16px; background:rgba(127,127,127,.04); }',
	'.tv-card-h{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }',
	'.tv-card-h h3{ margin:0; font-size:16px; flex:1 1 auto; min-width:0; }',
	'.tv-hint{ font-size:12px; color:var(--mut); margin:0 0 12px; line-height:1.4; }',
	'.tv-field{ margin-bottom:10px; }',
	'.tv-field label{ display:block; font-size:13px; color:var(--mut); margin-bottom:4px; }',
	'.tv-field input{ width:100%; box-sizing:border-box; background:rgba(127,127,127,.08); color:inherit; border:1px solid var(--bd); border-radius:8px; padding:8px 10px; font-size:14px; font-family:monospace; }',
	// без явной тёмной стилизации <input>/<select> рендерятся с белым UA-фоном браузера —
	// на тёмной теме выглядит как "ублюдские белые блоки".
	'.tv-inp{ box-sizing:border-box; background:#0d1117; color:inherit; border:1px solid var(--bd); border-radius:8px; padding:8px 10px; font-size:14px; font-family:inherit; flex:1 1 160px; min-width:0; }',
	'select.tv-inp{ -webkit-appearance:none; appearance:none; }',
	'select.tv-inp option{ background:#0d1117; color:#e6edf3; }',
	'.tv-inp:focus{ outline:none; border-color:var(--acc-bd); }',
	'.tv-field input[readonly]{ opacity:.65; }',
	'.tv-actions{ display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; }',
	'.tv-btn{ display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:8px 16px; border-radius:9px; border:1.5px solid var(--bd); background:transparent; color:inherit; cursor:pointer; font-size:14px; font-family:inherit; }',
	'.tv-btn.acc{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-btn.danger{ border-color:rgba(248,81,73,.5); color:#f85149; }',
	'.tv-btn.icon{ width:36px; height:36px; padding:0; flex:0 0 auto; font-size:20px; line-height:1; }',
	'.tv-btn.small{ padding:6px 10px; font-size:13px; }',
	'.tv-msg{ font-size:13px; color:var(--mut); margin-top:10px; min-height:1.2em; }',
	'.tv-top{ display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:8px; }',
	'.tv-top a{ color:var(--acc); text-decoration:none; font-size:14px; }',
	'.tv-dom-list{ display:flex; flex-direction:column; gap:8px; }',
	'.tv-dom-chip{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border:1.5px solid var(--bd); border-radius:10px; background:rgba(127,127,127,.06); }',
	'.tv-dom-chip .nm{ font-family:monospace; font-size:14px; word-break:break-all; flex:1 1 auto; }',
	'.tv-dom-chip .tv-btn.icon{ border-color:rgba(248,81,73,.45); color:#f85149; }',
	'.tv-dom-empty{ font-size:13px; color:var(--mut); padding:8px 0; }',
	'.tv-sw{ position:relative; width:44px; height:24px; flex:0 0 auto; }',
	'.tv-sw input{ opacity:0; width:0; height:0; position:absolute; }',
	'.tv-sw .sl{ position:absolute; inset:0; background:rgba(139,148,158,.35); border-radius:24px; cursor:pointer; transition:.15s; }',
	'.tv-sw .sl:before{ content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.15s; }',
	'.tv-sw input:checked + .sl{ background:var(--acc-bd); }',
	'.tv-sw input:checked + .sl:before{ transform:translateX(20px); }',
	'.tv-sw.rect{ width:52px; height:28px; }',
	'.tv-sw.rect .sl{ border-radius:10px; }',
	'.tv-sw.rect .sl:before{ width:22px; height:22px; border-radius:7px; top:3px; left:3px; }',
	'.tv-sw.rect input:checked + .sl:before{ transform:translateX(24px); }',
	'.modal-ov{ position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:16px; z-index:1000; }',
	'.modal-box{ background:#161b22; border:1px solid var(--bd); border-radius:14px; padding:18px 20px; width:100%; max-width:400px; }',
	'.modal-box h4{ margin:0 0 12px; font-size:16px; }',
	'.modal-box p{ margin:0 0 14px; font-size:14px; color:var(--mut); line-height:1.45; }',
	'.modal-box input{ width:100%; box-sizing:border-box; background:rgba(127,127,127,.08); color:inherit; border:1px solid var(--bd); border-radius:8px; padding:8px 10px; font-size:14px; margin-bottom:14px; }',
	'.modal-actions{ display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; }',
	'.tv-sys-card{ border-color:rgba(139,148,158,.35); }',
	'.tv-sys-actions{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }',
	'.tv-sys-actions .tv-btn{ justify-content:center; min-width:0; padding:8px 10px; font-size:13px; }'
].join('\n');

var MT_EXPORT_VER = 1;

function parseKV(txt) {
	var o = {};
	(txt || '').split('\n').forEach(function (l) {
		var m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
		if (m && l.charAt(0) !== '#') o[m[1]] = m[2];
	});
	return o;
}

function serializeKV(o, template) {
	var lines = (template || '').split('\n');
	var out = [];
	var seen = {};
	lines.forEach(function (l) {
		var m = l.match(/^\s*([A-Za-z0-9_]+)\s*=/);
		if (m && o[m[1]] !== undefined) {
			out.push(m[1] + '=' + o[m[1]]);
			seen[m[1]] = true;
		} else {
			out.push(l);
		}
	});
	Object.keys(o).forEach(function (k) {
		if (!seen[k]) out.push(k + '=' + o[k]);
	});
	return out.join('\n') + '\n';
}

function parseDomList(txt) {
	return (txt || '').split('\n').map(function (s) { return s.trim(); })
		.filter(function (s) { return s && s.charAt(0) !== '#'; });
}

function normDomain(s) {
	return (s || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
}

return view.extend({
	load: function () {
		return Promise.all([
			fs.read(MT).catch(function () { return fs.read(MT_DEF); }),
			fs.read(MT_DEF).catch(function () { return ''; }),
			fs.read(UDP_LIST).catch(function () { return ''; }),
			fs.read(CARD_ORDER_FILE).catch(function () { return ''; }),
			fs.read(SPEEDTEST_SOURCES_FILE).catch(function () { return ''; }),
			fs.read(POLL_INTERVAL_FILE).catch(function () { return ''; })
		]);
	},
	render: function (data) {
		var vals = parseKV(data[0]);
		var tmpl = data[1] || data[0];
		var udpDomains = parseDomList(data[2] || '');
		var _savedCardCfg = (function () {
			var saved;
			try { saved = JSON.parse(data[3] || ''); } catch (e) { saved = null; }
			var order = Array.isArray(saved) ? saved : (saved && Array.isArray(saved.order) ? saved.order : null);
			var disabled = (saved && !Array.isArray(saved) && Array.isArray(saved.disabled)) ? saved.disabled : [];
			if (!order || !order.length) order = CARD_DEFAULT_ORDER.slice();
			var out = order.filter(function (k) { return CARD_LABELS[k] != null; });
			CARD_DEFAULT_ORDER.forEach(function (k) { if (out.indexOf(k) === -1) out.push(k); });
			return { order: out, disabled: disabled };
		})();
		var cardOrder = _savedCardCfg.order;
		var cardDisabled = _savedCardCfg.disabled.slice();
		var speedSources = (function () {
			var saved;
			try { saved = JSON.parse(data[4] || ''); } catch (e) { saved = null; }
			var out = { tunnel: [], direct: [] };
			['tunnel', 'direct'].forEach(function (via) {
				var arr = saved && Array.isArray(saved[via]) ? saved[via] : null;
				out[via] = (arr && arr.length ? arr : SPEEDTEST_SOURCES_DEFAULT[via]).map(function (s) {
					return { label: s.label || '', url: s.url || '', type: s.type === 'cf' ? 'cf' : 'generic' };
				});
			});
			return out;
		})();
		var pollInterval = (function () {
			var v;
			try { v = JSON.parse(data[5] || '').seconds; } catch (e) { v = null; }
			v = parseInt(v, 10);
			if (!v || v < 4 || v > 120) return POLL_INTERVAL_DEFAULT;
			return v;
		})();
		var inputs = {};
		var msg = E('div', { 'class': 'tv-msg' }, '');

		function appendKids(el, ch) {
			if (ch == null || ch === false) return;
			if (Array.isArray(ch)) { ch.forEach(function (c) { appendKids(el, c); }); return; }
			if (ch instanceof Node) el.appendChild(ch); else el.appendChild(document.createTextNode(String(ch)));
		}

		function showModal(title, bodyKids, onOk, okLabel) {
			var ov = E('div', { 'class': 'modal-ov', click: function (e) { if (e.target === ov) close(); } });
			var box = E('div', { 'class': 'modal-box' });
			if (title) box.appendChild(E('h4', {}, title));
			appendKids(box, bodyKids);
			var actions = E('div', { 'class': 'modal-actions' });
			var btnCancel = E('button', { 'class': 'tv-btn small', click: close }, 'Отмена');
			var btnOk = E('button', { 'class': 'tv-btn small acc', click: function () { onOk(close); } }, okLabel || 'OK');
			actions.appendChild(btnCancel);
			actions.appendChild(btnOk);
			box.appendChild(actions);
			ov.appendChild(box);
			document.body.appendChild(ov);
			function close() { ov.remove(); }
			return { close: close, setOkLabel: function (t) { btnOk.textContent = t; }, setOkDanger: function () { btnOk.className = 'tv-btn small danger'; btnOk.textContent = 'Удалить'; } };
		}

		function buildBlock(block) {
			var kids = [E('h3', {}, block.title)];
			if (block.hint) kids.push(E('div', { 'class': 'tv-hint' }, block.hint));
			block.keys.forEach(function (f) {
				var inp = E('input', {
					type: f.type === 'number' ? 'number' : 'text',
					value: vals[f.k] || '',
					readonly: block.readonly ? 'readonly' : null
				});
				inputs[f.k] = inp;
				kids.push(E('div', { 'class': 'tv-field' }, [
					E('label', {}, f.label + ' (' + f.k + ')'),
					inp
				]));
			});
			return E('div', { 'class': 'tv-card' }, kids);
		}

		var elDomList = E('div', { 'class': 'tv-dom-list' });

		function renderDomCards() {
			elDomList.innerHTML = '';
			if (!udpDomains.length) {
				elDomList.appendChild(E('div', { 'class': 'tv-dom-empty' }, 'Список пуст — нажмите + чтобы добавить домен.'));
				return;
			}
			udpDomains.forEach(function (d, idx) {
				elDomList.appendChild(E('div', { 'class': 'tv-dom-chip' }, [
					E('span', { 'class': 'nm' }, d),
					E('button', {
						'class': 'tv-btn icon', type: 'button', title: 'Удалить',
						click: function () {
							var m = showModal('Удалить домен?', [
								E('p', {}, 'Убрать «' + d + '» из селективного UDP?')
							], function (close) {
								udpDomains.splice(idx, 1);
								renderDomCards();
								close();
							});
							m.setOkDanger();
						}
					}, '×')
				]));
			});
		}

		var btnAddDom = E('button', {
			'class': 'tv-btn icon acc', type: 'button', title: 'Добавить домен',
			click: function () {
				var inp = E('input', { type: 'text', placeholder: 'например discord.com' });
				showModal('Добавить домен UDP', [inp], function (close) {
					var d = normDomain(inp.value);
					if (!d || !/^[a-z0-9.-]+$/.test(d)) { inp.focus(); return; }
					if (udpDomains.indexOf(d) >= 0) { close(); return; }
					udpDomains.push(d);
					renderDomCards();
					close();
				}, 'Добавить');
			}
		}, '+');

		var udpCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [
				E('h3', {}, 'Селективный UDP — домены'),
				btnAddDom
			]),
			E('div', { 'class': 'tv-hint' }, 'При включённом «Селективный UDP» на главной — tproxy UDP только для этих доменов (+ fallback-порты выше).'),
			elDomList
		]);
		renderDomCards();

		function collect() {
			var o = parseKV(tmpl);
			Object.keys(inputs).forEach(function (k) {
				if (inputs[k].hasAttribute('readonly')) return;
				o[k] = inputs[k].value.trim();
			});
			return o;
		}

		function udpListText() {
			return udpDomains.join('\n') + (udpDomains.length ? '\n' : '');
		}

		var btnApply = E('button', { 'class': 'tv-btn acc', click: function () {
			msg.textContent = 'Применяю…';
			var body = serializeKV(collect(), tmpl);
			Promise.all([
				fs.write(MT, body),
				fs.write(UDP_LIST, udpListText()),
				fs.exec('/etc/tinyvless/api.sh', ['microtun_apply']),
				fs.exec('/etc/tinyvless/api.sh', ['domains'])
			]).then(function () {
				msg.textContent = '✓ Микротюнинг применён';
			}).catch(function () { msg.textContent = '⛔ Ошибка применения'; });
		} }, 'Применить');

		var btnReset = E('button', { 'class': 'tv-btn danger', click: function () {
			showModal('Сбросить настройки?', [
				E('p', {}, 'Вернуть microtun.conf и список UDP-доменов к заводским значениям?')
			], function (close) {
				close();
				msg.textContent = 'Сброс…';
				fs.exec('/etc/tinyvless/api.sh', ['microtun_reset']).then(function () {
					return Promise.all([fs.read(MT), fs.read(UDP_LIST)]);
				}).then(function (d) {
					var v = parseKV(d[0]);
					Object.keys(inputs).forEach(function (k) { if (inputs[k] && v[k] !== undefined) inputs[k].value = v[k]; });
					udpDomains = parseDomList(d[1] || '');
					renderDomCards();
					msg.textContent = '✓ Сброшено к заводским';
				}).catch(function () { msg.textContent = '⛔ Ошибка сброса'; });
			}).setOkDanger();
		} }, 'Откатить к заводским');

		function buildExportPayload() {
			return {
				version: MT_EXPORT_VER,
				exported_at: new Date().toISOString(),
				microtun: collect(),
				udp_domains: udpDomains.slice()
			};
		}

		function applyImported(data) {
			var mt = data && data.microtun;
			if (!mt || typeof mt !== 'object') return false;
			Object.keys(inputs).forEach(function (k) {
				if (mt[k] !== undefined) inputs[k].value = String(mt[k]);
			});
			if (Array.isArray(data.udp_domains)) {
				udpDomains = data.udp_domains.map(normDomain).filter(function (d) { return d && /^[a-z0-9.-]+$/.test(d); });
				var seen = {};
				udpDomains = udpDomains.filter(function (d) { if (seen[d]) return false; seen[d] = true; return true; });
				renderDomCards();
			}
			return true;
		}

		function persistImported() {
			msg.textContent = 'Импорт…';
			var body = serializeKV(collect(), tmpl);
			return Promise.all([
				fs.write(MT, body),
				fs.write(UDP_LIST, udpListText()),
				fs.exec('/etc/tinyvless/api.sh', ['microtun_apply']),
				fs.exec('/etc/tinyvless/api.sh', ['domains'])
			]).then(function () {
				msg.textContent = '✓ Конфиг импортирован и применён';
			}).catch(function () { msg.textContent = '⛔ Ошибка импорта'; });
		}

		var fileImport = E('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });

		var btnExport = E('button', {
			'class': 'tv-btn', type: 'button',
			click: function () {
				var payload = buildExportPayload();
				var blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
				var url = URL.createObjectURL(blob);
				var a = document.createElement('a');
				a.href = url;
				a.download = 'tinyvless-microtun-' + new Date().toISOString().slice(0, 10) + '.json';
				document.body.appendChild(a);
				a.click();
				a.remove();
				URL.revokeObjectURL(url);
				msg.textContent = '✓ Экспортировано';
			}
		}, 'Экспорт');

		var btnImport = E('button', {
			'class': 'tv-btn', type: 'button',
			click: function () { fileImport.click(); }
		}, 'Импорт');

		fileImport.addEventListener('change', function () {
			var file = fileImport.files && fileImport.files[0];
			fileImport.value = '';
			if (!file) return;
			var reader = new FileReader();
			reader.onload = function () {
				var data;
				try { data = JSON.parse(String(reader.result || '')); }
				catch (e) { msg.textContent = '⛔ Неверный JSON'; return; }
				if (!applyImported(data)) {
					msg.textContent = '⛔ Нет блока microtun в файле';
					return;
				}
				showModal('Импорт конфига?', [
					E('p', {}, 'Заменить текущие параметры микротюнинга и UDP-домены данными из файла и сразу применить на роутере?')
				], function (close) {
					close();
					persistImported();
				}, 'Импортировать');
			};
			reader.onerror = function () { msg.textContent = '⛔ Не удалось прочитать файл'; };
			reader.readAsText(file);
		});

		var configCard = E('div', { 'class': 'tv-card tv-sys-card' }, [
			E('h3', { style: 'margin:0 0 8px' }, 'Конфигурация'),
			E('div', { 'class': 'tv-hint', style: 'margin:0 0 4px' }, 'Импорт и экспорт настроек микротюнинга в JSON — все параметры на этой странице и список UDP-доменов.'),
			E('div', { 'class': 'tv-sys-actions' }, [btnImport, btnExport]),
			fileImport
		]);

		// -- порядок карточек главной панели --
		var orderMsg = E('div', { 'class': 'tv-msg' }, '');
		var elOrderList = E('div', { 'class': 'tv-dom-list' });
		function renderOrderList() {
			elOrderList.innerHTML = '';
			cardOrder.forEach(function (key, idx) {
				var isOn = cardDisabled.indexOf(key) === -1;
				var swOn = E('input', { type: 'checkbox' });
				swOn.checked = isOn;
				swOn.addEventListener('change', function () {
					var i = cardDisabled.indexOf(key);
					if (swOn.checked) { if (i !== -1) cardDisabled.splice(i, 1); }
					else if (i === -1) { cardDisabled.push(key); }
				});
				var btnUp = E('button', {
					'class': 'tv-btn small', type: 'button', title: 'Выше', disabled: idx === 0 ? 'disabled' : null,
					click: function () {
						if (idx === 0) return;
						var t = cardOrder[idx - 1]; cardOrder[idx - 1] = cardOrder[idx]; cardOrder[idx] = t;
						renderOrderList();
					}
				}, '↑');
				var btnDown = E('button', {
					'class': 'tv-btn small', type: 'button', title: 'Ниже', disabled: idx === cardOrder.length - 1 ? 'disabled' : null,
					click: function () {
						if (idx === cardOrder.length - 1) return;
						var t = cardOrder[idx + 1]; cardOrder[idx + 1] = cardOrder[idx]; cardOrder[idx] = t;
						renderOrderList();
					}
				}, '↓');
				elOrderList.appendChild(E('div', { 'class': 'tv-dom-chip' }, [
					E('label', { 'class': 'tv-sw rect', style: 'flex:0 0 auto', title: 'Показывать блок' }, [swOn, E('span', { 'class': 'sl' })]),
					E('span', { 'class': 'nm' }, (idx + 1) + '. ' + (CARD_LABELS[key] || key)),
					E('div', { style: 'display:flex;gap:6px' }, [btnUp, btnDown])
				]));
			});
		}
		renderOrderList();
		var btnOrderSave = E('button', {
			'class': 'tv-btn acc', type: 'button', click: function () {
				orderMsg.textContent = 'Сохраняю…';
				fs.write(CARD_ORDER_FILE, JSON.stringify({ order: cardOrder, disabled: cardDisabled })).then(function () {
					orderMsg.textContent = '✓ Сохранено — обновите главную панель';
				}).catch(function () { orderMsg.textContent = '⛔ Ошибка сохранения'; });
			}
		}, 'Сохранить порядок');
		var btnOrderReset = E('button', {
			'class': 'tv-btn', type: 'button', click: function () {
				cardOrder = CARD_DEFAULT_ORDER.slice();
				cardDisabled = [];
				renderOrderList();
				orderMsg.textContent = 'Сброшено к порядку по умолчанию (не забудьте сохранить)';
			}
		}, 'По умолчанию');
		var orderCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [E('h3', {}, 'Порядок и видимость блоков главной панели')]),
			E('div', { 'class': 'tv-hint' }, 'Стрелками меняете порядок, переключателем — показывать блок на главной панели или скрыть. Не забудьте «Сохранить порядок».'),
			elOrderList,
			E('div', { 'class': 'tv-sys-actions', style: 'margin-top:12px' }, [btnOrderSave, btnOrderReset]),
			orderMsg
		]);

		// -- источники для Speedtest (туннель/напрямую) --
		var speedMsg = E('div', { 'class': 'tv-msg' }, '');
		var elSpeedLists = { tunnel: E('div', { 'class': 'tv-dom-list' }), direct: E('div', { 'class': 'tv-dom-list' }) };
		function renderSpeedList(via) {
			var host = elSpeedLists[via];
			host.innerHTML = '';
			if (!speedSources[via].length) {
				host.appendChild(E('div', { 'class': 'tv-dom-empty' }, 'Список пуст.'));
				return;
			}
			speedSources[via].forEach(function (s, idx) {
				host.appendChild(E('div', { 'class': 'tv-dom-chip' }, [
					E('span', { 'class': 'nm' }, (s.label || s.url) + ' — ' + s.url + ' (' + (s.type === 'cf' ? 'cloudflare API' : 'обычный GET/POST') + ')'),
					E('button', {
						'class': 'tv-btn icon', type: 'button', title: 'Удалить',
						click: function () { speedSources[via].splice(idx, 1); renderSpeedList(via); }
					}, '×')
				]));
			});
		}
		renderSpeedList('tunnel');
		renderSpeedList('direct');
		function mkAddSpeedRow(via) {
			var inLabel = E('input', { type: 'text', 'class': 'tv-inp', placeholder: 'Название (напр. Yandex)' });
			var inUrl = E('input', { type: 'text', 'class': 'tv-inp', placeholder: 'https://example.com' });
			var selType = E('select', { 'class': 'tv-inp' }, [
				E('option', { value: 'generic' }, 'Обычный сайт (GET/POST)'),
				E('option', { value: 'cf' }, 'Cloudflare speedtest API')
			]);
			var btnAdd = E('button', {
				'class': 'tv-btn small acc', type: 'button', click: function () {
					var url = inUrl.value.trim();
					if (!/^https?:\/\/[A-Za-z0-9.-]+/.test(url)) { inUrl.focus(); return; }
					speedSources[via].push({ label: inLabel.value.trim() || url, url: url, type: selType.value });
					inLabel.value = ''; inUrl.value = ''; selType.value = 'generic';
					renderSpeedList(via);
				}
			}, 'Добавить');
			return E('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, [inLabel, inUrl, selType, btnAdd]);
		}
		var btnSpeedSave = E('button', {
			'class': 'tv-btn acc', type: 'button', click: function () {
				speedMsg.textContent = 'Сохраняю…';
				fs.write(SPEEDTEST_SOURCES_FILE, JSON.stringify(speedSources)).then(function () {
					speedMsg.textContent = '✓ Сохранено — обновите главную панель';
				}).catch(function () { speedMsg.textContent = '⛔ Ошибка сохранения'; });
			}
		}, 'Сохранить источники');
		var btnSpeedReset = E('button', {
			'class': 'tv-btn', type: 'button', click: function () {
				speedSources = JSON.parse(JSON.stringify(SPEEDTEST_SOURCES_DEFAULT));
				renderSpeedList('tunnel'); renderSpeedList('direct');
				speedMsg.textContent = 'Сброшено к источникам по умолчанию (не забудьте сохранить)';
			}
		}, 'По умолчанию');
		var speedSourcesCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [E('h3', {}, 'Источники для Speedtest')]),
			E('div', { 'class': 'tv-hint' }, 'Тест на одном сервере может врать — грузилка сама тормозит, сеть до неё нестабильна и т.п. Несколько источников на направление — среднее честнее. "Cloudflare API" даёт точный контроль размера чанка, "обычный сайт" — просто мерит реальную загрузку страницы (нужно для direct: тест на зарубежном хосте всегда покажет "недоступно", если прямой доступ за границу у оператора урезан — добавляйте RU-сайты).'),
			E('div', { style:'font-size:13px;color:var(--mut);margin:0 0 8px;font-weight:600' }, 'Через туннель'),
			elSpeedLists.tunnel,
			mkAddSpeedRow('tunnel'),
			E('div', { style:'font-size:13px;color:var(--mut);margin:16px 0 8px;font-weight:600' }, 'Напрямую'),
			elSpeedLists.direct,
			mkAddSpeedRow('direct'),
			E('div', { 'class': 'tv-sys-actions', style: 'margin-top:14px' }, [btnSpeedSave, btnSpeedReset]),
			speedMsg
		]);

		// -- частота обновления главной панели (карточка "Мониторинг" — статус/скорость/CPU/RAM) --
		var pollMsg = E('div', { 'class': 'tv-msg' }, '');
		var inPollInterval = E('input', { type: 'number', min: '4', max: '120', 'class': 'tv-inp', style: 'max-width:120px', value: pollInterval });
		var btnPollSave = E('button', {
			'class': 'tv-btn acc', type: 'button', click: function () {
				var v = parseInt(inPollInterval.value, 10);
				if (!v || v < 4 || v > 120) { inPollInterval.focus(); return; }
				pollMsg.textContent = 'Сохраняю…';
				fs.write(POLL_INTERVAL_FILE, JSON.stringify({ seconds: v })).then(function () {
					pollMsg.textContent = '✓ Сохранено — обновите главную панель';
				}).catch(function () { pollMsg.textContent = '⛔ Ошибка сохранения'; });
			}
		}, 'Сохранить');
		var pollCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [E('h3', {}, 'Частота обновления панели')]),
			E('div', { 'class': 'tv-hint' }, 'Как часто карточка «Мониторинг» (статус/скорость/CPU/RAM) опрашивает роутер, в секундах. Остальные блоки (клиенты, домены, профили и т.д.) сами по себе не обновляются периодически — только по кнопке или явному действию, так что отдельного интервала для них нет и не требуется. Панель также сама реже опрашивает роутер, если вкладка скрыта или ей не пользуются несколько минут подряд — эта настройка только про верхнюю границу при активном использовании.'),
			E('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [inPollInterval, E('span', { style: 'color:var(--mut);font-size:13px' }, 'секунд'), btnPollSave]),
			pollMsg
		]);

		var cards = BLOCKS.map(buildBlock);
		cards.push(udpCard);
		cards.push(configCard);
		cards.push(orderCard);
		cards.push(speedSourcesCard);
		cards.push(pollCard);

		return E('div', { 'class': 'tv' }, [
			E('style', {}, STYLE),
			E('div', { 'class': 'tv-wrap' }, [
				E('div', { 'class': 'tv-top' }, [
					E('h2', { style: 'margin:0;font-size:20px' }, 'MagnumOpusPlus — микротюнинг'),
					E('div', { style: 'display:flex;gap:14px' }, [
						E('a', { href: '/tinyvless/dev/' }, 'Для разработчиков'),
						E('a', { href: '/tinyvless/' }, '← Основная панель')
					])
				]),
				E('div', { 'class': 'tv-actions' }, [btnApply, btnReset]),
				msg
			].concat(cards))
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
