package web

import "embed"

//go:embed index.html quick.html css js img
var FS embed.FS
