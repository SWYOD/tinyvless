'use strict';
// MagnumOpusPlus V10 — страница "для разработчиков" /tinyvless/dev/
// Первый блок: beta-метки блоков главной панели (задел под дальнейшую кастомизацию/инструменты).

var BETA_FLAGS_FILE = '/etc/tinyvless/beta_flags.json';
// тот же канонический список, что в app4.js/microtun.js — держать в синхроне вручную,
// это независимые файлы морды.
var CARD_DEFAULT_ORDER = ['status', 'net', 'control', 'speed', 'clients', 'prof', 'dom', 'dns', 'reach', 'system'];
var CARD_LABELS = {
	status: 'Мониторинг', net: 'Модем', control: 'Проксирование', speed: 'Speedtest',
	clients: 'Клиенты LAN', prof: 'Профили', dom: 'Домены маршрутизации', dns: 'DNS-резолв',
	reach: 'Проверка доступности', system: 'Система'
};

var STYLE = [
	'.tv { --acc:#3fb950; --acc-bd:#2ea043; --acc-bg:rgba(46,160,67,.13); --mut:#8b949e; --bd:rgba(139,148,158,.28); }',
	'.tv-wrap{ max-width:900px; margin:0 auto; padding-bottom:24px; }',
	'.tv-card{ border:1px solid var(--bd); border-radius:12px; padding:16px 18px; margin:0 0 16px; background:rgba(127,127,127,.04); }',
	'.tv-card-h{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }',
	'.tv-card-h h3{ margin:0; font-size:16px; flex:1 1 auto; min-width:0; }',
	'.tv-hint{ font-size:12px; color:var(--mut); margin:0 0 12px; line-height:1.4; }',
	'.tv-btn{ display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:8px 16px; border-radius:9px; border:1.5px solid var(--bd); background:transparent; color:inherit; cursor:pointer; font-size:14px; font-family:inherit; }',
	'.tv-btn.acc{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-msg{ font-size:13px; color:var(--mut); margin-top:10px; min-height:1.2em; }',
	'.tv-top{ display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:8px; }',
	'.tv-top a{ color:var(--acc); text-decoration:none; font-size:14px; }',
	'.tv-dom-list{ display:flex; flex-direction:column; gap:8px; }',
	'.tv-dom-chip{ display:flex; align-items:center; gap:12px; padding:10px 12px; border:1.5px solid var(--bd); border-radius:10px; background:rgba(127,127,127,.06); }',
	'.tv-dom-chip .nm{ font-size:14px; flex:1 1 auto; }',
	'.tv-sw{ position:relative; width:44px; height:24px; flex:0 0 auto; }',
	'.tv-sw input{ opacity:0; width:0; height:0; position:absolute; }',
	'.tv-sw .sl{ position:absolute; inset:0; background:rgba(139,148,158,.35); border-radius:24px; cursor:pointer; transition:.15s; }',
	'.tv-sw .sl:before{ content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.15s; }',
	'.tv-sw input:checked + .sl{ background:var(--acc-bd); }',
	'.tv-sw input:checked + .sl:before{ transform:translateX(20px); }',
	'.tv-beta-chip-tag{ font-size:10.5px; font-weight:700; letter-spacing:.04em; color:var(--acc); border:1px solid var(--acc-bd); background:var(--acc-bg); padding:1px 7px; border-radius:6px; }'
].join('\n');

return view.extend({
	load: function () {
		return Promise.all([
			fs.read(BETA_FLAGS_FILE).catch(function () { return ''; })
		]);
	},
	render: function (data) {
		var betaFlags = (function () {
			try { var a = JSON.parse(data[0] || ''); return Array.isArray(a) ? a.filter(function (k) { return CARD_LABELS[k] != null; }) : []; }
			catch (e) { return []; }
		})();

		var msg = E('div', { 'class': 'tv-msg' }, '');
		var elList = E('div', { 'class': 'tv-dom-list' });
		function renderList() {
			elList.innerHTML = '';
			CARD_DEFAULT_ORDER.forEach(function (key) {
				var sw = E('input', { type: 'checkbox' });
				sw.checked = betaFlags.indexOf(key) !== -1;
				sw.addEventListener('change', function () {
					var i = betaFlags.indexOf(key);
					if (sw.checked) { if (i === -1) betaFlags.push(key); }
					else if (i !== -1) { betaFlags.splice(i, 1); }
				});
				elList.appendChild(E('div', { 'class': 'tv-dom-chip' }, [
					E('label', { 'class': 'tv-sw' }, [sw, E('span', { 'class': 'sl' })]),
					E('span', { 'class': 'nm' }, CARD_LABELS[key]),
					sw.checked ? E('span', { 'class': 'tv-beta-chip-tag' }, 'BETA') : null
				]));
			});
		}
		renderList();
		// перерисовываем чипы после каждого клика, чтобы плашка BETA у имени сразу появлялась/пропадала
		elList.addEventListener('change', function () { renderList(); });

		var btnSave = E('button', {
			'class': 'tv-btn acc', type: 'button', click: function () {
				msg.textContent = 'Сохраняю…';
				fs.write(BETA_FLAGS_FILE, JSON.stringify(betaFlags)).then(function () {
					msg.textContent = '✓ Сохранено — обновите главную панель';
				}).catch(function () { msg.textContent = '⛔ Ошибка сохранения'; });
			}
		}, 'Сохранить');

		var betaCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [E('h3', {}, 'Beta-метки блоков')]),
			E('div', { 'class': 'tv-hint' }, 'Отметьте блок как beta — на главной панели над ним появится зелёная плашка «BETA». Удобно помечать свежие/экспериментальные функции, не трогая остальной интерфейс.'),
			elList,
			E('div', { style: 'margin-top:12px' }, [btnSave]),
			msg
		]);

		// Роадмап — известные ограничения текущего железа и то, что осознанно отложено,
		// а не забыто. Статичная карточка, ничего не пишет/не читает — просто чтобы решение
		// и его причина не потерялись между сессиями.
		var roadmapCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-card-h' }, [E('h3', {}, 'Роадмап / известные ограничения')]),
			E('div', { 'class': 'tv-dom-list' }, [
				E('div', { 'class': 'tv-dom-chip', style: 'align-items:flex-start' }, [
					E('span', { 'class': 'nm' }, [
						E('b', {}, 'Горячее подключение USB-модема — отложено'),
						E('div', { 'class': 'tv-hint', style: 'margin:4px 0 0' },
							'Cudy LT300: /overlay всего 3.7МБ свободно (/rom забит на 100%) — ' +
							'QMI/MBIM-стек (kmod-usb-net-qmi-wwan, uqmi, cdc-mbim) физически не влезает. ' +
							'RNDIS/CDC-ECM-модемы (как встроенный) и AT-диагностика через option-драйвер ' +
							'технически возможны уже сейчас без новых пакетов, но полноценный hotplug ' +
							'с автоопределением типа модема и мобильным интернетом через QMI/MBIM ждёт ' +
							'более мощного железа — серия Cudy TR с бóльшим flash/RAM.')
					])
				])
			])
		]);

		return E('div', { 'class': 'tv' }, [
			E('style', {}, STYLE),
			E('div', { 'class': 'tv-wrap' }, [
				E('div', { 'class': 'tv-top' }, [
					E('h2', { style: 'margin:0;font-size:20px' }, 'Для разработчиков'),
					E('a', { href: '/tinyvless/' }, '← Основная панель')
				]),
				betaCard,
				roadmapCard
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
