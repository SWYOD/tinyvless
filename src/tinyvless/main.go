// tinyvless — минимальный VLESS-over-WS-over-TLS клиент для слабых MIPS-роутеров.
// Инбаунды: SOCKS5 (-listen) и прозрачный REDIRECT/SO_ORIGINAL_DST (-redir).
// Аутбаунд: VLESS+WS+TLS. Конфиг флагами или строкой vless:// (-link).
// Цель — крошечный бинарник, не триггерящий баги Go-рантайма на mipsel, в отличие от sing-box.
package main

import (
	"bufio"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// tlsSessionCache — stability-v2: 128 (один VLESS-сервер, 64 слотов кэша TLS избыточны).
var tlsSessionCache = tls.NewLRUClientSessionCache(128)

// cipherLogged — чтобы залогировать negotiated TLS cipher ровно один раз (нужен ChaCha20 на softfloat).
var cipherLogged atomic.Bool

// dialSem — stability-v2: 64. v1=72, perf=96. Память: 64 душил спидтест, но не OOM; 72 → ребут на YouTube-марафоне.
var dialSem = make(chan struct{}, 64)

// Пулы буферов — stability-v2: 4КБ (v1=8K, perf=16K).
const poolBufSize = 4096
var copyBufPool = sync.Pool{New: func() any { b := make([]byte, poolBufSize); return &b }}
var frameBufPool = sync.Pool{New: func() any { b := make([]byte, poolBufSize+16); return &b }} // +16 на WS-заголовок+маску

// ---- конфиг ----
var (
	listenAddr = flag.String("listen", "", "SOCKS5 listen address (e.g. 127.0.0.1:1080)")
	redirAddr  = flag.String("redir", "", "transparent REDIRECT listen address, TCP only (e.g. 0.0.0.0:1082)")
	tproxyAddr = flag.String("tproxy", "", "transparent TPROXY listen address, TCP+UDP (e.g. 0.0.0.0:1083)")
	udpTest    = flag.String("udptest", "", "self-test: resolve this domain via DNS over VLESS-UDP tunnel (8.8.8.8:53), print A record")
	testLink   = flag.String("testlink", "", "validate a vless:// link: dial tunnel + fetch exit IP, print JSON {ok,ip|error}")
	statusAddr = flag.String("status", "", "local HTTP status endpoint for LuCI (e.g. 127.0.0.1:19999)")
	link       = flag.String("link", "", "vless:// share link (overrides individual flags)")
	server     = flag.String("server", "", "VLESS server host")
	port       = flag.Int("port", 443, "VLESS server port")
	uuidStr    = flag.String("uuid", "", "VLESS UUID")
	sni        = flag.String("sni", "", "TLS SNI (default = server)")
	wsPath     = flag.String("path", "/", "WebSocket path")
	wsHost     = flag.String("host", "", "WebSocket Host header (default = sni)")
)

var uid []byte

func main() {
	// дисциплина памяти для слабого роутера (58МБ RAM)
	debug.SetGCPercent(50)          // компромисс: реже GC чем 30 (throughput), но не 80 (RAM тесная, ~9МБ avail)
	debug.SetMemoryLimit(18 << 20)  // stability-v2: 18МБ (v1=22, perf=30)

	flag.Parse()
	// -testlink: одноразовая валидация ссылки (для кнопки «Проверить» в морде). Отдельная ветка,
	// т.к. ссылка приходит в самом флаге и обычные требования -server/-uuid тут не нужны.
	if *testLink != "" {
		runTestLink(*testLink)
		return
	}
	if *link != "" {
		if err := applyLink(*link); err != nil {
			log.Fatal("bad -link: ", err)
		}
	}
	if *server == "" || *uuidStr == "" {
		log.Fatal("need -server and -uuid (or -link)")
	}
	if *sni == "" {
		*sni = *server
	}
	if *wsHost == "" {
		*wsHost = *sni
	}
	var err error
	uid, err = parseUUID(*uuidStr)
	if err != nil {
		log.Fatal("bad uuid: ", err)
	}
	if *udpTest != "" {
		runUDPTest(*udpTest)
		return
	}
	if *listenAddr == "" && *redirAddr == "" && *tproxyAddr == "" {
		*listenAddr = "127.0.0.1:1080"
	}

	log.Printf("tinyvless -> vless ws://%s:%d%s (sni=%s host=%s)", *server, *port, *wsPath, *sni, *wsHost)

	if *listenAddr != "" {
		ln, err := net.Listen("tcp", *listenAddr)
		if err != nil {
			log.Fatal("socks listen: ", err)
		}
		log.Printf("SOCKS5 inbound on %s", *listenAddr)
		go acceptLoop(ln, handleSocks)
	}
	if *redirAddr != "" {
		ln, err := net.Listen("tcp", *redirAddr)
		if err != nil {
			log.Fatal("redir listen: ", err)
		}
		log.Printf("REDIRECT inbound on %s", *redirAddr)
		go acceptLoop(ln, handleRedirect)
	}
	if *tproxyAddr != "" {
		if err := startTProxy(*tproxyAddr); err != nil {
			log.Fatal("tproxy: ", err)
		}
		log.Printf("TPROXY inbound (TCP+UDP) on %s", *tproxyAddr)
	}
	if *statusAddr != "" {
		startStatus(*statusAddr)
		log.Printf("status endpoint on %s", *statusAddr)
	}
	if *listenAddr == "" && *redirAddr == "" && *tproxyAddr == "" {
		log.Fatal("no inbound configured")
	}
	select {}
}

func acceptLoop(ln net.Listener, h func(net.Conn)) {
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go h(c)
	}
}

