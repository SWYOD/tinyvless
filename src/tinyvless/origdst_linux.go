//go:build linux

package main

import (
	"encoding/binary"
	"errors"
	"net"
	"syscall"
)

// originalDst достаёт адрес назначения до DNAT через getsockopt SO_ORIGINAL_DST (IPv4, Linux).
func originalDst(c net.Conn) (string, uint16, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return "", 0, errors.New("not tcp")
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return "", 0, err
	}
	var host string
	var dport uint16
	var gerr error
	const soOriginalDst = 80 // SO_ORIGINAL_DST
	cerr := raw.Control(func(fd uintptr) {
		mreq, e := syscall.GetsockoptIPv6Mreq(int(fd), syscall.SOL_IP, soOriginalDst)
		if e != nil {
			gerr = e
			return
		}
		// mreq.Multiaddr = sockaddr_in: [0:2]=family [2:4]=port(BE) [4:8]=addr
		dport = binary.BigEndian.Uint16(mreq.Multiaddr[2:4])
		host = net.IPv4(mreq.Multiaddr[4], mreq.Multiaddr[5], mreq.Multiaddr[6], mreq.Multiaddr[7]).String()
	})
	if cerr != nil {
		return "", 0, cerr
	}
	if gerr != nil {
		return "", 0, gerr
	}
	return host, dport, nil
}
