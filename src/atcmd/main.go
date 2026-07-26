// atcmd — разовая diagnostic-утилита: шлёт произвольную AT-команду на LTE-модем и печатает
// ответ. Автоопределение AT-порта среди /dev/ttyUSB0..3 (та же логика, что в tvled — busybox
// на роутере без stty/microcom, работаем через сырые syscalls termios).
// Использование: atcmd AT+CSQ | atcmd sms-list-json | atcmd sms-read 1 | atcmd sms-clear 1
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/unix"
)

var candidatePorts = []string{"/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2", "/dev/ttyUSB3"}

// atLockPath — общий с tvled флок на физический AT-порт: только один процесс говорит с
// модемом одновременно (второй ждёт своей очереди, не толкается с первым посреди AT-обмена).
const atLockPath = "/tmp/.tv_atport.lock"

// atTimeout — таймаут ожидания ответа на AT-команду, настраивается через TV_AT_TIMEOUT_SEC
// (microtun.conf AT_TIMEOUT_SEC), общий с tvled. Дефолт 12с — с запасом на медленный ответ
// модема сразу после загрузки/под нагрузкой (короткий таймаут даёт ложный "не удалось опросить").
var atTimeout = 12 * time.Second

func init() {
	if v := os.Getenv("TV_AT_TIMEOUT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			atTimeout = time.Duration(n) * time.Second
		}
	}
}

// withATLock сериализует доступ к AT-порту между atcmd и tvled через flock на общий файл.
// Если лок почему-то недоступен (например /tmp не смонтирован) — не блокируем диагностику,
// выполняем без сериализации, лучше рискнуть гонкой, чем не отвечать вообще.
func withATLock(fn func() (string, error)) (string, error) {
	lf, err := os.OpenFile(atLockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return fn()
	}
	defer lf.Close()
	if err := unix.Flock(int(lf.Fd()), unix.LOCK_EX); err != nil {
		return fn()
	}
	defer unix.Flock(int(lf.Fd()), unix.LOCK_UN)
	return fn()
}

func setRaw(fd int) error {
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return err
	}
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 0
	t.Cc[unix.VTIME] = 0
	t.Ispeed = unix.B115200
	t.Ospeed = unix.B115200
	return unix.IoctlSetTermios(fd, unix.TCSETS, t)
}

func atQuery(port, cmd, waitFor string, timeout time.Duration) (string, error) {
	return withATLock(func() (string, error) {
		return atQueryRaw(port, cmd, waitFor, timeout)
	})
}