// ---- SOCKS5 инбаунд ----
func handleSocks(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(30 * time.Second))
	br := bufio.NewReader(c)

	ver, _ := br.ReadByte()
	if ver != 5 {
		return
	}
	nm, _ := br.ReadByte()
	io.CopyN(io.Discard, br, int64(nm))
	c.Write([]byte{5, 0})

	hdr := make([]byte, 4)
	if _, err := io.ReadFull(br, hdr); err != nil {
		return
	}
	if hdr[1] != 1 {
		c.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	var host string
	switch hdr[3] {
	case 1:
		b := make([]byte, 4)
		io.ReadFull(br, b)
		host = net.IP(b).String()
	case 3:
		l, _ := br.ReadByte()
		b := make([]byte, int(l))
		io.ReadFull(br, b)
		host = string(b)
	case 4:
		b := make([]byte, 16)
		io.ReadFull(br, b)
		host = net.IP(b).String()
	default:
		return
	}
	var pb [2]byte
	io.ReadFull(br, pb[:])
	dport := binary.BigEndian.Uint16(pb[:])

	c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	c.SetDeadline(time.Time{})

	var pre []byte
	if n := br.Buffered(); n > 0 {
		pre, _ = br.Peek(n)
	}
	relay(c, host, dport, pre)
}

// ---- прозрачный REDIRECT инбаунд ----
func handleRedirect(c net.Conn) {
	defer c.Close()
	host, dport, err := originalDst(c)
	if err != nil {
		log.Printf("redir: no original dst: %v", err)
		return
	}
	relay(c, host, dport, nil)
}

// relay соединяет клиента с целью через VLESS-туннель.
func relay(client net.Conn, host string, dport uint16, prebuffered []byte) {
	// защита от петли: локальные/приватные/loopback цели не туннелируем
	// (легитимный редирект/tproxy сюда их не отдаёт — nft исключает приватные dst).
	if ip := net.ParseIP(host); ip != nil &&
		(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) {
		return
	}
	// захват слота с ожиданием: всплеск (YouTube открывает десятки соединений) ЖДЁТ слот,
	// а не дропается (drop был причиной «фид не грузится»); при затяжном переполнении — закрываем.
	select {
	case dialSem <- struct{}{}:
	case <-time.After(8 * time.Second):
		return
	}
	up, err := dialVLESS(host, dport)
	if err != nil {
		<-dialSem
		return
	}
	defer func() { up.Close(); <-dialSem }()
	statTotal.Add(1)
	statActive.Add(1)
	defer statActive.Add(-1)
	if len(prebuffered) > 0 {
		up.Write(prebuffered)
		statUp.Add(int64(len(prebuffered)))
	}
	done := make(chan struct{}, 1)
	go func() {
		countCopy(up, client, &statUp) // client -> server (upload)
		if cw, ok := up.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
		done <- struct{}{}
	}()
	countCopy(client, up, &statDown) // server -> client (download)
	if cw, ok := client.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	}
	<-done
}

// countCopy копирует с небольшим буфером и считает байты (экономия памяти + статистика).
// Буфер берётся из пула (анти-OOM: не аллокируем 16КБ на каждое соединение).
func countCopy(dst io.Writer, src io.Reader, counter *atomic.Int64) {
	bp := copyBufPool.Get().(*[]byte)
	defer copyBufPool.Put(bp)
	buf := *bp
	for {
		n, err := src.Read(buf)
		if n > 0 {
			dst.Write(buf[:n])
			counter.Add(int64(n))
		}
		if err != nil {
			return
		}
	}
}

