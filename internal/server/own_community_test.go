package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/store"
)

// #170: a personal style/layout that was synced and published to the community
// shows up once in pickers (as the local copy, with prompts), while other
// people's community resources stay prompt-hidden.
func TestOwnPublishedResourcesAreNotDuplicated(t *testing.T) {
	fakeSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/v1/community/resources" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "items": []map[string]any{
			// Own style, linked by the website's owner-only personalResourceId.
			{"id": "USR-S100", "code": "USR-S100", "kind": "style", "sourceType": "community", "name": "暖纸手绘",
				"author": "me", "isMine": true, "unlocked": true, "unlockCost": 5, "personalResourceId": "rid-style"},
			// Own layout, published on the website before the client knew: matched by name.
			{"id": "USR-L100", "code": "USR-L100", "kind": "layout", "sourceType": "community", "name": "双栏对照卡",
				"author": "me", "isMine": true, "unlocked": true, "unlockCost": 5},
			// Own style published through the client: matched by stored publish state.
			{"id": "USR-S200", "code": "USR-S200", "kind": "style", "sourceType": "community", "name": "改了名的社区版",
				"author": "me", "isMine": true, "unlocked": true, "unlockCost": 5},
			// Someone else's style with the same name must stay separate and hidden.
			{"id": "CS-001", "code": "CS-001", "kind": "style", "sourceType": "community", "name": "暖纸手绘",
				"author": "alice", "isMine": false, "unlockCost": 12},
		}})
	}))
	defer fakeSite.Close()

	srv, cancel := setupTestServer(t, fakeSite.URL)
	defer cancel()
	h := srv.Handler()
	_ = secrets.Set(secrets.SiteToken, "tok_test_own")
	t.Cleanup(func() { _ = secrets.Delete(secrets.SiteToken) })

	put := func(kind, id, remote, name string, v any) {
		data, _ := json.Marshal(v)
		if err := srv.DB.PutDoc(&store.Doc{Kind: kind, ID: id, Name: name, Data: data, RemoteID: remote, RemoteRev: 1}); err != nil {
			t.Fatal(err)
		}
	}
	put("style", "mine:rid-style", "rid-style", "暖纸手绘", resources.Style{Number: "MY-S-001", GroupCode: "MY",
		NameZh: "暖纸手绘", GenerationName: "暖纸手绘", Traits: "纸质肌理与细线描", Source: "mine"})
	put("style", "mine:rid-two", "rid-two", "原名画风", resources.Style{Number: "MY-S-002", GroupCode: "MY",
		NameZh: "原名画风", GenerationName: "原名画风", Traits: "蜡笔叠色", Source: "mine"})
	put(publishStateKind, "mine:rid-two", "", "原名画风", map[string]any{"code": "USR-S200", "status": "approved"})
	put("layout", "mine:rid-layout", "rid-layout", "双栏对照卡", resources.Layout{ID: "MY-L-001", Category: "mine",
		Name: "双栏对照卡", PromptZh: "左右双栏对称", Source: "mine"})

	var styles struct {
		Items []resources.Style `json:"items"`
	}
	rr := doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles", nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &styles); err != nil {
		t.Fatalf("styles: %v %s", err, rr.Body.String())
	}
	count := map[string]int{}
	for _, st := range styles.Items {
		count[strings.ToUpper(st.Number)]++
	}
	for _, dup := range []string{"USR-S100", "USR-S200"} {
		if count[dup] != 0 {
			t.Fatalf("own community style %s must be merged into the local copy, got %v", dup, count)
		}
	}
	if count["MY-S-001"] != 1 || count["MY-S-002"] != 1 || count["CS-001"] != 1 {
		t.Fatalf("expected each local style once and other user's style kept: %v", count)
	}
	for _, st := range styles.Items {
		if st.Number == "CS-001" && (st.Traits != "" || !st.PromptHidden) {
			t.Fatalf("other user's community style must stay hidden: %+v", st)
		}
	}

	var layouts struct {
		Items []resources.Layout `json:"items"`
	}
	rr = doReq(t, h, srv.Token, http.MethodGet, "/api/resources/layouts", nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &layouts); err != nil {
		t.Fatalf("layouts: %v %s", err, rr.Body.String())
	}
	lc := map[string]int{}
	for _, l := range layouts.Items {
		lc[strings.ToUpper(l.ID)]++
	}
	if lc["USR-L100"] != 0 || lc["MY-L-001"] != 1 {
		t.Fatalf("own community layout must be listed once as local copy: %v", lc)
	}

	// Opening an own community code shows the owner's prompts.
	var detail struct {
		Style    resources.Style `json:"style"`
		Decision map[string]any  `json:"decision"`
	}
	rr = doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles/USR-S100", nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &detail); err != nil || detail.Style.Number != "MY-S-001" || detail.Style.Traits == "" {
		t.Fatalf("own community style detail must resolve to local copy with prompt: %v %s", err, rr.Body.String())
	}
	if hidden, _ := detail.Decision["promptHidden"].(bool); hidden {
		t.Fatalf("own style prompt must not be hidden: %s", rr.Body.String())
	}
	rr = doReq(t, h, srv.Token, http.MethodGet, "/api/resources/styles/CS-001", nil)
	if err := json.Unmarshal(rr.Body.Bytes(), &detail); err != nil || detail.Style.Traits != "" {
		t.Fatalf("other user's style must stay hidden: %s", rr.Body.String())
	}
	if hidden, _ := detail.Decision["promptHidden"].(bool); !hidden {
		t.Fatalf("other user's style must report promptHidden: %s", rr.Body.String())
	}

	// Own community codes are not treated as protected when building prompts.
	if got := srv.resolveOwnCode(t.Context(), "layout", "usr-l100"); got != "MY-L-001" {
		t.Fatalf("resolveOwnCode layout = %q", got)
	}
	if got := srv.resolveOwnCode(t.Context(), "style", "CS-001"); got != "CS-001" {
		t.Fatalf("other user's code must not be rewritten, got %q", got)
	}
}
