#!/usr/bin/env bash
# WebMold 扩展打包脚本
#
# 产出：
#   - docs/webmold.zip   正式分发版（随站点发布，可被用户下载安装）
#
# 用法：
#   ./package.sh
#
# 说明：
#   - 仅打包运行时必需目录，自动排除文档 / 统计服务 / 开发产物（.DS_Store 等）
#   - 若以后新增需要随包发布的目录，在下方 SOURCES 数组中追加即可
set -euo pipefail

# 切换到项目根目录（无论从何处执行本脚本）
cd "$(dirname "$0")"

# 需要打进 zip 的目录/文件（相对项目根目录）
SOURCES=(manifest.json background content lib options sidepanel welcome assets)

echo "==> 清理旧包..."
rm -f docs/webmold.zip

echo "==> 打包：${SOURCES[*]}"
zip -r -X docs/webmold.zip "${SOURCES[@]}" -x "*.DS_Store"

echo ""
echo "==> 打包完成，文件清单："
unzip -l docs/webmold.zip
