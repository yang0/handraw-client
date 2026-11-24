package server

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/store"
)

var worksDirMigrateMu sync.Mutex

type worksDirStats struct {
	FileCount  int   `json:"fileCount"`
	DirCount   int   `json:"dirCount"`
	TotalBytes int64 `json:"totalBytes"`
	HasContent bool  `json:"hasContent"`
}

func inspectWorksDirHandler(s *Server) http.HandlerFunc {
	return s.h(s.inspectWorksDir)
}

func (s *Server) inspectWorksDir(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		TargetDir string `json:"targetDir"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	st := settings.Get()
	curAbs, err := resolveDirPath(st.WorksDir)
	if err != nil {
		return nil, bad("当前作品目录无效：" + err.Error())
	}
	targetRaw := strings.TrimSpace(body.TargetDir)
	if targetRaw == "" {
		return nil, bad("请选择或输入目标存储目录")
	}
	targetAbs, err := resolveDirPath(targetRaw)
	if err != nil {
		return nil, bad("目标目录无效：" + err.Error())
	}

	same := sameCleanPath(curAbs, targetAbs)
	nested := false
	nestedReason := ""
	if !same {
		if isStrictSubDir(targetAbs, curAbs) {
			nested = true
			nestedReason = "目标目录位于原目录内部，迁移会导致嵌套循环，请选择独立的文件夹。"
		} else if isStrictSubDir(curAbs, targetAbs) {
			nested = true
			nestedReason = "原目录位于目标目录内部，迁移可能导致文件冲突，请选择独立的文件夹。"
		}
	}

	curStats := scanDirUsage(curAbs)
	targetStats := scanDirUsage(targetAbs)
	activeJobs := 0
	if s.Jobs != nil {
		activeJobs = s.Jobs.Active()
	}

	return map[string]any{
		"ok":               true,
		"currentDir":       curAbs,
		"targetDir":        targetAbs,
		"sameDir":          same,
		"nested":           nested,
		"nestedReason":     nestedReason,
		"activeJobs":       activeJobs,
		"hasContent":       curStats.HasContent,
		"fileCount":        curStats.FileCount,
		"dirCount":         curStats.DirCount,
		"totalBytes":       curStats.TotalBytes,
		"targetHasContent": targetStats.HasContent,
		"targetFileCount":  targetStats.FileCount,
	}, nil
}

func (s *Server) switchWorksDir(w http.ResponseWriter, r *http.Request) (any, error) {
	var body struct {
		TargetDir string `json:"targetDir"`
		Migrate   bool   `json:"migrate"`
	}
	if err := decode(r, &body); err != nil {
		return nil, err
	}
	targetRaw := strings.TrimSpace(body.TargetDir)
	if targetRaw == "" {
		return nil, bad("请选择或输入目标存储目录")
	}

	worksDirMigrateMu.Lock()
	defer worksDirMigrateMu.Unlock()

	cur := settings.Get()
	oldAbs, err := resolveDirPath(cur.WorksDir)
	if err != nil {
		return nil, bad("当前作品目录无效：" + err.Error())
	}
	newAbs, err := resolveDirPath(targetRaw)
	if err != nil {
		return nil, bad("目标目录无效：" + err.Error())
	}
	if sameCleanPath(oldAbs, newAbs) {
		return map[string]any{
			"ok":       true,
			"changed":  false,
			"migrated": false,
			"settings": cur,
		}, nil
	}

	if body.Migrate {
		if s.Jobs != nil && s.Jobs.Active() > 0 {
			return nil, bad("当前有正在进行的生图任务，请等待任务完成后再迁移目录")
		}
		if isStrictSubDir(newAbs, oldAbs) || isStrictSubDir(oldAbs, newAbs) {
			return nil, bad("目标目录不能与原目录存在父子包含关系，请选择独立的文件夹")
		}
	}

	// Ensure target directory exists and is writable before touching anything.
	if err := ensureDirWritable(newAbs); err != nil {
		return nil, bad("目标目录不可写：" + err.Error())
	}

	oldStats := scanDirUsage(oldAbs)
	var migRes migrateResult
	var dbStats store.PathRewriteStats

	if body.Migrate && oldStats.HasContent {
		migRes, err = migrateDirContents(oldAbs, newAbs)
		if err != nil {
			return nil, bad("迁移原目录内容失败：" + err.Error())
		}
		if s.DB != nil {
			dbStats, err = s.DB.RewritePathPrefix(oldAbs, newAbs)
			if err != nil {
				return nil, bad("文件已迁移，但更新作品索引失败：" + err.Error())
			}
		}
	}

	updated, err := settings.Update(func(st *settings.Settings) error {
		st.WorksDir = newAbs
		if body.Migrate {
			if nextVault, changed := store.RewritePath(st.ArticleVaultDir, oldAbs, newAbs); changed {
				st.ArticleVaultDir = nextVault
			}
			for i, v := range st.ArticleVaultDirs {
				if nextV, changed := store.RewritePath(v, oldAbs, newAbs); changed {
					st.ArticleVaultDirs[i] = nextV
				}
			}
			// Keep oldAbs in LegacyWorksDirs only if some files were skipped due to conflicts.
			if migRes.SkippedFiles > 0 {
				st.LegacyWorksDirs = appendUniqueDir(st.LegacyWorksDirs, oldAbs)
			} else {
				st.LegacyWorksDirs = removeDirFromList(st.LegacyWorksDirs, oldAbs)
			}
		} else if oldStats.HasContent {
			// Preserve read access to old works directory so existing works stay visible without 403.
			st.LegacyWorksDirs = appendUniqueDir(st.LegacyWorksDirs, oldAbs)
		}
		// Never duplicate the active worksDir in LegacyWorksDirs.
		st.LegacyWorksDirs = removeDirFromList(st.LegacyWorksDirs, newAbs)
		return nil
	})
	if err != nil {
		return nil, err
	}

	s.Emit("settings", map[string]any{"worksDir": updated.WorksDir})
	s.Emit("works", map[string]any{"worksDirChanged": true})

	return map[string]any{
		"ok":           true,
		"changed":      true,
		"migrated":     body.Migrate && oldStats.HasContent,
		"movedFiles":   migRes.MovedFiles,
		"skippedFiles": migRes.SkippedFiles,
		"movedBytes":   migRes.MovedBytes,
		"dbUpdated":    dbStats,
		"settings":     updated,
	}, nil
}

func resolveDirPath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("目录路径不能为空")
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			p = filepath.Join(home, strings.TrimLeft(p[1:], `/\`))
		}
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func sameCleanPath(a, b string) bool {
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

func isStrictSubDir(child, parent string) bool {
	if sameCleanPath(child, parent) {
		return false
	}
	c, p := filepath.Clean(child), filepath.Clean(parent)
	if runtime.GOOS == "windows" {
		c = strings.ToLower(c)
		p = strings.ToLower(p)
	}
	rel, err := filepath.Rel(p, c)
	if err != nil {
		return false
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

func isIgnoredMetaFile(name string) bool {
	switch strings.ToLower(name) {
	case ".ds_store", "thumbs.db", "desktop.ini":
		return true
	}
	return false
}

func scanDirUsage(root string) worksDirStats {
	var out worksDirStats
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return out
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if sameCleanPath(p, root) {
			return nil
		}
		if d.IsDir() {
			out.DirCount++
			return nil
		}
		if isIgnoredMetaFile(d.Name()) {
			return nil
		}
		out.FileCount++
		if fi, err := d.Info(); err == nil {
			out.TotalBytes += fi.Size()
		}
		return nil
	})
	out.HasContent = out.FileCount > 0 || out.DirCount > 0
	return out
}

func ensureDirWritable(dir string) error {
	if fi, err := os.Stat(dir); err == nil && !fi.IsDir() {
		return fmt.Errorf("路径已存在且不是文件夹：%s", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".handraw-write-check-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return nil
}

type migrateResult struct {
	MovedFiles   int
	SkippedFiles int
	MovedBytes   int64
}

func migrateDirContents(srcRoot, dstRoot string) (migrateResult, error) {
	var res migrateResult
	entries, err := os.ReadDir(srcRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, err
	}
	if err := os.MkdirAll(dstRoot, 0o755); err != nil {
		return res, err
	}
	for _, entry := range entries {
		src := filepath.Join(srcRoot, entry.Name())
		dst := filepath.Join(dstRoot, entry.Name())
		if err := moveEntry(src, dst, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

func moveEntry(src, dst string, res *migrateResult) error {
	srcInfo, err := os.Lstat(src)
	if err != nil {
		return err
	}

	_, dstErr := os.Lstat(dst)
	dstExists := dstErr == nil

	// Fast path: destination doesn't exist yet -> attempt instant os.Rename.
	if !dstExists {
		var preStats worksDirStats
		if srcInfo.IsDir() {
			preStats = scanDirUsage(src)
		}
		if err := os.Rename(src, dst); err == nil {
			if srcInfo.IsDir() {
				res.MovedFiles += preStats.FileCount
				res.MovedBytes += preStats.TotalBytes
			} else if !isIgnoredMetaFile(srcInfo.Name()) {
				res.MovedFiles++
				res.MovedBytes += srcInfo.Size()
			}
			return nil
		}
		// Fall through to recursive copy+remove on cross-volume move (EXDEV) or lock.
	}

	if srcInfo.IsDir() {
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		children, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, ch := range children {
			if err := moveEntry(filepath.Join(src, ch.Name()), filepath.Join(dst, ch.Name()), res); err != nil {
				return err
			}
		}
		// Remove source dir if it is now empty.
		_ = os.Remove(src)
		return nil
	}

	if srcInfo.Mode()&os.ModeSymlink != 0 {
		if dstExists {
			res.SkippedFiles++
			return nil
		}
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		if err := os.Symlink(target, dst); err != nil {
			return err
		}
		_ = os.Remove(src)
		res.MovedFiles++
		return nil
	}

	// Regular file
	if dstExists {
		if !isIgnoredMetaFile(srcInfo.Name()) {
			res.SkippedFiles++
		}
		return nil
	}
	n, err := copyFileAtomic(src, dst, srcInfo.Mode().Perm())
	if err != nil {
		return err
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("已复制到目标目录，但清理源文件失败（%s）：%w", src, err)
	}
	if !isIgnoredMetaFile(srcInfo.Name()) {
		res.MovedFiles++
		res.MovedBytes += n
	}
	return nil
}

func copyFileAtomic(src, dst string, perm fs.FileMode) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()

	if perm == 0 {
		perm = 0o644
	}
	tmpFile, err := os.CreateTemp(filepath.Dir(dst), ".handraw-migrate-*")
	if err != nil {
		return 0, err
	}
	tmpPath := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	n, err := io.Copy(tmpFile, in)
	if err != nil {
		_ = tmpFile.Close()
		return 0, err
	}
	if err := tmpFile.Close(); err != nil {
		return 0, err
	}
	_ = os.Chmod(tmpPath, perm)
	if err := os.Rename(tmpPath, dst); err != nil {
		return 0, err
	}
	cleanup = false
	return n, nil
}

func appendUniqueDir(list []string, dir string) []string {
	for _, item := range list {
		if sameCleanPath(item, dir) {
			return list
		}
	}
	return append(list, dir)
}

func removeDirFromList(list []string, dir string) []string {
	out := make([]string, 0, len(list))
	for _, item := range list {
		if sameCleanPath(item, dir) {
			continue
		}
		out = append(out, item)
	}
	return out
}
