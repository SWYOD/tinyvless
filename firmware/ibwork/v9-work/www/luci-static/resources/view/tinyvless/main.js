'use strict';
'require view';
'require fs';
'require ui';
'require poll';

// ============ tinyvless морда v4 ============
// Карточки: Статус · Управление · Профили · Домены · DNS-резолв.
// Хранилище профилей: /etc/tinyvless/links.json = [{id,name,link,active}].
// Активная ссылка дублируется в config VLESS_LINK (init читает её без парсинга JSON).

var CFG = '/etc/tinyvless/config';
var LINKS = '/etc/tinyvless/links.json';
var DIRECT = '/etc/tinyvless/direct_domains.list';
var TUNNEL = '/etc/tinyvless/tunnel_domains.list';
var POISONED = '/etc/tinyvless/poisoned_domains.list';
var TESTFILE = '/etc/tinyvless/testlink.txt';

// ---------- inline-SVG иконки (Tabler-стиль, stroke) ----------
var ICONS = {
	route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h3.5"/>',
	shield: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/><circle cx="12" cy="11" r="1"/><path d="M12 12v2.5"/>',
	arrow: '<path d="M5 12h14"/><path d="M13 18l6 -6"/><path d="M13 6l6 -6" transform="translate(0,12)"/>',
	arrowr: '<path d="M5 12h14"/><path d="M15 16l4 -4"/><path d="M15 8l4 4"/>',
	checkf: '<path fill="currentColor" stroke="none" d="M17 3.34a10 10 0 1 1 -14.995 8.984l-.005 -.324l.005 -.324a10 10 0 0 1 14.995 -8.336zm-1.293 5.953a1 1 0 0 0 -1.414 -.083l-.094 .083l-3.293 3.292l-1.293 -1.292l-.094 -.083a1 1 0 0 0 -1.32 1.497l.083 .094l2 2l.094 .083a1 1 0 0 0 1.32 -.083l4 -4l.083 -.094a1 1 0 0 0 -.083 -1.414z"/>',
	circle: '<circle cx="12" cy="12" r="9"/>',
	edit: '<path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"/><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"/><path d="M16 5l3 3"/>',
	plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
	x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
	broadcast: '<path d="M18.364 19.364a9 9 0 1 0 -12.728 0"/><path d="M15.536 16.536a5 5 0 1 0 -7.072 0"/><circle cx="12" cy="12" r="1"/>',
	loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
	power: '<path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4l0 8"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35 -4.35"/>'
};

function ic(name, size, cls) {
	var s = size || 20;
	var el = document.createElement('span');
	el.className = 'tv-ic' + (cls ? ' ' + cls : '');
	el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s +
		'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
		'stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
	return el;
}

