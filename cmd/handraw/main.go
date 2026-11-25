package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/yang0/handraw-client/internal/appdir"
	"github.com/yang0/handraw-client/internal/desktop"
	"github.com/yang0/handraw-client/internal/jobs"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/server"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"github.com/yang0/handraw-client/internal/updater"
	"github.com/yang0/handraw-client/web"
)

// Version is overridden at release build time via -ldflags "-X main.Version=v...".
var Version = "0.4.0-dev"

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "version" {
		fmt.Println("handraw", Version)
		return
	}

	updater.CleanupOld()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	srv, closeBackend, err := bootBackend(ctx)
	if err != nil {
		log.Fatalf("手绘风初始化失败：%v", err)
	}
	defer closeBackend()

	mode := "gui"
	deepLink := ""
	rest := args
	if len(args) > 0 {
		switch {
		case args[0] == "web":
			mode = "web"
			rest = args[1:]
		case args[0] == "gui":
			mode = "gui"
			rest = args[1:]
		case strings.HasPrefix(strings.ToLower(args[0]), "handraw://"):
			deepLink = args[0]
			rest = args[1:]
		}
	}

	if mode == "web" {
		fs := flag.NewFlagSet("web", flag.ExitOnError)
		port := fs.Int("port", server.DefaultPort, "监听端口")
		noOpen := fs.Bool("no-open", false, "不自动打开浏览器")
		_ = fs.Parse(rest)

		srv.Host = desktop.WebHost()
		addr, err := srv.Listen(ctx, *port)
		if err != nil {
			log.Fatalf("启动服务失败：%v", err)
		}
		fmt.Printf("手绘风工作台 Web 模式已就绪：%s\n按 Ctrl+C 停止。\n", addr)
		if !*noOpen {
			_ = desktop.OpenBrowser(addr + "/")
		}
		<-ctx.Done()
		return
	}

	addr, err := srv.Listen(ctx, server.DefaultPort)
	if err != nil {
		log.Fatalf("启动本地服务失败：%v", err)
	}
	if err := desktop.Run(Version, srv, addr, true, deepLink); err != nil {
		log.Fatalf("桌面界面异常：%v", err)
	}
}

func bootBackend(ctx context.Context) (*server.Server, func(), error) {
	db, err := store.Open(appdir.DBPath())
	if err != nil {
		return nil, nil, err
	}

	userPackDir := appdir.Resources()
	bundledDir := findBundledPack(userPackDir)
	if bundledDir != "" {
		_ = updater.InstallBundled(bundledDir, userPackDir)
	}
	locateCandidates := []string{
		os.Getenv("HANDRAW_PACK_DIR"),
		userPackDir,
		bundledDir,
	}
	locateCandidates = append(locateCandidates, findDevSkillCheckouts()...)
	if packDir, err := resources.Locate(locateCandidates...); err == nil {
		if pack, lErr := resources.Load(packDir); lErr == nil {
			resources.SetCurrent(pack)
		} else {
			log.Printf("加载本地资源包 %s 失败：%v", packDir, lErr)
		}
	}

	sc := site.New(Version)
	upd := updater.New(Version, appdir.Updates())
	srv := newServer(db, sc, upd, userPackDir, bundledDir)

	var jm *jobs.Manager
	jm = jobs.New(db, sc, func(ev jobs.Event) {
		srv.Emit("job", ev)
		if ev.Type == "run" {
			srv.Emit("run", ev)
		}
	})
	jm.PluginProviders = srv.CommunityProviders
	srv.Jobs = jm
	jm.Start(ctx, 6)

	upd.OnChange = func(st updater.Status) {
		srv.Emit("update", st)
	}
	go upd.Loop(ctx, 6*time.Hour, func() bool {
		return settings.Get().AutoCheckUpdate
	})

	return srv, func() {
		if srv.DSH != nil {
			srv.DSH.Stop()
		}
		_ = db.Close()
	}, nil
}

func newServer(db *store.DB, sc *site.Client, upd *updater.Updater, packDir, bundledDir string) *server.Server {
	srv := server.New(Version)
	srv.DB = db
	srv.Site = sc
	srv.Updater = upd
	srv.Web = web.FS
	srv.PackDir = packDir
	srv.Bundled = bundledDir
	srv.RegisterBuiltins()
	return srv
}

func findBundledPack(userPackDir string) string {
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "resources"),
			filepath.Join(exeDir, "..", "Resources", "resources"),
		)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "resources"),
			filepath.Join(cwd, "..", "handraw-style", "dist", "client-resources"),
		)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".handraw-style", "client-resources"))
	}
	// When Windows data dir moved off C: (#125), seed from any previously downloaded
	// %APPDATA%\handraw-client\resources pack so styles/layouts/colors/tones appear immediately.
	if appdata := strings.TrimSpace(os.Getenv("APPDATA")); appdata != "" {
		legacyRes := filepath.Join(appdata, appdir.AppName, "resources")
		if !strings.EqualFold(filepath.Clean(legacyRes), filepath.Clean(userPackDir)) {
			candidates = append(candidates, legacyRes)
		}
	}
	for _, c := range candidates {
		if st, err := os.Stat(filepath.Join(c, "references", "styles.json")); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

func findDevSkillCheckouts() []string {
	var out []string
	if cwd, err := os.Getwd(); err == nil {
		out = append(out, filepath.Join(cwd, "..", "handraw-style"))
	}
	if exe, err := os.Executable(); err == nil {
		out = append(out, filepath.Join(filepath.Dir(exe), "..", "handraw-style"))
	}
	return out
}
