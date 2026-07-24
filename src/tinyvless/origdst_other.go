//go:build !linux

package main

import (
	"errors"
	"net"
)

func originalDst(c net.Conn) (string, uint16, error) {
	return "", 0, errors.New("REDIRECT inbound supported only on linux")
}
