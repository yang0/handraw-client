package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestUnifiedMixedCapabilityProvider(t *testing.T) {
	var mu sync.Mutex
	var hitModels, hitChat, hitImages int
	var lastChatHadImage bool

	mockOAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			mu.Lock()
			hitModels++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"id": "gpt-image-1"},
					{"id": "gpt-4o"},
					{"id": "deepseek-chat"},
				},
			})
		case "/v1/chat/completions":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			raw, _ := json.Marshal(body)
			mu.Lock()
			hitChat++
			lastChatHadImage = strings.Contains(string(raw), "image_url")
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{"role": "assistant", "content": "OK"}},
				},
			})
		case "/v1/images/generations":
			mu.Lock()
			hitImages++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"b64_json": base64.StdEncoding.EncodeToString(tinyPNG(t))},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockOAI.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()

	// Save a SINGLE provider that serves BOTH image and text/vision models.
	rrPut := doReq(t, h, srv.Token, http.MethodPost, "/api/providers", map[string]any{
		"id":      "mix1",
		"name":    "综合中转站",
		"kind":    "openai",
		"purpose": "all",
		"baseUrl": mockOAI.URL + "/v1",
		"apiKey":  "sk-mixed-key",
		"enabled": true,
		"models": []map[string]any{
			{"id": "gpt-image-1", "label": "gpt-image-1", "kind": "image", "canRefImage": true, "canEdit": true},
			{"id": "deepseek-chat", "label": "deepseek-chat", "kind": "text", "canVision": false},
			{"id": "gpt-4o", "label": "gpt-4o", "kind": "text", "canVision": true},
		},
	})
	if rrPut.Code != http.StatusOK {
		t.Fatalf("save mixed provider failed: %d %s", rrPut.Code, rrPut.Body.String())
	}

	// Verify /api/models splits models cleanly into providers (image) and textProviders (text/vision).
	rrMod := doReq(t, h, srv.Token, http.MethodGet, "/api/models", nil)
	if rrMod.Code != http.StatusOK {
		t.Fatalf("/api/models failed: %d %s", rrMod.Code, rrMod.Body.String())
	}
	var modOut struct {
		Providers []struct {
			ID     string `json:"id"`
			Models []struct {
				ID   string `json:"id"`
				Kind string `json:"kind"`
			} `json:"models"`
		} `json:"providers"`
		TextProviders []struct {
			ID     string `json:"id"`
			Models []struct {
				ID        string `json:"id"`
				Kind      string `json:"kind"`
				CanVision bool   `json:"canVision"`
			} `json:"models"`
		} `json:"textProviders"`
	}
	if err := json.Unmarshal(rrMod.Body.Bytes(), &modOut); err != nil {
		t.Fatal(err)
	}
	if len(modOut.Providers) != 1 || len(modOut.Providers[0].Models) != 1 || modOut.Providers[0].Models[0].ID != "gpt-image-1" {
		t.Fatalf("expected only gpt-image-1 in image providers, got %+v", modOut.Providers)
	}
	if len(modOut.TextProviders) != 1 || len(modOut.TextProviders[0].Models) != 2 {
		t.Fatalf("expected 2 text models in textProviders, got %+v", modOut.TextProviders)
	}

	// findTextProviderFor("vision") should skip gpt-image-1 and deepseek-chat and select gpt-4o.
	vp, vmid, ok := findTextProviderFor("vision")
	if !ok || vp.ID != "mix1" || vmid != "gpt-4o" {
		t.Fatalf("expected vision model mix1:gpt-4o, got ok=%v %s:%s", ok, vp.ID, vmid)
	}

	// 1. Connectivity ping (empty model) -> /v1/models
	rrPing := doReq(t, h, srv.Token, http.MethodPost, "/api/providers/mix1/test", map[string]any{})
	if rrPing.Code != http.StatusOK || !strings.Contains(rrPing.Body.String(), `"modelsCount":3`) {
		t.Fatalf("expected ping modelsCount=3, got %d %s", rrPing.Code, rrPing.Body.String())
	}

	// 2. Test image model -> /v1/images/generations
	rrImg := doReq(t, h, srv.Token, http.MethodPost, "/api/providers/mix1/test", map[string]any{
		"model": "gpt-image-1",
		"kind":  "image",
	})
	if rrImg.Code != http.StatusOK || !strings.Contains(rrImg.Body.String(), `"imagesCount":1`) {
		t.Fatalf("expected image test ok, got %d %s", rrImg.Code, rrImg.Body.String())
	}

	// 3. Test vision model -> /v1/chat/completions with image_url
	rrVis := doReq(t, h, srv.Token, http.MethodPost, "/api/providers/mix1/test", map[string]any{
		"model":  "gpt-4o",
		"kind":   "text",
		"vision": true,
	})
	if rrVis.Code != http.StatusOK || !strings.Contains(rrVis.Body.String(), `"reply":"OK"`) {
		t.Fatalf("expected vision test ok, got %d %s", rrVis.Code, rrVis.Body.String())
	}

	mu.Lock()
	defer mu.Unlock()
	if hitModels < 1 || hitImages != 1 || hitChat != 1 || !lastChatHadImage {
		t.Fatalf("unexpected upstream calls: models=%d images=%d chat=%d lastChatHadImage=%v", hitModels, hitImages, hitChat, lastChatHadImage)
	}
}

