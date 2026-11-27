package main

import "testing"

func TestIsExpectedJobBusinessError(t *testing.T) {
	expected := []string{
		"接口返回 400：非常抱歉，该提示可能违反了关于与第三方内容相似性的防护限制。如果你认为此判断有误，请重试或修改提示语。",
		"余额不足，请充值",
		"Request rejected by safety content policy",
		"context canceled",
	}
	for _, msg := range expected {
		if !isExpectedJobBusinessError(msg) {
			t.Errorf("expected business/policy error to be ignored, got false for %q", msg)
		}
	}
	technical := []string{
		"接口返回 502：Bad Gateway",
		"dial tcp: i/o timeout",
		"unexpected EOF",
	}
	for _, msg := range technical {
		if isExpectedJobBusinessError(msg) {
			t.Errorf("expected technical error to be reported, got true for %q", msg)
		}
	}
}
