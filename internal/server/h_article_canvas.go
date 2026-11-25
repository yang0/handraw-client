package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func resolveVaultCanvasPath(rootDir, relPath, notePath string, allowCreate bool) (absPath string, normRel string, err error) {
	rootAbs, err := filepath.Abs(rootDir)
	if err != nil {
		return "", "", err
	}
	raw := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	raw = strings.TrimLeft(raw, "/")
	if raw == "" && strings.TrimSpace(notePath) != "" {
		cleanNote := strings.ToLower(strings.TrimLeft(strings.TrimSpace(strings.ReplaceAll(notePath, "\\", "/")), "/"))
		sum := sha256.Sum256([]byte(cleanNote))
		raw = ".handraw/boards/" + hex.EncodeToString(sum[:8]) + ".canvas"
	}
	if raw == "" || raw == "." {
		return "", "", bad("请指定白板路径或关联笔记路径")
	}
	if strings.Contains(raw, ":") {
		return "", "", bad("白板路径只能是文章库内的相对路径")
	}
	cleaned := filepath.Clean(filepath.FromSlash(raw))
	if cleaned == "." || cleaned == ".." || filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	if allowCreate && !isCanvasExt(cleaned) {
		cleaned += ".canvas"
	}
	if !isCanvasExt(cleaned) {
		return "", "", bad("仅支持 .canvas 白板文件")
	}
	target := filepath.Join(rootAbs, cleaned)
	relCheck, err := filepath.Rel(rootAbs, target)
	if err != nil || relCheck == "." || relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(os.PathSeparator)) {
		return "", "", bad("不允许访问文章库目录之外的路径")
	}
	return target, filepath.ToSlash(relCheck), nil
}

func (s *Server) articleVaultReadCanvas(w http.ResponseWriter, r *http.Request) (any, error) {
	rootDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	rel := r.URL.Query().Get("path")
	note := r.URL.Query().Get("note")
	absPath, normRel, err := resolveVaultCanvasPath(rootDir, rel, note, true)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{
				"path":   normRel,
				"exists": false,
				"data":   map[string]any{"nodes": []any{}, "edges": []any{}},
			}, nil
		}
		return nil, fmt.Errorf("读取白板失败: %w", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed == nil {
		parsed = map[string]any{"nodes": []any{}, "edges": []any{}}
	}
	if _, ok := parsed["nodes"]; !ok {
		parsed["nodes"] = []any{}
	}
	if _, ok := parsed["edges"]; !ok {
		parsed["edges"] = []any{}
	}
	return map[string]any{
		"path":   normRel,
		"exists": true,
		"data":   parsed,
	}, nil
}

func (s *Server) articleVaultWriteCanvas(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		Path string         `json:"path"`
		Note string         `json:"note"`
		Data map[string]any `json:"data"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	rootDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultCanvasPath(rootDir, body.Path, body.Note, true)
	if err != nil {
		return nil, err
	}
	data := body.Data
	if data == nil {
		data = map[string]any{}
	}
	if _, ok := data["nodes"]; !ok {
		data["nodes"] = []any{}
	}
	if _, ok := data["edges"]; !ok {
		data["edges"] = []any{}
	}
	enc, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("序列化白板 JSON 失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("创建白板目录失败: %w", err)
	}
	if err := os.WriteFile(absPath, append(enc, '\n'), 0o644); err != nil {
		return nil, fmt.Errorf("保存白板失败: %w", err)
	}
	return map[string]any{
		"ok":   true,
		"path": normRel,
	}, nil
}

func (s *Server) articleVaultDeleteCanvas(w http.ResponseWriter, r *http.Request) (any, error) {
	rootDir, err := s.activeArticleVaultDir()
	if err != nil {
		return nil, err
	}
	absPath, normRel, err := resolveVaultCanvasPath(rootDir, r.URL.Query().Get("path"), "", false)
	if err != nil {
		return nil, err
	}
	if err := os.Remove(absPath); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("删除白板失败: %w", err)
	}
	return map[string]any{"ok": true, "path": normRel}, nil
}
