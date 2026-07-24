//go:build linux

// Прозрачный TPROXY-инбаунд (TCP+UDP) через IP_TRANSPARENT.
// TCP: слушаем с IP_TRANSPARENT, оригинальный dst = conn.LocalAddr().
// UDP: recvmsg с IP_RECVORIGDSTADDR, сессии по (src,dst), ответы шлём с
//      сокета, забинженного на dst (IP_TRANSPARENT) — источник = реальный сервер.
package main

import (
	"context"
	"encoding/binary"
	"log"
	"net"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const udpIdle = 60 * time.Second

func startTProxy(addr string) error {
	// TCP
	lc := net.ListenConfig{Control: transparentControl}
	ltcp, err := lc.Listen(context.Background(), "tcp4", addr)
	if err != nil {
		return err
	}
	go acceptLoop(ltcp, handleTProxyTCP)
	// UDP
	go serveTProxyUDP(addr)
	return nil
}

// transparentControl ставит IP_TRANSPARENT на сокет до bind.
func transparentControl(_, _ string, c syscall.RawConn) error {
	var serr error
	err := c.Control(func(fd uintptr) {
		if e := unix.SetsockoptInt(int(fd), unix.SOL_IP, unix.IP_TRANSPARENT, 1); e != nil {
			serr = e
			return
		}
		unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
	})
	if err != nil {
		return err
	}
	return serr
}

func handleTProxyTCP(c net.Conn) {
	defer c.Close()
	la, ok := c.LocalAddr().(*net.TCPAddr)
	if !ok {
		return
	}
	relay(c, la.IP.String(), uint16(la.Port), nil)
}

// ---- UDP TPROXY ----

type udpSession struct {
	tun   net.Conn     // VLESS-UDP туннель к dst
	reply *net.UDPConn // сокет с IP_TRANSPARENT, забинжен на dst (источник ответов)
}

var (
	udpMu  sync.Mutex
	udpSes = map[string]*udpSession{}
)

func serveTProxyUDP(addr string) {
	udpAddr, err := net.ResolveUDPAddr("udp4", addr)
	if err != nil {
		log.Printf("tproxy udp resolve: %v", err)
		return
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
	if err != nil {
		log.Printf("tproxy udp socket: %v", err)
		return
	}
	unix.SetsockoptInt(fd, unix.SOL_IP, unix.IP_TRANSPARENT, 1)
	unix.SetsockoptInt(fd, unix.SOL_IP, unix.IP_RECVORIGDSTADDR, 1)
	unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
	sa := &unix.SockaddrInet4{Port: udpAddr.Port}
	copy(sa.Addr[:], udpAddr.IP.To4())
	if err := unix.Bind(fd, sa); err != nil {
		log.Printf("tproxy udp bind: %v", err)
		unix.Close(fd)
		return
	}
	buf := make([]byte, 65535)
	oob := make([]byte, 256)
	for {
		n, oobn, _, src, err := unix.Recvmsg(fd, buf, oob, 0)
		if err != nil {
			continue
		}
		srcV4, ok := src.(*unix.SockaddrInet4)
		if !ok {
			continue
		}
		dst := parseOrigDstV4(oob[:oobn])
		if dst == nil {
			continue
		}
		srcAddr := &net.UDPAddr{IP: net.IP(srcV4.Addr[:]), Port: srcV4.Port}
		pkt := make([]byte, n)
		copy(pkt, buf[:n])
		dispatchUDP(srcAddr, dst, pkt)
	}
}

// parseOrigDstV4 достаёт IP_ORIGDSTADDR (sockaddr_in) из ancillary data.
func parseOrigDstV4(oob []byte) *net.UDPAddr {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	for _, m := range msgs {
		if m.Header.Level == unix.SOL_IP && m.Header.Type == unix.IP_ORIGDSTADDR && len(m.Data) >= 8 {
			// sockaddr_in: family(2) port(2, BE) addr(4)
			port := binary.BigEndian.Uint16(m.Data[2:4])
			ip := net.IPv4(m.Data[4], m.Data[5], m.Data[6], m.Data[7])
			return &net.UDPAddr{IP: ip, Port: int(port)}
		}
	}
	return nil
}

func dispatchUDP(src, dst *net.UDPAddr, data []byte) {
	key := src.String() + "|" + dst.String()
	udpMu.Lock()
	s := udpSes[key]
	if s == nil {
		tun, err := dialVLESSRaw(2, dst.IP.String(), uint16(dst.Port)) // cmd=2 UDP
		if err != nil {
			udpMu.Unlock()
			return
		}
		reply, err := transparentUDPSocket(dst)
		if err != nil {
			tun.Close()
			udpMu.Unlock()
			return
		}
		s = &udpSession{tun: tun, reply: reply}
		udpSes[key] = s
		go udpReturnLoop(key, s, src)
	}
	udpMu.Unlock()
	s.tun.SetDeadline(time.Now().Add(udpIdle))
	writeUDPPacket(s.tun, data)
}

// udpReturnLoop читает пакеты из туннеля и шлёт клиенту с адресом источника = dst.
func udpReturnLoop(key string, s *udpSession, src *net.UDPAddr) {
	buf := make([]byte, 65535)
	for {
		s.tun.SetReadDeadline(time.Now().Add(udpIdle))
		n, err := readUDPPacket(s.tun, buf)
		if err != nil {
			break
		}
		s.reply.WriteToUDP(buf[:n], src)
	}
	udpMu.Lock()
	delete(udpSes, key)
	udpMu.Unlock()
	s.tun.Close()
	s.reply.Close()
}

// transparentUDPSocket создаёт UDP-сокет с IP_TRANSPARENT, забинженный на dst,
// чтобы исходящие пакеты имели адрес источника = dst (реальный сервер).
func transparentUDPSocket(dst *net.UDPAddr) (*net.UDPConn, error) {
	lc := net.ListenConfig{Control: transparentControl}
	pc, err := lc.ListenPacket(context.Background(), "udp4", dst.String())
	if err != nil {
		return nil, err
	}
	return pc.(*net.UDPConn), nil
}