func atQueryRaw(port, cmd, waitFor string, timeout time.Duration) (string, error) {
	f, err := os.OpenFile(port, os.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := setRaw(int(f.Fd())); err != nil {
		return "", err
	}
	if _, err := f.Write([]byte(cmd + "\r\n")); err != nil {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	buf := make([]byte, 4096)
	var acc strings.Builder
	for time.Now().Before(deadline) {
		n, _ := f.Read(buf)
		if n > 0 {
			acc.Write(buf[:n])
			if s := acc.String(); strings.Contains(s, waitFor) || strings.Contains(s, "ERROR") {
				return s, nil
			}
		} else {
			time.Sleep(100 * time.Millisecond)
		}
	}
	return acc.String(), fmt.Errorf("timeout waiting for %q", waitFor)
}

func findATPort() string {
	for _, p := range candidatePorts {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		if resp, _ := atQuery(p, "AT", "OK", 1500*time.Millisecond); strings.Contains(resp, "OK") {
			return p
		}
	}
	return ""
}

type smsMsg struct {
	Index   int    `json:"index"`
	Indices []int  `json:"indices"`
	Status  string `json:"status"`
	Sender  string `json:"sender"`
	Time    string `json:"time"`
	Text    string `json:"text"`
}

// decodeText: модем в text-режиме (AT+CMGF=1) с UCS2-charset шлёт тело сообщения как
// HEX-строку big-endian UTF-16 (кириллица). Если строка не похожа на такой hex — возвращаем
// как есть (латиница/цифры модем иногда шлёт открытым текстом).
func decodeText(s string) string {
	s = strings.TrimSpace(s)
	// модем оборачивает тело в буквальные кавычки ("0412...002E") — убираем перед hex-декодом.
	// Если после этого строка НЕ похожа на UCS2-hex — возвращаем её же (уже без кавычек-шума).
	s = strings.TrimPrefix(s, `"`)
	s = strings.TrimSuffix(s, `"`)
	if len(s) == 0 || len(s)%4 != 0 {
		return s
	}
	raw, err := hex.DecodeString(s)
	if err != nil || len(raw)%2 != 0 {
		return s
	}
	u16 := make([]uint16, len(raw)/2)
	for i := range u16 {
		u16[i] = uint16(raw[2*i])<<8 | uint16(raw[2*i+1])
	}
	decoded := string(utf16.Decode(u16))
	if strings.ContainsRune(decoded, '�') {
		return s // невалидная UTF-16 — не наш формат, отдаём исходную строку
	}
	return decoded
}

type netInfo struct {
	SignalRSSI int    `json:"signal_rssi"`
	SignalDBM  int    `json:"signal_dbm"`
	SignalPct  int    `json:"signal_pct"`
	Operator   string `json:"operator"`
	AcT        int    `json:"act"`
	NetType    string `json:"net_type"`
	CEReg      int    `json:"cereg"`
	CReg       int    `json:"creg"`
	Model      string `json:"model"`
}

var (
	reCSQ       = regexp.MustCompile(`\+CSQ:\s*(\d+),(\d+)`)
	reCOPS      = regexp.MustCompile(`\+COPS:\s*\d+,\d+,"([^"]*)",(\d+)`)
	reCEREG     = regexp.MustCompile(`\+CEREG:\s*\d+,(\d+)`)
	reCREG      = regexp.MustCompile(`\+CREG:\s*\d+,(\d+)`)
	reQuoted    = regexp.MustCompile(`"([^"]*)"`)
	reCGMMModel = regexp.MustCompile(`([A-Za-z0-9_-]{3,})`)
)

func getNetInfo(port string) netInfo {
	var ni netInfo
	ni.SignalRSSI = -1

	if resp, _ := atQuery(port, "AT+CSQ", "OK", atTimeout); true {
		if m := reCSQ.FindStringSubmatch(resp); m != nil {
			rssi, _ := strconv.Atoi(m[1])
			ni.SignalRSSI = rssi
			if rssi == 99 {
				ni.SignalDBM = 0
				ni.SignalPct = 0
			} else {
				ni.SignalDBM = -113 + 2*rssi
				pct := rssi * 100 / 31
				if pct > 100 {
					pct = 100
				}
				ni.SignalPct = pct
			}
		}
	}

	atQuery(port, "AT+COPS=3,0", "OK", atTimeout)
	if resp, _ := atQuery(port, "AT+COPS?", "OK", atTimeout); true {
		if m := reCOPS.FindStringSubmatch(resp); m != nil {
			ni.Operator = m[1]
			act, _ := strconv.Atoi(m[2])
			ni.AcT = act
		}
	}

	if resp, _ := atQuery(port, "AT+CEREG?", "OK", atTimeout); true {
		if m := reCEREG.FindStringSubmatch(resp); m != nil {
			ni.CEReg, _ = strconv.Atoi(m[1])
		}
	}
	if resp, _ := atQuery(port, "AT+CREG?", "OK", atTimeout); true {
		if m := reCREG.FindStringSubmatch(resp); m != nil {
			ni.CReg, _ = strconv.Atoi(m[1])
		}
	}

	if resp, err := atQuery(port, "AT^SYSINFOEX", "OK", atTimeout); err == nil {
		if qs := reQuoted.FindAllStringSubmatch(resp, -1); len(qs) > 0 {
			ni.NetType = qs[len(qs)-1][1]
		}
	}

	if resp, err := atQuery(port, "AT+CGMM", "OK", atTimeout); err == nil {
		lines := strings.Split(strings.ReplaceAll(resp, "\r", ""), "\n")
		for _, l := range lines {
			l = strings.TrimSpace(l)
			if l == "" || strings.HasPrefix(l, "AT") || l == "OK" {
				continue
			}
			if reCGMMModel.MatchString(l) {
				l = strings.TrimPrefix(l, "+CGMM:")
				ni.Model = strings.TrimSpace(l)
				break
			}
		}
	}

	return ni
}

var reCMGL = regexp.MustCompile(`\+CMGL:\s*(\d+),"([^"]*)","([^"]*)",[^,]*,"([^"]*)"`)

// parseSMSList разбирает сырой ответ AT+CMGL="ALL" на структурированный список сообщений.
func parseSMSList(raw string) []smsMsg {
	lines := strings.Split(strings.ReplaceAll(raw, "\r", ""), "\n")
	var out []smsMsg
	for i := 0; i < len(lines); i++ {
		m := reCMGL.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		idx, _ := strconv.Atoi(m[1])
		msg := smsMsg{Index: idx, Indices: []int{idx}, Status: m[2], Sender: m[3], Time: m[4]}
		if i+1 < len(lines) {
			msg.Text = decodeText(lines[i+1])
		}
		out = append(out, msg)
	}
	return mergeParts(out)
}

// mergeParts склеивает многочастные SMS (длинный текст модем шлёт несколькими +CMGL записями
// подряд с одним отправителем/временем и последовательными индексами) обратно в одно сообщение —
// иначе на странице SMS длинное сообщение от одного отправителя рвётся на несколько карточек.
func mergeParts(msgs []smsMsg) []smsMsg {
	var out []smsMsg
	for _, m := range msgs {
		if n := len(out); n > 0 {
			last := &out[n-1]
			lastIdx := last.Indices[len(last.Indices)-1]
			if last.Sender == m.Sender && last.Time == m.Time && m.Index == lastIdx+1 {
				last.Text += m.Text
				last.Indices = append(last.Indices, m.Index)
				last.Index = m.Index
				continue
			}
		}
		out = append(out, m)
	}
	return out
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println(`usage: atcmd "<AT-команда>" | atcmd sms-list | atcmd sms-read <N> | atcmd sms-clear <N>`)
		os.Exit(1)
	}
	port := findATPort()
	if port == "" {
		fmt.Println("AT-порт не найден среди /dev/ttyUSB0-3")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "net-info-json":
		ni := getNetInfo(port)
		enc, _ := json.Marshal(ni)
		fmt.Println(string(enc))
	case "sms-list":
		atQuery(port, "AT+CMGF=1", "OK", atTimeout) // текстовый режим SMS
		resp, err := atQuery(port, `AT+CMGL="ALL"`, "OK", atTimeout)
		fmt.Println(resp)
		if err != nil {
			fmt.Fprintln(os.Stderr, "warn:", err)
		}
	case "sms-list-json":
		atQuery(port, "AT+CMGF=1", "OK", atTimeout)
		resp, err := atQuery(port, `AT+CMGL="ALL"`, "OK", atTimeout)
		msgs := parseSMSList(resp)
		if msgs == nil {
			msgs = []smsMsg{}
		}
		enc, _ := json.Marshal(msgs)
		fmt.Println(string(enc))
		if err != nil {
			fmt.Fprintln(os.Stderr, "warn:", err)
		}
	case "sms-read":
		if len(os.Args) < 3 {
			fmt.Println("нужен индекс сообщения")
			os.Exit(1)
		}
		atQuery(port, "AT+CMGF=1", "OK", atTimeout)
		resp, err := atQuery(port, "AT+CMGR="+os.Args[2], "OK", atTimeout)
		fmt.Println(resp)
		if err != nil {
			fmt.Fprintln(os.Stderr, "warn:", err)
		}
	case "sms-clear":
		if len(os.Args) < 3 {
			fmt.Println("нужен индекс сообщения")
			os.Exit(1)
		}
		// поддержка "1,2,3" — удаление всех частей многочастного SMS одним вызовом
		for _, idx := range strings.Split(os.Args[2], ",") {
			idx = strings.TrimSpace(idx)
			if idx == "" {
				continue
			}
			resp, err := atQuery(port, "AT+CMGD="+idx, "OK", atTimeout)
			fmt.Println(resp)
			if err != nil {
				fmt.Fprintln(os.Stderr, "warn:", err)
			}
		}
	default:
		cmd := strings.Join(os.Args[1:], " ")
		resp, err := atQuery(port, cmd, "OK", atTimeout)
		fmt.Println(resp)
		if err != nil {
			fmt.Fprintln(os.Stderr, "warn:", err)
		}
	}
}
