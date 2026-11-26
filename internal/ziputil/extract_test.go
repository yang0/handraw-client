package ziputil

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildTestZip(t *testing.T, entries []struct {
	name string
	mode os.FileMode
	data []byte
}) []*zip.File {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			hdr.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write(e.data)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return zr.File
}

func TestExtractFilesSecurityAndLimits(t *testing.T) {
	// 1. Normal extract with prefix strip, __MACOSX skip, symlink skip, and TransformRel.
	files := buildTestZip(t, []struct {
		name string
		mode os.FileMode
		data []byte
	}{
		{name: "pkg/skill.md", data: []byte("# hello")},
		{name: "pkg/sub/a.txt", data: []byte("abc")},
		{name: "__MACOSX/pkg/._skill.md", data: []byte("junk")},
		{name: "pkg/link", mode: os.ModeSymlink | 0o777, data: []byte("../../etc/passwd")},
	})
	dst := t.TempDir()
	res, err := ExtractFiles(files, dst, Options{
		Prefix:        "pkg/",
		MaxFileBytes:  1024,
		MaxTotalBytes: 4096,
		SkipMacOSX:    true,
		TransformRel: func(rel string) string {
			if strings.EqualFold(rel, "skill.md") {
				return "SKILL.md"
			}
			return rel
		},
	})
	if err != nil {
		t.Fatalf("ExtractFiles failed: %v", err)
	}
	if res.Files != 2 {
		t.Fatalf("expected 2 extracted files, got %d", res.Files)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "SKILL.md")); err != nil || string(b) != "# hello" {
		t.Fatalf("SKILL.md mismatch: err=%v val=%q", err, string(b))
	}
	if _, err := os.Lstat(filepath.Join(dst, "link")); !os.IsNotExist(err) {
		t.Fatalf("symlink entry must be skipped")
	}

	// 2. RejectUnsafePath blocks ../ and backslash traversal.
	evil := buildTestZip(t, []struct {
		name string
		mode os.FileMode
		data []byte
	}{{name: `..\outside.txt`, data: []byte("bad")}})
	if _, err := ExtractFiles(evil, t.TempDir(), Options{RejectUnsafePath: true, MaxFileBytes: 1024, MaxTotalBytes: 4096}); err == nil {
		t.Fatalf("expected backslash traversal to fail")
	}

	// 3. Enforce actual written total byte limit.
	big := buildTestZip(t, []struct {
		name string
		mode os.FileMode
		data []byte
	}{
		{name: "a.bin", data: bytes.Repeat([]byte("A"), 600)},
		{name: "b.bin", data: bytes.Repeat([]byte("B"), 600)},
	})
	if _, err := ExtractFiles(big, t.TempDir(), Options{MaxFileBytes: 1000, MaxTotalBytes: 1000}); err == nil {
		t.Fatalf("expected total byte limit violation to fail")
	}
}
