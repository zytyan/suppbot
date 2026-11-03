#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
name=suppbot
package="dist/package/$name-linux-x86_64"
rm -rf -- "$package"
mkdir -p "$package"
deno compile --frozen --allow-read --allow-write --allow-ffi --allow-net --allow-env --allow-run=ffmpeg,ffprobe,rar --output dist/suppbot src/main.ts
install -m 0755 dist/suppbot "$package/suppbot"
install -D -m 0644 lib/libsimple.so "$package/lib/libsimple.so"
cp -R static "$package/static"
install -m 0644 no_image.png "$package/no_image.png"
printf '%s\n' "$(git rev-parse HEAD)" > "$package/SOURCE_COMMIT"
# Only explicitly selected release files are archived; never include the worktree.
archive="$name-linux-x86_64.tar.gz"
tar -C dist/package -czf "dist/$archive" "$name-linux-x86_64"
(cd dist && sha256sum "$archive" > SHA256SUMS)
