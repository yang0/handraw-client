package skills

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// DiscoveredSkill is one SKILL.md directory found inside a local AI harness client.
type DiscoveredSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version,omitempty"`
	Dir         string `json:"dir"`
	ClientID    string `json:"clientId"`
	ClientName  string `json:"clientName"`
	Installed   bool   `json:"installed"`
	InstalledID string `json:"installedId,omitempty"`
}

// DiscoveredClient represents one detected local AI harness client and its skills.
type DiscoveredClient struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Detected   bool              `json:"detected"`
	SkillsDirs []string          `json:"skillsDirs"`
	SkillCount int               `json:"skillCount"`
	Skills     []DiscoveredSkill `json:"skills"`
}

// DiscoveryResult is returned by GET /api/skills/discover.
type DiscoveryResult struct {
	Clients      []DiscoveredClient `json:"clients"`
	TotalClients int                `json:"totalClients"`
	TotalSkills  int                `json:"totalSkills"`
}

type harnessSpec struct {
	ID         string
	Name       string
	ProbeDirs  []string // client root dirs indicating installation
	SkillsDirs []string // direct skills directories
	PluginGlob []string // optional glob patterns pointing to nested plugin skills dirs
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func defaultHarnessSpecs(home string) []harnessSpec {
	xdg := envOr("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	claudeRoot := envOr("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	codexRoot := envOr("CODEX_HOME", filepath.Join(home, ".codex"))
	dshRoot := envOr("DSH_HOME", filepath.Join(home, ".dsh"))
	workbuddyRoot := envOr("WORKBUDDY_CONFIG_DIR", filepath.Join(home, ".workbuddy"))
	codebuddyRoot := envOr("CODEBUDDY_CONFIG_DIR", filepath.Join(home, ".codebuddy"))
	copilotRoot := envOr("COPILOT_HOME", filepath.Join(home, ".copilot"))
	grokRoot := envOr("GROK_HOME", filepath.Join(home, ".grok"))
	hermesRoot := envOr("HERMES_HOME", filepath.Join(home, ".hermes"))
	piRoot := envOr("PI_CODING_AGENT_DIR", filepath.Join(home, ".pi", "agent"))
	kimiRoot := envOr("KIMI_CODE_HOME", filepath.Join(home, ".kimi-code"))

	return []harnessSpec{
		{
			ID:        "antigravity",
			Name:      "Antigravity",
			ProbeDirs: []string{filepath.Join(home, ".gemini", "config"), filepath.Join(home, ".gemini", "antigravity")},
			SkillsDirs: []string{
				filepath.Join(home, ".gemini", "config", "skills"),
				filepath.Join(home, ".gemini", "antigravity", "skills"),
			},
			PluginGlob: []string{
				filepath.Join(home, ".gemini", "config", "plugins", "*", "skills"),
			},
		},
		{
			ID:         "claude",
			Name:       "Claude Code",
			ProbeDirs:  []string{claudeRoot},
			SkillsDirs: []string{filepath.Join(claudeRoot, "skills")},
			PluginGlob: []string{
				filepath.Join(claudeRoot, "plugins", "cache", "*", "*", "*", "skills"),
			},
		},
		{
			ID:         "codex",
			Name:       "Codex",
			ProbeDirs:  []string{codexRoot},
			SkillsDirs: []string{filepath.Join(codexRoot, "skills")},
			PluginGlob: []string{
				filepath.Join(codexRoot, "plugins", "cache", "*", "*", "*", "skills"),
			},
		},
		{
			ID:         "dsh",
			Name:       "DeepSeek Harness (DSH)",
			ProbeDirs:  []string{dshRoot},
			SkillsDirs: []string{filepath.Join(dshRoot, "skills")},
		},
		{
			ID:         "cursor",
			Name:       "Cursor",
			ProbeDirs:  []string{filepath.Join(home, ".cursor")},
			SkillsDirs: []string{filepath.Join(home, ".cursor", "skills")},
		},
		{
			ID:         "gemini",
			Name:       "Gemini CLI",
			ProbeDirs:  []string{filepath.Join(home, ".gemini")},
			SkillsDirs: []string{filepath.Join(home, ".gemini", "skills")},
		},
		{
			ID:         "opencode",
			Name:       "OpenCode",
			ProbeDirs:  []string{filepath.Join(xdg, "opencode")},
			SkillsDirs: []string{filepath.Join(xdg, "opencode", "skills")},
		},
		{
			ID:         "qwen",
			Name:       "Qwen Code",
			ProbeDirs:  []string{filepath.Join(home, ".qwen")},
			SkillsDirs: []string{filepath.Join(home, ".qwen", "skills")},
		},
		{
			ID:         "workbuddy",
			Name:       "WorkBuddy",
			ProbeDirs:  []string{workbuddyRoot},
			SkillsDirs: []string{filepath.Join(workbuddyRoot, "skills")},
		},
		{
			ID:         "codebuddy",
			Name:       "CodeBuddy",
			ProbeDirs:  []string{codebuddyRoot},
			SkillsDirs: []string{filepath.Join(codebuddyRoot, "skills")},
		},
		{
			ID:         "cline",
			Name:       "Cline",
			ProbeDirs:  []string{filepath.Join(home, ".cline")},
			SkillsDirs: []string{filepath.Join(home, ".cline", "skills")},
		},
		{
			ID:         "copilot",
			Name:       "GitHub Copilot",
			ProbeDirs:  []string{copilotRoot},
			SkillsDirs: []string{filepath.Join(copilotRoot, "skills")},
		},
		{
			ID:         "grok",
			Name:       "Grok Build",
			ProbeDirs:  []string{grokRoot},
			SkillsDirs: []string{filepath.Join(grokRoot, "skills")},
		},
		{
			ID:         "hermes",
			Name:       "Hermes Agent",
			ProbeDirs:  []string{hermesRoot},
			SkillsDirs: []string{filepath.Join(hermesRoot, "skills")},
		},
		{
			ID:         "pi",
			Name:       "Pi Coding Agent",
			ProbeDirs:  []string{piRoot},
			SkillsDirs: []string{filepath.Join(piRoot, "skills")},
		},
		{
			ID:        "kimi",
			Name:      "Kimi Code",
			ProbeDirs: []string{kimiRoot, filepath.Join(home, ".kimi")},
			SkillsDirs: []string{
				filepath.Join(kimiRoot, "skills"),
				filepath.Join(home, ".kimi", "skills"),
			},
		},
		{
			ID:        "agents-shared",
			Name:      "通用共享 (~/.agents)",
			ProbeDirs: []string{filepath.Join(home, ".agents"), filepath.Join(xdg, "agents")},
			SkillsDirs: []string{
				filepath.Join(home, ".agents", "skills"),
				filepath.Join(xdg, "agents", "skills"),
			},
		},
	}
}

func isExistingDir(p string) bool {
	if strings.TrimSpace(p) == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func normPathKey(p string) string {
	clean := filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(clean); err == nil {
		clean = real
	}
	if runtime.GOOS == "windows" {
		return strings.ToLower(clean)
	}
	return clean
}

// DiscoverHarnessSkills scans installed local AI harness clients under homeDir
// (defaults to os.UserHomeDir) and returns all discoverable SKILL.md folders
// annotated with whether they are already installed in Handraw.
func (m *Manager) DiscoverHarnessSkills(homeDir string, extraDir string) DiscoveryResult {
	if strings.TrimSpace(homeDir) == "" {
		homeDir, _ = os.UserHomeDir()
	}
	installedList, _ := m.List()
	installedByID := map[string]Skill{}
	installedBySrc := map[string]Skill{}
	for _, sk := range installedList {
		installedByID[sk.ID] = sk
		if sk.Source != "" {
			// Match either exact local path or harness:<client>:<path>
			src := strings.TrimSpace(sk.Source)
			if strings.HasPrefix(src, "harness:") {
				parts := strings.SplitN(src, ":", 3)
				if len(parts) == 3 {
					installedBySrc[normPathKey(parts[2])] = sk
				}
			} else if isExistingDir(src) {
				installedBySrc[normPathKey(src)] = sk
			}
		}
	}

	specs := defaultHarnessSpecs(homeDir)
	if strings.TrimSpace(extraDir) != "" && isExistingDir(extraDir) {
		specs = append([]harnessSpec{{
			ID:         "custom",
			Name:       "自定义目录 (" + filepath.Base(extraDir) + ")",
			ProbeDirs:  []string{extraDir},
			SkillsDirs: []string{extraDir},
		}}, specs...)
	}

	var clients []DiscoveredClient
	totalSkills := 0

	for _, spec := range specs {
		detected := false
		for _, pd := range spec.ProbeDirs {
			if isExistingDir(pd) {
				detected = true
				break
			}
		}
		var scanDirs []string
		seenScan := map[string]bool{}
		addScan := func(d string) {
			if !isExistingDir(d) {
				return
			}
			k := normPathKey(d)
			if seenScan[k] {
				return
			}
			seenScan[k] = true
			detected = true
			scanDirs = append(scanDirs, filepath.Clean(d))
		}
		for _, sd := range spec.SkillsDirs {
			addScan(sd)
		}
		for _, pat := range spec.PluginGlob {
			if matches, err := filepath.Glob(pat); err == nil {
				for _, match := range matches {
					addScan(match)
				}
			}
		}
		if !detected {
			continue
		}

		var found []DiscoveredSkill
		seenSkillDir := map[string]bool{}
		for _, rootDir := range scanDirs {
			// Support either a direct skill folder (contains SKILL.md) or a container of skill folders.
			if sf := findSkillMD(rootDir); sf != "" {
				if sk, ok := parseDiscoveredSkill(rootDir, sf, spec.ID, spec.Name, installedByID, installedBySrc); ok {
					k := normPathKey(rootDir)
					if !seenSkillDir[k] {
						seenSkillDir[k] = true
						found = append(found, sk)
					}
				}
				continue
			}
			entries, err := os.ReadDir(rootDir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				name := e.Name()
				if strings.HasPrefix(name, ".") {
					continue
				}
				subDir := filepath.Join(rootDir, name)
				if !isExistingDir(subDir) {
					continue
				}
				sf := findSkillMD(subDir)
				if sf == "" {
					continue
				}
				k := normPathKey(subDir)
				if seenSkillDir[k] {
					continue
				}
				if sk, ok := parseDiscoveredSkill(subDir, sf, spec.ID, spec.Name, installedByID, installedBySrc); ok {
					seenSkillDir[k] = true
					found = append(found, sk)
				}
			}
		}

		sort.Slice(found, func(i, j int) bool {
			return strings.ToLower(found[i].Name) < strings.ToLower(found[j].Name)
		})
		if found == nil {
			found = []DiscoveredSkill{}
		}
		if scanDirs == nil {
			scanDirs = []string{}
		}
		totalSkills += len(found)
		clients = append(clients, DiscoveredClient{
			ID:         spec.ID,
			Name:       spec.Name,
			Detected:   true,
			SkillsDirs: scanDirs,
			SkillCount: len(found),
			Skills:     found,
		})
	}

	sort.SliceStable(clients, func(i, j int) bool {
		if (clients[i].SkillCount > 0) != (clients[j].SkillCount > 0) {
			return clients[i].SkillCount > 0
		}
		if clients[i].SkillCount != clients[j].SkillCount {
			return clients[i].SkillCount > clients[j].SkillCount
		}
		return clients[i].Name < clients[j].Name
	})
	if clients == nil {
		clients = []DiscoveredClient{}
	}
	return DiscoveryResult{
		Clients:      clients,
		TotalClients: len(clients),
		TotalSkills:  totalSkills,
	}
}

func parseDiscoveredSkill(skillDir, skillFile, clientID, clientName string, byID, bySrc map[string]Skill) (DiscoveredSkill, bool) {
	info, err := os.Stat(skillFile)
	if err != nil || info.IsDir() || info.Size() > maxSkillFileBytes {
		return DiscoveredSkill{}, false
	}
	raw, err := os.ReadFile(skillFile)
	if err != nil {
		return DiscoveredSkill{}, false
	}
	pName, pDesc, _, pVer := ParseFrontmatterFull(string(raw))
	baseName := filepath.Base(skillDir)
	displayName := firstNonEmpty(pName, baseName)
	id := SanitizeID(firstNonEmpty(pName, baseName))
	if id == "" {
		id = SanitizeID(baseName)
	}
	if id == "" {
		return DiscoveredSkill{}, false
	}
	inst, hasInst := bySrc[normPathKey(skillDir)]
	if !hasInst {
		inst, hasInst = byID[id]
	}
	return DiscoveredSkill{
		ID:          id,
		Name:        displayName,
		Description: pDesc,
		Version:     pVer,
		Dir:         filepath.Clean(skillDir),
		ClientID:    clientID,
		ClientName:  clientName,
		Installed:   hasInst,
		InstalledID: inst.ID,
	}, true
}
