package web

import "embed"

//go:embed index.html quick.html dsh-host.html css js img vendor
var FS embed.FS
