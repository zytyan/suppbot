#!/usr/bin/env python3
"""Install the pinned upstream Linux x86_64 simple tokenizer, verifying archive and binary."""
import hashlib
import io
import os
from pathlib import Path
import platform
import tempfile
import urllib.request
import zipfile

VERSION = 'v0.7.1'
URL = f'https://github.com/wangfenjin/simple/releases/download/{VERSION}/libsimple-linux-ubuntu-22.04.zip'
ARCHIVE_SHA256 = '0c9a7a578fc50ef5480e69e1e1880535ae68d75e1c1580f6bf106073087642a5'
BINARY_SHA256 = '53a267cda027e3ed19d24b78c1e0bb59aa752f971d6f3f571d5a0eebaa752151'
TARGET = Path(__file__).resolve().parent.parent / 'lib' / 'libsimple.so'

def main():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise SystemExit('This pinned artifact supports Linux x86_64 only.')
    if TARGET.exists() and hashlib.sha256(TARGET.read_bytes()).hexdigest() == BINARY_SHA256:
        print(f'simple {VERSION} already installed and verified')
        return
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise SystemExit('simple archive checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        binary = archive.read('libsimple-linux-ubuntu-22.04/libsimple.so')
    if hashlib.sha256(binary).hexdigest() != BINARY_SHA256:
        raise SystemExit('simple binary checksum mismatch')
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=TARGET.parent, delete=False) as temp:
        temporary = Path(temp.name)
        try:
            temp.write(binary)
            temp.flush()
            os.fchmod(temp.fileno(), 0o644)
            os.replace(temporary, TARGET)
        finally:
            temporary.unlink(missing_ok=True)
    print(f'Installed verified simple {VERSION}: {TARGET}')

if __name__ == '__main__':
    main()
