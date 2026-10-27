#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v python3 >/dev/null 2>&1; then
    exec python3 mulai.py
fi
printf '%s\n' 'Python 3 belum ditemukan. Pasang dari https://www.python.org/downloads/ lalu jalankan lagi.'
exit 1
