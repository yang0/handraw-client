package server

// Posts (#164): a finished social "note" — ordered images from the works
// library plus title / body / tags. Stored as JSON docs (kind=post) so no
// schema migration is needed. Images are referenced by image id and resolved
// on read, so the works library stays the single owner of image files.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/store"
)

const postKind = "post"

type postImageRef struct {
	RunID   string `json:"runId"`
	ImageID string `json:"imageId"`
}

type postSource struct {
	CanvasID string `json:"canvasId,omitempty"`
	NodeID   string `json:"nodeId,omitempty"`
}

type postData struct {
	Platform    string         `json:"platform"`
	Title       string         `json:"title"`
	Titles      []string       `json:"titles"`
	Body        string         `json:"body"`
	Tags        []string       `json:"tags"`
	Images      []postImageRef `json:"images"`
	CoverIndex  int            `json:"coverIndex"`
	Status      string         `json:"status"` // draft | exported
	Source      postSource     `json:"source"`
	TextEdited  bool           `json:"textEdited"`  // user edited title/body/tags in the post editor
	ImageEdited bool           `json:"imageEdited"` // user reordered/removed images or changed cover
	Removed     []string       `json:"removedImageIds,omitempty"` // image ids the user removed; canvas re-assembly won't re-add them
	ExportedAt  string         `json:"exportedAt,omitempty"`
}

// postView is what the API returns: stored data + resolved image info.
type postView struct {
	ID        string          `json:"id"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
	Resolved  []postImageView `json:"resolvedImages"`
	postData
}

type postImageView struct {
	RunID   string `json:"runId"`
	ImageID string `json:"imageId"`
	Path    string `json:"path"`
	Thumb   string `json:"thumb"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Theme   string `json:"theme"`
}

func normalizePostData(p *postData) {
	p.Platform = normalizeCanvasCopyPlatform(p.Platform)
	p.Title = strings.TrimSpace(p.Title)
	var titles []string
	seen := map[string]bool{}
	for _, t := range p.Titles {
		t = strings.TrimSpace(t)
		if t != "" && !seen[t] {
			seen[t] = true
			titles = append(titles, t)
		}
	}
	p.Titles = titles
	if p.Title == "" && len(titles) > 0 {
		p.Title = titles[0]
	}
	var tags []string
	seenTag := map[string]bool{}
	for _, t := range p.Tags {
		t = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(t), "#＃"))
		if t != "" && !seenTag[t] {
			seenTag[t] = true
			tags = append(tags, t)
		}
	}
	p.Tags = tags
	var imgs []postImageRef
	seenImg := map[string]bool{}
	for _, im := range p.Images {
		if im.ImageID == "" || seenImg[im.ImageID] {
			continue
		}
		seenImg[im.ImageID] = true
		imgs = append(imgs, im)
	}
	p.Images = imgs
	if p.CoverIndex < 0 || p.CoverIndex >= len(p.Images) {
		p.CoverIndex = 0
	}
	if p.Status == "" {
		p.Status = "draft"
	}
	if p.Titles == nil {
		p.Titles = []string{}
	}
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if p.Images == nil {
		p.Images = []postImageRef{}
	}
}

func (s *Server) loadPost(id string) (store.Doc, postData, error) {
	doc, err := s.DB.GetDoc(postKind, id)
	if err != nil {
		return doc, postData{}, err
	}
	if doc.Deleted {
		return doc, postData{}, store.ErrNotFound
	}
	var p postData
	if err := json.Unmarshal(doc.Data, &p); err != nil {
		return doc, p, fmt.Errorf("笔记数据损坏：%w", err)
	}
	normalizePostData(&p)
	return doc, p, nil
}

func (s *Server) savePost(doc *store.Doc, p postData) error {
	normalizePostData(&p)
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	doc.Kind = postKind
	doc.Name = p.Title
	doc.Data = b
	doc.Dirty = false // local only for now; not part of cloud sync
	return s.DB.PutDoc(doc)
}

