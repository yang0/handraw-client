package appdir

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSelectWindowsRootPicksLargestFreeDriveAndPinsPointer(t *testing.T) {
	var writtenPtrPath, writtenPtrVal string
	got := selectWindowsRoot(windowsRootConfig{
		appdataDir:  `C:\Users\alice\AppData\Roaming\handraw-client`,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 3 << 30, TotalBytes: 256 << 30},
			{Root: `D:\`, FreeBytes: 45 << 30, TotalBytes: 256 << 30},
			{Root: `E:\`, FreeBytes: 157 << 30, TotalBytes: 700 << 30},
			{Root: `G:\`, FreeBytes: 485 << 30, TotalBytes: 950 << 30},
			{Root: `F:\`, FreeBytes: 184 << 30, TotalBytes: 950 << 30},
		},
		hasData:       func(string) bool { return false },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return "" },
		writePointer: func(p, v string) {
			writtenPtrPath = p
			writtenPtrVal = v
		},
	})
	want := `G:\handraw-client`
	if !strings.EqualFold(got, want) {
		t.Fatalf("expected %q, got %q", want, got)
	}
	if !strings.EqualFold(writtenPtrVal, want) || !strings.HasSuffix(writtenPtrPath, pointerFileName) {
		t.Fatalf("expected pointer written to %s = %q, got %q = %q", pointerFileName, want, writtenPtrPath, writtenPtrVal)
	}
}

func TestSelectWindowsRootHonorsPinnedPointerAcrossFreeSpaceChanges(t *testing.T) {
	got := selectWindowsRoot(windowsRootConfig{
		appdataDir:  `C:\Users\alice\AppData\Roaming\handraw-client`,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 10 << 30, TotalBytes: 256 << 30},
			{Root: `D:\`, FreeBytes: 900 << 30, TotalBytes: 1000 << 30}, // now larger than G:
			{Root: `G:\`, FreeBytes: 100 << 30, TotalBytes: 1000 << 30},
		},
		hasData:       func(dir string) bool { return strings.EqualFold(dir, `G:\handraw-client`) },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return `G:\handraw-client` },
	})
	if !strings.EqualFold(got, `G:\handraw-client`) {
		t.Fatalf("pinned pointer must prevent drive drift, got %q", got)
	}
}

func TestSelectWindowsRootPreservesLegacyAppDataForExistingUsers(t *testing.T) {
	legacy := `C:\Users\alice\AppData\Roaming\handraw-client`
	got := selectWindowsRoot(windowsRootConfig{
		appdataDir:  legacy,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 5 << 30, TotalBytes: 256 << 30},
			{Root: `D:\`, FreeBytes: 800 << 30, TotalBytes: 1000 << 30},
		},
		hasData:       func(dir string) bool { return strings.EqualFold(dir, legacy) },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return "" },
	})
	if !strings.EqualFold(got, legacy) {
		t.Fatalf("existing legacy AppData user must not lose data, got %q", got)
	}
}

func TestSelectWindowsRootRecoversExistingNonSystemDriveDataWithoutPointer(t *testing.T) {
	var savedPtr string
	got := selectWindowsRoot(windowsRootConfig{
		appdataDir:  `C:\Users\alice\AppData\Roaming\handraw-client`,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 5 << 30, TotalBytes: 256 << 30},
			{Root: `E:\`, FreeBytes: 120 << 30, TotalBytes: 500 << 30},
			{Root: `G:\`, FreeBytes: 500 << 30, TotalBytes: 1000 << 30},
		},
		hasData:       func(dir string) bool { return strings.EqualFold(dir, `E:\handraw-client`) },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return "" },
		writePointer:  func(_, v string) { savedPtr = v },
	})
	if !strings.EqualFold(got, `E:\handraw-client`) || !strings.EqualFold(savedPtr, `E:\handraw-client`) {
		t.Fatalf("expected recovery of E:\\handraw-client with pointer rewrite, got=%q ptr=%q", got, savedPtr)
	}
}

func TestSelectWindowsRootSkipsUnwritableDriveAndFallsBack(t *testing.T) {
	got := selectWindowsRoot(windowsRootConfig{
		appdataDir:  `C:\Users\alice\AppData\Roaming\handraw-client`,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 20 << 30, TotalBytes: 256 << 30},
			{Root: `D:\`, FreeBytes: 200 << 30, TotalBytes: 500 << 30},
			{Root: `G:\`, FreeBytes: 800 << 30, TotalBytes: 1000 << 30}, // read-only
		},
		hasData: func(string) bool { return false },
		probeWritable: func(dir string) bool {
			return !strings.EqualFold(dir, `G:\handraw-client`)
		},
		readPointer: func(string) string { return "" },
	})
	if !strings.EqualFold(got, `D:\handraw-client`) {
		t.Fatalf("expected fallback to writable D:\\handraw-client, got %q", got)
	}
}

func TestSelectWindowsRootSingleCDriveUsesAppDataAndTiePrefersNonSystem(t *testing.T) {
	legacy := `C:\Users\alice\AppData\Roaming\handraw-client`
	gotSingle := selectWindowsRoot(windowsRootConfig{
		appdataDir:    legacy,
		systemDrive:   `C:\`,
		drives:        []driveInfo{{Root: `C:\`, FreeBytes: 200 << 30, TotalBytes: 500 << 30}},
		hasData:       func(string) bool { return false },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return "" },
	})
	if !strings.EqualFold(gotSingle, legacy) {
		t.Fatalf("single C: machine should use AppData to avoid C:\\ UAC issues, got %q", gotSingle)
	}

	gotTie := selectWindowsRoot(windowsRootConfig{
		appdataDir:  legacy,
		systemDrive: `C:\`,
		drives: []driveInfo{
			{Root: `C:\`, FreeBytes: 200 << 30, TotalBytes: 500 << 30},
			{Root: `D:\`, FreeBytes: 200 << 30, TotalBytes: 500 << 30},
		},
		hasData:       func(string) bool { return false },
		probeWritable: func(string) bool { return true },
		readPointer:   func(string) string { return "" },
	})
	if !strings.EqualFold(gotTie, `D:\handraw-client`) {
		t.Fatalf("tie between C: and D: should prefer non-system D:\\handraw-client, got %q", gotTie)
	}
}

func TestDefaultWorksFollowsNonSystemWindowsRoot(t *testing.T) {
	got := defaultWorksFor("windows", `G:\handraw-client`, `C:\`)
	want := filepath.Join(`G:\handraw-client`, "works")
	if got != want {
		t.Fatalf("expected works under non-system root %q, got %q", want, got)
	}
}

func TestWindowsListFixedDrivesLive(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows-only live drive scan test")
	}
	drives := listFixedDrives()
	if len(drives) == 0 {
		t.Fatal("expected at least one fixed drive on Windows")
	}
	for _, d := range drives {
		t.Logf("detected fixed drive %s free=%.2f GB total=%.2f GB", d.Root, float64(d.FreeBytes)/(1<<30), float64(d.TotalBytes)/(1<<30))
		if d.TotalBytes == 0 {
			t.Fatalf("drive %s reported 0 total bytes", d.Root)
		}
	}
}