// ---------- утилиты ----------
function uid() { return 'p' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

var MODE_LABEL = { selective: 'Селективный', full: 'В туннель', off: 'Напрямую' };
var DOH_LABEL = { off: 'Только резолверы', smart: 'Умный (по списку)', full: 'Всегда DoH' };

function parseConfig(txt) {
	var o = { link: '', mode: 'selective', dnsPrimary: '77.88.8.8', dnsFallback: '77.88.8.1', dohMode: 'smart' };
	(txt || '').split('\n').forEach(function (l) {
		var m;
		if ((m = l.match(/^\s*VLESS_LINK\s*=\s*['"]?([^'"]*)['"]?\s*$/))) o.link = m[1];
		else if ((m = l.match(/^\s*MODE\s*=\s*['"]?(\w+)['"]?/))) o.mode = m[1];
		else if ((m = l.match(/^\s*DNS_PRIMARY\s*=\s*['"]?([^'"]*)['"]?/))) o.dnsPrimary = m[1];
		else if ((m = l.match(/^\s*DNS_FALLBACK\s*=\s*['"]?([^'"]*)['"]?/))) o.dnsFallback = m[1];
		else if ((m = l.match(/^\s*DOH_MODE\s*=\s*['"]?(\w+)['"]?/))) o.dohMode = m[1];
	});
	return o;
}

function isValidIPv4(s) {
	return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test((s || '').trim());
}

function setKV(txt, key, val) {
	var lines = (txt || '').split('\n');
	var re = new RegExp('^\\s*' + key + '\\s*=');
	var found = false;
	for (var i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) { lines[i] = key + "='" + val + "'"; found = true; break; }
	}
	if (!found) lines.push(key + "='" + val + "'");
	return lines.join('\n');
}

// краткое описание профиля: "host · ws · tls"
function linkSummary(link) {
	try {
		var host = (link.match(/^vless:\/\/[^@]*@([^:/?]+)/) || [])[1] || '?';
		var q = (link.split('?')[1] || '');
		var type = (q.match(/type=([^&]+)/) || [])[1] || 'tcp';
		var sec = (q.match(/security=([^&]+)/) || [])[1] || 'none';
		return host + ' · ' + type + ' · ' + sec;
	} catch (e) { return link.slice(0, 40); }
}

function fmtBytes(n) {
	n = n || 0;
	var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

// tinyvless умеет ТОЛЬКО VLESS+WebSocket+TLS. Возвращает причину, если ссылка не такая (иначе null).
function linkUnsupported(link) {
	if (!/^vless:\/\//.test(link)) return 'ссылка должна начинаться с vless://';
	var q = (link.split('?')[1] || '').split('#')[0];
	var type = (q.match(/(?:^|&)type=([^&]+)/) || [])[1] || 'tcp';
	var sec = (q.match(/(?:^|&)security=([^&]+)/) || [])[1] || 'none';
	if (/reality/i.test(sec)) return 'Reality не поддерживается (нужен WS+TLS)';
	if (/xtls/i.test(q)) return 'XTLS/Vision не поддерживается';
	if (type !== 'ws') return 'транспорт «' + type + '» не поддерживается — нужен WebSocket (type=ws)';
	if (sec !== 'tls') return 'нужен security=tls (в ссылке: ' + sec + ')';
	return null;
}

// ---------- CSS (тёмная тема LuCI) ----------
var STYLE = [
	'.tv { --acc:#3fb950; --acc-bd:#2ea043; --acc-bg:rgba(46,160,67,.13); --mut:#8b949e; --bd:rgba(139,148,158,.28); }',
	'.tv .tv-ic{ display:inline-flex; align-items:center; vertical-align:middle; }',
	'.tv .tv-ic svg{ display:block; }',
	'.tv-card{ border:1px solid var(--bd); border-radius:12px; padding:16px 18px; margin:0 0 16px; background:rgba(127,127,127,.04); }',
	'.tv-card > .tv-h{ display:flex; align-items:center; justify-content:space-between; margin:0 0 14px; }',
	'.tv-card .tv-h h3{ margin:0; font-size:16px; font-weight:600; display:flex; align-items:center; gap:8px; }',
	'.tv-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; }',
	'.tv-dot{ width:10px; height:10px; border-radius:50%; background:var(--mut); flex:0 0 auto; box-shadow:0 0 0 3px rgba(139,148,158,.15); }',
	'.tv-dot.on{ background:var(--acc); box-shadow:0 0 0 3px var(--acc-bg); }',
	'.tv-modes{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin:6px 0 4px; }',
	'.tv-mode{ display:flex; flex-direction:column; align-items:center; gap:6px; padding:12px 6px; border:1.5px solid var(--bd); border-radius:10px; background:transparent; color:var(--mut); cursor:pointer; font-size:13px; font-weight:500; transition:.12s; text-align:center; }',
	'.tv-mode:hover:not(.act):not([disabled]){ border-color:var(--mut); color:inherit; }',
	'.tv-mode.act{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-mode[disabled]{ opacity:.4; cursor:not-allowed; }',
	'.tv-lbl{ font-size:13px; color:var(--mut); margin:12px 0 2px; }',
	'.tv-lbl b{ color:inherit; font-weight:600; }',
	'.tv-hint{ font-size:12px; color:var(--mut); margin:4px 0 2px; line-height:1.4; }',
	'.tv-info{ display:flex; align-items:flex-start; gap:9px; font-size:12.5px; color:var(--mut); line-height:1.45; background:rgba(139,148,158,.08); border-radius:9px; padding:9px 11px; margin-bottom:14px; }',
	'.tv-info b{ color:inherit; }',
	'.tv-btn{ display:inline-flex; align-items:center; gap:7px; padding:8px 16px; border-radius:9px; border:1.5px solid var(--bd); background:transparent; color:inherit; cursor:pointer; font-size:14px; font-weight:500; transition:.12s; }',
	'.tv-btn:hover{ border-color:var(--mut); }',
	'.tv-btn.acc{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-btn.danger{ border-color:rgba(248,81,73,.5); color:#f85149; }',
	'.tv-btn.danger:hover{ background:rgba(248,81,73,.1); }',
	'.tv-btn.small{ padding:5px 10px; font-size:13px; }',
	'.tv-btn[disabled]{ opacity:.5; cursor:not-allowed; }',
	'.tv-sw{ position:relative; width:44px; height:24px; flex:0 0 auto; }',
	'.tv-sw input{ opacity:0; width:0; height:0; position:absolute; }',
	'.tv-sw .sl{ position:absolute; inset:0; background:rgba(139,148,158,.35); border-radius:24px; cursor:pointer; transition:.15s; }',
	'.tv-sw .sl:before{ content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.15s; }',
	'.tv-sw input:checked + .sl{ background:var(--acc-bd); }',
	'.tv-sw input:checked + .sl:before{ transform:translateX(20px); }',
	'.tv-prof{ display:flex; align-items:center; gap:12px; padding:11px 13px; border:1.5px solid var(--bd); border-radius:10px; margin-bottom:8px; cursor:pointer; transition:.12s; }',
	'.tv-prof:hover{ border-color:var(--mut); }',
	'.tv-prof.act{ border-color:var(--acc-bd); background:var(--acc-bg); cursor:default; }',
	'.tv-prof .ci{ flex:0 0 auto; color:var(--mut); display:flex; }',
	'.tv-prof.act .ci{ color:var(--acc); }',
	'.tv-prof .nm{ flex:1 1 auto; min-width:0; }',
	'.tv-prof .nm b{ display:block; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
	'.tv-prof.act .nm b{ color:var(--acc); }',
	'.tv-prof .nm small{ color:var(--mut); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }',
	'.tv-prof .pen{ flex:0 0 auto; color:var(--mut); padding:5px; border-radius:7px; }',
	'.tv-prof .pen:hover{ color:inherit; background:rgba(139,148,158,.15); }',
	'.tv-prof.bad{ border-color:rgba(210,153,34,.5); }',
	'.tv-prof.bad .ci{ color:#d29922; }',
	'.tv-badge{ font-size:11px; color:#d29922; border:1px solid rgba(210,153,34,.5); border-radius:6px; padding:1px 6px; white-space:nowrap; flex:0 0 auto; }',
	'.tv-badge.ok{ color:var(--acc); border-color:var(--acc-bd); }',
	'.tv-badge.dead{ color:#f85149; border-color:rgba(248,81,73,.5); }',
	'.tv-badge.testing{ color:var(--mut); border-color:var(--bd); }',
	'.tv-prof.dead{ border-color:rgba(248,81,73,.4); }',
	'.tv-status{ border:1.5px solid var(--acc-bd); border-radius:12px; padding:16px 18px; background:transparent; margin:0 0 16px; }',
	'.tv-status.down{ border-color:rgba(248,81,73,.5); }',
	'.tv-status table{ width:100%; margin:0; }',
	'.tv-status td{ padding:5px 4px; border:0; }',
	'.tv-status td.k{ color:var(--mut); width:190px; }',
	'.tv-ta{ width:100%; font-family:monospace; font-size:13px; border-radius:8px; }',
	'.tv-modal-fld{ margin-bottom:14px; }',
	'.tv-modal-fld label{ display:block; font-size:13px; color:var(--mut); margin-bottom:5px; }',
	'.tv-modal-fld input,.tv-modal-fld textarea{ width:100%; box-sizing:border-box; }',
	'@keyframes tvspin{ to{ transform:rotate(360deg); } }',
	'.tv-spin{ animation:tvspin 1s linear infinite; display:inline-flex; }',
	// неблокирующий баннер прогресса (не мешает пользоваться интерфейсом)
	'.tv-banner{ display:none; align-items:center; gap:11px; padding:10px 14px; border-radius:10px; margin:0 0 14px; border:1.5px solid var(--bd); font-size:14px; }',
	'.tv-banner.show{ display:flex; }',
	'.tv-banner.busy{ border-color:var(--acc-bd); }',
	'.tv-banner.ok{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-banner.err{ border-color:rgba(248,81,73,.5); color:#f85149; background:rgba(248,81,73,.08); }',
	'.tv-banner .bt{ flex:0 0 auto; font-weight:500; }',
	'.tv-banner .track{ flex:1 1 auto; height:6px; border-radius:4px; background:rgba(139,148,158,.2); overflow:hidden; position:relative; }',
	'.tv-banner.busy .track:after{ content:""; position:absolute; left:-45%; width:45%; height:100%; background:var(--acc-bd); border-radius:4px; animation:tvindet 1.05s ease-in-out infinite; }',
	'@keyframes tvindet{ 0%{left:-45%} 100%{left:100%} }',
	'.tv-banner.ok .track, .tv-banner.err .track{ visibility:hidden; }',
	'.tv-inp{ width:100%; box-sizing:border-box; font-family:monospace; font-size:13px; border-radius:8px; background:rgba(127,127,127,.08); color:inherit; border:1px solid var(--bd); padding:8px 10px; }',
	'.tv-dns-row{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:4px; }',
	'.tv-check-row{ display:flex; gap:8px; align-items:center; margin-top:6px; }',
	'.tv-check-row .tv-inp{ flex:1 1 auto; }',
	'.tv-check-result{ margin-top:10px; padding:10px 12px; border-radius:9px; border:1px solid var(--bd); font-size:13px; line-height:1.45; display:none; }',
	'.tv-check-result.show{ display:block; }',
	'.tv-check-result.poisoned{ border-color:rgba(248,81,73,.5); background:rgba(248,81,73,.08); }',
	'.tv-check-result.clean{ border-color:var(--acc-bd); background:var(--acc-bg); }',
	'@media(max-width:480px){ .tv-dns-row{ grid-template-columns:1fr; } }'
].join('\n');

// Неблокирующий опрос /status до running:true. done(true|false) вызывается ровно один раз.
// КРИТИЧНО: дедлайн проверяется и в ветке ошибки fs.exec (иначе под нагрузкой rpcd висит и
// цикл крутится вечно — из-за этого раньше зависала блокирующая модалка).
function waitRunningPoll(timeoutSec, done) {
	var deadline = Date.now() + (timeoutSec || 45) * 1000;
	var finished = false;
	function finish(ok) { if (!finished) { finished = true; done(ok); } }
	(function loop() {
		if (finished) return;
		if (Date.now() > deadline) return finish(false);
		fs.exec('/etc/tinyvless/api.sh', ['status']).then(function (r) {
			if (/"running":true/.test(r.stdout || '')) return finish(true);
			setTimeout(loop, 1600);
		}).catch(function () { setTimeout(loop, 1600); });
	})();
}

return view.extend({
	load: function () {
		return Promise.all([
			fs.read(CFG).catch(function () { return ''; }),
			fs.read(LINKS).catch(function () { return ''; }),
			fs.read(DIRECT).catch(function () { return ''; }),
			fs.read(TUNNEL).catch(function () { return ''; }),
			fs.read(POISONED).catch(function () { return ''; }),
			fs.exec('/etc/tinyvless/api.sh', ['state']).then(function (r) { return r.stdout; }).catch(function () { return '{}'; })
		]);
	},

	render: function (data) {
		var self = this;
		var cfg = parseConfig(data[0]);
		var st = {
			rawCfg: data[0] || '', mode: cfg.mode, running: false, autostart: false, profiles: [], ruSubnets: 0,
			dnsPrimary: cfg.dnsPrimary, dnsFallback: cfg.dnsFallback, dohMode: cfg.dohMode
		};

		// state из api.sh
		try {
			var js = JSON.parse(data[5] || '{}');
			st.running = !!js.running; st.autostart = !!js.autostart; st.ruSubnets = js.ru_subnets || 0;
			if (js.dns_primary) st.dnsPrimary = js.dns_primary;
			if (js.dns_fallback) st.dnsFallback = js.dns_fallback;
			if (js.doh_mode) st.dohMode = js.doh_mode;
		} catch (e) {}

		// профили: из links.json, иначе миграция из config
		try { st.profiles = JSON.parse(data[1] || '[]'); } catch (e) { st.profiles = []; }
		if (!Array.isArray(st.profiles) || !st.profiles.length) {
			st.profiles = cfg.link ? [{ id: uid(), name: 'Профиль 1', link: cfg.link, active: true }] : [];
		}
		if (st.profiles.length && !st.profiles.some(function (p) { return p.active; })) st.profiles[0].active = true;

		function activeProfile() { return st.profiles.filter(function (p) { return p.active; })[0] || null; }
		function saveLinks() { return fs.write(LINKS, JSON.stringify(st.profiles)); }

		// транзиентный статус проверки профилей (не сохраняется): id -> 'testing'|'ok'|'blocked'
		var testStatus = {}, testIP = {}, testErr = {}, testingAll = false;

		// Проверить один профиль: пишем ссылку в файл, дёргаем testlink (поднимает туннель, берёт exit-IP).
		function testProfile(p) {
			testStatus[p.id] = 'testing'; renderProfiles();
			return fs.write(TESTFILE, p.link)
				.then(function () { return fs.exec('/etc/tinyvless/api.sh', ['testlink']); })
				.then(function (r) {
					var res; try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) { res = null; }
					if (res && res.ok) { testStatus[p.id] = 'ok'; testIP[p.id] = res.ip; delete testErr[p.id]; }
					else { testStatus[p.id] = 'blocked'; testErr[p.id] = (res && res.error) || 'не отвечает'; }
				})
				.catch(function () { testStatus[p.id] = 'blocked'; testErr[p.id] = 'ошибка проверки'; })
				.then(function () { renderProfiles(); });
		}

		// Проверить ВСЕ профили по очереди (по одному тест-инстансу — бережём RAM), с живой подсветкой.
		function testAllProfiles() {
			if (testingAll) return;
			var list = st.profiles.filter(function (p) { return !linkUnsupported(p.link); });
			if (!list.length) { ui.addNotification(null, E('p', 'Нет профилей WS/TLS для проверки'), 'warning'); return; }
			testingAll = true; renderProfiles();
			var i = 0;
			(function next() {
				if (i >= list.length) { testingAll = false; renderProfiles(); return; }
				testProfile(list[i++]).then(next);
			})();
		}

		// ====== мелкие рендер-функции (обновляют DOM на месте) ======
		var elDot, elStateTxt, btnPower, modeBtns = {}, elProfList, elAutoSw;

		// --- неблокирующий баннер прогресса ---
		var elBanner = E('div', { 'class': 'tv-banner' }, [E('span', { 'class': 'bt' }, ''), E('span', { 'class': 'track' })]);
		var busyOn = false, bannerTimer = null;
		function bannerShow(t) { if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; } elBanner.firstChild.textContent = t; elBanner.className = 'tv-banner show busy'; }
		function bannerOk(t) { elBanner.firstChild.textContent = '✓ ' + t; elBanner.className = 'tv-banner show ok'; bannerTimer = setTimeout(function () { elBanner.className = 'tv-banner'; }, 2200); }
		function bannerErr(t) { elBanner.firstChild.textContent = '✕ ' + t; elBanner.className = 'tv-banner show err'; bannerTimer = setTimeout(function () { elBanner.className = 'tv-banner'; }, 4500); }
		// блокируем органы управления на время перехода (защита от наложения операций → OOM)
		function setBusy(on) { busyOn = on; renderControlHeader(); renderProfiles(); }

		function renderControlHeader() {
			elDot.className = 'tv-dot' + (st.running ? ' on' : '');
			elStateTxt.textContent = st.running ? 'Проксирование включено' : 'Проксирование выключено';
			btnPower.className = 'tv-btn ' + (st.running ? 'danger' : 'acc');
			btnPower.innerHTML = '';
			btnPower.appendChild(ic('power', 18));
			btnPower.appendChild(document.createTextNode(st.running ? ' Выключить' : ' Включить'));
			if (busyOn) btnPower.setAttribute('disabled', ''); else btnPower.removeAttribute('disabled');
			Object.keys(modeBtns).forEach(function (m) {
				var b = modeBtns[m];
				b.className = 'tv-mode' + (st.mode === m ? ' act' : '');
				if (st.running && !busyOn) b.removeAttribute('disabled'); else b.setAttribute('disabled', '');
			});
		}

		function renderProfiles() {
			elProfList.innerHTML = '';
			if (!st.profiles.length) {
				elProfList.appendChild(E('div', { style: 'color:var(--mut);font-size:13px;padding:6px 0' }, 'Профилей нет. Нажми «Добавить».'));
				return;
			}
			st.profiles.forEach(function (p) {
				var bad = linkUnsupported(p.link);
				var stt = testStatus[p.id]; // 'testing' | 'ok' | 'blocked' | undefined
				var kids = [
					E('span', { 'class': 'ci' }, [ic(p.active ? 'checkf' : 'circle', 22)]),
					E('div', { 'class': 'nm' }, [E('b', {}, p.name || '(без имени)'), E('small', {}, linkSummary(p.link))])
				];
				// статусный бейдж: приоритет — неподдерживаемый тип, затем результат проверки
				var deadCls = '';
				if (bad) kids.push(E('span', { 'class': 'tv-badge', title: bad }, 'не WS/TLS'));
				else if (stt === 'testing') kids.push(E('span', { 'class': 'tv-badge testing' }, '⟳ проверка…'));
				else if (stt === 'ok') kids.push(E('span', { 'class': 'tv-badge ok', title: 'внешний IP через этот профиль' }, '✓ ' + (testIP[p.id] || 'работает')));
				else if (stt === 'blocked') { kids.push(E('span', { 'class': 'tv-badge dead', title: testErr[p.id] || '' }, '✕ недоступен')); deadCls = ' dead'; }
				kids.push(E('span', { 'class': 'pen', click: function (ev) { ev.stopPropagation(); if (!busyOn) openProfileModal(p); } }, [ic('edit', 18)]));
				var row = E('div', { 'class': 'tv-prof' + (p.active ? ' act' : '') + (bad ? ' bad' : '') + deadCls, style: busyOn ? 'opacity:.55' : '' }, kids);
				if (!p.active && !busyOn) row.addEventListener('click', function () { activateProfile(p); });
				elProfList.appendChild(row);
			});
		}

		// ====== действия (все неблокирующие: баннер + poll, органы блокируются только на время) ======
		function setMode(m) {
			if (!st.running || st.mode === m || busyOn) return;
			var prev = st.mode; st.mode = m;
			setBusy(true); bannerShow('Переключаю режим…');
			fs.exec('/etc/tinyvless/api.sh', ['mode', m]).then(function (r) {
				if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
				st.rawCfg = setKV(st.rawCfg, 'MODE', m);
				setBusy(false); bannerOk('Режим применён: ' + (MODE_LABEL[m] || m));
			}).catch(function () { st.mode = prev; setBusy(false); bannerErr('Не удалось сменить режим'); });
		}

		function togglePower() {
			if (busyOn) return;
			if (st.running) {
				setBusy(true); bannerShow('Выключаю проксирование…');
				fs.exec('/etc/tinyvless/api.sh', ['stop']).then(function () {
					st.running = false; setBusy(false); bannerOk('Проксирование выключено');
				}).catch(function () { setBusy(false); bannerErr('Ошибка выключения'); });
			} else {
				setBusy(true); bannerShow('Запускаю tinyvless… поднимаю туннель (до ~50с)');
				fs.exec('/etc/tinyvless/api.sh', ['start']).then(function () {
					waitRunningPoll(55, function (ok) {
						st.running = ok; setBusy(false);
						if (ok) bannerOk('Проксирование включено'); else bannerErr('Не удалось запустить за 55с');
					});
				}).catch(function () { setBusy(false); bannerErr('Ошибка запуска'); });
			}
		}

		// Сделать профиль активным с рестартом и АВТО-ОТКАТОМ на предыдущий рабочий при неудаче.
		// extraRestore() — доп-откат мутаций (напр. вернуть отредактированную ссылку профиля).
		function activateProfile(p, extraRestore) {
			if (busyOn) return;
			var bad = linkUnsupported(p.link);
			if (bad) {
				ui.addNotification(null, E('p', 'Профиль «' + (p.name || '') + '»: ' + bad + '. Активация отменена.'), 'warning');
				if (extraRestore) { extraRestore(); saveLinks(); }
				renderProfiles();
				return;
			}
			var prevCfg = st.rawCfg;
			var prevActive = activeProfile();
			var prevActiveId = prevActive ? prevActive.id : null;
			st.profiles.forEach(function (x) { x.active = (x === p); });
			st.rawCfg = setKV(st.rawCfg, 'VLESS_LINK', p.link);
			setBusy(true); bannerShow('Переключаю профиль «' + (p.name || '') + '»…');
			Promise.all([saveLinks(), fs.write(CFG, st.rawCfg)]).then(function () {
				return fs.exec('/etc/tinyvless/api.sh', ['restart']);
			}).then(function () {
				waitRunningPoll(55, function (ok) {
					if (ok) { st.running = true; setBusy(false); bannerOk('Профиль: ' + (p.name || '')); return; }
					// ОТКАТ: профиль не поднялся — возвращаем предыдущий рабочий, чтобы не блэкхолить роутер
					if (extraRestore) extraRestore();
					st.rawCfg = prevCfg;
					st.profiles.forEach(function (x) { x.active = (x.id === prevActiveId); });
					bannerShow('Профиль не поднялся — возвращаю предыдущий рабочий…');
					Promise.all([saveLinks(), fs.write(CFG, prevCfg)]).then(function () {
						return fs.exec('/etc/tinyvless/api.sh', ['restart']);
					}).then(function () {
						waitRunningPoll(55, function (ok2) {
							st.running = ok2; setBusy(false);
							if (ok2) bannerErr('Профиль не поднялся — вернул предыдущий рабочий');
							else bannerErr('Не удалось поднять даже предыдущий — проверь сеть');
						});
					}).catch(function () { setBusy(false); bannerErr('Ошибка возврата'); });
				});
			}).catch(function () { setBusy(false); bannerErr('Ошибка переключения'); });
		}

		function openProfileModal(prof) {
			var isEdit = !!prof;
			var inName = E('input', { type: 'text', 'class': 'cbi-input-text', placeholder: 'напр. Нидерланды', value: isEdit ? (prof.name || '') : '' });
			var inLink = E('textarea', { 'class': 'tv-ta', rows: 4, placeholder: 'vless://…', style: 'height:90px' }, isEdit ? (prof.link || '') : '');
			var err = E('div', { style: 'color:#f85149;font-size:13px;min-height:16px;margin-bottom:8px' }, '');
			var testMsg = E('span', { style: 'font-size:13px;color:var(--mut)' }, '');
			var testBtn = E('button', { 'class': 'tv-btn small', style: 'flex:0 0 auto' }, 'Проверить');

			// Проверка ссылки: пишем кандидата в файл, дёргаем tinyvless -testlink (поднимает туннель,
			// получает exit-IP) — детектит белые списки/DPI-блок даже для валидной WS-ссылки.
			var testing = false;
			testBtn.addEventListener('click', function () {
				if (testing) return;
				var lk = inLink.value.trim();
				if (!/^vless:\/\//.test(lk)) { err.textContent = 'Сначала вставь vless://-ссылку'; return; }
				err.textContent = ''; testing = true;
				testBtn.setAttribute('disabled', ''); testMsg.style.color = 'var(--mut)';
				testMsg.textContent = '⟳ проверяю (до ~20с)…';
				fs.write(TESTFILE, lk)
					.then(function () { return fs.exec('/etc/tinyvless/api.sh', ['testlink']); })
					.then(function (r) {
						var res; try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) { res = null; }
						if (res && res.ok) { testMsg.style.color = 'var(--acc)'; testMsg.textContent = '✓ работает · внешний IP ' + res.ip; }
						else { testMsg.style.color = '#f85149'; testMsg.textContent = '✕ ' + ((res && res.error) || 'не отвечает'); }
					})
					.catch(function () { testMsg.style.color = '#f85149'; testMsg.textContent = '✕ ошибка проверки'; })
					.then(function () { testing = false; testBtn.removeAttribute('disabled'); });
			});

			function save() {
				var name = inName.value.trim(), link = inLink.value.trim();
				if (!/^vless:\/\//.test(link)) { err.textContent = 'Ссылка должна начинаться с vless://'; return; }
				// не блокируем сохранение неподдерживаемых (пусть лежат в списке с бейджем),
				// но предупреждаем — активировать их морда всё равно не даст.
				var bad = linkUnsupported(link);
				if (!name) name = linkSummary(link).split(' · ')[0];
				var oldLink, oldName;
				if (isEdit) {
					oldLink = prof.link; oldName = prof.name;
					prof.name = name; prof.link = link;
				} else {
					var np = { id: uid(), name: name, link: link, active: false };
					if (!st.profiles.length && !bad) np.active = true;
					st.profiles.push(np);
				}
				var wasActive = isEdit && prof.active;
				renderProfiles();
				saveLinks().then(function () {
					ui.hideModal();
					if (bad) ui.addNotification(null, E('p', 'Сохранено, но «' + name + '» — ' + bad + '. Этот профиль нельзя сделать активным.'), 'warning');
					if (wasActive) {
						// активный профиль изменился → переприменить с авто-откатом на старую ссылку при неудаче
						activateProfile(prof, function () { prof.link = oldLink; prof.name = oldName; });
					}
				});
			}

			var btns = [E('button', { 'class': 'tv-btn', click: ui.hideModal }, 'Отмена'),
				E('button', { 'class': 'tv-btn acc', style: 'margin-left:8px', click: save }, 'Сохранить')];
			if (isEdit) btns.unshift(E('button', {
				'class': 'tv-btn danger', style: 'margin-right:auto', click: function () {
					st.profiles = st.profiles.filter(function (x) { return x !== prof; });
					if (prof.active && st.profiles.length) st.profiles[0].active = true;
					renderProfiles(); saveLinks().then(ui.hideModal);
				}
			}, 'Удалить'));

			ui.showModal(null, E('div', { 'class': 'tv' }, [
				E('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px' }, [
					E('h4', { style: 'margin:0' }, isEdit ? 'Редактировать профиль' : 'Добавить профиль'),
					E('span', { style: 'cursor:pointer;color:var(--mut)', click: ui.hideModal }, [ic('x', 20)])
				]),
				E('div', { 'class': 'tv-modal-fld' }, [E('label', {}, 'Дружелюбное имя'), inName]),
				E('div', { 'class': 'tv-modal-fld' }, [E('label', {}, 'VLESS-ссылка'), inLink]),
				E('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [testBtn, testMsg]),
				err,
				E('div', { style: 'display:flex;align-items:center;margin-top:8px' }, btns)
			]), 'tv');
		}

		// ====== построение DOM ======
		// -- статус --
		var elState = E('span', { style: 'font-weight:600' }, '…'), elIP = E('span', {}, '—'),
			elDown = E('span', {}, '—'), elUp = E('span', {}, '—'), elActive = E('span', {}, '—'), elServer = E('span', {}, '—');
		var statusBox = E('div', { 'class': 'tv-status' }, [
			E('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' }, [ic('broadcast', 20), E('b', { style: 'font-size:15px' }, 'Статус подключения')]),
			E('table', {}, [
				E('tr', {}, [E('td', { 'class': 'k' }, 'Состояние'), E('td', {}, elState)]),
				E('tr', {}, [E('td', { 'class': 'k' }, 'Сервер'), E('td', {}, elServer)]),
				E('tr', {}, [E('td', { 'class': 'k' }, 'Внешний IP (через туннель)'), E('td', {}, elIP)]),
				E('tr', {}, [E('td', { 'class': 'k' }, 'Скорость'), E('td', {}, [E('span', {}, [elDown]), E('span', { style: 'color:var(--mut)' }, '   ·   '), E('span', {}, [elUp])])]),
				E('tr', {}, [E('td', { 'class': 'k' }, 'Активных соединений'), E('td', {}, elActive)])
			])
		]);
		var prev = null, prevT = 0, offStreak = 0;
		poll.add(function () {
			return fs.exec('/etc/tinyvless/api.sh', ['status']).then(function (res) {
				var s; try { s = JSON.parse((res.stdout || '').trim()); } catch (e) { s = null; }
				var run = !!(s && s.running);
				// ДЕБАУНС: единичный false — обычно транзиентный таймаут /status во время apply-route/
				// рестарта dnsmasq (CPU-пик), проксирование при этом живо. Не мигаем: показываем «выкл»
				// только после 2 подряд неудач.
				if (!run) { offStreak++; if (offStreak < 2 && st.running) return; } else { offStreak = 0; }
				if (run !== st.running) { st.running = run; renderControlHeader(); }
				statusBox.className = 'tv-status' + (run ? '' : ' down');
				if (!run) {
					elState.textContent = '⛔ не запущен'; elState.style.color = '#f85149';
					elIP.textContent = elDown.textContent = elUp.textContent = elActive.textContent = '—'; prev = null; return;
				}
				elState.textContent = '● работает'; elState.style.color = 'var(--acc)';
				elServer.textContent = s.server || '—';
				elIP.textContent = s.exit_ip || '(проверяется…)';
				elActive.textContent = '' + (s.active || 0) + ' (всего ' + (s.total || 0) + ')';
				var now = Date.now();
				if (prev && now > prevT) {
					var dt = (now - prevT) / 1000;
					elDown.textContent = '↓ ' + fmtBytes((s.down_bytes - prev.down_bytes) / dt) + '/с';
					elUp.textContent = '↑ ' + fmtBytes((s.up_bytes - prev.up_bytes) / dt) + '/с';
				} else { elDown.textContent = '↓ …'; elUp.textContent = '↑ …'; }
				prev = s; prevT = now;
			});
		}, 8);

		// -- карточка Управление --
		elDot = E('span', { 'class': 'tv-dot' });
		elStateTxt = E('span', { style: 'font-weight:500' }, '');
		btnPower = E('button', { click: ui.createHandlerFn(this, togglePower) });
		['selective', 'full', 'off'].forEach(function (m) {
			var meta = { selective: ['route', 'Селективный'], full: ['shield', 'В туннель'], off: ['arrowr', 'Напрямую'] }[m];
			modeBtns[m] = E('button', { 'class': 'tv-mode', click: ui.createHandlerFn(self, function () { setMode(m); }) }, [ic(meta[0], 22), E('span', {}, meta[1])]);
		});
		elAutoSw = E('input', { type: 'checkbox' });
		elAutoSw.checked = st.autostart;
		elAutoSw.addEventListener('change', function () {
			var on = elAutoSw.checked;
			fs.exec('/etc/tinyvless/api.sh', ['autostart', on ? 'on' : 'off']).then(function () { st.autostart = on; })
				.catch(function () { elAutoSw.checked = !on; });
		});
		var controlCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-row', style: 'margin-bottom:16px' }, [
				E('div', { style: 'display:flex;align-items:center;gap:10px' }, [elDot, elStateTxt]),
				btnPower
			]),
			E('div', { 'class': 'tv-lbl' }, 'Режим маршрутизации'),
			E('div', { 'class': 'tv-modes' }, [modeBtns.selective, modeBtns.full, modeBtns.off]),
			E('div', { 'class': 'tv-row', style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--bd)' }, [
				E('span', { style: 'font-size:14px' }, 'Автозагрузка при старте роутера'),
				E('label', { 'class': 'tv-sw' }, [elAutoSw, E('span', { 'class': 'sl' })])
			])
		]);

		// -- карточка Профили --
		elProfList = E('div', {});
		var profCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-h' }, [
				E('h3', {}, 'Профили подключения'),
				E('div', { style: 'display:flex;gap:8px' }, [
					E('button', { 'class': 'tv-btn small', style: 'padding:6px 9px', title: 'Проверить доступность всех профилей', click: ui.createHandlerFn(this, function () { testAllProfiles(); }) }, [ic('broadcast', 18)]),
					E('button', { 'class': 'tv-btn small acc', click: ui.createHandlerFn(this, function () { openProfileModal(null); }) }, [ic('plus', 16), E('span', {}, 'Добавить')])
				])
			]),
			elProfList
		]);

		// -- карточка Домены --
		// показываем ТОЛЬКО реальные домены (без служебных #-комментариев из файла) — чтобы было
		// наглядно видно, что настроено, и легко редактировать.
		function parseDomains(txt) {
			return (txt || '').split('\n').map(function (s) { return s.trim(); })
				.filter(function (s) { return s && s.charAt(0) !== '#'; });
		}
		var taDirect = E('textarea', { 'class': 'tv-ta', style: 'height:110px', placeholder: 'например:\nsberbank.ru\ngosuslugi.ru\n\n(по одному домену в строке)' }, parseDomains(data[2]).join('\n'));
		var taTunnel = E('textarea', { 'class': 'tv-ta', style: 'height:90px', placeholder: 'например:\nchatgpt.com\nnotion.so\n\n(по одному домену в строке)' }, parseDomains(data[3]).join('\n'));
		var cntDirect = E('span', { style: 'color:var(--mut);font-weight:400' }, '');
		var cntTunnel = E('span', { style: 'color:var(--mut);font-weight:400' }, '');
		function updCounts() {
			cntDirect.textContent = ' · ' + parseDomains(taDirect.value).length + ' шт.';
			cntTunnel.textContent = ' · ' + parseDomains(taTunnel.value).length + ' шт.';
		}
		taDirect.addEventListener('input', updCounts);
		taTunnel.addEventListener('input', updCounts);
		updCounts();
		var domMsg = E('span', { style: 'margin-left:10px;color:var(--mut);font-size:13px' }, '');
		var domCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-h' }, [E('h3', {}, [ic('route', 18), E('span', {}, 'Домены маршрутизации')])]),
			E('div', { 'class': 'tv-info' }, [
				ic('shield', 16, 'tv-mut'),
				E('div', {}, [
					'В режиме «Селективный» уже автоматически используется встроенная база ',
					E('b', {}, (st.ruSubnets || '~8600') + ' российских IP-подсетей'),
					' — весь трафик на эти адреса и так идёт напрямую, без настройки. ',
					'Ниже — только ТВОИ дополнительные исключения (например, RU-сервис на зарубежном хостинге, который не попал в базу).'
				])
			]),
			E('div', { 'class': 'tv-lbl' }, [E('b', {}, 'Напрямую в обход туннеля'), cntDirect]),
			E('div', { 'class': 'tv-hint' }, 'Эти домены и их поддомены идут МИМО VLESS (напрямую). Для RU-сервисов на зарубежных CDN, банков, госуслуг.'),
			taDirect,
			E('div', { 'class': 'tv-lbl', style: 'margin-top:16px' }, [E('b', {}, 'Принудительно в туннель'), cntTunnel]),
			E('div', { 'class': 'tv-hint' }, 'Всегда через VLESS, даже если IP российский. Приоритет над всеми остальными правилами.'),
			taTunnel,
			E('div', { style: 'margin-top:14px' }, [
				E('button', {
					'class': 'tv-btn acc', click: ui.createHandlerFn(this, function () {
						if (busyOn) return;
						domMsg.textContent = 'применяю…';
						var dtxt = parseDomains(taDirect.value).join('\n') + '\n';
						var ttxt = parseDomains(taTunnel.value).join('\n') + '\n';
						return Promise.all([fs.write(DIRECT, dtxt), fs.write(TUNNEL, ttxt)])
							.then(function () { return fs.exec('/etc/tinyvless/api.sh', ['domains']); })
							.then(function () { updCounts(); domMsg.textContent = '✓ сохранено (применится при следующем DNS-запросе к домену)'; })
							.catch(function () { domMsg.textContent = '⛔ ошибка сохранения'; });
					})
				}, 'Сохранить домены'), domMsg
			])
		]);

		// -- карточка DNS-резолв --
		var dohBtns = {};
		function renderDohModes() {
			Object.keys(dohBtns).forEach(function (m) {
				dohBtns[m].className = 'tv-mode' + (st.dohMode === m ? ' act' : '');
			});
		}
		function setDohMode(m) {
			if (st.dohMode === m) return;
			st.dohMode = m;
			st.rawCfg = setKV(st.rawCfg, 'DOH_MODE', m);
			renderDohModes();
		}
		['off', 'smart', 'full'].forEach(function (m) {
			var meta = { off: ['arrowr', 'Только резолверы'], smart: ['route', 'Умный (по списку)'], full: ['shield', 'Всегда DoH'] }[m];
			dohBtns[m] = E('button', { 'class': 'tv-mode', click: ui.createHandlerFn(self, function () { setDohMode(m); }) }, [ic(meta[0], 22), E('span', {}, meta[1])]);
		});
		var inPrimary = E('input', { type: 'text', 'class': 'tv-inp', placeholder: '77.88.8.8', value: st.dnsPrimary });
		var inFallback = E('input', { type: 'text', 'class': 'tv-inp', placeholder: '77.88.8.1', value: st.dnsFallback });
		var inCheckDom = E('input', { type: 'text', 'class': 'tv-inp', placeholder: 'instagram.com' });
		var elCheckResult = E('div', { 'class': 'tv-check-result' });
		var btnAddPoison = E('button', { 'class': 'tv-btn small acc', style: 'display:none;margin-top:8px' }, 'Добавить в список DoH-исключений');
		var taPoison = E('textarea', { 'class': 'tv-ta', style: 'height:90px', placeholder: 'facebook.com\nx.com\n\n(по одному домену в строке)' }, parseDomains(data[4]).join('\n'));
		var cntPoison = E('span', { style: 'color:var(--mut);font-weight:400' }, '');
		var dnsMsg = E('span', { style: 'margin-left:10px;color:var(--mut);font-size:13px' }, '');
		var lastCheck = null;
		function updPoisonCount() {
			cntPoison.textContent = ' · ' + parseDomains(taPoison.value).length + ' шт.';
		}
		taPoison.addEventListener('input', updPoisonCount);
		updPoisonCount();
		function showCheckResult(res) {
			lastCheck = res;
			elCheckResult.innerHTML = '';
			btnAddPoison.style.display = 'none';
			if (!res || res.error) {
				elCheckResult.className = 'tv-check-result show poisoned';
				elCheckResult.appendChild(E('div', {}, '⛔ ' + ((res && res.error) || 'ошибка проверки')));
				return;
			}
			elCheckResult.className = 'tv-check-result show ' + (res.poisoned ? 'poisoned' : 'clean');
			elCheckResult.appendChild(E('div', {}, [
				E('b', {}, res.domain), ' — ',
				res.poisoned ? 'травлен' : 'не травлен'
			]));
			elCheckResult.appendChild(E('div', { style: 'margin-top:6px;color:var(--mut)' }, [
				'Основной: ', E('code', {}, res.primary || '—'), ' · DoH: ', E('code', {}, res.doh || '—')
			]));
			if (res.poisoned) btnAddPoison.style.display = 'inline-flex';
		}
		var checkingDom = false;
		var btnCheckDom = E('button', { 'class': 'tv-btn small acc', click: ui.createHandlerFn(this, function () {
			if (checkingDom) return;
			var d = inCheckDom.value.trim().replace(/^https?:\/\//, '').split('/')[0];
			if (!d || !/^[a-zA-Z0-9.-]+$/.test(d)) { showCheckResult({ error: 'введите корректный домен' }); return; }
			checkingDom = true; btnCheckDom.setAttribute('disabled', '');
			btnCheckDom.innerHTML = ''; btnCheckDom.appendChild(ic('loader', 16, 'tv-spin'));
			btnCheckDom.appendChild(document.createTextNode(' Проверка…'));
			fs.exec('/etc/tinyvless/api.sh', ['checkdomain', d]).then(function (r) {
				var res; try { res = JSON.parse((r.stdout || '').trim()); } catch (e) { res = null; }
				showCheckResult(res);
			}).catch(function () { showCheckResult({ error: 'ошибка запроса' }); })
				.then(function () {
					checkingDom = false; btnCheckDom.removeAttribute('disabled');
					btnCheckDom.innerHTML = ''; btnCheckDom.appendChild(ic('search', 16));
					btnCheckDom.appendChild(document.createTextNode(' Проверить'));
				});
		}) }, [ic('search', 16), E('span', {}, ' Проверить')]);
		btnAddPoison.addEventListener('click', function () {
			if (!lastCheck || !lastCheck.poisoned || !lastCheck.domain) return;
			var list = parseDomains(taPoison.value);
			if (list.indexOf(lastCheck.domain) >= 0) {
				dnsMsg.textContent = 'домен уже в списке';
				return;
			}
			list.push(lastCheck.domain);
			taPoison.value = list.join('\n');
			updPoisonCount();
			dnsMsg.textContent = '✓ ' + lastCheck.domain + ' добавлен (нажми «Сохранить DNS»)';
		});
		var dnsCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-h' }, [E('h3', {}, [ic('globe', 18), E('span', {}, 'DNS-резолв')])]),
			E('div', { 'class': 'tv-info' }, [
				ic('shield', 16, 'tv-mut'),
				E('div', {}, [
					'Yota травит DNS на своём резолвере. По умолчанию — быстрые резолверы (Яндекс), ',
					'DoH через туннель — точечно для доменов из списка ниже или для всего (режим «Всегда DoH»).'
				])
			]),
			E('div', { 'class': 'tv-lbl' }, 'Режим DoH'),
			E('div', { 'class': 'tv-modes' }, [dohBtns.off, dohBtns.smart, dohBtns.full]),
			E('div', { 'class': 'tv-lbl', style: 'margin-top:14px' }, 'Резолверы'),
			E('div', { 'class': 'tv-hint' }, 'Основной и резервный — оба редактируемые. Если среда изменится, поменяй адреса здесь.'),
			E('div', { 'class': 'tv-dns-row' }, [
				E('div', {}, [E('div', { 'class': 'tv-lbl' }, 'Основной'), inPrimary]),
				E('div', {}, [E('div', { 'class': 'tv-lbl' }, 'Резервный'), inFallback])
			]),
			E('div', { 'class': 'tv-lbl', style: 'margin-top:16px' }, 'Проверка домена на травлю'),
			E('div', { 'class': 'tv-hint' }, 'Сравнивает ответ основного резолвера и DoH. Разные IP у CDN — норма; травля — loopback/приватный адрес.'),
			E('div', { 'class': 'tv-check-row' }, [inCheckDom, btnCheckDom]),
			elCheckResult,
			btnAddPoison,
			E('div', { 'class': 'tv-lbl', style: 'margin-top:16px' }, [E('b', {}, 'Список DoH-исключений'), cntPoison]),
			E('div', { 'class': 'tv-hint' }, 'В режиме «Умный» эти домены резолвятся строго через DoH-туннель.'),
			taPoison,
			E('div', { style: 'margin-top:14px' }, [
				E('button', {
					'class': 'tv-btn acc', click: ui.createHandlerFn(this, function () {
						if (busyOn) return;
						var pri = inPrimary.value.trim();
						var fb = inFallback.value.trim();
						if (!isValidIPv4(pri)) { dnsMsg.textContent = '⛔ некорректный основной резолвер'; return; }
						if (!isValidIPv4(fb)) { dnsMsg.textContent = '⛔ некорректный резервный резолвер'; return; }
						dnsMsg.textContent = 'применяю…';
						st.dnsPrimary = pri; st.dnsFallback = fb;
						st.rawCfg = setKV(setKV(setKV(st.rawCfg, 'DNS_PRIMARY', pri), 'DNS_FALLBACK', fb), 'DOH_MODE', st.dohMode);
						var ptxt = parseDomains(taPoison.value).join('\n') + '\n';
						return Promise.all([fs.write(CFG, st.rawCfg), fs.write(POISONED, ptxt)])
							.then(function () { return fs.exec('/etc/tinyvless/api.sh', ['dnsapply']); })
							.then(function () {
								updPoisonCount();
								dnsMsg.textContent = '✓ DNS сохранён (' + (DOH_LABEL[st.dohMode] || st.dohMode) + ')';
							})
							.catch(function () { dnsMsg.textContent = '⛔ ошибка сохранения'; });
					})
				}, 'Сохранить DNS'), dnsMsg
			])
		]);
		renderDohModes();

		renderControlHeader();
		renderProfiles();

		return E('div', { 'class': 'tv' }, [
			E('style', {}, STYLE),
			E('h2', { style: 'display:flex;align-items:center;gap:9px' }, [ic('shield', 26), 'tinyvless — VLESS-роутер']),
			elBanner,
			statusBox,
			controlCard,
			profCard,
			domCard,
			dnsCard
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
