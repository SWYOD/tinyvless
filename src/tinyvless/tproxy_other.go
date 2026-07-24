//go:build !linux

package main

import "errors"

func startTProxy(addr string) error {
	return errors.New("TPROXY supported only on linux")
}
