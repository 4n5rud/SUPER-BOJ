#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 || ! "$2" =~ ^[a-p]{32}$ || ! -f "$3" ]]; then
  printf 'Usage: %s macos|linux WEB_STORE_ID CORE_BINARY OUTPUT_PACKAGE\n' "$0" >&2
  exit 2
fi

platform=$1
extension_id=$2
binary=$3
output=$4
case "$platform" in
  macos)
    host='/Library/Application Support/SUPER_BOJ/bin/super-boj-core'
    manifest='/Library/Google/Chrome/NativeMessagingHosts/com.superboj.core.json'
    ;;
  linux)
    host='/usr/lib/super-boj/super-boj-core'
    manifest='/etc/opt/chrome/native-messaging-hosts/com.superboj.core.json'
    ;;
  *) exit 2 ;;
esac

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
umask 022
root="$stage/root"
mkdir -p "$(dirname "$root$host")" "$(dirname "$root$manifest")"
install -m 755 "$binary" "$root$host"
python3 - "$root$manifest" "$host" "$extension_id" <<'PY'
import json
import sys

manifest, host, extension_id = sys.argv[1:]
with open(manifest, "w", encoding="utf-8") as output:
    json.dump(dict(name="com.superboj.core", description="SUPER_BOJ Local Native Engine",
                   path=host, type="stdio", allowed_origins=[f"chrome-extension://{extension_id}/"]), output)
    output.write("\n")
PY

version=${SUPER_BOJ_CORE_VERSION:?set SUPER_BOJ_CORE_VERSION to the Core version}
case "$platform" in
  macos)
    pkgbuild --root "$root" --identifier com.superboj.core --version "$version" \
      --install-location / --ownership recommended "$output"
    ;;
  linux)
    install -d -m 755 "$root/DEBIAN"
    cat > "$root/DEBIAN/control" <<CONTROL
Package: super-boj-core
Version: $version
Architecture: amd64
Depends: libc6 (>= 2.39)
Maintainer: SUPER_BOJ project
Description: Native Messaging host for the SUPER_BOJ Chrome extension
CONTROL
    dpkg-deb --root-owner-group --build "$root" "$output"
    ;;
esac
