// tvled — опрашивает LTE-модем (AT+CSQ) и зажигает 3 задних LED сигнала (white:signal1/2/3)
// пропорционально уровню сети. Автоопределение AT-порта среди /dev/ttyUSB0..3 (busybox на
// роутере без stty/microcom — работаем через сырые syscalls termios, без внешних утилит).
package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// atLockPath — общий с atcmd флок на физический AT-порт (см. комментарий в src/atcmd/main.go).
const atLockPath = "/tmp/.tv_atport.lock"

// pollInterval/atTimeout настраиваются через TV_LED_POLL_SEC/TV_AT_TIMEOUT_SEC (microtun.conf
// LED_POLL_INTERVAL/AT_TIMEOUT_SEC), пробрасываются в init.d-обёртке. Дефолты — прежнее поведение.
var (
	pollInterval = 8 * time.Second
	atTimeout    = 12 * time.Second
)

var (
	ledPaths      = []string{"/sys/class/leds/white:signal1/brightness", "/sys/class/leds/white:signal2/brightness", "/sys/class/leds/white:signal3/brightness"}
	candidatePorts = []string{"/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2", "/dev/ttyUSB3"}
)

func init() {
	if v := os.Getenv("TV_LED_POLL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			pollInterval = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("TV_AT_TIMEOUT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			atTimeout = time.Duration(n) * time.Second
		}
	}
}

// withATLock — см. src/atcmd/main.go: сериализует доступ к AT-порту между tvled и atcmd.
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

// atQuery открывает порт, шлёт AT-команду, ждёт ответ (до timeout). Открывает заново на
// каждый вызов — модем может отвалиться/переподключиться, стабильнее держать порт недолго.
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
	buf := make([]byte, 512)
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

func setLEDs(n int) {
	for i, p := range ledPaths {
		v := []byte("0")
		if i < n {
			v = []byte("1")
		}
		os.WriteFile(p, v, 0644)
	}
}

// csqToLEDs переводит шкалу CSQ (0-31, 99=неизвестно) в число зажжённых LED (0-3).
func csqToLEDs(rssi int) int {
	switch {
	case rssi < 0 || rssi == 99:
		return 0
	case rssi < 10:
		return 1
	case rssi < 20:
		return 2
	default:
		return 3
	}
}

func parseCSQ(resp string) int {
	idx := strings.Index(resp, "+CSQ:")
	if idx < 0 {
		return -1
	}
	rest := strings.TrimSpace(resp[idx+len("+CSQ:"):])
	v, err := strconv.Atoi(strings.TrimSpace(strings.SplitN(rest, ",", 2)[0]))
	if err != nil {
		return -1
	}
	return v
}

func main() {
	var port string
	for port == "" {
		port = findATPort()
		if port == "" {
			log.Println("tvled: AT-порт не найден среди /dev/ttyUSB0-3, повтор через 15с")
			time.Sleep(15 * time.Second)
		}
	}
	log.Printf("tvled: AT-порт найден: %s", port)
	for {
		resp, err := atQuery(port, "AT+CSQ", "+CSQ", atTimeout)
		if err != nil {
			setLEDs(0) // модем недоступен — гасим индикатор, не гадаем
			time.Sleep(pollInterval)
			continue
		}
		setLEDs(csqToLEDs(parseCSQ(resp)))
		time.Sleep(pollInterval)
	}
}