// ---- VLESS+WS+TLS аутбаунд ----
func dialVLESS(targetHost string, targetPort uint16) (net.Conn, error) {
	return dialVLESSRaw(1, targetHost, targetPort) // cmd=1 TCP
}

// dialVLESSRaw поднимает TLS+WS, шлёт VLESS-заголовок с заданной командой (1=TCP, 2=UDP)
// и возвращает vlessConn (после заголовка — сырой поток для TCP или фрейминг для UDP).
func dialVLESSRaw(cmd byte, targetHost string, targetPort uint16) (net.Conn, error) {
	tcp, err := net.DialTimeout("tcp", net.JoinHostPort(*server, strconv.Itoa(*port)), 15*time.Second)
	if err != nil {
		return nil, err
	}
	tlsConn := tls.Client(tcp, &tls.Config{
		ServerName:         *sni,
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
		ClientSessionCache: tlsSessionCache, // возобновление TLS-сессий — пропускает дорогой ECDHE на повторных коннектах
	})
	tlsConn.SetDeadline(time.Now().Add(20 * time.Second))
	if err := tlsConn.Handshake(); err != nil {
		tcp.Close()
		return nil, fmt.Errorf("tls: %w", err)
	}
	if cipherLogged.CompareAndSwap(false, true) {
		cs := tlsConn.ConnectionState()
		log.Printf("TLS: %s cipher=%s resumed=%v", tls.VersionName(cs.Version), tls.CipherSuiteName(cs.CipherSuite), cs.DidResume)
	}

	key := make([]byte, 16)
	rand.Read(key)
	req := "GET " + *wsPath + " HTTP/1.1\r\n" +
		"Host: " + *wsHost + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(key) + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := tlsConn.Write([]byte(req)); err != nil {
		tcp.Close()
		return nil, fmt.Errorf("ws write: %w", err)
	}
	br := bufio.NewReader(tlsConn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		tcp.Close()
		return nil, fmt.Errorf("ws resp: %w", err)
	}
	if resp.StatusCode != 101 {
		tcp.Close()
		return nil, fmt.Errorf("ws status %d", resp.StatusCode)
	}
	tlsConn.SetDeadline(time.Time{})

	ws := &wsConn{Conn: tlsConn, br: br}

	var h []byte
	h = append(h, 0)
	h = append(h, uid...)
	h = append(h, 0)
	h = append(h, cmd)
	h = append(h, byte(targetPort>>8), byte(targetPort))
	if ip := net.ParseIP(targetHost); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			h = append(h, 1)
			h = append(h, v4...)
		} else {
			h = append(h, 3)
			h = append(h, ip.To16()...)
		}
	} else {
		h = append(h, 2, byte(len(targetHost)))
		h = append(h, targetHost...)
	}
	vc := &vlessConn{Conn: ws}
	vc.reqHeader = h
	return vc, nil
}

// ---- VLESS-UDP framing: каждый UDP-пакет = [2 байта длина BE][payload] ----
func writeUDPPacket(c net.Conn, p []byte) error {
	buf := make([]byte, 2+len(p))
	binary.BigEndian.PutUint16(buf[:2], uint16(len(p)))
	copy(buf[2:], p)
	_, err := c.Write(buf)
	return err
}

func readUDPPacket(c net.Conn, buf []byte) (int, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return 0, err
	}
	n := int(binary.BigEndian.Uint16(hdr[:]))
	if n > len(buf) {
		if _, err := io.ReadFull(c, buf); err != nil {
			return 0, err
		}
		io.CopyN(io.Discard, c, int64(n-len(buf)))
		return len(buf), nil
	}
	if _, err := io.ReadFull(c, buf[:n]); err != nil {
		return 0, err
	}
	return n, nil
}

// wsConn: WebSocket client frame codec поверх net.Conn (binary, mask на клиенте).
type wsConn struct {
	net.Conn
	br      *bufio.Reader
	readBuf []byte
}

func (w *wsConn) Read(p []byte) (int, error) {
	for len(w.readBuf) == 0 {
		payload, err := w.readFrame()
		if err != nil {
			return 0, err
		}
		w.readBuf = payload
	}
	n := copy(p, w.readBuf)
	w.readBuf = w.readBuf[n:]
	return n, nil
}

