//go:build !windows

package appdir

func listFixedDrives() []driveInfo { return nil }

func systemDriveRoot() string { return "" }
