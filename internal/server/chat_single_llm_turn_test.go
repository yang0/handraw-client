package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/skills"
)

func TestChatGenerateUsesSingleTextLLMCall(t *testing.T) {
	const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	var textCalls atomic.Int32

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + tinyPNG + `"}]}`))
		case "/v1/chat/completions":
			n := textCalls.Add(1)
			if n == 1 {
				_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[{"id":"call_draw","type":"function","function":{"name":"generate_images","arguments":"{\"title\":\"母亲节双图\",\"mode\":\"poster\",\"ratio\":\"3:4\",\"items\":[{\"theme\":\"妈妈在窗边织毛衣\",\"style\":\"FA-001\",\"text\":\"母亲节\\n致最爱的妈妈\"},{\"theme\":\"母女在餐桌包饺子\",\"style\":\"FA-001\",\"text\":\"母亲节\\n烟火气里的爱\"}]}"}}]}}]}`))
				return
			}
			t.Errorf("unexpected extra text LLM call #%d after generate_images", n)
			_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"content":"extra call"}}]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mockLLM.Close()

	srv, _ := setupTestServer(t, "http://127.0.0.1:1")
	srv.Skills = skills.New(filepath.Join(t.TempDir(), "skills"))
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })
	h := srv.Handler()

	doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "txt1",
		"name":    "测试文本",
		"kind":    "openai",
		"purpose": "text",
		"baseUrl": mockLLM.URL + "/v1",
		"apiKey":  "sk-txt",
		"enabled": true,
		"models":  []map[string]any{{"id": "gpt-4o", "name": "GPT-4o"}},
	})
	doReq(t, h, srv.Token, "POST", "/api/providers", map[string]any{
		"id":      "img1",
		"name":    "测试生图",
		"kind":    "openai",
		"purpose": "image",
		"baseUrl": mockLLM.URL + "/v1",
		"apiKey":  "sk-img",
		"enabled": true,
		"models":  []map[string]any{{"id": "mock-img", "name": "Mock Img"}},
	})

	rr := doReq(t, h, srv.Token, "POST", "/api/chat/turn", map[string]any{
		"messages":      []map[string]string{{"role": "user", "content": "帮我画两张母亲节海报"}},
		"textModelRef":  "txt1:gpt-4o",
		"imageModelRef": "img1:mock-img",
	})
	if rr.Code != 200 {
		t.Fatalf("chat turn failed: %d %s", rr.Code, rr.Body.String())
	}
	var res chatTurnResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if textCalls.Load() != 1 {
		t.Fatalf("expected exactly 1 text LLM call for generate_images, got %d", textCalls.Load())
	}
	if len(res.Runs) != 1 || !strings.Contains(res.Reply, "母亲节双图") || !strings.Contains(res.Reply, "致最爱的妈妈") {
		t.Fatalf("expected structured summary reply & 1 run, got reply=%q runs=%d", res.Reply, len(res.Runs))
	}
}
