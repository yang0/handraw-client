//go:build windows

package appdir

import (
	"os"
	"strings"
	"syscall"
	"unsafe"
)

const winDriveFixed = 3 // DRIVE_FIXED

var (
	kernel32DLL            = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives   = kernel32DLL.NewProc("GetLogicalDrives")
	procGetDriveTypeW      = kernel32DLL.NewProc("GetDriveTypeW")
	procGetDiskFreeSpaceEx = kernel32DLL.NewProc("GetDiskFreeSpaceExW")
)

// listFixedDrives enumerates all local fixed hard drives (DRIVE_FIXED) and
// queries their available free bytes for the current user via Win32 APIs.
// Removable USB drives, CD-ROMs, network shares, and RAM disks are skipped.
func listFixedDrives() []driveInfo {
	mask, _, _ := procGetLogicalDrives.Call()
	if mask == 0 {
		return nil
	}
	var out []driveInfo
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		rootPtr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		dt, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(rootPtr)))
		if dt != winDriveFixed {
			continue
		}
		var freeAvail, totalBytes, totalFree uint64
		ret, _, _ := procGetDiskFreeSpaceEx.Call(
			uintptr(unsafe.Pointer(rootPtr)),
			uintptr(unsafe.Pointer(&freeAvail)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFree)),
		)
		if ret == 0 || totalBytes == 0 {
			continue
		}
		out = append(out, driveInfo{
			Root:       root,
			FreeBytes:  freeAvail,
			TotalBytes: totalBytes,
		})
	}
	return out
}

func systemDriveRoot() string {
	sd := strings.TrimSpace(os.Getenv("SystemDrive"))
	if len(sd) >= 2 && sd[1] == ':' {
		return strings.ToUpper(sd[:2]) + `\`
	}
	return `C:\`
}