func TestAutoProbeVisionDuringProviderTest(t *testing.T) {
	mockOAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		model, _ := body["model"].(string)
		raw, _ := json.Marshal(body)
		hasImg := strings.Contains(string(raw), "image_url")

		// text-only-llm rejects image_url with 400, succeeds on plain text
		if model == "text-only-llm" && hasImg {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"message": "image_url is not supported by this model"},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": "OK"}},
			},
		})
	}))
	defer mockOAI.Close()

	srv, _ := setupTestServer(t, "")
	h := srv.Handler()
	_ = doReq(t, h, srv.Token, http.MethodPost, "/api/providers", map[string]any{
		"id":      "probe1",
		"name":    "探测中转站",
		"kind":    "openai",
		"purpose": "all",
		"baseUrl": mockOAI.URL + "/v1",
		"apiKey":  "sk-probe",
		"enabled": true,
		"models": []map[string]any{
			{"id": "mystery-multimodal", "label": "mystery-multimodal", "kind": "text", "canVision": false},
			{"id": "text-only-llm", "label": "text-only-llm", "kind": "text", "canVision": true},
		},
	})

	// 1. mystery-multimodal has canVision=false, autoProbeVision discovers it DOES support vision!
	rr1 := doReq(t, h, srv.Token, http.MethodPost, "/api/providers/probe1/test", map[string]any{
		"model":           "mystery-multimodal",
		"kind":            "text",
		"vision":          false,
		"autoProbeVision": true,
	})
	if rr1.Code != http.StatusOK || !strings.Contains(rr1.Body.String(), `"visionDetected":true`) {
		t.Fatalf("expected visionDetected=true for mystery-multimodal, got %d %s", rr1.Code, rr1.Body.String())
	}

	// 2. text-only-llm had canVision=true, probe detects image_url fails while plain text works -> visionDetected=false!
	rr2 := doReq(t, h, srv.Token, http.MethodPost, "/api/providers/probe1/test", map[string]any{
		"model":           "text-only-llm",
		"kind":            "text",
		"vision":          true,
		"autoProbeVision": true,
	})
	if rr2.Code != http.StatusOK || !strings.Contains(rr2.Body.String(), `"visionDetected":false`) || !strings.Contains(rr2.Body.String(), `"ok":true`) {
		t.Fatalf("expected ok=true visionDetected=false for text-only-llm, got %d %s", rr2.Code, rr2.Body.String())
	}
}
