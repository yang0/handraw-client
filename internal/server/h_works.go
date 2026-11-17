package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

func (s *Server) works(w http.ResponseWriter, r *http.Request) (any, error) {
	q := r.URL.Query()
	list, total, err := s.DB.ListRuns(store.RunQuery{
		Search:    q.Get("q"),
		Mode:      q.Get("mode"),
		Starred:   q.Get("starred") == "1",
		Published: q.Get("published"),
		GroupID:   q.Get("groupId"),
		Status:    q.Get("status"),
		Limit:     qint(r, "limit", 48),
		Offset:    qint(r, "offset", 0),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": list, "total": total}, nil
}

func (s *Server) work(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	run, err := s.DB.GetRun(id)
	if err != nil {
		return nil, err
	}
	// Walk parent chain upward and collect direct/descendant edits for version timeline.
	versions := []store.Run{}
	seen := map[string]bool{}
	cur := run
	for cur.ParentID != "" && !seen[cur.ParentID] {
		seen[cur.ParentID] = true
		p, err := s.DB.GetRun(cur.ParentID)
		if err != nil {
			break
		}
		versions = append([]store.Run{p}, versions...)
		cur = p
	}
	versions = append(versions, run)
	all, _, _ := s.DB.ListRuns(store.RunQuery{Limit: 200})
	for _, cand := range all {
		if cand.ParentID == run.ID && !seen[cand.ID] {
			seen[cand.ID] = true
			versions = append(versions, cand)
		}
	}
	return map[string]any{"run": run, "versions": versions}, nil
}

func (s *Server) workPatch(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	var body struct {
		Title   *string         `json:"title"`
		Starred *bool           `json:"starred"`
		Meta    json.RawMessage `json:"meta"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	fields := map[string]any{}
	if body.Title != nil {
		fields["title"] = *body.Title
	}
	if body.Starred != nil {
		fields["starred"] = *body.Starred
	}
	if len(body.Meta) > 0 {
		fields["meta"] = body.Meta
	}
	if err := s.DB.UpdateRun(id, fields); err != nil {
		return nil, err
	}
	_ = jobs.WriteRunJSON(s.DB, id)
	return s.work(w, r)
}

func (s *Server) workDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	run, err := s.DB.GetRun(id)
	if err != nil {
		return nil, err
	}
	if err := s.DB.SoftDeleteRun(id); err != nil {
		return nil, err
	}
	if run.Dir != "" {
		trash := filepath.Join(settings.Get().WorksDir, ".trash", run.ID)
		_ = os.MkdirAll(filepath.Dir(trash), 0o755)
		_ = os.Rename(run.Dir, trash)
	}
	return okv, nil
}

func (s *Server) workPublish(w http.ResponseWriter, r *http.Request) (any, error) {
	if !s.Site.LoggedIn() {
		return nil, site.ErrNotLoggedIn
	}
	id := r.PathValue("id")
	run, err := s.DB.GetRun(id)
	if err != nil {
		return nil, err
	}
	if run.PublishedWorkID != "" {
		return map[string]any{
			"ok":     true,
			"workId": run.PublishedWorkID,
			"url":    run.PublishedURL,
			"deduped": true,
		}, nil
	}
	var body struct {
		Title    string   `json:"title"`
		Notes    string   `json:"notes"`
		ImageIDs []string `json:"imageIds"`
	}
	_ = decode(r, &body)

	want := map[string]bool{}
	for _, iid := range body.ImageIDs {
		want[iid] = true
	}
	var selected []store.Image
	for _, im := range run.Images {
		if im.Status != "done" || im.Path == "" {
			continue
		}
		if len(want) > 0 && !want[im.ID] {
			continue
		}
		selected = append(selected, im)
	}
	if len(selected) == 0 {
		return nil, bad("没有可发布的已完成图片")
	}
	if len(selected) > 12 {
		selected = selected[:12]
	}

	var imagesPayload []map[string]any
	for _, im := range selected {
		raw, err := os.ReadFile(im.Path)
		if err != nil {
			return nil, fmt.Errorf("读取图片失败：%w", err)
		}
		sum := sha256.Sum256(raw)
		mime := "image/png"
		switch strings.ToLower(filepath.Ext(im.Path)) {
		case ".jpg", ".jpeg":
			mime = "image/jpeg"
		case ".webp":
			mime = "image/webp"
		}
		imagesPayload = append(imagesPayload, map[string]any{
			"name":    filepath.Base(im.Path),
			"sha256":  hex.EncodeToString(sum[:]),
			"dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw),
		})
	}

	extUUID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("handraw-run:"+run.ID)).String()
	origReq := buildPublishRequestText(run, body.Title, body.Notes)
	payload := map[string]any{
		"externalRunId":   extUUID,
		"requestId":       "skill-history-" + extUUID,
		"originClient":    "skill",
		"visibility":      "public",
		"status":          "success",
		"originalRequest": origReq,
		"images":          imagesPayload,
	}
	rawResp, err := s.Site.Send(r.Context(), "POST", "/api/v1/me/generations", payload)
	if err != nil {
		return nil, err
	}
	var res struct {
		WorkID   string   `json:"workId"`
		WorkIds  []string `json:"workIds"`
		CoverURL string   `json:"coverUrl"`
	}
	_ = json.Unmarshal(rawResp, &res)
	wid := res.WorkID
	if wid == "" && len(res.WorkIds) > 0 {
		wid = res.WorkIds[0]
	}
	workURL := s.Site.Base() + "/t/work-" + wid
	fields := map[string]any{"published_work_id": wid, "published_url": workURL}
	if body.Title != "" {
		fields["title"] = body.Title
	}
	_ = s.DB.UpdateRun(run.ID, fields)
	_ = jobs.WriteRunJSON(s.DB, run.ID)
	s.Emit("work_published", map[string]any{"runId": run.ID, "workId": wid, "url": workURL})
	return map[string]any{"ok": true, "workId": wid, "url": workURL}, nil
}

// buildPublishRequestText follows AGENTS.md sharing rules: keep original request,
// append only official 【画风：... 】【图型：... 】 tags (never leaking MY-* custom defs).
func buildPublishRequestText(run store.Run, title, notes string) string {
	base := strings.TrimSpace(firstStr(run.OriginalRequest, run.Title, title, "手绘风创作"))
	if notes = strings.TrimSpace(notes); notes != "" {
		base += "\n" + notes
	}
	var rec struct {
		StyleIDs []string `json:"styleIds"`
		Style    string   `json:"style"`
		Style2   string   `json:"style2"`
		LayoutID string   `json:"layoutId"`
		Layout   string   `json:"layout"`
	}
	_ = json.Unmarshal(run.Recipe, &rec)
	var styles []string
	for _, id := range append(rec.StyleIDs, rec.Style, rec.Style2) {
		id = strings.TrimSpace(id)
		if id != "" && !strings.HasPrefix(id, "MY-") && !strings.HasPrefix(id, "mine:") {
			found := false
			for _, ex := range styles {
				if ex == id {
					found = true
				}
			}
			if !found {
				styles = append(styles, id)
			}
		}
	}
	if len(styles) > 0 {
		base += " 【画风：" + strings.Join(styles, "、") + " 】"
	}
	lay := strings.TrimSpace(firstStr(rec.LayoutID, rec.Layout))
	if lay != "" && !strings.HasPrefix(lay, "MY-") && !strings.HasPrefix(lay, "mine:") {
		base += "【图型：" + lay + " 】"
	}
	return base
}

func (s *Server) workExport(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	run, err := s.DB.GetRun(id)
	if err != nil {
		return nil, err
	}
	var body struct {
		Format string `json:"format"` // zip | xiaohongshu | png | jpg | webp
		Dest   string `json:"dest"`
	}
	_ = decode(r, &body)
	if body.Format == "" {
		body.Format = "zip"
	}
	exportDir := filepath.Join(settings.Get().WorksDir, "exports")
	_ = os.MkdirAll(exportDir, 0o755)
	if body.Dest != "" {
		exportDir = body.Dest
	}

	var done []store.Image
	for _, im := range run.Images {
		if im.Status == "done" && im.Path != "" {
			done = append(done, im)
		}
	}
	if len(done) == 0 {
		return nil, bad("没有可导出的已完成图片")
	}

	if body.Format == "zip" || body.Format == "xiaohongshu" {
		outName := run.ID + "_" + body.Format + ".zip"
		outPath := filepath.Join(exportDir, outName)
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for i, im := range done {
			raw, err := os.ReadFile(im.Path)
			if err != nil {
				continue
			}
			if body.Format == "xiaohongshu" {
				if xhs, err := fitRatio34JPEG(raw); err == nil {
					f, _ := zw.Create(fmt.Sprintf("%02d.jpg", i+1))
					_, _ = f.Write(xhs)
					continue
				}
			}
			f, _ := zw.Create(fmt.Sprintf("%02d%s", i+1, filepath.Ext(im.Path)))
			_, _ = f.Write(raw)
		}
		if b, err := os.ReadFile(filepath.Join(run.Dir, "run.json")); err == nil && body.Format == "zip" {
			f, _ := zw.Create("run.json")
			_, _ = f.Write(b)
		}
		zw.Close()
		if err := os.WriteFile(outPath, buf.Bytes(), 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "path": outPath}, nil
	}

	raw, err := os.ReadFile(done[0].Path)
	if err != nil {
		return nil, err
	}
	outPath := filepath.Join(exportDir, run.ID+"."+body.Format)
	if converted, err := convertImageFormat(raw, body.Format); err == nil {
		raw = converted
	}
	if err := os.WriteFile(outPath, raw, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "path": outPath}, nil
}

func fitRatio34JPEG(raw []byte) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	const w, h = 1242, 1656 // 3:4 standard XiaoHongShu canvas
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	bg := color.RGBA{247, 243, 236, 255}
	draw.Draw(dst, dst.Bounds(), &image.Uniform{bg}, image.Point{}, draw.Src)
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	scale := float64(w) / float64(sw)
	if float64(h)/float64(sh) < scale {
		scale = float64(h) / float64(sh)
	}
	nw, nh := int(float64(sw)*scale), int(float64(sh)*scale)
	ox, oy := (w-nw)/2, (h-nh)/2
	draw.CatmullRom.Scale(dst, image.Rect(ox, oy, ox+nw, oy+nh), src, b, draw.Over, nil)
	var out bytes.Buffer
	err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 92})
	return out.Bytes(), err
}

func convertImageFormat(raw []byte, format string) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	switch format {
	case "jpg", "jpeg":
		err = jpeg.Encode(&out, src, &jpeg.Options{Quality: 92})
	case "png":
		err = png.Encode(&out, src)
	default:
		return raw, nil
	}
	return out.Bytes(), err
}

func (s *Server) workReveal(w http.ResponseWriter, r *http.Request) (any, error) {
	run, err := s.DB.GetRun(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	return okv, s.Host.OpenPath(run.Dir)
}

func (s *Server) imageRetry(w http.ResponseWriter, r *http.Request) (any, error) {
	if err := s.Jobs.Retry(r.PathValue("id")); err != nil {
		return nil, bad(err.Error())
	}
	return okv, nil
}

func (s *Server) imageCancel(w http.ResponseWriter, r *http.Request) (any, error) {
	if err := s.Jobs.Cancel(r.PathValue("id")); err != nil {
		return nil, bad(err.Error())
	}
	return okv, nil
}

func (s *Server) imageCopy(w http.ResponseWriter, r *http.Request) (any, error) {
	im, err := s.DB.GetImage(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if im.Path == "" {
		return nil, bad("图片尚未生成完成")
	}
	return okv, s.Host.CopyImage(im.Path)
}

func (s *Server) queue(w http.ResponseWriter, r *http.Request) (any, error) {
	active, err := s.DB.ActiveImages()
	if err != nil {
		return nil, err
	}
	return map[string]any{"active": active, "count": len(active)}, nil
}

// ---------- shared image helpers ----------

func sniffImageExt(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0x89, 'P', 'N', 'G'}):
		return ".png"
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8}):
		return ".jpg"
	case len(b) > 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return ".webp"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return ".gif"
	}
	return ".png"
}

func imgName(idx int, b []byte) string {
	return fmt.Sprintf("%02d%s", idx+1, sniffImageExt(b))
}

func inspectBytes(b []byte) (int, int, string, []byte) {
	sum := sha256.Sum256(b)
	w, h := 0, 0
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(b)); err == nil {
		w, h = cfg.Width, cfg.Height
	}
	var thumb []byte
	if src, _, err := image.Decode(bytes.NewReader(b)); err == nil {
		bd := src.Bounds()
		sw, sh := bd.Dx(), bd.Dy()
		const max = 480
		if sw > max || sh > max {
			if sw >= sh {
				sh = sh * max / sw
				sw = max
			} else {
				sw = sw * max / sh
				sh = max
			}
		}
		dst := image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, bd, draw.Over, nil)
		var out bytes.Buffer
		if jpeg.Encode(&out, dst, &jpeg.Options{Quality: 82}) == nil {
			thumb = out.Bytes()
		}
	}
	return w, h, hex.EncodeToString(sum[:]), thumb
}

func inspectAndThumb(dir string, idx int, b []byte) (int, int, string, string) {
	w, h, sha, thumb := inspectBytes(b)
	tp := ""
	if len(thumb) > 0 {
		p := filepath.Join(dir, ".thumbs", fmt.Sprintf("%02d.jpg", idx+1))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if os.WriteFile(p, thumb, 0o644) == nil {
			tp = p
		}
	}
	return w, h, sha, tp
}
