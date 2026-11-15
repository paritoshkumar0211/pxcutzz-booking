"""Push local updates of the PXCUTZZ booking app to GitHub main.

The bundled github.py push-app only handles the initial push (it stops when
main already exists). This script updates already-tracked files and adds new
ones through the Contents API, one commit per file, using the same
custom.github credential surrogate as github.py.
"""
from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = "custom.github"
HOSTS = ["api.github.com"]
OWNER = "paritoshkumar0211"
REPO = "pxcutzz-booking"
APP_DIR = "/home/hatch/workspace/pxcutzz-render-app"
BRANCH = "main"

FILES = [
    "README.md",
    "public/app.js",
    "public/index.html",
    "public/styles.css",
    "server.js",
    "public/photos/salon-1.jpg",
    "public/photos/salon-2.jpg",
    "public/photos/salon-3.jpg",
    "public/photos/salon-4.jpg",
]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def api(method: str, path: str, payload: dict | None = None) -> dict:
    url = f"https://api.github.com{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    add_surrogate_to_request(request, CREDENTIAL, allowed_hosts=HOSTS)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            return read_json_response(response)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub {method} {path} failed: HTTP {exc.code}: {body}") from exc


def main() -> int:
    for rel in FILES:
        try:
            current = api("GET", f"/repos/{OWNER}/{REPO}/contents/{rel}?ref={BRANCH}")
            sha = current.get("sha")
        except RuntimeError as exc:
            if "HTTP 404" not in str(exc):
                raise
            sha = None
        with open(f"{APP_DIR}/{rel}", "rb") as handle:
            content = base64.b64encode(handle.read()).decode("ascii")
        payload: dict = {
            "message": f"Update {rel} — new salon address + photo gallery",
            "content": content,
            "branch": BRANCH,
        }
        if sha:
            payload["sha"] = sha
        done = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{rel}", payload)
        print(f"{rel}: {done['content']['sha']}")
    ref = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
    print(json.dumps({"status": "pushed", "head_sha": ref["object"]["sha"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