// resolvePostImages returns usable (done, on-disk) images in post order.
func (s *Server) resolvePostImages(p postData) []postImageView {
	out := []postImageView{}
	for _, ref := range p.Images {
		im, err := s.DB.GetImage(ref.ImageID)
		if err != nil || im.Status != "done" || im.Path == "" {
			continue
		}
		out = append(out, postImageView{
			RunID: im.RunID, ImageID: im.ID, Path: im.Path, Thumb: im.Thumb,
			Width: im.Width, Height: im.Height, Theme: im.Theme,
		})
	}
	return out
}

func (s *Server) postViewOf(doc store.Doc, p postData) postView {
	return postView{ID: doc.ID, CreatedAt: doc.CreatedAt, UpdatedAt: doc.UpdatedAt, Resolved: s.resolvePostImages(p), postData: p}
}

func (s *Server) postList(w http.ResponseWriter, r *http.Request) (any, error) {
	docs, err := s.DB.ListDocs(postKind, false)
	if err != nil {
		return nil, err
	}
	platform := strings.TrimSpace(r.URL.Query().Get("platform"))
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	items := []postView{}
	for _, doc := range docs {
		var p postData
		if json.Unmarshal(doc.Data, &p) != nil {
			continue
		}
		normalizePostData(&p)
		if platform != "" && p.Platform != normalizeCanvasCopyPlatform(platform) {
			continue
		}
		if q != "" {
			hay := strings.ToLower(p.Title + "\n" + p.Body + "\n" + strings.Join(p.Tags, " "))
			if !strings.Contains(hay, q) {
				continue
			}
		}
		items = append(items, s.postViewOf(doc, p))
	}
	return map[string]any{"items": items}, nil
}

