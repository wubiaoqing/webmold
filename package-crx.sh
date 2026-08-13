#!/usr/bin/env bash
# WebMold 扩展 CRX 打包脚本（调用 Chrome 原生打包能力）
#
# 产出：
#   - docs/webmold.crx   可安装的 CRX 包（随站点发布）
#   - keys/webmold.pem   签名私钥（首次自动生成，已加入 .gitignore）
#
# 用法：
#   ./package-crx.sh
#
# 重要说明：
#   - .pem 私钥决定扩展 ID。请务必妥善备份 keys/webmold.pem：
#     丢失后重新生成的 ID 会变化，将无法覆盖安装旧版本。
#   - 现代 Chrome 已禁止直接拖拽安装 CRX，需在 chrome://extensions 打开
#     「开发者模式」后拖入，或通过企业策略 / Chrome Web Store 分发。
#   - 首次运行会启动一个新的 Chrome 进程完成打包（用独立临时 profile，
#     不会干扰你正在使用的 Chrome）。
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

# 需要打进 CRX 的目录/文件（相对项目根目录，与 package.sh 保持一致）
SOURCES=(manifest.json background content lib options sidepanel welcome assets)

BUILD_DIR="$ROOT/build"            # 临时构建目录（已加入 .gitignore）
EXT_DIR="$BUILD_DIR/webmold"       # 待打包的扩展目录
PEM_FILE="$ROOT/keys/webmold.pem"  # 长期私钥（决定扩展 ID）
CRX_OUT="$ROOT/docs/webmold.crx"   # 最终产物

# 1) 定位 Chrome / Chromium / Edge 可执行文件
CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  if [ -x "$c" ]; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  for c in google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "!! 未找到 Chrome/Chromium/Edge 可执行文件，无法打包 CRX" >&2
  exit 1
fi
echo "==> 使用浏览器: $CHROME"

# 2) 准备干净的扩展目录
echo "==> 准备构建目录 $EXT_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$EXT_DIR" "$(dirname "$PEM_FILE")" "$ROOT/docs"
for s in "${SOURCES[@]}"; do
  cp -R "$s" "$EXT_DIR/"
done

# 3) 独立临时 profile：强制启动新进程，避免被已运行的 Chrome 实例转发
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

echo "==> 打包 CRX..."
if [ -f "$PEM_FILE" ]; then
  "$CHROME" --pack-extension="$EXT_DIR" --pack-extension-key="$PEM_FILE" \
    --no-message-box --user-data-dir="$PROFILE" >/dev/null 2>&1 || true
  echo "    （复用已有私钥 ${PEM_FILE}）"
else
  "$CHROME" --pack-extension="$EXT_DIR" \
    --no-message-box --user-data-dir="$PROFILE" >/dev/null 2>&1 || true
  if [ -f "$BUILD_DIR/webmold.pem" ]; then
    mv "$BUILD_DIR/webmold.pem" "$PEM_FILE"
    echo "    （已生成并保存私钥 ${PEM_FILE}，请妥善备份，勿提交到公开仓库）"
  fi
fi

# 4) 移动产物到 docs
if [ -f "$BUILD_DIR/webmold.crx" ]; then
  mv "$BUILD_DIR/webmold.crx" "$CRX_OUT"
  echo ""
  echo "==> 打包完成: $CRX_OUT"
  ls -la "$CRX_OUT"
else
  echo "!! 打包失败：未生成 CRX 文件" >&2
  exit 1
fi
