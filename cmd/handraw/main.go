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
	"github.com/yang0/handraw-client/internal/netutil"
	"github.com/yang0/handraw-client/internal/resources"
	"github.com/yang0/handraw-client/internal/secrets"
	"github.com/yang0/handraw-client/internal/server"
	"github.com/yang0/handraw-client/internal/settings"
	"github.com/yang0/handraw-client/internal/site"
	"github.com/yang0/handraw-client/internal/store"
	"github.com/yang0/handraw-client/internal/telemetry"
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

	netutil.InstallDefaultTransport()
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
	autoStart := false
	rest := []string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == desktop.AutoStartArg {
			autoStart = true
			continue
		}
		if len(rest) == 0 && mode == "gui" && deepLink == "" {
			switch {
			case arg == "web":
				mode = "web"
				continue
			case arg == "gui":
				mode = "gui"
				continue
			case strings.HasPrefix(strings.ToLower(arg), "handraw://"):
				deepLink = arg
				continue
			}
		}
		rest = append(rest, arg)
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

	st := settings.Get()
	if st.HasPrivacyConsent() {
		go func(enabled bool) {
			if err := desktop.SetAutoStart(enabled); err != nil {
				log.Printf("同步开机自启设置失败：%v", err)
			}
		}(st.LaunchAtLogin)
	}

	addr, err := srv.Listen(ctx, server.DefaultPort)
	if err != nil {
		log.Fatalf("启动本地服务失败：%v", err)
	}
	go func() {
		_, _ = srv.EnsureClipperExtension()
	}()
	showMain := !autoStart || !st.MinimizeToTray
	if err := desktop.Run(Version, srv, addr, showMain, deepLink); err != nil {
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
	if resources.HasBuiltinMarker(userPackDir) {
		if err := resources.EnsureBuiltin(userPackDir); err != nil {
			log.Printf("升级内置参考资源包失败：%v", err)
		}
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
	if resources.Current() == nil {
		if err := resources.EnsureBuiltin(userPackDir); err != nil {
			log.Printf("释放内置参考资源包失败：%v", err)
		} else if pack, lErr := resources.Load(userPackDir); lErr == nil {
			resources.SetCurrent(pack)
		} else {
			log.Printf("加载内置参考资源包失败：%v", lErr)
		}
	}

	sc := site.New(Version)
	upd := updater.New(Version, appdir.Updates())
	tel := telemetry.New(Version)
	tel.Enabled = func() bool {
		st := settings.Get()
		return st.HasPrivacyConsent() && !st.TelemetryDisabled
	}
	tel.SiteBase = func() string { return settings.Get().SiteBase }
	tel.AnonID = settings.EnsureTelemetryID
	tel.Token = func() string {
		tok, _ := secrets.Get(secrets.SiteToken)
		return tok
	}
	srv := newServer(db, sc, upd, userPackDir, bundledDir)
	srv.Telemetry = tel

	var jm *jobs.Manager
	jm = jobs.New(db, sc, func(ev jobs.Event) {
		srv.Emit("job", ev)
		if ev.Type == "run" {
			srv.Emit("run", ev)
			if ev.Status == "done" || ev.Status == "partial" || ev.Status == "failed" {
				go func(runID, st string) {
					run, err := db.GetRun(runID)
					if err != nil {
						return
					}
					mode := "byok"
					if strings.HasPrefix(strings.ToLower(strings.TrimSpace(run.Model)), "site:") || strings.EqualFold(strings.TrimSpace(run.Source), "site") {
						mode = "site"
					}
					imgs, _ := db.Images(runID)
					cnt := len(imgs)
					if cnt <= 0 {
						cnt = 1
					}
					tel.Track("client_generate_done", map[string]any{
						"providerMode": mode,
						"ok":           st == "done" || st == "partial",
						"count":        cnt,
					})
				}(ev.RunID, ev.Status)
			}
		}
	})
	jm.PluginProviders = srv.CommunityProviders
	srv.Jobs = jm
	jm.Start(ctx, jobs.DefaultWorkers)

	upd.OnChange = func(st updater.Status) {
		srv.Emit("update", st)
	}
	upd.Mode = func() string {
		st := settings.Get()
		if !st.HasPrivacyConsent() {
			return updater.AutoModeOff
		}
		return st.EffectiveAutoUpdateMode()
	}
	upd.IsBusy = func() bool {
		return jm.Active() > 0
	}
	upd.BucketKey = settings.EnsureTelemetryID
	upd.LoadStaged()
	go upd.AutoLoop(ctx, updater.DefaultCheckCooldown)
	crashPath := filepath.Join(appdir.Root(), "crash-last.log")
	tel.ReportPreviousCrash(crashPath)
	_ = telemetry.SetupCrashOutput(crashPath)
	go tel.Start(ctx)

	return srv, func() {
		if applied, aErr := upd.ApplyIfReady(); aErr != nil {
			log.Printf("退出自动应用更新失败：%v", aErr)
			tel.ReportError(telemetry.ErrorReport{
				Category: "updater_apply",
				Source:   "backend",
				Message:  aErr.Error(),
			})
		} else if applied {
			log.Printf("已在退出时自动应用新版本，下次启动将生效")
		}
		fctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		tel.Flush(fctx)
		cancel()
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