func (s *Server) postGet(w http.ResponseWriter, r *http.Request) (any, error) {
	doc, p, err := s.loadPost(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	return map[string]any{"post": s.postViewOf(doc, p)}, nil
}

// postCreate creates a post from explicit fields (e.g. "new post" in works).
func (s *Server) postCreate(w http.ResponseWriter, r *http.Request) (any, error) {
	var p postData
	if err := decode(r, &p); err != nil {
		return nil, err
	}
	doc := store.Doc{ID: "post_" + newShortID()}
	if err := s.savePost(&doc, p); err != nil {
		return nil, err
	}
	doc, p, err := s.loadPost(doc.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"post": s.postViewOf(doc, p)}, nil
}

// postUpdate is the editor save. Any provided field marks the post as
// user-edited so later canvas re-assembly will not clobber it.
func (s *Server) postUpdate(w http.ResponseWriter, r *http.Request) (any, error) {
	doc, p, err := s.loadPost(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	var body struct {
		Platform   *string         `json:"platform"`
		Title      *string         `json:"title"`
		Titles     *[]string       `json:"titles"`
		Body       *string         `json:"body"`
		Tags       *[]string       `json:"tags"`
		Images     *[]postImageRef `json:"images"`
		CoverIndex *int            `json:"coverIndex"`
		Status     *string         `json:"status"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	if body.Platform != nil {
		p.Platform = *body.Platform
	}
	if body.Title != nil {
		p.Title, p.TextEdited = *body.Title, true
	}
	if body.Titles != nil {
		p.Titles = *body.Titles
	}
	if body.Body != nil {
		p.Body, p.TextEdited = *body.Body, true
	}
	if body.Tags != nil {
		p.Tags, p.TextEdited = *body.Tags, true
	}
	if body.Images != nil {
		next := map[string]bool{}
		for _, im := range *body.Images {
			next[im.ImageID] = true
		}
		removed := map[string]bool{}
		for _, id := range p.Removed {
			if !next[id] {
				removed[id] = true
			}
		}
		for _, im := range p.Images {
			if !next[im.ImageID] {
				removed[im.ImageID] = true
			}
		}
		p.Removed = p.Removed[:0]
		for id := range removed {
			p.Removed = append(p.Removed, id)
		}
		p.Images, p.ImageEdited = *body.Images, true
	}
	if body.CoverIndex != nil {
		p.CoverIndex, p.ImageEdited = *body.CoverIndex, true
	}
	if body.Status != nil {
		p.Status = *body.Status
	}
	if err := s.savePost(&doc, p); err != nil {
		return nil, err
	}
	doc, p, err = s.loadPost(doc.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"post": s.postViewOf(doc, p)}, nil
}

func (s *Server) postDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	id := r.PathValue("id")
	if _, _, err := s.loadPost(id); err != nil {
		return nil, err
	}
	if err := s.DB.DeleteDocHard(postKind, id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

type postAssembleRequest struct {
	PostID   string         `json:"postId"`
	CanvasID string         `json:"canvasId"`
	NodeID   string         `json:"nodeId"`
	Platform string         `json:"platform"`
	Images   []postImageRef `json:"images"`
	Copy     *struct {
		Titles      []string `json:"titles"`
		ActiveTitle string   `json:"activeTitle"`
		Content     string   `json:"content"`
		Tags        []string `json:"tags"`
	} `json:"copy"`
	// OverwriteText replaces user-edited text with the incoming copy.
	OverwriteText bool `json:"overwriteText"`
}

// assemblePost creates or updates the draft owned by a canvas post node.
// It never overwrites fields the user edited in the post editor unless asked;
// in that case it reports textConflict so the UI can offer an overwrite.
func (s *Server) assemblePost(req postAssembleRequest) (postView, bool, error) {
	var doc store.Doc
	var p postData
	found := false
	if req.PostID != "" {
		d, pd, err := s.loadPost(req.PostID)
		if err == nil {
			doc, p, found = d, pd, true
		} else if !errors.Is(err, store.ErrNotFound) {
			return postView{}, false, err
		}
	}
	if !found && req.CanvasID != "" && req.NodeID != "" {
		// The canvas may not have been saved after the first assemble, so the
		// node lost its postId; reuse the draft owned by the same canvas node.
		if docs, err := s.DB.ListDocs(postKind, false); err == nil {
			for _, d := range docs {
				var pd postData
				if json.Unmarshal(d.Data, &pd) == nil && pd.Source.CanvasID == req.CanvasID && pd.Source.NodeID == req.NodeID {
					normalizePostData(&pd)
					doc, p, found = d, pd, true
					break
				}
			}
		}
	}
	if !found {
		doc = store.Doc{ID: "post_" + newShortID()}
		p = postData{Status: "draft"}
	}
	p.Source = postSource{CanvasID: req.CanvasID, NodeID: req.NodeID}
	if req.Platform != "" {
		p.Platform = req.Platform
	}

	if !p.ImageEdited || !found {
		p.Images = req.Images
	} else {
		// Keep the user's order and removals; drop images that no longer
		// exist and append images the canvas produced since the last edit.
		known := map[string]bool{}
		for _, im := range p.Images {
			known[im.ImageID] = true
		}
		for _, id := range p.Removed {
			known[id] = true
		}
		var kept []postImageRef
		for _, im := range p.Images {
			if _, err := s.DB.GetImage(im.ImageID); err == nil {
				kept = append(kept, im)
			}
		}
		for _, im := range req.Images {
			if !known[im.ImageID] {
				kept = append(kept, im)
			}
		}
		p.Images = kept
	}

	conflict := false
	if req.Copy != nil {
		title := strings.TrimSpace(req.Copy.ActiveTitle)
		if title == "" && len(req.Copy.Titles) > 0 {
			title = req.Copy.Titles[0]
		}
		incomingSame := p.Title == title && p.Body == req.Copy.Content && strings.Join(p.Tags, "\x00") == strings.Join(trimTags(req.Copy.Tags), "\x00")
		if p.TextEdited && !req.OverwriteText {
			conflict = !incomingSame
			p.Titles = req.Copy.Titles
		} else {
			p.Titles = req.Copy.Titles
			p.Title = title
			p.Body = req.Copy.Content
			p.Tags = req.Copy.Tags
			if req.OverwriteText {
				p.TextEdited = false
			}
		}
	}
	if err := s.savePost(&doc, p); err != nil {
		return postView{}, false, err
	}
	doc, p, err := s.loadPost(doc.ID)
	if err != nil {
		return postView{}, false, err
	}
	return s.postViewOf(doc, p), conflict, nil
}

func trimTags(tags []string) []string {
	var out []string
	for _, t := range tags {
		t = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(t), "#＃"))
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

func (s *Server) postAssemble(w http.ResponseWriter, r *http.Request) (any, error) {
	var req postAssembleRequest
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if len(req.Images) == 0 && req.Copy == nil {
		return nil, bad("还没有可组成笔记的图片或文案")
	}
	view, conflict, err := s.assemblePost(req)
	if err != nil {
		return nil, err
	}
	return map[string]any{"post": view, "textConflict": conflict}, nil
}

// postText renders the copy block users paste into the publishing app.
func postText(p postData) string {
	var tagLine []string
	for _, t := range p.Tags {
		tagLine = append(tagLine, "#"+t)
	}
	parts := []string{}
	if strings.TrimSpace(p.Title) != "" {
		parts = append(parts, strings.TrimSpace(p.Title))
	}
	if strings.TrimSpace(p.Body) != "" {
		parts = append(parts, strings.TrimSpace(p.Body))
	}
	if len(tagLine) > 0 {
		parts = append(parts, strings.Join(tagLine, " "))
	}
	return strings.Join(parts, "\n\n")
}

// postExport writes an ordered folder (cover first): 01.jpg … + 笔记文案.txt.
func (s *Server) postExport(w http.ResponseWriter, r *http.Request) (any, error) {
	doc, p, err := s.loadPost(r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	var body struct {
		Reveal bool   `json:"reveal"`
		Dest   string `json:"dest"`
	}
	_ = decode(r, &body)
	imgs := s.resolvePostImages(p)
	if len(imgs) == 0 {
		return nil, bad("这篇笔记还没有可导出的图片")
	}
	// Cover goes first, the rest keep their order.
	cover := 0
	if p.CoverIndex < len(p.Images) {
		for j, im := range imgs {
			if im.ImageID == p.Images[p.CoverIndex].ImageID {
				cover = j
			}
		}
	}
	ordered := append([]postImageView{imgs[cover]}, append(append([]postImageView{}, imgs[:cover]...), imgs[cover+1:]...)...)

	base := filepath.Join(settings.Get().WorksDir, "exports")
	if body.Dest != "" {
		base = body.Dest
	}
	name := sanitizeName(strings.Join(strings.Fields(firstNRunes(firstStr(p.Title, "笔记"), 24)), " "))
	if name == "" {
		name = "笔记"
	}
	outDir := filepath.Join(base, name+"_"+strings.TrimPrefix(doc.ID, "post_"))
	_ = os.RemoveAll(outDir)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}
	written := 0
	for _, im := range ordered {
		raw, err := os.ReadFile(im.Path)
		if err != nil {
			continue
		}
		written++
		if p.Platform == "xiaohongshu" {
			if out, err := fitRatio34JPEG(raw); err == nil {
				if err := os.WriteFile(filepath.Join(outDir, fmt.Sprintf("%02d.jpg", written)), out, 0o644); err != nil {
					return nil, err
				}
				continue
			}
		}
		ext := strings.ToLower(filepath.Ext(im.Path))
		if ext == "" {
			ext = ".png"
		}
		if err := os.WriteFile(filepath.Join(outDir, fmt.Sprintf("%02d%s", written, ext)), raw, 0o644); err != nil {
			return nil, err
		}
	}
	if written == 0 {
		return nil, bad("图片文件读取失败，可能已被移动或删除")
	}
	text := postText(p)
	if err := os.WriteFile(filepath.Join(outDir, "笔记文案.txt"), []byte(text), 0o644); err != nil {
		return nil, err
	}
	p.Status = "exported"
	p.ExportedAt = store.Now()
	_ = s.savePost(&doc, p)
	if body.Reveal && s.Host != nil {
		_ = s.Host.OpenPath(outDir)
	}
	return map[string]any{"ok": true, "dir": outDir, "count": written, "text": text}, nil
}

func newShortID() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
}
