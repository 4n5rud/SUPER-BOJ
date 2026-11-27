#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  printf 'Usage: %s --install EXTENSION_ID BINARY | --uninstall\n' "$0" >&2
  exit 2
fi

case "$1" in
  macos)
    data_dir="$HOME/Library/Application Support/SUPER_BOJ"
    manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  linux)
    data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/SUPER_BOJ"
    manifest_dir="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts"
    ;;
  *) exit 2 ;;
esac
shift

binary="$data_dir/bin/super-boj-core"
manifest="$manifest_dir/com.superboj.core.json"
case "$1" in
  --uninstall)
    [[ $# -eq 1 ]] || exit 2
    rm -f -- "$manifest" "$binary"
    printf 'Removed Chrome registration and native binary. Local data: %s\n' "$data_dir"
    ;;
  --install)
    if [[ $# -ne 3 || ! "$2" =~ ^[a-p]{32}$ || ! -f "$3" ]]; then
      printf 'Usage: install.sh EXTENSION_ID BINARY (32 letters a–p, existing binary)\n' >&2
      exit 2
    fi
    command -v python3 >/dev/null || { printf 'python3 is required.\n' >&2; exit 1; }
    umask 077
    mkdir -p -- "$data_dir/bin" "$manifest_dir"
    staged_binary=$(mktemp "$data_dir/bin/.super-boj-core.XXXXXXXX")
    staged_manifest=''
    cleanup() {
      rm -f -- "$staged_binary"
      if [[ -n "$staged_manifest" ]]; then rm -f -- "$staged_manifest"; fi
    }
    trap cleanup EXIT
    staged_manifest=$(mktemp "$manifest_dir/.com.superboj.core.XXXXXXXX")
    install -m 755 -- "$3" "$staged_binary"
    python3 - "$staged_binary" "$binary" "$staged_manifest" "$2" <<'PY'
import json
import os
import struct
import subprocess
import sys
import uuid

staged_binary, binary, manifest, extension = sys.argv[1:]
request_id = str(uuid.uuid4())
request = json.dumps(dict(protocolVersion=1, requestId=request_id, type="PING", payload={})).encode()
response = subprocess.run(
    [staged_binary], input=struct.pack("=I", len(request)) + request,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10,
).stdout
if (len(response) < 4 or struct.unpack("=I", response[:4])[0] != len(response) - 4):
    raise SystemExit("Native host did not return a valid frame.")
reply = json.loads(response[4:])
if not (reply.get("requestId") == request_id and reply.get("ok") is True
        and reply.get("payload", {}).get("status") == "PONG"):
    raise SystemExit("Native host did not return PONG.")
with open(manifest, "w", encoding="utf-8") as output:
    json.dump(dict(name="com.superboj.core", description="SUPER_BOJ Local Native Engine",
                   path=os.path.abspath(binary), type="stdio",
                   allowed_origins=[f"chrome-extension://{extension}/"]), output)
    output.write("\n")
PY
    mv -f -- "$staged_binary" "$binary"
    mv -f -- "$staged_manifest" "$manifest"
    test -x "$binary" && test -r "$manifest"
    printf 'Installed and verified native binary. Chrome manifest: %s\n' "$manifest"
    ;;
  *) exit 2 ;;
esac
