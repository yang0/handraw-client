package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yang0/handraw-client/internal/settings"
)

func TestModelCapabilityHeuristicsAndMetadata(t *testing.T) {
	// 1. Updated heuristics: modern multimodal models detected, no sd/mj false positives.
	visionCases := []string{
		"deepseek-flash-4.1",
		"deepseek-v4",
		"deepseek-vl2",
		"doubao-seed-1.6",
		"kimi-k2.5",
		"qwen3.5-plus",
		"glm-5",
		"o3-mini",
		"gpt-4o",
	}
	for _, id := range visionCases {
		if !LooksVision(id) || LooksImage(id) {
			t.Errorf("expected %q to be vision (non-image), got isImage=%v isVision=%v", id, LooksImage(id), LooksVision(id))
		}
	}

	nonImageCases := []string{"usd-chat", "mjolnir-7b", "deepseek-chat", "qwen-max"}
	for _, id := range nonImageCases {
		if LooksImage(id) {
			t.Errorf("expected %q NOT to be misclassified as image model", id)
		}
	}

	imageCases := []string{"gpt-image-1", "seedream-4.5", "flux-pro", "sdxl-turbo", "midjourney-v6", "nano-banana-pro"}
	for _, id := range imageCases {
		if !LooksImage(id) {
			t.Errorf("expected %q to be classified as image model", id)
		}
	}

	// 2. Authoritative /v1/models metadata overrides name heuristics!
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				// Obscure name, but OpenRouter architecture declares vision input!
				{
					"id": "acme/opaque-model-x",
					"architecture": map[string]any{
						"input_modalities":  []string{"text", "image"},
						"output_modalities": []string{"text"},
					},
				},
				// Obscure name, but capabilities map declares image generation!
				{
					"id":           "acme/painter-v2",
					"capabilities": map[string]any{"image_generation": true},
				},
				// No metadata at all -> falls back to updated heuristics
				{
					"id": "deepseek-flash-4.1",
				},
			},
		})
	}))
	defer mock.Close()

	list, err := ListModelsWithKey(context.Background(), settings.Provider{Kind: "openai", BaseURL: mock.URL + "/v1"}, "sk-test")
	if err != nil {
		t.Fatalf("ListModelsWithKey failed: %v", err)
	}
	byID := map[string]ModelInfo{}
	for _, m := range list {
		byID[m.ID] = m
	}

	if m := byID["acme/opaque-model-x"]; !m.IsVision || m.IsImage || m.CapabilitySource != "metadata" {
		t.Fatalf("expected opaque-model-x vision from metadata, got %+v", m)
	}
	if m := byID["acme/painter-v2"]; !m.IsImage || m.IsVision || m.CapabilitySource != "metadata" {
		t.Fatalf("expected painter-v2 image from metadata, got %+v", m)
	}
	if m := byID["deepseek-flash-4.1"]; !m.IsVision || m.IsImage || m.CapabilitySource != "heuristic" {
		t.Fatalf("expected deepseek-flash-4.1 vision from heuristic, got %+v", m)
	}
}

func TestNormalizeBaseURLStripsEndpointSuffixes(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions", "https://maas-api.cn-huabei-1.xf-yun.com/v2"},
		{"https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions/", "https://maas-api.cn-huabei-1.xf-yun.com/v2"},
		{"https://api.example.com/v1/images/generations", "https://api.example.com/v1"},
		{"https://api.example.com/v1/models", "https://api.example.com/v1"},
		{"https://api.example.com/v1/", "https://api.example.com/v1"},
		{"https://api.example.com", "https://api.example.com"},
	}
	for _, tc := range cases {
		if got := NormalizeBaseURL(tc.in); got != tc.want {
			t.Errorf("NormalizeBaseURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	gotEp := endpoint(settings.Provider{BaseURL: "https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions"}, "/models")
	if gotEp != "https://maas-api.cn-huabei-1.xf-yun.com/v2/models" {
		t.Fatalf("unexpected endpoint: %q", gotEp)
	}
}
