package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/site"
)

func TestGenerateInsufficientCash2kExplainsResolutionAnd1kFreeQuota(t *testing.T) {
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/economy/public-models":
			_, _ = w.Write([]byte(`{"specifications":[
				{"id":"spec-1k","model":"gpt-image-2.5","resolution":"1k","quality":"standard","priceCents":5,"enabled":true,"verified":true},
				{"id":"spec-2k","model":"gpt-image-2.5","resolution":"2k","quality":"standard","priceCents":10,"enabled":true,"verified":true}
			]}`))
		case "/api/studio/quote":
			_, _ = w.Write([]byte(`{"ok":true,"quoteId":"q_2k_no_cash","count":1,"freeCount":0,"totalCents":10,"balanceCents":0,"affordable":false,"freeDailyCapReached":false}`))
		case "/api/economy":
			_, _ = w.Write([]byte(`{
				"cash":{"balanceCents":0,"heldCents":0},
				"freeQuota":[{"resolution":"1k","remaining":58,"usableRemaining":20,"total":58,"held":0}],
				"aiBonus":{"balanceMicros":1900000,"availableMicros":1900000,"heldMicros":0}
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockSite.Close()

	srv, _ := setupTestServer(t, "")
	srv.Site = site.NewWithBase(mockSite.URL, "test")
	t.Setenv("HANDRAW_SECRETS", "memory")
	_ = secrets.Set(secrets.SiteToken, "tok-test-guiyi")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	h := srv.Handler()
	rr := doReq(t, h, srv.Token, "POST", "/api/generate", map[string]any{
		"mode":       "single",
		"title":      "测试2K余额不足",
		"modelRef":   "site:gpt-image-2.5",
		"resolution": "2k",
		"input": map[string]any{
			"theme": "一只喝咖啡的橘猫",
			"style": "FA-001",
			"ratio": "3:4",
		},
	})
	if rr.Code != 402 {
		t.Fatalf("expected HTTP 402 for insufficient cash, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["code"] != "insufficient_cash" {
		t.Fatalf("expected code insufficient_cash, got %v", resp["code"])
	}
	if resp["resolution"] != "2k" {
		t.Fatalf("expected resolution 2k, got %v", resp["resolution"])
	}
	if got := int(resp["free1kRemaining"].(float64)); got != 20 {
		t.Fatalf("expected usable free1kRemaining=20, got %d", got)
	}
	msg, _ := resp["error"].(string)
	for _, want := range []string{"2K", "付费档位", "赠金", "1K 免费生图额度", "切回 1K"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("expected error message to contain %q, got %q", want, msg)
		}
	}
}

func TestFormatInsufficientCashErrorVariants(t *testing.T) {
	msg2k := jobs.FormatInsufficientCashError("2k", 10, 0, 58, true, true, false)
	if !strings.Contains(msg2k, "2K") || !strings.Contains(msg2k, "58 张 1K 免费") || !strings.Contains(msg2k, "赠金") {
		t.Fatalf("unexpected 2k message: %q", msg2k)
	}
	msg2kUnknown := jobs.FormatInsufficientCashError("2k", 0, 0, 0, false, false, false)
	if !strings.Contains(msg2kUnknown, "2K") || !strings.Contains(msg2kUnknown, "切回 1K") {
		t.Fatalf("unexpected 2k unknown-quota message: %q", msg2kUnknown)
	}
	msg1kCap := jobs.FormatInsufficientCashError("1k", 5, 0, 0, true, true, true)
	if !strings.Contains(msg1kCap, "24 小时上限") {
		t.Fatalf("unexpected 1k daily-cap message: %q", msg1kCap)
	}
	_ = site.New("test")
}
