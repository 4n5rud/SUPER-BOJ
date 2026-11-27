#!/usr/bin/env bash
set -euo pipefail
directory=$(cd -- "$(dirname -- "$0")" && pwd)
exec bash "$directory/../install-unix.sh" macos --uninstall "$@"