func (w *wsConn) readFrame() ([]byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(w.br, h[:]); err != nil {
		return nil, err
	}
	opcode := h[0] & 0x0f
	length := int(h[1] & 0x7f)
	switch length {
	case 126:
		var e [2]byte
		io.ReadFull(w.br, e[:])
		length = int(binary.BigEndian.Uint16(e[:]))
	case 127:
		var e [8]byte
		io.ReadFull(w.br, e[:])
		length = int(binary.BigEndian.Uint64(e[:]))
	}
	masked := h[1]&0x80 != 0
	var mask [4]byte
	if masked {
		io.ReadFull(w.br, mask[:])
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(w.br, payload); err != nil {
		return nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	switch opcode {
	case 0x8:
		return nil, io.EOF
	case 0x9:
		w.writeFrame(0xA, payload)
		return w.readFrame()
	case 0xA:
		return w.readFrame()
	}
	return payload, nil
}

func (w *wsConn) Write(p []byte) (int, error) {
	if err := w.writeFrame(0x2, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (w *wsConn) writeFrame(opcode byte, payload []byte) error {
	l := len(payload)
	// длина заголовка (включая 4 байта клиентской маски)
	var hl int
	switch {
	case l < 126:
		hl = 6
	case l < 65536:
		hl = 8
	default:
		hl = 14
	}
	// ОДИН буфер [заголовок+маска+payload] и ОДИН Write = одна TLS-запись.
	// Раньше было два Write (hdr, затем masked) = две TLS-записи на каждый кадр
	// (двойной MAC/record-overhead + лишний syscall) — заметно било по аплоаду.
	// Буфер из пула (анти-OOM: не аллокируем кадр на каждый Write). Крупные (>16КБ) — обычным make.
	need := hl + l
	var frame []byte
	var fbp *[]byte
	if need <= poolBufSize+16 {
		fbp = frameBufPool.Get().(*[]byte)
		frame = (*fbp)[:need]
	} else {
		frame = make([]byte, need)
	}
	frame[0] = 0x80 | opcode
	switch {
	case l < 126:
		frame[1] = byte(l) | 0x80
	case l < 65536:
		frame[1] = 126 | 0x80
		frame[2] = byte(l >> 8)
		frame[3] = byte(l)
	default:
		frame[1] = 127 | 0x80
		binary.BigEndian.PutUint64(frame[2:10], uint64(l))
	}
	mask := frame[hl-4 : hl]
	rand.Read(mask)
	dst := frame[hl:]
	// Пословное (uint32) XOR-маскирование payload->dst — в 4× меньше операций, чем побайтово.
	// mw собираем из байтов (маска в буфере может быть НЕвыровнена — на MIPS aligned-read обязателен,
	// иначе SIGBUS). Быстрый путь берём только когда И payload, И dst выровнены по 4 (частый случай
	// кадров 126..65535 — весь bulk-трафик из 16КБ-буфера туда попадает).
	mw := uint32(mask[0]) | uint32(mask[1])<<8 | uint32(mask[2])<<16 | uint32(mask[3])<<24
	i := 0
	if l >= 4 && uintptr(unsafe.Pointer(&payload[0]))&3 == 0 && uintptr(unsafe.Pointer(&dst[0]))&3 == 0 {
		for ; i+4 <= l; i += 4 {
			*(*uint32)(unsafe.Pointer(&dst[i])) = *(*uint32)(unsafe.Pointer(&payload[i])) ^ mw
		}
	}
	for ; i < l; i++ {
		dst[i] = payload[i] ^ mask[i&3]
	}
	_, err := w.Conn.Write(frame)
	if fbp != nil {
		frameBufPool.Put(fbp)
	}
	return err
}

func (w *wsConn) CloseWrite() error {
	w.writeFrame(0x8, nil)
	return nil
}

// vlessConn: пишет VLESS-заголовок перед первым payload, срезает ответный заголовок при первом чтении.
type vlessConn struct {
	net.Conn
	reqHeader []byte
	respDone  bool
}

func (v *vlessConn) Write(p []byte) (int, error) {
	if v.reqHeader != nil {
		buf := append(append([]byte{}, v.reqHeader...), p...)
		v.reqHeader = nil
		if _, err := v.Conn.Write(buf); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return v.Conn.Write(p)
}

func (v *vlessConn) Read(p []byte) (int, error) {
	if !v.respDone {
		var h [2]byte
		if _, err := io.ReadFull(v.Conn, h[:]); err != nil {
			return 0, err
		}
		if n := int(h[1]); n > 0 {
			io.CopyN(io.Discard, v.Conn, int64(n))
		}
		v.respDone = true
	}
	return v.Conn.Read(p)
}

// ---- self-test VLESS-UDP: DNS-запрос к 8.8.8.8:53 через туннель ----
func runUDPTest(domain string) {
	log.Printf("udptest: %s via VLESS-UDP -> 8.8.8.8:53", domain)
	tun, err := dialVLESSRaw(2, "8.8.8.8", 53) // cmd=2 UDP
	if err != nil {
		log.Fatal("dial: ", err)
	}
	defer tun.Close()
	// строим DNS-запрос A
	q := buildDNSQuery(domain)
	if err := writeUDPPacket(tun, q); err != nil {
		log.Fatal("send: ", err)
	}
	tun.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 1500)
	n, err := readUDPPacket(tun, buf)
	if err != nil {
		log.Fatal("recv: ", err)
	}
	ip := parseDNSAnswer(buf[:n])
	if ip == "" {
		log.Fatalf("got %d bytes but no A record", n)
	}
	log.Printf("OK: %s = %s (через VLESS-UDP туннель, %d байт ответа)", domain, ip, n)
}

func buildDNSQuery(domain string) []byte {
	var b []byte
	b = append(b, 0x12, 0x34)             // ID
	b = append(b, 0x01, 0x00)             // flags: recursion desired
	b = append(b, 0x00, 0x01)             // qdcount=1
	b = append(b, 0x00, 0x00, 0x00, 0x00) // an/ns=0
	b = append(b, 0x00, 0x00)             // arcount=0
	for _, part := range strings.Split(domain, ".") {
		b = append(b, byte(len(part)))
		b = append(b, part...)
	}
	b = append(b, 0x00)       // конец имени
	b = append(b, 0x00, 0x01) // qtype A
	b = append(b, 0x00, 0x01) // qclass IN
	return b
}

func parseDNSAnswer(b []byte) string {
	if len(b) < 12 {
		return ""
	}
	anc := int(binary.BigEndian.Uint16(b[6:8]))
	pos := 12
	// пропускаем вопрос (имя + 4)
	for pos < len(b) && b[pos] != 0 {
		pos += int(b[pos]) + 1
	}
	pos += 5 // нулевой байт + qtype(2) + qclass(2)
	for i := 0; i < anc && pos+12 <= len(b); i++ {
		// имя (обычно указатель 0xc0xx = 2 байта)
		if b[pos]&0xc0 == 0xc0 {
			pos += 2
		} else {
			for pos < len(b) && b[pos] != 0 {
				pos += int(b[pos]) + 1
			}
			pos++
		}
		if pos+10 > len(b) {
			return ""
		}
		typ := binary.BigEndian.Uint16(b[pos : pos+2])
		rdlen := int(binary.BigEndian.Uint16(b[pos+8 : pos+10]))
		pos += 10
		if typ == 1 && rdlen == 4 && pos+4 <= len(b) {
			return net.IPv4(b[pos], b[pos+1], b[pos+2], b[pos+3]).String()
		}
		pos += rdlen
	}
	return ""
}

// ---- парсер vless:// ----
// vless://<uuid>@<host>:<port>?type=ws&path=/x&host=h&security=tls&sni=s#name
func applyLink(s string) error {
	u, err := url.Parse(s)
	if err != nil {
		return err
	}
	if u.Scheme != "vless" {
		return errors.New("scheme must be vless://")
	}
	if u.User == nil {
		return errors.New("no uuid")
	}
	*uuidStr = u.User.Username()
	*server = u.Hostname()
	if p := u.Port(); p != "" {
		*port, _ = strconv.Atoi(p)
	}
	q := u.Query()
	if v := q.Get("path"); v != "" {
		*wsPath = v
	}
	if v := q.Get("host"); v != "" {
		*wsHost = v
	}
	if v := q.Get("sni"); v != "" {
		*sni = v
	}
	if q.Get("type") != "" && q.Get("type") != "ws" {
		return fmt.Errorf("unsupported transport %q (only ws)", q.Get("type"))
	}
	if sec := q.Get("security"); sec != "" && sec != "tls" {
		return fmt.Errorf("unsupported security %q (only tls)", sec)
	}
	return nil
}

// ---- UUID ----
func parseUUID(s string) ([]byte, error) {
	s = strings.ReplaceAll(s, "-", "")
	if len(s) != 32 {
		return nil, errors.New("length")
	}
	b := make([]byte, 16)
	for i := 0; i < 16; i++ {
		v, err := strconv.ParseUint(s[i*2:i*2+2], 16, 8)
		if err != nil {
			return nil, err
		}
		b[i] = byte(v)
	}
	return b, nil
}
