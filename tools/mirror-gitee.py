#!/usr/bin/env python3
"""Mirror a signed handraw-client release and its artifacts to Gitee Releases (#172).

Usage:
    GITEE_TOKEN=<token> python3 tools/mirror-gitee.py <tag> <artifacts_dir> [notes_file]

Idempotent: if the tag already has a Gitee Release (e.g. when re-running the
workflow with platforms=all to attach macOS builds and updated SHA256SUMS),
existing attachments with matching names are replaced cleanly.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API_BASE = "https://gitee.com/api/v5"


def _api(method: str, path: str, token: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    url = f"{API_BASE}{path}"
    data = None
    headers = {
        "User-Agent": "handraw-release-mirror/1.0",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except Exception:
            parsed = {"raw": raw[:300]}
        return exc.code, parsed


def _upload_attachment(owner: str, repo: str, release_id: int, token: str, file_path: Path) -> None:
    url = f"{API_BASE}/repos/{owner}/{repo}/releases/{release_id}/attach_files"
    # Pass the bearer token via curl stdin config (-K -) so it never appears in
    # process command-line arguments (#177).
    curl_cfg = f'header = "Authorization: Bearer {token}"\n'
    for attempt in range(1, 4):
        t0 = time.monotonic()
        proc = subprocess.run(
            [
                "curl",
                "-fsS",
                "--http1.1",
                "-H",
                "Expect:",
                "--connect-timeout",
                "30",
                "--speed-limit",
                "10240",
                "--speed-time",
                "45",
                "--max-time",
                "300",
                "-K",
                "-",
                "-X",
                "POST",
                url,
                "-F",
                f"file=@{file_path}",
            ],
            input=curl_cfg,
            capture_output=True,
            text=True,
        )
        elapsed = time.monotonic() - t0
        if proc.returncode == 0:
            print(f"  -> uploaded {file_path.name} in {elapsed:.1f}s", flush=True)
            return
        err_msg = (proc.stderr or proc.stdout or "").replace(token, "***").strip()
        print(f"  -> attempt {attempt}/3 failed for {file_path.name} after {elapsed:.1f}s (rc={proc.returncode}): {err_msg[:300]}", flush=True)
        if attempt == 3:
            raise RuntimeError(f"upload {file_path.name} failed (rc={proc.returncode}): {err_msg[:400]}")
        time.sleep(3 * attempt)


def main() -> int:
    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token:
        print("GITEE_TOKEN is not set; skipping Gitee release mirror.")
        return 0
    if len(sys.argv) < 3:
        print("usage: mirror-gitee.py <tag> <artifacts_dir> [notes_file]", file=sys.stderr)
        return 2

    tag = sys.argv[1].strip()
    art_dir = Path(sys.argv[2])
    notes = ""
    if len(sys.argv) >= 4 and Path(sys.argv[3]).is_file():
        notes = Path(sys.argv[3]).read_text(encoding="utf-8", errors="replace").strip()
    if not notes:
        notes = f"手绘风桌面客户端 {tag}"

    owner = os.environ.get("GITEE_OWNER", "yang02010").strip() or "yang02010"
    repo = os.environ.get("GITEE_REPO", "handraw-client").strip() or "handraw-client"

    files = sorted(
        (p for p in art_dir.iterdir() if p.is_file()),
        key=lambda p: (p.stat().st_size, p.name),
    )
    if not files:
        raise RuntimeError(f"no artifacts found in {art_dir}")

    # Check if release already exists for this tag.
    status, existing = _api("GET", f"/repos/{owner}/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}", token)
    release_id: int | None = None
    if status == 200 and isinstance(existing, dict) and existing.get("id"):
        release_id = int(existing["id"])
        print(f"Updating existing Gitee release id={release_id} for {tag}", flush=True)
        # Update release title/body
        _api(
            "PATCH",
            f"/repos/{owner}/{repo}/releases/{release_id}",
            token,
            {"tag_name": tag, "name": f"手绘风 {tag}", "body": notes, "prerelease": False},
        )
        # Remove existing attachments that we are about to re-upload so names stay unique.
        a_status, cur_att = _api("GET", f"/repos/{owner}/{repo}/releases/{release_id}/attach_files", token)
        wanted_names = {f.name for f in files}
        if a_status == 200 and isinstance(cur_att, list):
            for item in cur_att:
                if isinstance(item, dict) and item.get("name") in wanted_names and item.get("id"):
                    _api("DELETE", f"/repos/{owner}/{repo}/releases/{release_id}/attach_files/{int(item['id'])}", token)
    else:
        c_status, created = _api(
            "POST",
            f"/repos/{owner}/{repo}/releases",
            token,
            {
                "tag_name": tag,
                "name": f"手绘风 {tag}",
                "body": notes,
                "prerelease": False,
                "target_commitish": "main",
            },
        )
        if c_status not in (200, 201) or not isinstance(created, dict) or not created.get("id"):
            raise RuntimeError(f"create Gitee release failed ({c_status}): {created}")
        release_id = int(created["id"])
        print(f"Created Gitee release id={release_id} for {tag}", flush=True)

    for fp in files:
        print(f"Uploading {fp.name} ({fp.stat().st_size} bytes) to Gitee release {release_id}...", flush=True)
        _upload_attachment(owner, repo, release_id, token, fp)

    print(f"Gitee release mirror complete: https://gitee.com/{owner}/{repo}/releases/tag/{tag}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
