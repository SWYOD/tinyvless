'use strict';
'require view';
'require fs';
'require ui';
'require poll';

// ============ tinyvless морда v5 (MagnumOpusPlus V10) ============
// Карточки: Статус · Управление · Профили · Домены · DNS-резолв.
// Хранилище профилей: /etc/tinyvless/links.json = [{id,name,link,active}].
// Активная ссылка дублируется в config VLESS_LINK (init читает её без парсинга JSON).

var CFG = '/etc/tinyvless/config';
var LINKS = '/etc/tinyvless/links.json';
var DIRECT = '/etc/tinyvless/direct_domains.list';
var TUNNEL = '/etc/tinyvless/tunnel_domains.list';
var POISONED = '/etc/tinyvless/poisoned_domains.list';
var TESTFILE = '/etc/tinyvless/testlink.txt';
var CARD_ORDER_FILE = '/etc/tinyvless/card_order.json';
var SPEEDTEST_SOURCES_FILE = '/etc/tinyvless/speedtest_sources.json';
var BETA_FLAGS_FILE = '/etc/tinyvless/beta_flags.json';
var POLL_INTERVAL_FILE = '/etc/tinyvless/poll_interval.json';
var MODEM_FIELDS_FILE = '/etc/tinyvless/modem_card_fields.json';
// modem_card_fields.json: массив СКРЫТЫХ ключей (пусто/отсутствует = все поля видны).
// Ключи: operator, net_type, signal, model, reg_data, reg_voice, health, checked_ago,
// btn_led, banner (последний — глобальный баннер плохой связи, не поле карточки).
var POLL_INTERVAL_DEFAULT = 8;
var SPEEDTEST_SOURCES_DEFAULT = {
	tunnel: [{ label: 'Cloudflare', url: 'https://speed.cloudflare.com', type: 'cf' }, { label: 'Google', url: 'https://www.google.com', type: 'generic' }],
	direct: [{ label: 'Mail.ru', url: 'https://mail.ru', type: 'generic' }, { label: 'VK', url: 'https://vk.com', type: 'generic' }]
};
function resolveSpeedSources(savedJson) {
	var saved;
	try { saved = JSON.parse(savedJson || ''); } catch (e) { saved = null; }
	var out = { tunnel: [], direct: [] };
	['tunnel', 'direct'].forEach(function (via) {
		var arr = saved && Array.isArray(saved[via]) ? saved[via] : null;
		out[via] = (arr && arr.length ? arr : SPEEDTEST_SOURCES_DEFAULT[via]).filter(function (s) {
			return s && typeof s.url === 'string' && /^https?:\/\//.test(s.url);
		});
	});
	return out;
}
// канонический список карточек + порядок по умолчанию (после доработки — Мониторинг/Модем/
// Проксирование/Speedtest первыми, остальное как раньше). Микротюнинг умеет менять порядок —
// см. чтение CARD_ORDER_FILE ниже; неизвестные/отсутствующие ключи просто игнорируются.
var CARD_DEFAULT_ORDER = ['status', 'net', 'control', 'speed', 'clients', 'prof', 'dom', 'dns', 'reach', 'system'];
var CARD_LABELS = {
	status: 'Мониторинг', net: 'Модем', control: 'Проксирование', speed: 'Speedtest',
	clients: 'Клиенты LAN', prof: 'Профили', dom: 'Домены маршрутизации', dns: 'DNS-резолв',
	reach: 'Проверка доступности', system: 'Система'
};
// сохранённый порядок мог устареть (переименование/удаление карточки) — берём из него только
// известные ключи по порядку, остальные (новые/пропущенные) дописываем в конце по дефолту.
// card_order.json: {"order":[...все ключи...], "disabled":[...скрытые...]} — старый формат
// (просто массив ключей, без disabled) тоже поддерживается для обратной совместимости.
function resolveCardOrder(savedJson) {
	var saved;
	try { saved = JSON.parse(savedJson || ''); } catch (e) { saved = null; }
	var order = Array.isArray(saved) ? saved : (saved && Array.isArray(saved.order) ? saved.order : null);
	var disabled = (saved && !Array.isArray(saved) && Array.isArray(saved.disabled)) ? saved.disabled : [];
	if (!order || !order.length) order = CARD_DEFAULT_ORDER.slice();
	var out = order.filter(function (k) { return CARD_LABELS[k] != null; });
	CARD_DEFAULT_ORDER.forEach(function (k) { if (out.indexOf(k) === -1) out.push(k); });
	return out.filter(function (k) { return disabled.indexOf(k) === -1; });
}

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
	refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
	power: '<path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4l0 8"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35 -4.35"/>',
	mail: '<path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10z"/><path d="M3 7l9 6l9 -6"/>',
	signal: '<path d="M4 20v-4"/><path d="M9.5 20v-8"/><path d="M15 20v-12"/><path d="M20.5 20v-16"/>',
	settings: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
	download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>',
	upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>',
	chevronDown: '<path d="M6 9l6 6l6 -6"/>',
	chevronUp: '<path d="M6 15l6 -6l6 6"/>',
	bulb: '<path d="M12 2a7 7 0 0 0 -7 7c0 2.4 1.2 4.1 2.5 5.3.8 .8 1.5 1.7 1.5 2.7v1h6v-1c0 -1 .7 -1.9 1.5 -2.7c1.3 -1.2 2.5 -2.9 2.5 -5.3a7 7 0 0 0 -7 -7z"/><path d="M9 18h6"/><path d="M10 21h4"/>',
	alertTriangle: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86l-8.47 14.14a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71 -3l-8.47 -14.14a2 2 0 0 0 -3.42 0z"/>'
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
		else if ((m = l.match(/^\s*SELECT_LEVEL\s*=\s*['"]?(\w+)['"]?/))) o.selectLevel = m[1];
		else if ((m = l.match(/^\s*RU_SET\s*=\s*['"]?(\d)['"]?/))) o.ruSet = m[1] === '1';
		else if ((m = l.match(/^\s*UDP_TUNNEL\s*=\s*['"]?(\w+)['"]?/))) o.udpTunnel = m[1];
	});
	return o;
}

function fmtUptime(sec) {
	sec = sec || 0;
	if (sec < 60) return sec + ' с';
	var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
	if (h < 24) return h + ' ч ' + m + ' м';
	return Math.floor(h / 24) + ' д ' + (h % 24) + ' ч';
}

function gaugeClass(pct) {
	if (pct >= 85) return 'bad';
	if (pct >= 65) return 'warn';
	return 'ok';
}

function mkGauge(pct) {
	var fill = E('div', { 'class': 'fill', style: 'width:' + Math.min(100, Math.max(0, pct)).toFixed(0) + '%' });
	return E('div', { 'class': 'tv-gauge ' + gaugeClass(pct) }, [fill]);
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

// Нормализация вставки: некоторые приложения отдают URL-encoded строку без vless:// в начале.
function normalizeVlessLink(raw) {
	var lk = (raw || '').trim();
	if (!lk) return '';
	if (/^vless:\/\//i.test(lk)) return lk;
	if (/%[0-9A-Fa-f]{2}/.test(lk)) {
		try { lk = decodeURIComponent(lk); } catch (e) {}
	}
	lk = lk.trim();
	// emoji/мусор перед vless://
	var idx = lk.toLowerCase().indexOf('vless://');
	if (idx > 0) lk = lk.slice(idx);
	return lk.trim();
}

// tinyvless умеет ТОЛЬКО VLESS+WebSocket+TLS. Возвращает причину, если ссылка не такая (иначе null).
function linkUnsupported(link) {
	link = normalizeVlessLink(link);
	if (!/^vless:\/\//i.test(link)) return 'ссылка должна начинаться с vless://';
	var q = (link.split('?')[1] || '').split('#')[0];
	var type = (q.match(/(?:^|&)type=([^&]+)/) || [])[1] || 'tcp';
	var sec = (q.match(/(?:^|&)security=([^&]+)/) || [])[1] || 'none';
	if (/reality/i.test(sec)) return 'Reality не поддерживается (нужен WS+TLS)';
	if (/xtls/i.test(q)) return 'XTLS/Vision не поддерживается';
	if (type !== 'ws') return 'транспорт «' + type + '» не поддерживается — нужен WebSocket (type=ws)';
	if (sec !== 'tls') return 'нужен security=tls (в ссылке: ' + sec + ')';
	return null;
}

// ---------- хранилище профилей v2 (singles + subscriptions) ----------
function parseLinksStore(raw) {
	var data;
	try { data = JSON.parse(raw || ''); } catch (e) { data = null; }
	if (Array.isArray(data)) {
		return { version: 2, profiles: data, subscriptions: [] };
	}
	if (data && data.version === 2) {
		return {
			version: 2,
			profiles: Array.isArray(data.profiles) ? data.profiles : [],
			subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : []
		};
	}
	return { version: 2, profiles: [], subscriptions: [] };
}

function serializeLinksStore(st) {
	return JSON.stringify({ version: 2, profiles: st.profiles || [], subscriptions: st.subscriptions || [] });
}

function allProfiles(st) {
	var out = (st.profiles || []).slice();
	(st.subscriptions || []).forEach(function (s) {
		(s.profiles || []).forEach(function (p) { out.push(p); });
	});
	return out;
}

function setActiveProfile(st, p) {
	(st.profiles || []).forEach(function (x) { x.active = false; });
	(st.subscriptions || []).forEach(function (s) {
		(s.profiles || []).forEach(function (x) { x.active = false; });
	});
	if (p) p.active = true;
}

function activeProfileIn(st) {
	var ap = null;
	allProfiles(st).some(function (p) { if (p.active) { ap = p; return true; } return false; });
	return ap;
}

function mergeSubscriptionProfiles(sub, fetched) {
	var activeLink = null;
	(sub.profiles || []).forEach(function (p) { if (p.active) activeLink = p.link; });
	var next = [];
	var activeSet = false;
	(fetched.profiles || []).forEach(function (fp) {
		var np = { id: uid(), name: fp.name || linkSummary(fp.link).split(' · ')[0], link: fp.link, active: false };
		if (activeLink && fp.link === activeLink) { np.active = true; activeSet = true; }
		next.push(np);
	});
	if (!activeSet && activeLink) {
		next.forEach(function (np) { if (np.link === activeLink) { np.active = true; activeSet = true; } });
	}
	sub.profiles = next;
	sub.updated_at = Date.now();
	if (fetched.name) sub.name = fetched.name;
	return { kept: next.length, total: fetched.total || 0, skipped: fetched.skipped || 0 };
}

function fetchSubscription(url) {
	return fs.exec('/etc/tinyvless/api.sh', ['subscription_fetch', url]).then(function (r) {
		var res; try { res = JSON.parse((r.stdout || '').trim()); } catch (e) { res = null; }
		if (!res || !res.ok) throw new Error((res && res.error) || 'ошибка загрузки');
		return res;
	});
}
var STYLE = [
	'.tv { --acc:#3fb950; --acc-bd:#2ea043; --acc-bg:rgba(46,160,67,.13); --mut:#8b949e; --bd:rgba(139,148,158,.28); }',
	'.tv-wrap{ max-width:1440px; margin:0 auto; }',
	// баннер плохой связи (net-watchdog) — вверху страницы, вне грида; 2 состояния через модификатор
	'.tv-banner{ display:flex; align-items:center; gap:10px; border-radius:10px; padding:10px 14px; margin:0 0 14px; font-size:14px; }',
	'.tv-banner.warn{ background:rgba(210,153,34,.13); border:1px solid #9e6a03; color:#d29922; }',
	'.tv-banner.bad{ background:rgba(248,81,73,.13); border:1px solid #f85149; color:#f85149; }',
	'.tv-grid{ display:grid; grid-template-columns:1fr; gap:16px; align-items:stretch; }',
	'.tv-grid > .tv-card,.tv-grid > .tv-status{ margin:0; }',
	'.tv-grid > .tv-status{ grid-column:1 / -1; }',
	// stretch выравнивает карточки одной строки по высоте самой высокой (планшет/ноутбук —
	// 2-3 колонки) — визуально монолитный ряд вместо рваного низа у коротких карточек.
	'.tv-grid > .tv-card{ display:flex; flex-direction:column; }',
	// на планшете/десктопе stretch (выше) растягивает карточки короче соседей — остаётся
	// пустой хвост. ::after — flex-элемент, забирает себе весь остаток и красится точечной
	// сеткой (только там, где реально пусто; если контент уже заполняет карточку — 0 высоты).
	'.tv-grid > .tv-card::after{ content:""; display:block; flex:1 1 0; min-height:0; margin-top:12px; border-radius:0 0 10px 10px; background-image:radial-gradient(circle, rgba(139,148,158,.3) 1px, transparent 1px); background-size:14px 14px; }',
	// beta-метки (управляются на /tinyvless/dev/) — зелёная плашка BETA сверху блока
	'.tv-card.tv-beta-marked,.tv-status.tv-beta-marked{ position:relative; border-color:var(--acc-bd); }',
	'.tv-card.tv-beta-marked::before,.tv-status.tv-beta-marked::before{ content:"BETA"; position:absolute; top:-1px; right:14px; background:var(--acc); color:#0d1117; font-size:10px; font-weight:700; padding:2px 10px; border-radius:0 0 6px 6px; letter-spacing:.05em; z-index:1; }',
	'@media(min-width:720px){ .tv-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); } }',
	'@media(min-width:1100px){ .tv-grid{ grid-template-columns:repeat(3,minmax(0,1fr)); } }',
	'.tv .tv-ic{ display:inline-flex; align-items:center; vertical-align:middle; }',
	'.tv .tv-ic svg{ display:block; }',
	'.tv-card{ border:1px solid var(--bd); border-radius:12px; padding:16px 18px; margin:0 0 16px; background:rgba(127,127,127,.04); min-width:0; }',
	'.tv-card > .tv-h{ display:flex; align-items:center; justify-content:space-between; gap:8px 12px; margin:0 0 14px; min-width:0; }',
	'.tv-card .tv-h h3{ margin:0; font-size:16px; font-weight:600; display:flex; align-items:center; gap:8px; flex:0 1 auto; min-width:0; overflow:hidden; }',
	// группа кнопок в шапке карточки — всегда в один ряд с заголовком; когда не помещаются,
	// кнопки СЖИМАЮТСЯ (не переносятся), текст внутри обрезается многоточием.
	'.tv-h-actions{ display:flex; gap:8px; flex:0 1 auto; min-width:0; justify-content:flex-end; }',
	'.tv-h-actions .tv-btn{ white-space:nowrap; flex:0 1 auto; min-width:0; }',
	'.tv-h-actions .tv-btn-txt{ display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; }',
	'.tv-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }',
	'.tv-row > .tv-btn{ flex:0 0 auto; }',
	'.tv-power-row{ flex-wrap:nowrap; gap:8px; }',
	'.tv-power-row .tv-power-st{ display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; }',
	'.tv-power-row .tv-power-st span{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }',
	'.tv-power-row > .tv-btn{ flex:0 0 auto; padding:7px 11px; font-size:13px; white-space:nowrap; }',
	'.tv-dot{ width:10px; height:10px; border-radius:50%; background:var(--mut); flex:0 0 auto; box-shadow:0 0 0 3px rgba(139,148,158,.15); }',
	'.tv-dot.on{ background:var(--acc); box-shadow:0 0 0 3px var(--acc-bg); }',
	'.tv-modes{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:6px 0 4px; }',
	'.tv-mode{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; padding:10px 4px; border:1.5px solid var(--bd); border-radius:10px; background:transparent; color:var(--mut); cursor:pointer; font-size:12px; font-weight:500; transition:.12s; text-align:center; min-width:0; min-height:72px; }',
	'.tv-mode span{ display:block; line-height:1.2; word-break:break-word; hyphens:auto; }',
	'.tv-mode:hover:not(.act):not([disabled]){ border-color:var(--mut); color:inherit; }',
	'.tv-mode.act{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-mode[disabled]{ opacity:.4; cursor:not-allowed; }',
	'.tv-lbl{ font-size:13px; color:var(--mut); margin:12px 0 2px; }',
	'.tv-lbl b{ color:inherit; font-weight:600; }',
	'.tv-hint{ font-size:12px; color:var(--mut); margin:4px 0 2px; line-height:1.4; }',
	'.tv-info{ display:flex; align-items:flex-start; gap:9px; font-size:12.5px; color:var(--mut); line-height:1.45; background:rgba(139,148,158,.08); border-radius:9px; padding:9px 11px; margin-bottom:14px; }',
	'.tv-info b{ color:inherit; }',
	// без этого сброса <button class="tv-btn"> (Обновить) получает нативный UA-бокс браузера
	// (padding/box-sizing по умолчанию у button отличаются от div/a) — та же высота+паддинг
	// в CSS даёт РАЗНУЮ высоту рендера у button vs a (SMS/Микротюнинг), визуально "разный размер".
	'button.tv-btn{ -webkit-appearance:none; appearance:none; box-sizing:border-box; margin:0; font-family:inherit; }',
	'.tv-btn{ display:inline-flex; align-items:center; gap:7px; padding:8px 16px; border-radius:9px; border:1.5px solid var(--bd); background:transparent; color:inherit; cursor:pointer; font-size:14px; font-weight:500; transition:.12s; text-decoration:none; }',
	'.tv-btn:hover{ border-color:var(--mut); }',
	'.tv-btn.acc{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-btn.danger{ border-color:rgba(248,81,73,.5); color:#f85149; }',
	'.tv-btn.danger:hover{ background:rgba(248,81,73,.1); }',
	'.tv-btn.small{ padding:5px 10px; font-size:13px; }',
	'.tv-btn.ghost{ border-color:transparent; color:var(--mut); padding:8px 12px; }',
	'.tv-btn.ghost:hover{ color:inherit; background:rgba(139,148,158,.1); border-color:var(--bd); }',
	'.tv-log-body{ margin:10px 0 0; max-height:340px; overflow:auto; display:flex; flex-direction:column; gap:6px; }',
	'.tv-log-empty{ text-align:center; color:var(--mut); font-size:13px; padding:16px; }',
	'.tv-log-card{ padding:8px 10px; border-radius:8px; border:1px solid var(--bd); background:rgba(127,127,127,.05); }',
	'.tv-log-card.warn{ border-color:rgba(210,153,34,.4); background:rgba(210,153,34,.08); }',
	'.tv-log-card.danger{ border-color:rgba(248,81,73,.4); background:rgba(248,81,73,.08); }',
	'.tv-log-time{ font-size:10.5px; color:var(--mut); margin-bottom:3px; font-family:monospace; }',
	'.tv-log-msg{ font-size:12.5px; line-height:1.4; word-break:break-word; }',
	'.tv-speed-card{ text-align:center; }',
	'.tv-speed-card .tv-info{ text-align:left; }',
	'.tv-speed-ring-wrap{ position:relative; width:160px; height:160px; margin:14px auto 18px; }',
	'.tv-speed-ring-wrap svg{ width:100%; height:100%; display:block; }',
	'.tv-speed-val{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 12px; }',
	'.tv-speed-results{ display:flex; justify-content:center; gap:20px; flex-wrap:wrap; }',
	'.tv-speed-results .r{ text-align:center; }',
	'.tv-speed-results .r b{ display:block; font-size:16px; font-weight:600; }',
	'.tv-speed-results .r span{ font-size:11px; color:var(--mut); }',
	'.tv-speed-groups{ display:flex; gap:16px; flex-wrap:wrap; justify-content:center; }',
	'.tv-speed-group{ flex:1 1 200px; min-width:200px; border:1px solid var(--bd); border-radius:12px; padding:14px 10px; }',
	'.tv-speed-group-h{ font-size:13px; font-weight:600; color:var(--mut); margin-bottom:10px; }',
	'.tv-speed-detail{ margin-top:12px; padding-top:10px; border-top:1px solid var(--bd); display:flex; flex-direction:column; gap:4px; }',
	'.tv-speed-src-row{ display:flex; justify-content:space-between; gap:8px; font-size:11.5px; color:var(--mut); }',
	'.tv-speed-src-row .nm{ font-weight:500; }',
	'.tv-speed-src-row .v{ font-family:monospace; white-space:nowrap; }',
	'.tv-btn.icon{ padding:7px 9px; }',
	'.tv-reach-row{ display:flex; gap:8px; margin-bottom:10px; }',
	'.tv-reach-row .tv-inp{ flex:1 1 auto; }',
	'.tv-reach-list{ display:flex; flex-direction:column; gap:8px; }',
	'.tv-reach-chip{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; border:1.5px solid var(--bd); border-radius:10px; background:rgba(127,127,127,.06); }',
	'.tv-reach-chip .nm{ font-family:monospace; font-size:13.5px; word-break:break-all; flex:1 1 auto; }',
	'.tv-reach-chip .st{ font-size:11.5px; padding:2px 8px; border-radius:6px; border:1px solid var(--bd); color:var(--mut); white-space:nowrap; }',
	'.tv-reach-chip .st.ok{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-reach-chip .st.fail{ border-color:rgba(248,81,73,.5); background:rgba(248,81,73,.08); color:#f85149; }',
	'.tv-reach-empty{ text-align:center; color:var(--mut); font-size:13px; padding:14px; border:1px dashed var(--bd); border-radius:10px; }',
	'.tv-sysrow{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }',
	'.tv-sysrow .tl b{ display:block; font-size:14px; font-weight:500; }',
	'.tv-sysrow .tl small{ display:block; font-size:12px; color:var(--mut); margin-top:2px; line-height:1.35; }',
	'.tv-sys-card{ border-color:rgba(139,148,158,.35); }',
	'.tv-sys-actions{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }',
	'.tv-sys-actions .tv-btn{ justify-content:center; min-width:0; padding:8px 10px; font-size:13px; }',
	'.tv-sw{ position:relative; width:44px; height:24px; flex:0 0 auto; }',
	'.tv-sw input{ opacity:0; width:0; height:0; position:absolute; }',
	'.tv-sw .sl{ position:absolute; inset:0; background:rgba(139,148,158,.35); border-radius:24px; cursor:pointer; transition:.15s; }',
	'.tv-sw .sl:before{ content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.15s; }',
	'.tv-sw input:checked + .sl{ background:var(--acc-bd); }',
	'.tv-sw input:checked + .sl:before{ transform:translateX(20px); }',
	'.tv-trow{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--bd); }',
	'.tv-trow:last-child{ border-bottom:0; }',
	'.tv-trow .tl{ flex:1 1 auto; min-width:0; padding-right:4px; }',
	'.tv-trow .tl b{ display:block; font-size:14px; font-weight:500; }',
	'.tv-trow .tl small{ display:block; font-size:12px; color:var(--mut); margin-top:2px; line-height:1.35; word-break:break-word; }',
	'.tv-trow .tv-sw{ flex:0 0 auto; align-self:center; }',
	'.tv-sw.rect{ width:52px; height:28px; }',
	'.tv-sw.rect .sl{ border-radius:10px; }',
	'.tv-sw.rect .sl:before{ width:22px; height:22px; border-radius:7px; top:3px; left:3px; }',
	'.tv-sw.rect input:checked + .sl:before{ transform:translateX(24px); }',
	'.tv-sep{ margin-top:14px; padding-top:14px; border-top:1px solid var(--bd); }',
	'.tv-autostart{ display:flex; align-items:center; justify-content:space-between; gap:12px; }',
	'.tv-autostart .tl{ flex:1 1 auto; min-width:0; }',
	'.tv-autostart .tl b{ display:block; font-size:14px; font-weight:500; }',
	'.tv-autostart .tl small{ display:block; font-size:12px; color:var(--mut); margin-top:2px; line-height:1.35; word-break:break-word; }',
	'.tv-autostart .tv-sw{ flex:0 0 auto; align-self:center; }',
	'.tv-gauge{ height:8px; border-radius:6px; background:rgba(139,148,158,.22); overflow:hidden; margin-top:5px; max-width:280px; }',
	'.tv-gauge .fill{ height:100%; border-radius:6px; transition:width .35s ease; }',
	'.tv-gauge.ok .fill{ background:var(--acc-bd); }',
	'.tv-gauge.warn .fill{ background:#d29922; }',
	'.tv-gauge.bad .fill{ background:#f85149; }',
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
	'.tv-sub{ border:1px solid var(--bd); border-radius:10px; padding:10px 12px 6px; margin-bottom:10px; background:rgba(127,127,127,.03); }',
	'.tv-sub-h{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:8px; }',
	'.tv-sub-h .meta{ flex:1 1 auto; min-width:0; }',
	'.tv-sub-h b{ display:block; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
	'.tv-sub-h small{ color:var(--mut); font-size:12px; }',
	'.tv-sub-list .tv-prof{ margin-bottom:6px; }',
	'.tv-tabs{ display:flex; gap:6px; margin-bottom:14px; }',
	'.tv-tab{ flex:1; padding:8px 6px; border:1px solid var(--bd); border-radius:8px; background:transparent; color:var(--mut); cursor:pointer; font-size:13px; }',
	'.tv-tab.act{ border-color:var(--acc-bd); color:var(--acc); background:var(--acc-bg); }',
	'.tv-status{ border:1.5px solid var(--acc-bd); border-radius:12px; padding:16px 18px; background:transparent; margin:0 0 16px; min-width:0; }',
	'.tv-status.down{ border-color:rgba(248,81,73,.5); }',
	'.tv-stat-grid{ display:grid; grid-template-columns:1fr; gap:10px 16px; }',
	'.tv-stat{ min-width:0; }',
	'.tv-stat .sk{ font-size:12px; color:var(--mut); margin-bottom:3px; }',
	'.tv-stat .sv{ font-size:14px; line-height:1.35; min-width:0; }',
	'.tv-stat .tv-gauge{ max-width:100%; margin-top:6px; }',
	'@media(min-width:560px){ .tv-stat-grid{ grid-template-columns:repeat(2,minmax(0,1fr)); } }',
	'@media(min-width:900px){ .tv-stat-grid{ grid-template-columns:repeat(3,minmax(0,1fr)); } }',
	'@media(min-width:1200px){ .tv-stat-grid{ grid-template-columns:repeat(4,minmax(0,1fr)); } }',
	// карточки-виджеты (Модем и т.п.) часто уже сами по себе узкие в многоколоночном tv-grid —
	// глобальные viewport-медиа-запросы на .tv-stat-grid этого не знают и сжимают колонки. Фикс:
	// принудительно держим 2 колонки независимо от ширины окна для карточек с этим модификатором.
	'.tv-stat-grid.tv-stat-grid-fixed2{ grid-template-columns:repeat(2,minmax(0,1fr))!important; }',
	'.tv-ta{ width:100%; font-family:monospace; font-size:13px; border-radius:8px; }',
	'.tv-modal-fld{ margin-bottom:14px; }',
	'.tv-modal-fld label{ display:block; font-size:13px; color:var(--mut); margin-bottom:5px; }',
	'.tv-modal-fld input,.tv-modal-fld textarea{ width:100%; box-sizing:border-box; }',
	'@keyframes tvspin{ to{ transform:rotate(360deg); } }',
	'.tv-spin{ animation:tvspin 1s linear infinite; display:inline-flex; }',
	// пульсация для splash-экранов reboot/poweroff (вместо кружка-спиннера вокруг иконки)
	'@keyframes tvpulse{ 0%,100%{ transform:scale(1); opacity:1; } 50%{ transform:scale(1.1); opacity:.8; } }',
	'.tv-splash-ov{ position:fixed; inset:0; background:#0d1117; display:flex; align-items:center; justify-content:center; z-index:2000; }',
	'@media(prefers-color-scheme:light){ .tv-splash-ov{ background:#f6f8fa; } }',
	':root[data-theme="light"] .tv-splash-ov{ background:#f6f8fa; }',
	'.tv-splash{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; text-align:center; padding:24px; }',
	'.tv-splash-icon{ color:var(--acc); animation:tvpulse 1.7s ease-in-out infinite; transition:color .4s ease; }',
	'.tv-splash-icon.danger{ color:#f85149; animation:none; }',
	'.tv-splash-text{ margin:0; font-size:16px; letter-spacing:.02em; font-weight:500; }',
	'.tv-splash-sub{ margin:0; font-size:13px; color:var(--mut); }',
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
	'.tv-check-row{ display:flex; gap:8px; align-items:stretch; margin-top:6px; }',
	'.tv-check-row .tv-inp{ flex:1 1 auto; }',
	'.tv-check-result{ margin-top:10px; padding:10px 12px; border-radius:9px; border:1px solid var(--bd); font-size:13px; line-height:1.45; display:none; }',
	'.tv-check-result.show{ display:block; }',
	'.tv-check-result.poisoned{ border-color:rgba(248,81,73,.5); background:rgba(248,81,73,.08); }',
	'.tv-check-result.clean{ border-color:var(--acc-bd); background:var(--acc-bg); }',
	'.tv-client{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid var(--bd); }',
	'.tv-client:last-child{ border-bottom:0; }',
	'.tv-client .nm b{ display:block; font-size:14px; font-weight:500; }',
	'.tv-client .nm small{ display:block; font-size:12px; color:var(--mut); }',
	'.tv-client .tv-sw{ flex:0 0 auto; }',
	'.tv-toplinks{ display:flex; gap:12px; flex-wrap:wrap; margin:-8px 0 12px; }',
	'.tv-toplinks a{ color:var(--acc); text-decoration:none; font-size:13px; }',
	'.tv-page-h{ display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin:0 0 16px; }',
	'.tv-title-block{ display:flex; align-items:center; gap:10px; flex:1 1 auto; min-width:0; }',
	'.tv-title-block h2{ margin:0; display:flex; align-items:center; gap:9px; }',
	'.tv-version{ font-size:12.5px; color:var(--mut); font-weight:500; letter-spacing:.02em; white-space:nowrap; }',
	'.tv-header-actions{ display:flex; align-items:center; gap:8px; }',
	// фикс "SMS больше остальных": button vs a — разные UA-дефолты line-height/font-metrics
	// даже при идентичных padding/border. Явная height + border-box гарантируют пиксель-в-пиксель
	// одинаковый рендер независимо от типа элемента (button/a) и браузерных квирков.
	'.tv-header-actions .tv-btn,.tv-header-actions .tv-sms-link,.tv-header-actions .tv-microtun-link{ height:40px; box-sizing:border-box; line-height:1; }',
	'.tv-btn.refresh{ border-color:var(--acc-bd); background:var(--acc-bg); color:var(--acc); }',
	'.tv-btn.refresh:hover{ background:rgba(46,160,67,.2); }',
	'.tv-microtun-link,.tv-sms-link{ -webkit-appearance:none; appearance:none; box-sizing:border-box; margin:0; font-family:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:7px; padding:8px 16px; border-radius:9px; border:1.5px solid var(--acc-bd); background:var(--acc-bg); color:var(--acc); text-decoration:none; font-size:14px; font-weight:500; white-space:nowrap; }',
	'.tv-sms-link:hover{ background:rgba(46,160,67,.2); }',
	'.tv-microtun-bar{ display:none; justify-content:center; margin:20px 0 10px; padding-bottom:8px; }',
	'@media(max-width:719px){ .tv-page-h .tv-microtun-link{ display:none; } .tv-microtun-bar{ display:flex; } }',
	'@media(max-width:480px){ .tv-dns-row{ grid-template-columns:1fr; } }'
].join('\n');

function mkStat(label, val) {
	return E('div', { 'class': 'tv-stat' }, [E('div', { 'class': 'sk' }, label), E('div', { 'class': 'sv' }, val)]);
}

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
			fs.exec('/etc/tinyvless/api.sh', ['state']).then(function (r) { return r.stdout; }).catch(function () { return '{}'; }),
			fs.exec('/etc/tinyvless/api.sh', ['clients']).then(function (r) { return r.stdout; }).catch(function () { return '{"clients":[]}'; }),
			fs.read(CARD_ORDER_FILE).catch(function () { return ''; }),
			fs.read(SPEEDTEST_SOURCES_FILE).catch(function () { return ''; }),
			fs.read(BETA_FLAGS_FILE).catch(function () { return ''; }),
			fs.read(POLL_INTERVAL_FILE).catch(function () { return ''; }),
			fs.read(MODEM_FIELDS_FILE).catch(function () { return ''; })
		]);
	},

	render: function (data) {
		var self = this;
		var cfg = parseConfig(data[0]);
		var st = {
			rawCfg: data[0] || '', mode: cfg.mode, running: false, autostart: false, profiles: [], subscriptions: [], ruSubnets: 0,
			dnsPrimary: cfg.dnsPrimary, dnsFallback: cfg.dnsFallback, dohMode: cfg.dohMode,
			selectLevel: cfg.selectLevel || 'low', ruSet: cfg.ruSet !== false, udpTunnel: cfg.udpTunnel || 'full',
			memTotal: 0, memAvail: 0, cpuPct: 0, uptime: 0, flashPct: 0, clients: [],
			cardOrder: resolveCardOrder(data[7]),
			speedSources: resolveSpeedSources(data[8]),
			betaFlags: (function () { try { var a = JSON.parse(data[9] || ''); return Array.isArray(a) ? a : []; } catch (e) { return []; } })(),
			pollInterval: (function () {
				var v;
				try { v = JSON.parse(data[10] || '').seconds; } catch (e) { v = null; }
				v = parseInt(v, 10);
				if (!v || v < 4 || v > 120) return POLL_INTERVAL_DEFAULT;
				return v;
			})(),
			modemHidden: (function () { try { var a = JSON.parse(data[11] || ''); return Array.isArray(a) ? a : []; } catch (e) { return []; } })()
		};

		// state из api.sh
		try {
			var js = JSON.parse(data[5] || '{}');
			st.running = !!js.running; st.autostart = !!js.autostart; st.ruSubnets = js.ru_subnets || 0;
			if (js.dns_primary) st.dnsPrimary = js.dns_primary;
			if (js.dns_fallback) st.dnsFallback = js.dns_fallback;
			if (js.doh_mode) st.dohMode = js.doh_mode;
			if (js.select_level) st.selectLevel = js.select_level;
			if (js.ru_set !== undefined) st.ruSet = !!js.ru_set;
			if (js.udp_tunnel) st.udpTunnel = js.udp_tunnel === 'discord' ? 'selective' : js.udp_tunnel;
			st.memTotal = js.mem_total || 0; st.memAvail = js.mem_avail || 0;
			st.cpuPct = js.cpu_pct || 0; st.uptime = js.uptime || 0; st.flashPct = js.flash_pct || 0;
		} catch (e) {}
		try {
			var cj = JSON.parse(data[6] || '{"clients":[]}');
			st.clients = Array.isArray(cj.clients) ? cj.clients : [];
		} catch (e2) { st.clients = []; }

		// профили: links.json v2 (singles + subscriptions), иначе миграция из config
		var linksStore = parseLinksStore(data[1]);
		st.profiles = linksStore.profiles;
		st.subscriptions = linksStore.subscriptions;
		if (!st.profiles.length && !st.subscriptions.length) {
			st.profiles = cfg.link ? [{ id: uid(), name: 'Профиль 1', link: cfg.link, active: true }] : [];
		}
		if (allProfiles(st).length && !activeProfileIn(st)) {
			if (st.profiles.length) st.profiles[0].active = true;
			else if (st.subscriptions[0] && st.subscriptions[0].profiles && st.subscriptions[0].profiles[0]) {
				st.subscriptions[0].profiles[0].active = true;
			}
		}

		function activeProfile() { return activeProfileIn(st); }
		function saveLinks() {
			return fs.write(LINKS, serializeLinksStore(st)).then(function (r) {
				if (!r || r.ok !== true) throw new Error('write failed');
				return r;
			});
		}

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
		var TEST_GAP_MS = 1500;
		function testAllProfiles() {
			if (testingAll) return;
			var list = allProfiles(st).filter(function (p) { return !linkUnsupported(p.link); });
			if (!list.length) { ui.addNotification(null, E('p', 'Нет профилей WS/TLS для проверки'), 'warning'); return; }
			testingAll = true; renderProfiles();
			var i = 0;
			(function next() {
				if (i >= list.length) { testingAll = false; renderProfiles(); return; }
				testProfile(list[i++]).then(function () { setTimeout(next, TEST_GAP_MS); });
			})();
		}

		// ====== мелкие рендер-функции (обновляют DOM на месте) ======
		var elDot, elStateTxt, btnPower, btnReboot, btnShutdown, modeBtns = {}, elProfList, elAutoSw;

		// --- неблокирующие баннеры прогресса — ПО ОДНОМУ НА КАРТОЧКУ, не общий сверху страницы.
		// Раньше был один elBanner в шапке — на мобильном, если проскроллить вниз к карточке,
		// в которой реально идёт действие, баннер сверху просто не виден. Теперь у каждой
		// карточки с длительными действиями свой баннер прямо внутри неё.
		function mkBanner() {
			var el = E('div', { 'class': 'tv-banner' }, [E('span', { 'class': 'bt' }, ''), E('span', { 'class': 'track' })]);
			var timer = null;
			return {
				el: el,
				show: function (t) { if (timer) { clearTimeout(timer); timer = null; } el.firstChild.textContent = t; el.className = 'tv-banner show busy'; },
				ok: function (t) { el.firstChild.textContent = '✓ ' + t; el.className = 'tv-banner show ok'; timer = setTimeout(function () { el.className = 'tv-banner'; }, 2200); },
				err: function (t) { el.firstChild.textContent = '✕ ' + t; el.className = 'tv-banner show err'; timer = setTimeout(function () { el.className = 'tv-banner'; }, 4500); }
			};
		}
		var controlBanner = mkBanner();  // Проксирование: вкл/выкл, режим, тонкая настройка
		var profBanner = mkBanner();     // Профили: подписки, переключение профиля
		var clientsBanner = mkBanner();  // Клиенты LAN: байпас
		var systemBanner = mkBanner();   // Система: reboot/poweroff (фолбэк, основной фидбек — сплэш)
		var busyOn = false;
		// блокируем органы управления на время перехода (защита от наложения операций → OOM)
		function setBusy(on) { busyOn = on; renderControlHeader(); renderProfiles(); }

		// --- полноэкранный сплэш для reboot/poweroff (пульсирующая иконка вместо кружка) ---
		var elSplashIcon = ic('shield', 96, 'tv-splash-icon');
		var elSplashText = E('p', { 'class': 'tv-splash-text' }, '');
		var elSplashSub = E('p', { 'class': 'tv-splash-sub' }, '');
		var elSplashOv = E('div', { 'class': 'tv-splash-ov', style: 'display:none' }, [
			E('div', { 'class': 'tv-splash' }, [elSplashIcon, elSplashText, elSplashSub])
		]);
		function splashShow(text, sub) {
			elSplashIcon.classList.remove('danger');
			elSplashText.textContent = text; elSplashSub.textContent = sub || '';
			elSplashOv.style.display = 'flex';
		}
		function splashDanger(text, sub) {
			elSplashIcon.classList.add('danger');
			elSplashText.textContent = text; elSplashSub.textContent = sub || '';
		}
		// опрос до успешного отклика роутера после reboot (макс. timeoutSec, интервал intervalSec)
		function waitReconnect(timeoutSec, intervalSec, onSuccess, onTimeout) {
			var deadline = Date.now() + timeoutSec * 1000;
			(function tick() {
				if (Date.now() > deadline) { onTimeout(); return; }
				fs.exec('/etc/tinyvless/api.sh', ['status']).then(function (r) {
					if (/"running"/.test(r.stdout || '')) onSuccess();
					else setTimeout(tick, intervalSec * 1000);
				}).catch(function () { setTimeout(tick, intervalSec * 1000); });
			})();
		}

		function renderControlHeader() {
			elDot.className = 'tv-dot' + (st.running ? ' on' : '');
			elStateTxt.textContent = st.running ? 'Проксирование включено' : 'Проксирование выключено';
			btnPower.className = 'tv-btn ' + (st.running ? 'danger' : 'acc');
			btnPower.innerHTML = '';
			btnPower.appendChild(ic('power', 18));
			btnPower.appendChild(document.createTextNode(st.running ? ' Выключить' : ' Включить'));
			if (busyOn) btnPower.setAttribute('disabled', ''); else btnPower.removeAttribute('disabled');
			[btnReboot, btnShutdown].forEach(function (b) {
				if (!b) return;
				if (busyOn) b.setAttribute('disabled', ''); else b.removeAttribute('disabled');
			});
			Object.keys(modeBtns).forEach(function (m) {
				var b = modeBtns[m];
				b.className = 'tv-mode' + (st.mode === m ? ' act' : '');
				if (st.running && !busyOn) b.removeAttribute('disabled'); else b.setAttribute('disabled', '');
			});
		}

		function renderProfileRow(p, opts) {
			opts = opts || {};
			var bad = linkUnsupported(p.link);
			var stt = testStatus[p.id];
			var kids = [
				E('span', { 'class': 'ci' }, [ic(p.active ? 'checkf' : 'circle', 22)]),
				E('div', { 'class': 'nm' }, [E('b', {}, p.name || '(без имени)'), E('small', {}, linkSummary(p.link))])
			];
			var deadCls = '';
			if (bad) kids.push(E('span', { 'class': 'tv-badge', title: bad }, 'не WS/TLS'));
			else if (stt === 'testing') kids.push(E('span', { 'class': 'tv-badge testing' }, '⟳ проверка…'));
			else if (stt === 'ok') kids.push(E('span', { 'class': 'tv-badge ok', title: 'внешний IP через этот профиль' }, '✓ ' + (testIP[p.id] || 'работает')));
			else if (stt === 'blocked') { kids.push(E('span', { 'class': 'tv-badge dead', title: testErr[p.id] || '' }, '✕ недоступен')); deadCls = ' dead'; }
			if (!opts.readonly) {
				kids.push(E('span', { 'class': 'pen', click: function (ev) {
					ev.stopPropagation();
					if (!busyOn) openProfileModal(p, opts.subId ? 'sub-profile' : 'single', opts.subId);
				} }, [ic('edit', 18)]));
			}
			var showAct = p.active && stt !== 'blocked' && stt !== 'testing' && !bad;
			var row = E('div', { 'class': 'tv-prof' + (showAct ? ' act' : '') + (bad ? ' bad' : '') + deadCls, style: busyOn ? 'opacity:.55' : '' }, kids);
			if (!p.active && !busyOn && !bad) row.addEventListener('click', function () { activateProfile(p); });
			return row;
		}

		function refreshSubscription(sub) {
			if (busyOn) return;
			setBusy(true); profBanner.show('Обновляю подписку…');
			fetchSubscription(sub.url).then(function (res) {
				var info = mergeSubscriptionProfiles(sub, res);
				return saveLinks().then(function () {
					setBusy(false);
					profBanner.ok('Подписка: ' + info.kept + ' WS/TLS (из ' + info.total + ', пропущено ' + info.skipped + ')');
					renderProfiles();
				});
			}).catch(function (e) {
				setBusy(false);
				profBanner.err((e && e.message) || 'Не удалось обновить подписку');
			});
		}

		function renderProfiles() {
			elProfList.innerHTML = '';
			var hasAny = st.profiles.length || (st.subscriptions && st.subscriptions.length);
			if (!hasAny) {
				elProfList.appendChild(E('div', { style: 'color:var(--mut);font-size:13px;padding:6px 0' }, 'Профилей нет. Нажми «Добавить».'));
				return;
			}
			st.profiles.forEach(function (p) { elProfList.appendChild(renderProfileRow(p)); });
			(st.subscriptions || []).forEach(function (sub) {
				var inner = E('div', { 'class': 'tv-sub-list' });
				(sub.profiles || []).forEach(function (p) { inner.appendChild(renderProfileRow(p, { subId: sub.id })); });
				if (!(sub.profiles || []).length) {
					inner.appendChild(E('div', { style: 'color:var(--mut);font-size:12px;padding:4px 0 8px' }, 'Нет совместимых конфигураций (WS+TLS).'));
				}
				var upd = sub.updated_at ? new Date(sub.updated_at).toLocaleString('ru-RU') : '—';
				var collapsed = !!sub._collapsed;
				var body = E('div', { style: collapsed ? 'display:none' : '' }, [
					inner,
					E('div', { style: 'display:flex;gap:8px;margin-top:6px' }, [
						E('button', {
							'class': 'tv-btn small danger', click: ui.createHandlerFn(self, function () {
								var wasActive = (sub.profiles || []).some(function (p) { return p.active; });
								st.subscriptions = st.subscriptions.filter(function (x) { return x !== sub; });
								if (wasActive && st.profiles.length) { st.profiles[0].active = true; }
								saveLinks().then(renderProfiles);
							})
						}, 'Удалить подписку')
					])
				]);
				var btnCollapse = E('button', {
					'class': 'tv-btn small', style: 'padding:6px 9px', title: collapsed ? 'Развернуть' : 'Свернуть',
					click: ui.createHandlerFn(self, function () { sub._collapsed = !collapsed; renderProfiles(); })
				}, [ic(collapsed ? 'chevronDown' : 'chevronUp', 16)]);
				elProfList.appendChild(E('div', { 'class': 'tv-sub' }, [
					E('div', { 'class': 'tv-sub-h' }, [
						E('div', { 'class': 'meta' }, [
							E('b', {}, sub.name || 'Подписка'),
							E('small', {}, (sub.profiles || []).length + ' проф. · обновлено ' + upd)
						]),
						btnCollapse,
						E('button', {
							'class': 'tv-btn small', style: 'padding:6px 9px', title: 'Обновить из подписки',
							click: ui.createHandlerFn(self, function () { refreshSubscription(sub); })
						}, [ic('refresh', 18)])
					]),
					body
				]));
			});
		}

		// ====== действия (все неблокирующие: баннер + poll, органы блокируются только на время) ======
		function setMode(m) {
			if (!st.running || st.mode === m || busyOn) return;
			var prev = st.mode; st.mode = m;
			setBusy(true); controlBanner.show('Переключаю режим…');
			fs.exec('/etc/tinyvless/api.sh', ['mode', m]).then(function (r) {
				if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
				st.rawCfg = setKV(st.rawCfg, 'MODE', m);
				setBusy(false); controlBanner.ok('Режим применён: ' + (MODE_LABEL[m] || m));
			}).catch(function () { st.mode = prev; setBusy(false); controlBanner.err('Не удалось сменить режим'); });
		}

		function togglePower() {
			if (busyOn) return;
			if (st.running) {
				setBusy(true); controlBanner.show('Выключаю проксирование…');
				fs.exec('/etc/tinyvless/api.sh', ['stop']).then(function () {
					st.running = false; setBusy(false); controlBanner.ok('Проксирование выключено');
				}).catch(function () { setBusy(false); controlBanner.err('Ошибка выключения'); });
			} else {
				setBusy(true); controlBanner.show('Запускаю tinyvless… поднимаю туннель (до ~50с)');
				fs.exec('/etc/tinyvless/api.sh', ['start']).then(function () {
					waitRunningPoll(55, function (ok) {
						st.running = ok; setBusy(false);
						if (ok) controlBanner.ok('Проксирование включено'); else controlBanner.err('Не удалось запустить за 55с');
					});
				}).catch(function () { setBusy(false); controlBanner.err('Ошибка запуска'); });
			}
		}

		function doPoweroff() {
			if (busyOn) return;
			ui.hideModal();
			setBusy(true);
			splashShow('Роутер выключается…', 'Не отключайте питание преждевременно');
			fs.exec('/etc/tinyvless/api.sh', ['poweroff']).then(function (r) {
				if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
				// точного момента отключения питания клиент знать не может — используем
				// типичную задержку OpenWrt shutdown перед тем как показать красную иконку.
				setTimeout(function () {
					splashDanger('Роутер выключен', 'Чтобы включить снова — подайте питание');
				}, 2600);
			}).catch(function () { elSplashOv.style.display = 'none'; setBusy(false); systemBanner.err('Не удалось выключить'); });
		}

		function doReboot() {
			if (busyOn) return;
			ui.hideModal();
			setBusy(true);
			splashShow('Роутер перезагружается…', 'Обычно занимает ~1–2 минуты');
			fs.exec('/etc/tinyvless/api.sh', ['reboot']).then(function (r) {
				if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
				setTimeout(function () { elSplashSub.textContent = 'Ждём отклика роутера…'; }, 3000);
				waitReconnect(180, 4, function () {
					elSplashText.textContent = '✓ Роутер снова на связи';
					elSplashSub.textContent = 'Открываю интерфейс…';
					elSplashIcon.style.animation = 'none';
					setTimeout(function () { location.reload(); }, 900);
				}, function () {
					elSplashOv.style.display = 'none';
					setBusy(false);
					systemBanner.err('Роутер не откликнулся за 3 минуты — обновите страницу вручную');
				});
			}).catch(function () { elSplashOv.style.display = 'none'; setBusy(false); systemBanner.err('Не удалось перезагрузить'); });
		}

		function confirmPoweroff() {
			if (busyOn) return;
			ui.showModal('Выключить роутер?', E('div', {}, [
				E('p', { style: 'margin:0 0 12px;line-height:1.45;color:var(--mut)' },
					'OpenWrt корректно завершит работу. Чтобы включить снова — подайте питание или нажмите кнопку на корпусе.'),
				E('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px' }, [
					E('button', { 'class': 'tv-btn', click: ui.hideModal }, 'Отмена'),
					E('button', { 'class': 'tv-btn danger', click: ui.createHandlerFn(self, doPoweroff) }, [ic('power', 16), E('span', {}, ' Выключить')])
				])
			]));
		}

		function confirmReboot() {
			if (busyOn) return;
			ui.showModal('Перезагрузить роутер?', E('div', {}, [
				E('p', { style: 'margin:0 0 12px;line-height:1.45;color:var(--mut)' },
					'OpenWrt перезапустится. Интернет и панель будут недоступны ~1–2 минуты, затем всё поднимется автоматически.'),
				E('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px' }, [
					E('button', { 'class': 'tv-btn', click: ui.hideModal }, 'Отмена'),
					E('button', { 'class': 'tv-btn acc', click: ui.createHandlerFn(self, doReboot) }, [ic('refresh', 16), E('span', {}, ' Перезагрузить')])
				])
			]));
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
			setActiveProfile(st, p);
			st.rawCfg = setKV(st.rawCfg, 'VLESS_LINK', p.link);
			setBusy(true); profBanner.show('Переключаю профиль «' + (p.name || '') + '»…');
			Promise.all([saveLinks(), fs.write(CFG, st.rawCfg)]).then(function () {
				return fs.exec('/etc/tinyvless/api.sh', ['restart']);
			}).then(function () {
				waitRunningPoll(55, function (ok) {
					if (ok) { st.running = true; setBusy(false); profBanner.ok('Профиль: ' + (p.name || '')); return; }
					// ОТКАТ: профиль не поднялся — возвращаем предыдущий рабочий, чтобы не блэкхолить роутер
					if (extraRestore) extraRestore();
					st.rawCfg = prevCfg;
					setActiveProfile(st, prevActive);
					profBanner.show('Профиль не поднялся — возвращаю предыдущий рабочий…');
					Promise.all([saveLinks(), fs.write(CFG, prevCfg)]).then(function () {
						return fs.exec('/etc/tinyvless/api.sh', ['restart']);
					}).then(function () {
						waitRunningPoll(55, function (ok2) {
							st.running = ok2; setBusy(false);
							if (ok2) profBanner.err('Профиль не поднялся — вернул предыдущий рабочий');
							else profBanner.err('Не удалось поднять даже предыдущий — проверь сеть');
						});
					}).catch(function () { setBusy(false); profBanner.err('Ошибка возврата'); });
				});
			}).catch(function () { setBusy(false); profBanner.err('Ошибка переключения'); });
		}

		function openProfileModal(prof, mode, subId) {
			mode = mode || (prof ? 'single' : 'single');
			var isEdit = !!prof;
			var tabSingle = E('button', { type: 'button', 'class': 'tv-tab act' }, 'Конфигурация');
			var tabSub = E('button', { type: 'button', 'class': 'tv-tab' }, 'Подписка');
			var panelSingle = E('div', {});
			var panelSub = E('div', { style: 'display:none' });
			var inName = E('input', { type: 'text', 'class': 'cbi-input-text', placeholder: 'напр. Нидерланды', value: isEdit ? (prof.name || '') : '' });
			var inLink = E('textarea', { 'class': 'tv-ta', rows: 4, placeholder: 'vless://…', style: 'height:90px' }, isEdit ? (prof.link || '') : '');
			var inSubUrl = E('input', { type: 'text', 'class': 'cbi-input-text', placeholder: 'https://sub.example.com/…' });
			var err = E('div', { style: 'color:#f85149;font-size:13px;min-height:16px;margin-bottom:8px' }, '');
			var testMsg = E('span', { style: 'font-size:13px;color:var(--mut)' }, '');
			var subPreview = E('div', { style: 'font-size:13px;color:var(--mut);min-height:18px;margin-top:6px' }, '');
			var testBtn = E('button', { 'class': 'tv-btn small', style: 'flex:0 0 auto' }, 'Проверить');
			var previewBtn = E('button', { 'class': 'tv-btn small', style: 'flex:0 0 auto' }, 'Проверить подписку');

			var currentTab = 'single';
			function setTab(which) {
				currentTab = which;
				var subOn = which === 'sub';
				tabSingle.className = 'tv-tab' + (subOn ? '' : ' act');
				tabSub.className = 'tv-tab' + (subOn ? ' act' : '');
				panelSingle.style.display = subOn ? 'none' : 'block';
				panelSub.style.display = subOn ? 'block' : 'none';
				err.textContent = '';
			}
			if (!isEdit) {
				tabSingle.addEventListener('click', function () { setTab('single'); });
				tabSub.addEventListener('click', function () { setTab('sub'); });
			}

			var testing = false;
			testBtn.addEventListener('click', function () {
				if (testing) return;
				var lk = normalizeVlessLink(inLink.value);
				if (lk !== inLink.value.trim()) inLink.value = lk;
				if (!/^vless:\/\//i.test(lk)) { err.textContent = 'Сначала вставь vless://-ссылку'; return; }
				err.textContent = ''; testing = true;
				testBtn.setAttribute('disabled', ''); testMsg.style.color = 'var(--mut)';
				testMsg.textContent = '⟳ проверяю (до ~20с)…';
				fs.write(TESTFILE, lk)
					.then(function (r) { if (!r || r.ok !== true) throw new Error('write'); return fs.exec('/etc/tinyvless/api.sh', ['testlink']); })
					.then(function (r) {
						var res; try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) { res = null; }
						if (res && res.ok) { testMsg.style.color = 'var(--acc)'; testMsg.textContent = '✓ работает · внешний IP ' + res.ip; }
						else { testMsg.style.color = '#f85149'; testMsg.textContent = '✕ ' + ((res && res.error) || 'не отвечает'); }
					})
					.catch(function () { testMsg.style.color = '#f85149'; testMsg.textContent = '✕ ошибка проверки'; })
					.then(function () { testing = false; testBtn.removeAttribute('disabled'); });
			});

			previewBtn.addEventListener('click', function () {
				var url = inSubUrl.value.trim();
				if (!/^https?:\/\//i.test(url)) { err.textContent = 'Вставь URL подписки (http/https)'; return; }
				err.textContent = ''; subPreview.textContent = '⟳ загружаю и фильтрую WS+TLS…';
				previewBtn.setAttribute('disabled', '');
				fetchSubscription(url).then(function (res) {
					subPreview.textContent = '✓ ' + (res.profiles || []).length + ' подходящих из ' + (res.total || 0) + ' (пропущено ' + (res.skipped || 0) + ': gRPC/Reality/TCP/…)';
					subPreview.style.color = 'var(--acc)';
				}).catch(function (e) {
					subPreview.textContent = '✕ ' + ((e && e.message) || 'ошибка');
					subPreview.style.color = '#f85149';
				}).then(function () { previewBtn.removeAttribute('disabled'); });
			});

			panelSingle.appendChild(E('div', { 'class': 'tv-modal-fld' }, [E('label', {}, 'Дружелюбное имя'), inName]));
			panelSingle.appendChild(E('div', { 'class': 'tv-modal-fld' }, [E('label', {}, 'VLESS-ссылка'), inLink]));
			panelSingle.appendChild(E('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [testBtn, testMsg]));

			panelSub.appendChild(E('div', { 'class': 'tv-modal-fld' }, [E('label', {}, 'URL подписки'), inSubUrl]));
			panelSub.appendChild(E('div', { 'class': 'tv-hint' }, 'Загрузим список конфигураций, оставим только VLESS WebSocket+TLS (совместимые с LT300).'));
			panelSub.appendChild(E('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:4px' }, [previewBtn]));
			panelSub.appendChild(subPreview);

			function save() {
				var subOn = !isEdit && currentTab === 'sub';
				if (subOn) {
					var url = inSubUrl.value.trim();
					if (!/^https?:\/\//i.test(url)) { err.textContent = 'Нужен URL подписки (http/https)'; return; }
					err.textContent = '⟳ загружаю подписку…';
					fetchSubscription(url).then(function (res) {
						if (!(res.profiles || []).length) throw new Error('нет совместимых WS+TLS конфигураций');
						var sub = { id: uid(), name: res.name || 'Подписка', url: url, updated_at: Date.now(), profiles: [] };
						mergeSubscriptionProfiles(sub, res);
						if (!st.subscriptions) st.subscriptions = [];
						st.subscriptions.push(sub);
						if (!allProfiles(st).some(function (p) { return p.active; }) && sub.profiles[0]) {
							sub.profiles[0].active = true;
						}
						return saveLinks();
					}).then(function () {
						ui.hideModal();
						renderProfiles();
						ui.addNotification(null, E('p', 'Подписка добавлена'), 'info');
					}).catch(function (e) {
						err.textContent = (e && e.message) || 'Не удалось добавить подписку';
					});
					return;
				}
				var name = inName.value.trim(), link = normalizeVlessLink(inLink.value);
				if (link !== inLink.value.trim()) inLink.value = link;
				if (!/^vless:\/\//i.test(link)) { err.textContent = 'Ссылка должна начинаться с vless://'; return; }
				var bad = linkUnsupported(link);
				if (!name) name = linkSummary(link).split(' · ')[0];
				var oldLink, oldName;
				if (isEdit) {
					oldLink = prof.link; oldName = prof.name;
					prof.name = name;
					if (mode !== 'sub-profile') prof.link = link;
				} else {
					var np = { id: uid(), name: name, link: link, active: false };
					if (!allProfiles(st).length && !bad) np.active = true;
					st.profiles.push(np);
				}
				var wasActive = isEdit && prof.active;
				renderProfiles();
				saveLinks().then(function () {
					ui.hideModal();
					if (bad) ui.addNotification(null, E('p', 'Сохранено, но «' + name + '» — ' + bad + '. Этот профиль нельзя сделать активным.'), 'warning');
					if (wasActive) activateProfile(prof, function () { prof.link = oldLink; prof.name = oldName; });
				}).catch(function () {
					err.textContent = 'Не удалось сохранить профили на роутер';
					if (!isEdit) st.profiles.pop();
					renderProfiles();
				});
			}

			var btns = [E('button', { 'class': 'tv-btn', click: ui.hideModal }, 'Отмена'),
				E('button', { 'class': 'tv-btn acc', style: 'margin-left:8px', click: save }, isEdit ? 'Сохранить' : 'Добавить')];
			if (isEdit && mode !== 'sub-profile') btns.unshift(E('button', {
				'class': 'tv-btn danger', style: 'margin-right:auto', click: function () {
					st.profiles = st.profiles.filter(function (x) { return x !== prof; });
					if (prof.active && st.profiles.length) st.profiles[0].active = true;
					renderProfiles(); saveLinks().then(ui.hideModal);
				}
			}, 'Удалить'));
			if (isEdit && mode === 'sub-profile') {
				inLink.setAttribute('readonly', 'readonly');
				btns = [E('button', { 'class': 'tv-btn', click: ui.hideModal }, 'Закрыть'),
					E('button', { 'class': 'tv-btn acc', style: 'margin-left:8px', click: save }, 'Сохранить имя')];
			}

			var kids = [
				E('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px' }, [
					E('h4', { style: 'margin:0' }, isEdit ? 'Редактировать профиль' : 'Добавить'),
					E('span', { style: 'cursor:pointer;color:var(--mut)', click: ui.hideModal }, [ic('x', 20)])
				])
			];
			if (!isEdit) kids.push(E('div', { 'class': 'tv-tabs' }, [tabSingle, tabSub]));
			kids.push(panelSingle, panelSub, err, E('div', { style: 'display:flex;align-items:center;margin-top:8px' }, btns));
			ui.showModal(null, E('div', { 'class': 'tv' }, kids), 'tv');
		}

		// ====== построение DOM ======
		// -- статус --
		var elState = E('span', { style: 'font-weight:600' }, '…'), elIP = E('span', {}, '—'),
			elDown = E('span', {}, '—'), elUp = E('span', {}, '—'), elActive = E('span', {}, '—'), elServer = E('span', {}, '—'),
			elRamTxt = E('span', {}, '—'), elCpuTxt = E('span', {}, '—'), elUpTxt = E('span', {}, '—'),
			elFlashTxt = E('span', {}, '—'), elRuTxt = E('span', {}, '—'),
			elTrafDay = E('span', {}, '—'), elTrafMonth = E('span', {}, '—'),
			elRamGauge = E('div', {}), elCpuGauge = E('div', {});

		function renderSysinfo() {
			var mt = st.memTotal, ma = st.memAvail;
			if (mt > 0) {
				var used = mt - ma, pct = used * 100 / mt;
				elRamTxt.textContent = (used / 1048576).toFixed(1) + ' / ' + (mt / 1048576).toFixed(0) + ' МБ · своб. ' + (ma / 1048576).toFixed(1) + ' МБ';
				elRamGauge.innerHTML = ''; elRamGauge.appendChild(mkGauge(pct));
			}
			var cpuPct = Math.max(0, Math.min(100, Math.round(st.cpuPct || 0)));
			elCpuTxt.textContent = cpuPct + '%';
			elCpuGauge.innerHTML = ''; elCpuGauge.appendChild(mkGauge(cpuPct));
			elUpTxt.textContent = fmtUptime(st.uptime);
			elFlashTxt.textContent = st.flashPct ? st.flashPct + '% overlay' : '—';
			elRuTxt.textContent = st.ruSet ? (st.ruSubnets + ' подсетей (/18 agg.)') : 'выкл (только домены)';
			elTrafDay.textContent = '↓ ' + fmtBytes(st.dayDown) + ' · ↑ ' + fmtBytes(st.dayUp);
			elTrafMonth.textContent = '↓ ' + fmtBytes(st.monthDown) + ' · ↑ ' + fmtBytes(st.monthUp);
		}

		// -- сворачиваемый мини-журнал (tv-health/OOM/dnsmasq) — карточками, не сплошным <pre>:
		// на мобильном экране длинные строки логов в моноширинном блоке с горизонтальным
		// скроллом читать неудобно — разбиваем каждую строку на время+сообщение как карточку.
		var RE_LOG_LINE = /^(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/;
		function logLineKind(facility, msg) {
			if (/oom|out of memory|killed process/i.test(msg)) return 'danger';
			if (/err\./.test(facility) || /respawn/i.test(msg)) return 'warn';
			return '';
		}
		function renderLogCards(raw) {
			elLogBody.innerHTML = '';
			var lines = (raw || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
			if (!lines.length) { elLogBody.appendChild(E('div', { 'class': 'tv-log-empty' }, 'Журнал пуст.')); return; }
			lines.slice().reverse().forEach(function (line) {
				var m = RE_LOG_LINE.exec(line);
				var time = m ? m[1] : '';
				var facility = m ? m[2] : '';
				var msg = m ? m[3] : line;
				var kind = logLineKind(facility, msg);
				elLogBody.appendChild(E('div', { 'class': 'tv-log-card' + (kind ? ' ' + kind : '') }, [
					time ? E('div', { 'class': 'tv-log-time' }, time) : null,
					E('div', { 'class': 'tv-log-msg' }, msg)
				]));
			});
		}
		var elLogBody = E('div', { 'class': 'tv-log-body', style: 'display:none' });
		var logOpen = false, logLoaded = false;
		var btnLogToggle = E('button', {
			'class': 'tv-btn small ghost', style: 'margin-top:12px', click: ui.createHandlerFn(this, function () {
				logOpen = !logOpen;
				elLogBody.style.display = logOpen ? 'block' : 'none';
				btnLogToggle.lastChild.textContent = logOpen ? ' Скрыть журнал' : ' Показать журнал';
				if (logOpen && !logLoaded) {
					logLoaded = true;
					elLogBody.innerHTML = '';
					elLogBody.appendChild(E('div', { 'class': 'tv-log-empty' }, 'Загрузка…'));
					fs.exec('/etc/tinyvless/api.sh', ['log']).then(function (r) {
						renderLogCards(r.stdout || '');
					}).catch(function () {
						elLogBody.innerHTML = '';
						elLogBody.appendChild(E('div', { 'class': 'tv-log-empty' }, '⛔ ошибка загрузки журнала'));
						logLoaded = false;
					});
				}
			})
		}, [ic('arrowr', 14), E('span', {}, ' Показать журнал')]);

		var statusBox = E('div', { 'class': 'tv-status' }, [
			E('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' }, [ic('broadcast', 20), E('b', { style: 'font-size:15px' }, 'Статус подключения')]),
			E('div', { 'class': 'tv-stat-grid' }, [
				mkStat('Состояние', elState),
				mkStat('Сервер', elServer),
				mkStat('Внешний IP (через туннель)', elIP),
				mkStat('Скорость', E('span', {}, [elDown, E('span', { style: 'color:var(--mut)' }, ' · '), elUp])),
				mkStat('Активных соединений', elActive),
				mkStat('RAM', [elRamTxt, elRamGauge]),
				mkStat('CPU', [elCpuTxt, elCpuGauge]),
				mkStat('Uptime роутера', elUpTxt),
				mkStat('Flash overlay', elFlashTxt),
				mkStat('RU CIDR', elRuTxt),
				mkStat('Трафик сегодня', elTrafDay),
				mkStat('Трафик за месяц', elTrafMonth)
			]),
			btnLogToggle,
			elLogBody
		]);
		renderSysinfo();
		var prev = null, prevT = 0, offStreak = 0;
		// uhttpd держит всего 3 одновременных CGI-слота (-n 3) — пока идёт speedtest (много
		// последовательных запросов, включая блокирующий ICMP-пинг), обычный поллинг каждые 8с
		// конкурировал за те же слоты и панель периодически "подвисала". Пропускаем поллинг,
		// пока speedBusy (см. карточку Speedtest ниже).
		var speedBusy = false;
		// idle-бэкофф: если панель открыта, но никто не тыкал в неё N минут — реже дёргаем
		// api.sh (интервал таймера не трогаем, просто пропускаем часть тиков — проще и надёжнее,
		// чем пересоздавать poll.add на лету). На первый же клик/тач сразу возвращаемся к полной
		// частоте (idleTick сбрасывается вместе с lastInteraction).
		var lastInteraction = Date.now(), idleTick = 0;
		var IDLE_AFTER_MS = 5 * 60 * 1000, IDLE_SKIP_EVERY = 3;
		document.addEventListener('click', function () { lastInteraction = Date.now(); idleTick = 0; }, true);
		document.addEventListener('touchstart', function () { lastInteraction = Date.now(); idleTick = 0; }, true);
		function idleSkip() {
			if (Date.now() - lastInteraction < IDLE_AFTER_MS) return false;
			idleTick++;
			return (idleTick % IDLE_SKIP_EVERY) !== 0;
		}
		function pollStatus() {
			if (speedBusy || testingAll || idleSkip()) return Promise.resolve();
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
		}
		poll.add(pollStatus, st.pollInterval);

		function pollSysinfo() {
			if (speedBusy || testingAll || idleSkip()) return Promise.resolve();
			return fs.exec('/etc/tinyvless/api.sh', ['state']).then(function (res) {
				var js; try { js = JSON.parse((res.stdout || '').trim()); } catch (e) { return; }
				st.memTotal = js.mem_total || st.memTotal;
				st.memAvail = js.mem_avail || st.memAvail;
				st.cpuPct = js.cpu_pct != null ? js.cpu_pct : st.cpuPct;
				st.uptime = js.uptime || st.uptime;
				st.flashPct = js.flash_pct || st.flashPct;
				st.ruSubnets = js.ru_subnets || st.ruSubnets;
				if (js.ru_set !== undefined) st.ruSet = !!js.ru_set;
				st.dayUp = js.day_up || 0; st.dayDown = js.day_down || 0;
				st.monthUp = js.month_up || 0; st.monthDown = js.month_down || 0;
				renderSysinfo();
			});
		}
		poll.add(pollSysinfo, st.pollInterval);

		// -- карточка Управление --
		elDot = E('span', { 'class': 'tv-dot' });
		elStateTxt = E('span', { style: 'font-weight:500;min-width:0' }, '');
		btnPower = E('button', { click: ui.createHandlerFn(this, togglePower) });
		btnReboot = E('button', { 'class': 'tv-btn', click: ui.createHandlerFn(this, confirmReboot) }, [ic('refresh', 16), E('span', {}, ' Перезагрузить')]);
		btnShutdown = E('button', { 'class': 'tv-btn danger', click: ui.createHandlerFn(this, confirmPoweroff) }, [ic('power', 16), E('span', {}, ' Выключить')]);
		['selective', 'full', 'off'].forEach(function (m) {
			var meta = { selective: ['route', 'Селективный'], full: ['shield', 'В туннель'], off: ['arrowr', 'Напрямую'] }[m];
			modeBtns[m] = E('button', { 'class': 'tv-mode', click: ui.createHandlerFn(self, function () { setMode(m); }) }, [ic(meta[0], 18), E('span', {}, meta[1])]);
		});
		elAutoSw = E('input', { type: 'checkbox' });
		elAutoSw.checked = st.autostart;
		elAutoSw.addEventListener('change', function () {
			var on = elAutoSw.checked;
			fs.exec('/etc/tinyvless/api.sh', ['autostart', on ? 'on' : 'off']).then(function () { st.autostart = on; })
				.catch(function () { elAutoSw.checked = !on; });
		});

		function applyTuning(key, val, onFail) {
			if (busyOn) { if (onFail) onFail(); return; }
			setBusy(true); controlBanner.show('Применяю настройку…');
			fs.exec('/etc/tinyvless/api.sh', ['tuning', key, val]).then(function (r) {
				if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
				st.rawCfg = setKV(st.rawCfg, key === 'select_level' ? 'SELECT_LEVEL' : key === 'ru_set' ? 'RU_SET' : 'UDP_TUNNEL',
					key === 'ru_set' ? (val === 'on' ? '1' : '0') : val);
				setBusy(false); controlBanner.ok('Настройка применена');
			}).catch(function () { if (onFail) onFail(); setBusy(false); controlBanner.err('Не удалось применить'); });
		}

		var swSelectHigh = E('input', { type: 'checkbox' });
		swSelectHigh.checked = st.selectLevel === 'high';
		swSelectHigh.addEventListener('change', function () {
			var high = swSelectHigh.checked, prev = st.selectLevel;
			st.selectLevel = high ? 'high' : 'low';
			applyTuning('select_level', st.selectLevel, function () { swSelectHigh.checked = !high; st.selectLevel = prev; });
		});

		var swRuCidr = E('input', { type: 'checkbox' });
		swRuCidr.checked = st.ruSet;
		swRuCidr.addEventListener('change', function () {
			var on = swRuCidr.checked, prev = st.ruSet;
			st.ruSet = on;
			applyTuning('ru_set', on ? 'on' : 'off', function () { swRuCidr.checked = !on; st.ruSet = prev; });
		});

		var swUdpSelective = E('input', { type: 'checkbox' });
		swUdpSelective.checked = st.udpTunnel === 'selective';
		swUdpSelective.addEventListener('change', function () {
			var sel = swUdpSelective.checked, prev = st.udpTunnel;
			st.udpTunnel = sel ? 'selective' : 'full';
			applyTuning('udp_tunnel', st.udpTunnel, function () { swUdpSelective.checked = !sel; st.udpTunnel = prev; });
		});

		function mkTrow(title, hint, swInput) {
			return E('div', { 'class': 'tv-trow' }, [
				E('div', { 'class': 'tl' }, [E('b', {}, title), E('small', {}, hint)]),
				E('label', { 'class': 'tv-sw rect' }, [swInput, E('span', { 'class': 'sl' })])
			]);
		}

		var controlCard = E('div', { 'class': 'tv-card' }, [
			controlBanner.el,
			E('div', { 'class': 'tv-row tv-power-row', style: 'margin-bottom:16px' }, [
				E('div', { 'class': 'tv-power-st' }, [elDot, elStateTxt]),
				btnPower
			]),
			E('div', { 'class': 'tv-lbl' }, 'Режим маршрутизации'),
			E('div', { 'class': 'tv-modes' }, [modeBtns.selective, modeBtns.full, modeBtns.off]),
			E('div', { 'class': 'tv-sep tv-autostart' }, [
				E('div', { 'class': 'tl' }, [
					E('b', {}, 'Автозагрузка'),
					E('small', {}, 'Запускать tinyvless автоматически при включении роутера.')
				]),
				E('label', { 'class': 'tv-sw rect' }, [elAutoSw, E('span', { 'class': 'sl' })])
			]),
			E('div', { 'class': 'tv-lbl tv-sep' }, 'Тонкая настройка (селективный режим)'),
			mkTrow('Select High', 'Вкл: в туннель только домены из списка «Принудительно в туннель». Выкл (Low): классика — всё зарубежное в туннель.', swSelectHigh),
			mkTrow('RU CIDR база', 'Гео-набор ~1109 /16-подсетей (~0.4 МБ RAM). Выкл — только direct/tunnel домены.', swRuCidr),
			mkTrow('Селективный UDP', 'Вкл: UDP через tproxy только для доменов из списка в микротюнинге (+ Discord-порты). Выкл: весь UDP.', swUdpSelective)
		]);

		var elClientsList = E('div', {});
		function renderClients() {
			elClientsList.innerHTML = '';
			if (!st.clients.length) {
				elClientsList.appendChild(E('div', { style: 'color:var(--mut);font-size:13px;padding:6px 0' }, 'Нет активных DHCP-клиентов.'));
				return;
			}
			st.clients.forEach(function (c) {
				var sw = E('input', { type: 'checkbox' });
				sw.checked = c.proxy !== false;
				sw.addEventListener('change', function () {
					var wantProxy = sw.checked, prev = c.proxy;
					c.proxy = wantProxy;
					var act = wantProxy ? 'off' : 'on';
					fs.exec('/etc/tinyvless/api.sh', ['client_bypass', c.mac, act]).then(function (r) {
						if (!/"ok":true/.test(r.stdout || '')) throw new Error('bad');
					}).catch(function () { sw.checked = !wantProxy; c.proxy = prev; clientsBanner.err('Не удалось сменить режим клиента'); });
				});
				elClientsList.appendChild(E('div', { 'class': 'tv-client' }, [
					E('div', { 'class': 'nm' }, [
						E('b', {}, c.hostname && c.hostname !== '*' ? c.hostname : c.ip),
						E('small', {}, c.ip + ' · ' + c.mac)
					]),
					E('label', { 'class': 'tv-sw rect', title: 'Проксировать' }, [sw, E('span', { 'class': 'sl' })])
				]));
			});
		}
		var clientsCard = E('div', { 'class': 'tv-card' }, [
			clientsBanner.el,
			E('div', { 'class': 'tv-h' }, [
				E('h3', {}, 'Клиенты LAN'),
				E('button', { 'class': 'tv-btn small', click: function () {
					fs.exec('/etc/tinyvless/api.sh', ['clients']).then(function (r) {
						try { st.clients = JSON.parse((r.stdout || '').trim()).clients || []; } catch (e) { st.clients = []; }
						renderClients();
					});
				} }, 'Обновить')
			]),
			E('div', { 'class': 'tv-hint', style: 'margin:0 0 10px' }, 'Выключите переключатель — клиент ходит в интернет напрямую, минуя туннель (по MAC).'),
			elClientsList
		]);
		renderClients();

		// -- бэкап/восстановление настроек (config+списки доменов+ссылки) --
		var elBackupMsg = E('span', { style: 'margin-left:10px;color:var(--mut);font-size:13px' });
		var btnExport = E('a', {
			'class': 'tv-btn small', href: '/cgi-bin/backup?a=export'
		}, [ic('download', 14), E('span', {}, ' Экспорт настроек')]);
		var inRestore = E('input', { type: 'file', accept: '.gz,.tgz,application/gzip', style: 'display:none' });
		var btnImport = E('button', {
			'class': 'tv-btn small', click: function () { inRestore.click(); }
		}, [ic('upload', 14), E('span', {}, ' Импорт настроек')]);
		inRestore.addEventListener('change', function () {
			var f = inRestore.files && inRestore.files[0];
			if (!f) return;
			if (!confirm('Заменить текущие настройки (конфиг, списки доменов, профили) содержимым файла «' + f.name + '»?')) { inRestore.value = ''; return; }
			elBackupMsg.textContent = 'восстанавливаю…';
			fetch('/cgi-bin/backup?a=restore', { method: 'POST', body: f }).then(function (r) { return r.json(); }).then(function (j) {
				if (j && j.ok) {
					elBackupMsg.textContent = '✓ восстановлено, обновите страницу';
				} else {
					elBackupMsg.textContent = '⛔ ' + ((j && j.error) || 'ошибка восстановления');
				}
			}).catch(function () { elBackupMsg.textContent = '⛔ ошибка запроса'; })
				.then(function () { inRestore.value = ''; });
		});

		var systemCard = E('div', { 'class': 'tv-card tv-sys-card' }, [
			systemBanner.el,
			E('div', { 'class': 'tv-h', style: 'margin-bottom:10px' }, [
				E('h3', {}, [ic('power', 18), E('span', {}, ' Система')])
			]),
			E('div', { 'class': 'tv-hint', style: 'margin:0 0 4px' },
				'Корректное управление питанием OpenWrt — без обрыва питания из розетки.'),
			E('div', { 'class': 'tv-sys-actions' }, [btnReboot, btnShutdown]),
			E('div', { 'class': 'tv-lbl tv-sep' }, 'Резервная копия настроек'),
			E('div', { 'class': 'tv-hint', style: 'margin:0 0 10px' },
				'Конфиг, списки доменов и профили-ссылки — без самого туннельного бинарника.'),
			E('div', { 'class': 'tv-sys-actions' }, [btnExport, btnImport, inRestore]),
			elBackupMsg
		]);

		// -- карточка Профили --
		elProfList = E('div', {});
		var profCard = E('div', { 'class': 'tv-card' }, [
			profBanner.el,
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
					'В режиме «Селективный» используется компактная RU-база ',
					E('b', {}, (st.ruSubnets || '~1109') + ' /16-подсетей'),
					' (или только домены, если CIDR выкл). ',
					'Select High — в туннель только список «Принудительно в туннель».'
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
			dohBtns[m] = E('button', { 'class': 'tv-mode', click: ui.createHandlerFn(self, function () { setDohMode(m); }) }, [ic(meta[0], 18), E('span', {}, meta[1])]);
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

		// -- карточка проверки доступности (nslookup/ping по списку доменов) --
		var REACH_KEY = 'tv_reach_domains_v1';
		function loadReachDomains() {
			try {
				var o = JSON.parse(localStorage.getItem(REACH_KEY) || '{}');
				return { nslookup: Array.isArray(o.nslookup) ? o.nslookup : [], ping: Array.isArray(o.ping) ? o.ping : [] };
			} catch (e) { return { nslookup: [], ping: [] }; }
		}
		function saveReachDomains(rd) {
			try { localStorage.setItem(REACH_KEY, JSON.stringify(rd)); } catch (e) { /* noop */ }
		}
		var reachDomains = loadReachDomains();

		function buildReachSection(kind, label, placeholder) {
			var elList = E('div', { 'class': 'tv-reach-list' });
			var inp = E('input', { type: 'text', 'class': 'tv-inp', placeholder: placeholder });

			function renderList() {
				elList.innerHTML = '';
				var arr = reachDomains[kind];
				if (!arr.length) { elList.appendChild(E('div', { 'class': 'tv-reach-empty' }, 'Список пуст — добавьте домен.')); return; }
				arr.forEach(function (d, idx) {
					elList.appendChild(E('div', { 'class': 'tv-reach-chip' }, [
						E('span', { 'class': 'nm' }, d),
						E('span', { 'class': 'st' }, '—'),
						E('button', {
							'class': 'tv-btn small icon', type: 'button', title: 'Удалить',
							click: function () { arr.splice(idx, 1); saveReachDomains(reachDomains); renderList(); }
						}, [ic('x', 14)])
					]));
				});
			}
			renderList();

			function addDomain() {
				var d = (inp.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
				if (!d || !/^[a-z0-9.-]+$/.test(d)) { inp.focus(); return; }
				if (reachDomains[kind].indexOf(d) >= 0) { inp.value = ''; return; }
				reachDomains[kind].push(d);
				saveReachDomains(reachDomains);
				inp.value = '';
				renderList();
			}
			inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') addDomain(); });
			var btnAdd = E('button', { 'class': 'tv-btn small icon acc', type: 'button', title: 'Добавить', click: addDomain }, [ic('plus', 14)]);

			var checking = false;
			var btnCheck = E('button', {
				'class': 'tv-btn small acc', click: ui.createHandlerFn(this, function () {
					var arr = reachDomains[kind];
					if (checking || !arr.length) return;
					checking = true; btnCheck.setAttribute('disabled', '');
					var chips = elList.querySelectorAll('.tv-reach-chip');
					chips.forEach(function (c) { var s = c.querySelector('.st'); s.className = 'st'; s.textContent = '…'; });
					Promise.all(arr.map(function (d, idx) {
						return fs.exec('/etc/tinyvless/api.sh', ['checkreach', kind, d]).then(function (r) {
							var res; try { res = JSON.parse((r.stdout || '').trim()); } catch (e) { res = null; }
							var s = chips[idx] && chips[idx].querySelector('.st');
							if (!s) return;
							if (res && res.ok) { s.className = 'st ok'; s.textContent = res.detail || 'ok'; }
							else { s.className = 'st fail'; s.textContent = (res && res.detail) || 'ошибка'; }
						}).catch(function () {
							var s = chips[idx] && chips[idx].querySelector('.st');
							if (s) { s.className = 'st fail'; s.textContent = 'ошибка запроса'; }
						});
					})).then(function () {
						checking = false; btnCheck.removeAttribute('disabled');
					});
				})
			}, [ic('search', 14), E('span', {}, ' Проверить')]);

			return E('div', {}, [
				E('div', { 'class': 'tv-lbl' }, label),
				E('div', { 'class': 'tv-reach-row' }, [inp, btnAdd, btnCheck]),
				elList
			]);
		}

		var reachCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-h' }, [E('h3', {}, [ic('globe', 18), E('span', {}, 'Проверка доступности')])]),
			E('div', { 'class': 'tv-info' }, [
				ic('shield', 16, 'tv-mut'),
				E('div', {}, 'Проверяет резолвинг (nslookup) и отклик (ping) для доменов из списков ниже — быстро понять, доступен ли сервис прямо сейчас.')
			]),
			buildReachSection('nslookup', 'Проверка DNS (nslookup)', 'example.com'),
			E('div', { style: 'margin-top:16px' }, [buildReachSection('ping', 'Проверка отклика (ping)', 'example.com')])
		]);

		// -- карточка диагностики модема (сигнал/оператор/тип сети/регистрация) --
		var REG_LABELS = {
			0: 'не зарегистрирован', 1: 'зарегистрирован (home)', 2: 'поиск сети…',
			3: 'отказано в регистрации', 4: 'неизвестно', 5: 'роуминг',
			6: 'только SMS (home)', 7: 'только SMS (роуминг)', 8: 'только экстренные вызовы',
			9: 'CSFB не предпочтителен (home)', 10: 'CSFB не предпочтителен (роуминг)'
		};
		function regLabel(code) {
			if (code == null) return '—';
			return REG_LABELS[code] != null ? REG_LABELS[code] : ('статус ' + code);
		}
		var elNetOp = E('span', {}, '—');
		var elNetType = E('span', {}, '—');
		var elNetSignal = E('span', {}, '—');
		var elNetRegData = E('span', {}, '—');
		var elNetRegVoice = E('span', {}, '—');
		var elNetModel = E('span', {}, '—');
		var elNetHealth = E('span', {}, '—');
		var elNetCheckedAgo = E('span', {}, '—');
		var elNetErr = E('div', { style: 'color:#f85149;font-size:13px;margin-top:10px;display:none' });
		var netBusy = false;
		function netRefresh() {
			if (netBusy) return;
			netBusy = true; btnNetRefresh.setAttribute('disabled', '');
			btnNetRefresh.innerHTML = ''; btnNetRefresh.appendChild(ic('loader', 14, 'tv-spin'));
			btnNetRefresh.appendChild(document.createTextNode(' Опрос…'));
			fs.exec('/etc/tinyvless/api.sh', ['netinfo']).then(function (r) {
				var ni; try { ni = JSON.parse((r.stdout || '').trim()); } catch (e) { ni = null; }
				if (!ni || ni.error) { elNetErr.style.display = 'block'; elNetErr.textContent = '⛔ не удалось опросить модем'; return; }
				elNetErr.style.display = 'none';
				elNetOp.textContent = ni.operator || '—';
				elNetType.textContent = ni.net_type || '—';
				elNetSignal.textContent = (ni.signal_rssi != null && ni.signal_rssi >= 0) ? (ni.signal_pct + '% (' + ni.signal_dbm + ' dBm)') : '—';
				elNetRegData.textContent = regLabel(ni.cereg);
				elNetRegVoice.textContent = regLabel(ni.creg);
				elNetModel.textContent = ni.model || '—';
			}).catch(function () {
				elNetErr.style.display = 'block'; elNetErr.textContent = '⛔ ошибка запроса';
			}).then(function () {
				netBusy = false; btnNetRefresh.removeAttribute('disabled');
				btnNetRefresh.innerHTML = ''; btnNetRefresh.appendChild(ic('refresh', 14));
				btnNetRefresh.appendChild(document.createTextNode(' Обновить'));
			});
		}
		var ledBusy = false;
		function ledRefresh() {
			if (ledBusy) return;
			ledBusy = true; btnLedRefresh.setAttribute('disabled', '');
			fs.exec('/etc/tinyvless/api.sh', ['led_refresh']).catch(function () {}).then(function () {
				ledBusy = false; btnLedRefresh.removeAttribute('disabled');
			});
		}
		// баннер плохой связи (вверху страницы, вне грида) — обновляется вместе с netcheck
		var elBanner = E('div', { 'class': 'tv-banner', style: 'display:none' }, [ic('alertTriangle', 18), E('span', { 'class': 'tv-banner-txt' })]);
		function fmtAgo(ts) {
			if (!ts) return '—';
			var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
			if (s < 60) return s + ' секунд назад';
			if (s < 3600) return Math.floor(s / 60) + ' мин назад';
			return Math.floor(s / 3600) + ' ч назад';
		}
		function pollNetcheck() {
			return fs.exec('/etc/tinyvless/api.sh', ['netcheck']).then(function (r) {
				var nc; try { nc = JSON.parse((r.stdout || '').trim()); } catch (e) { nc = null; }
				if (!nc || nc.error) { elNetHealth.textContent = '—'; elNetCheckedAgo.textContent = '—'; return; }
				elNetHealth.textContent = nc.ping_ok
					? ('ping ' + (nc.ping_detail || 'ok') + (nc.dns_ok ? ', DNS ок' : ', DNS не отвечает'))
					: '⛔ нет ответа от ' + (nc.target || 'цели проверки');
				elNetCheckedAgo.textContent = fmtAgo(nc.checked_at);
				if (st.modemHidden.indexOf('banner') !== -1 || nc.state === 'ok' || !nc.state) {
					elBanner.style.display = 'none';
					return;
				}
				elBanner.className = 'tv-banner ' + (nc.state === 'bad' ? 'bad' : 'warn');
				elBanner.querySelector('.tv-banner-txt').textContent = nc.state === 'bad'
					? ('Нет связи с провайдером — ping до ' + (nc.target || '') + ' не проходит')
					: ('Слабый сигнал — ' + (nc.signal_pct != null ? nc.signal_pct + '%' : '?') + ' (' + (nc.signal_dbm || '?') + ' dBm), возможны обрывы');
				elBanner.style.display = 'flex';
			}).catch(function () {});
		}
		poll.add(pollNetcheck, st.pollInterval);
		var btnNetRefresh = E('button', { 'class': 'tv-btn small acc', click: ui.createHandlerFn(this, netRefresh) }, [ic('refresh', 14), E('span', {}, ' Обновить')]);
		var btnLedRefresh = E('button', { 'class': 'tv-btn small', title: 'Обновить светодиоды', click: ui.createHandlerFn(this, ledRefresh) }, [ic('bulb', 14), E('span', { 'class': 'tv-btn-txt' }, ' Светодиоды')]);
		var NET_STATS = [
			{ key: 'operator', node: mkStat('Оператор', elNetOp) },
			{ key: 'net_type', node: mkStat('Тип сети', elNetType) },
			{ key: 'signal', node: mkStat('Сигнал', elNetSignal) },
			{ key: 'model', node: mkStat('Модель модема', elNetModel) },
			{ key: 'reg_data', node: mkStat('Регистрация (данные)', elNetRegData) },
			{ key: 'reg_voice', node: mkStat('Регистрация (голос/SMS)', elNetRegVoice) },
			{ key: 'health', node: mkStat('Здоровье сети', elNetHealth) },
			{ key: 'checked_ago', node: mkStat('Проверка была', elNetCheckedAgo) }
		];
		var netHeaderBtns = [
			{ key: 'btn_led', node: btnLedRefresh },
			{ key: 'always', node: btnNetRefresh }
		];
		var netCard = E('div', { 'class': 'tv-card' }, [
			E('div', { 'class': 'tv-h' }, [E('h3', {}, [ic('signal', 18), E('span', {}, 'Модем')]),
				E('div', { 'class': 'tv-h-actions' }, netHeaderBtns.filter(function (b) { return st.modemHidden.indexOf(b.key) === -1; }).map(function (b) { return b.node; }))
			]),
			E('div', { 'class': 'tv-stat-grid tv-stat-grid-fixed2' },
				NET_STATS.filter(function (s) { return st.modemHidden.indexOf(s.key) === -1; }).map(function (s) { return s.node; })
			),
			elNetErr
		]);
		netRefresh();
		pollNetcheck();

		// -- карточка speedtest: ДВОЙНОЙ тест (через туннель socks5 127.0.0.1:1080 и напрямую)
		// с живым прогрессом — вместо одного долгого блокирующего запроса гоняем несколько
		// мелких "чанков" подряд, обновляя число после КАЖДОГО (иначе цифра "мгновенная"
		// только в момент завершения всего теста, а до этого экран выглядит зависшим).
		function mbpsToPct(v) {
			if (!v || v <= 0) return 2;
			var pct = Math.log(v + 1) / Math.log(101) * 100;
			return Math.max(2, Math.min(100, pct));
		}
		function pingToPct(ms) {
			if (ms == null || ms <= 0) return 2;
			var pct = 100 - Math.min(100, ms / 20);
			return Math.max(2, pct);
		}
		var RING_R = 54, RING_C = 2 * Math.PI * RING_R;
		var elRingProg = null;
		function mkSpeedRing() {
			var svgNs = 'http://www.w3.org/2000/svg';
			var svg = document.createElementNS(svgNs, 'svg');
			svg.setAttribute('viewBox', '0 0 120 120');
			var bg = document.createElementNS(svgNs, 'circle');
			bg.setAttribute('cx', 60); bg.setAttribute('cy', 60); bg.setAttribute('r', RING_R);
			bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', 'rgba(139,148,158,.18)'); bg.setAttribute('stroke-width', '10');
			var prog = document.createElementNS(svgNs, 'circle');
			prog.setAttribute('cx', 60); prog.setAttribute('cy', 60); prog.setAttribute('r', RING_R);
			prog.setAttribute('fill', 'none'); prog.setAttribute('stroke', 'var(--acc)'); prog.setAttribute('stroke-width', '10');
			prog.setAttribute('stroke-linecap', 'round');
			prog.setAttribute('stroke-dasharray', RING_C);
			prog.setAttribute('stroke-dashoffset', RING_C);
			prog.setAttribute('transform', 'rotate(-90 60 60)');
			prog.style.transition = 'stroke-dashoffset .35s linear';
			svg.appendChild(bg); svg.appendChild(prog);
			elRingProg = prog;
			return svg;
		}
		function setRing(pct) {
			elRingProg.setAttribute('stroke-dashoffset', String(RING_C - (Math.max(0, Math.min(100, pct)) / 100) * RING_C));
		}
		var elRingBig = E('b', { style: 'font-size:30px;line-height:1' }, '—');
		var elRingLbl = E('span', { style: 'font-size:12px;color:var(--mut);margin-top:4px;text-align:center' }, 'Готов к тесту');

		var VIAS = [{ key: 'tunnel', label: 'Туннель' }, { key: 'direct', label: 'Напрямую' }];
		var elSpeedCells = {}, elSpeedDetail = {};
		VIAS.forEach(function (v) {
			elSpeedCells[v.key] = { ping: E('b', {}, '—'), down: E('b', {}, '—'), up: E('b', {}, '—') };
			elSpeedDetail[v.key] = E('div', { 'class': 'tv-speed-detail' });
		});

		function speedCall(cmd, via, src, bytes) {
			var args = bytes != null ? [cmd, via, src.url, src.type, String(bytes)] : [cmd, via, src.url, src.type];
			return fs.exec('/etc/tinyvless/api.sh', args).then(function (r) {
				var j; try { j = JSON.parse((r.stdout || '').trim()); } catch (e) { j = null; }
				return j;
			}).catch(function () { return null; });
		}

		// последовательные чанки, cumulative Мбит/с после каждого — это и есть "живое" значение.
		// Резолвится итоговым cumulative-значением (null, если ни один чанк не прошёл).
		// speedCancelled проверяется МЕЖДУ чанками — уже запущенный запрос до конца не оборвать
		// (это shell exec, а не fetch с AbortController), но следующий чанк уже не уйдёт.
		function runChunks(cmd, via, src, bytesPerChunk, count, onProgress) {
			var doneBytes = 0, doneTime = 0, anyOk = false;
			function step(i) {
				if (speedCancelled || i >= count) return Promise.resolve(anyOk ? (doneBytes * 8) / (doneTime * 1000000) : null);
				return speedCall(cmd, via, src, bytesPerChunk).then(function (j) {
					if (j && j.http === 200 && j.bytes > 0 && j.time > 0) {
						anyOk = true;
						doneBytes += j.bytes; doneTime += j.time;
						var cur = (doneBytes * 8) / (doneTime * 1000000);
						onProgress(cur);
						return step(i + 1);
					}
					return anyOk ? (doneBytes * 8) / (doneTime * 1000000) : null;
				});
			}
			return step(0);
		}

		function avgOf(arr) {
			var v = arr.filter(function (x) { return x != null; });
			if (!v.length) return null;
			return v.reduce(function (a, b) { return a + b; }, 0) / v.length;
		}

		function mkViaGroup(via, label) {
			return E('div', { 'class': 'tv-speed-group' }, [
				E('div', { 'class': 'tv-speed-group-h' }, label),
				E('div', { 'class': 'tv-speed-results' }, [
					E('div', { 'class': 'r' }, [elSpeedCells[via].ping, E('span', {}, 'Пинг')]),
					E('div', { 'class': 'r' }, [elSpeedCells[via].down, E('span', {}, 'Загрузка')]),
					E('div', { 'class': 'r' }, [elSpeedCells[via].up, E('span', {}, 'Отдача')])
				]),
				elSpeedDetail[via]
			]);
		}

		var speedBusy = false, speedCancelled = false;
		var btnSpeedGo = E('button', { 'class': 'tv-btn acc', click: ui.createHandlerFn(this, function () { runSpeedtest(); }) }, [ic('broadcast', 16), E('span', {}, ' Начать тест')]);
		var btnSpeedStop = E('button', {
			'class': 'tv-btn danger', style: 'display:none', click: ui.createHandlerFn(this, function () {
				speedCancelled = true;
				elRingLbl.textContent = 'Останавливаю…';
			})
		}, [ic('x', 16), E('span', {}, ' Остановить тест')]);

		// один источник (source) — пинг → скачивание(чанки) → отдача(чанки), с живым обновлением
		// кольца/детализации. Возвращает {ping,down,up} (любое поле может быть null = недоступно).
		function runSource(via, label, src) {
			var srcLabel = label + ' (' + (src.label || src.url) + ')';
			var row = E('div', { 'class': 'tv-speed-src-row' }, [
				E('span', { 'class': 'nm' }, src.label || src.url),
				E('span', { 'class': 'v' }, '…')
			]);
			elSpeedDetail[via].appendChild(row);
			var vEl = row.querySelector('.v');
			elRingLbl.textContent = srcLabel + ': пинг…'; elRingBig.textContent = '…'; setRing(4);
			return speedCall('speedtest_ping', via, src).then(function (j) {
				var ms = j && j.http === 200 && j.ping_ms > 0 ? j.ping_ms : null;
				if (ms == null) { vEl.textContent = 'недоступно'; elRingLbl.textContent = srcLabel + ': недоступно'; elRingBig.textContent = '—'; setRing(0); return { ping: null, down: null, up: null }; }
				vEl.textContent = ms + ' мс · …';
				elRingLbl.textContent = srcLabel + ': загрузка…'; setRing(pingToPct(ms));
				return runChunks('speedtest_dl_chunk', via, src, 700000, 5, function (mbps) {
					vEl.textContent = ms + ' мс · ↓' + mbps.toFixed(2) + ' · …';
					elRingBig.textContent = mbps.toFixed(1); elRingLbl.textContent = srcLabel + ': Мбит/с (загрузка)'; setRing(mbpsToPct(mbps));
				}).then(function (down) {
					vEl.textContent = ms + ' мс · ↓' + (down != null ? down.toFixed(2) : 'н/д') + ' · …';
					elRingLbl.textContent = srcLabel + ': отдача…';
					if (speedCancelled) return { ping: ms, down: down, up: null };
					return runChunks('speedtest_ul_chunk', via, src, 450000, 4, function (mbps) {
						vEl.textContent = ms + ' мс · ↓' + (down != null ? down.toFixed(2) : 'н/д') + ' · ↑' + mbps.toFixed(2);
						elRingBig.textContent = mbps.toFixed(1); elRingLbl.textContent = srcLabel + ': Мбит/с (отдача)'; setRing(mbpsToPct(mbps));
					}).then(function (up) {
						vEl.textContent = ms + ' мс · ↓' + (down != null ? down.toFixed(2) : 'н/д') + ' · ↑' + (up != null ? up.toFixed(2) : 'н/д');
						return { ping: ms, down: down, up: up };
					});
				});
			});
		}

		// несколько источников подряд (тест каждого по очереди) — итог усредняем для "полной
		// картины" вместо доверия одному серверу, который сам может тормозить/быть перегружен.
		function runVia(via, label) {
			elSpeedDetail[via].innerHTML = '';
			var sources = (st.speedSources && st.speedSources[via]) || [];
			if (!sources.length || speedCancelled) {
				elSpeedCells[via].ping.textContent = 'н/д'; elSpeedCells[via].down.textContent = 'н/д'; elSpeedCells[via].up.textContent = 'н/д';
				return Promise.resolve();
			}
			var pings = [], downs = [], ups = [];
			function next(i) {
				if (speedCancelled || i >= sources.length) {
					var ap = avgOf(pings), ad = avgOf(downs), au = avgOf(ups);
					elSpeedCells[via].ping.textContent = ap != null ? (Math.round(ap) + ' мс') : 'н/д';
					elSpeedCells[via].down.textContent = ad != null ? (ad.toFixed(2) + ' Мбит/с') : 'н/д';
					elSpeedCells[via].up.textContent = au != null ? (au.toFixed(2) + ' Мбит/с') : 'н/д';
					return Promise.resolve();
				}
				return runSource(via, label, sources[i]).then(function (r) {
					pings.push(r.ping); downs.push(r.down); ups.push(r.up);
					return next(i + 1);
				});
			}
			return next(0);
		}

		function runSpeedtest() {
			if (speedBusy) return;
			speedBusy = true; speedCancelled = false;
			btnSpeedGo.setAttribute('disabled', ''); btnSpeedGo.style.display = 'none';
			btnSpeedStop.style.display = '';
			VIAS.forEach(function (v) {
				elSpeedCells[v.key].ping.textContent = '—';
				elSpeedCells[v.key].down.textContent = '—';
				elSpeedCells[v.key].up.textContent = '—';
			});
			runVia('tunnel', 'Туннель').then(function () {
				return runVia('direct', 'Напрямую');
			}).then(function () {
				if (speedCancelled) { elRingLbl.textContent = 'Остановлено'; elRingBig.textContent = '—'; }
				else { elRingLbl.textContent = 'Готово'; elRingBig.textContent = '✓'; }
				setRing(0);
			}).catch(function () {
				elRingLbl.textContent = '⛔ ошибка теста'; elRingBig.textContent = '—'; setRing(0);
			}).then(function () {
				speedBusy = false; btnSpeedGo.removeAttribute('disabled');
				btnSpeedGo.style.display = ''; btnSpeedStop.style.display = 'none';
			});
		}
		var elSpeedRing = E('div', { 'class': 'tv-speed-ring-wrap' }, [
			mkSpeedRing(),
			E('div', { 'class': 'tv-speed-val' }, [elRingBig, elRingLbl])
		]);
		var speedCard = E('div', { 'class': 'tv-card tv-speed-card' }, [
			E('div', { 'class': 'tv-h' }, [E('h3', {}, [ic('broadcast', 18), E('span', {}, 'Speedtest')])]),
			E('div', { 'class': 'tv-info' }, [
				ic('shield', 16, 'tv-mut'),
				E('div', {}, 'Меряет и туннель (SOCKS5 напрямую к VLESS-серверу, минуя routing-правила), и обычное прямое подключение — по нескольким источникам каждое (среднее по ним — итоговое число), список источников редактируется в микротюнинге.')
			]),
			elSpeedRing,
			E('div', { 'class': 'tv-speed-groups' }, [
				mkViaGroup('tunnel', 'Через туннель'),
				mkViaGroup('direct', 'Напрямую')
			]),
			E('div', { style: 'text-align:center;margin-top:16px' }, [btnSpeedGo, btnSpeedStop])
		]);

		renderControlHeader();
		renderProfiles();

		// button, не a — <a> и <button> по-разному считают line-height/font-metrics в браузере
		// даже при идентичных padding (ровно это и давало "SMS больше/меньше остальных" баги).
		// Единообразно button везде, где это визуально КНОПКА в панели действий.
		function navBtn(href, cls, kids) {
			return E('button', { type: 'button', 'class': cls, click: function () { location.href = href; } }, kids);
		}
		var linkMicrotunTop = navBtn('/tinyvless/microtun/', 'tv-microtun-link', [ic('settings', 16), E('span', {}, 'Микротюнинг')]);
		var linkMicrotunBottom = navBtn('/tinyvless/microtun/', 'tv-microtun-link', [ic('settings', 16), E('span', {}, 'Микротюнинг')]);
		var linkSmsTop = navBtn('/tinyvless/sms/', 'tv-sms-link', [ic('mail', 16), E('span', {}, 'SMS')]);

		var elRefreshIc = ic('refresh', 16);
		var btnRefresh = E('button', {
			'class': 'tv-btn refresh', click: ui.createHandlerFn(this, function () {
				elRefreshIc.firstChild.classList.add('tv-spin');
				var refreshClients = fs.exec('/etc/tinyvless/api.sh', ['clients']).then(function (r) {
					try { st.clients = JSON.parse((r.stdout || '').trim()).clients || []; } catch (e) { st.clients = []; }
					renderClients();
				});
				Promise.all([pollStatus(), pollSysinfo(), refreshClients]).catch(function () {}).then(function () {
					elRefreshIc.firstChild.classList.remove('tv-spin');
				});
			})
		}, [elRefreshIc, E('span', {}, 'Обновить')]);

		return E('div', { 'class': 'tv' }, [
			E('style', {}, STYLE),
			elSplashOv,
			E('div', { 'class': 'tv-wrap' }, [
				elBanner,
				E('div', { 'class': 'tv-page-h' }, [
					E('div', { 'class': 'tv-title-block' }, [
						E('h2', {}, [ic('shield', 26), 'tinyvless']),
						E('span', { 'class': 'tv-version' }, 'MagnumOpusPlus V10')
					]),
					E('div', { 'class': 'tv-header-actions' }, [btnRefresh, linkSmsTop, linkMicrotunTop])
				]),
				E('div', { 'class': 'tv-grid' }, (function () {
					var CARD_EL = {
						status: statusBox, net: netCard, control: controlCard, speed: speedCard,
						clients: clientsCard, prof: profCard, dom: domCard, dns: dnsCard,
						reach: reachCard, system: systemCard
					};
					// beta-метки (см. страницу "для разработчиков" /tinyvless/dev/) — зелёная
					// плашка BETA сверху блока, без изменения самой карточки.
					(st.betaFlags || []).forEach(function (k) {
						var el = CARD_EL[k];
						if (el && el.classList) el.classList.add('tv-beta-marked');
					});
					return st.cardOrder.map(function (k) { return CARD_EL[k]; }).filter(Boolean);
				})()),
				E('div', { 'class': 'tv-microtun-bar' }, [linkMicrotunBottom])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
