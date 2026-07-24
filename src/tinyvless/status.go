package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Счётчики статистики (для индикатора в LuCI).
var (
	statUp     atomic.Int64 // байт отправлено (клиент -> сервер)
	statDown   atomic.Int64 // байт получено (сервер -> клиент)
	statActive atomic.Int64 // активных туннельных соединений
	statTotal  atomic.Int64 // всего туннельных соединений с запуска
	statExitIP atomic.Value // string — внешний IP через туннель
	statStart  = time.Now()
)

// runTestLink валидирует vless://-ссылку: применяет её, пробует поднять туннель и получить
// внешний IP через api.ipify. Печатает JSON {ok,ip} или {ok:false,error}. Одноразовый режим
// для кнопки «Проверить» в морде — детектит белые списки/DPI-блок (даже для рабочей WS-ссылки).
func runTestLink(rawLink string) {
	if err := applyLink(rawLink); err != nil {
		fmt.Printf("{\"ok\":false,\"error\":%q}\n", "плохая ссылка: "+err.Error())
		return
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
		fmt.Printf("{\"ok\":false,\"error\":%q}\n", "плохой uuid")
		return
	}
	done := make(chan string, 1)
	go func() {
		c, e := dialVLESS("api.ipify.org", 80)
		if e != nil {
			done <- ""
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(10 * time.Second))
		fmt.Fprintf(c, "GET / HTTP/1.0\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
		buf, _ := io.ReadAll(io.LimitReader(c, 4096))
		s := string(buf)
		if i := strings.Index(s, "\r\n\r\n"); i >= 0 {
			body := strings.TrimSpace(s[i+4:])
			if net.ParseIP(body) != nil {
				done <- body
				return
			}
		}
		done <- ""
	}()
	select {
	case ip := <-done:
		if ip != "" {
			fmt.Printf("{\"ok\":true,\"ip\":%q}\n", ip)
		} else {
			fmt.Printf("{\"ok\":false,\"error\":\"туннель поднялся, но внешний IP не получен\"}\n")
		}
	case <-time.After(13 * time.Second):
		fmt.Printf("{\"ok\":false,\"error\":\"нет ответа за 13с — вероятно блокировка (белый список/DPI)\"}\n")
	}
}

// startStatus поднимает локальный HTTP /status (JSON) и периодический чек exit-IP.
func startStatus(addr string) {
	go exitIPLoop()
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		ip, _ := statExitIP.Load().(string)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w,
			`{"running":true,"server":%q,"exit_ip":%q,"up_bytes":%d,"down_bytes":%d,"active":%d,"total":%d,"uptime":%d}`+"\n",
			*server, ip, statUp.Load(), statDown.Load(), statActive.Load(), statTotal.Load(),
			int(time.Since(statStart).Seconds()))
	})
	srv := &http.Server{Addr: addr, Handler: mux}
	go srv.ListenAndServe()
}

// exitIPLoop раз в 60с узнаёт внешний IP через туннель (HTTP к api.ipify.org:80).
func exitIPLoop() {
	for {
		if ip := checkExitIP(); ip != "" {
			statExitIP.Store(ip)
		}
		time.Sleep(60 * time.Second)
	}
}

func checkExitIP() string {
	c, err := dialVLESS("api.ipify.org", 80) // домен резолвит сервер, plain HTTP (без TLS-in-TLS)
	if err != nil {
		return ""
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(15 * time.Second))
	fmt.Fprintf(c, "GET / HTTP/1.0\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
	buf, _ := io.ReadAll(io.LimitReader(c, 4096))
	s := string(buf)
	if i := strings.Index(s, "\r\n\r\n"); i >= 0 {
		body := strings.TrimSpace(s[i+4:])
		if net.ParseIP(body) != nil {
			return body
		}
	}
	return ""
}
