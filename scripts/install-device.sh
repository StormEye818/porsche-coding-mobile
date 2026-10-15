#!/bin/bash
# install-device.sh — 一条命令：同步 → 编真机 → 装到 iPhone
#
# 前置（一次性，需人工）：
#   Xcode → Settings → Accounts → 登录 Apple ID（Team MW795KJMTY）
#   否则 xcodebuild 报 "No Accounts" / "requires a provisioning profile"
#
# 用法：
#   ./scripts/install-device.sh              # 编译 + 装到第一台物理 iPhone
#   ./scripts/install-device.sh --build-only # 只编译不装
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_ONLY=0
[ "${1:-}" = "--build-only" ] && BUILD_ONLY=1

echo "── 1/5 同步 web 产物 ──"
npm run sync
npx cap sync ios >/dev/null
node scripts/sync.mjs --refill

echo "── 2/5 发版面泄漏检查 ──"
LEAK=$(grep -rniE "X431|YZJM|DSTREAM|Unicorn|oracle|逆向|破解|libPORSCHE|flat-six|0x1e2b0|0x1e348|rijndael|反汇编|LFSR" \
       ios/App/App/public/*.js ios/App/App/public/*.html 2>/dev/null || true)
if [ -n "$LEAK" ]; then
  echo "❌ 发版面有泄漏，中止："
  echo "$LEAK" | head -5
  exit 1
fi
echo "   ✅ 干净"

echo "── 3/5 编真机包 ──"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/pc-build-device \
  -allowProvisioningUpdates \
  build 2>&1 | tail -5

APP=/tmp/pc-build-device/Build/Products/Debug-iphoneos/App.app
[ -d "$APP" ] || { echo "❌ 构建产物缺失"; exit 1; }
echo "   ✅ $APP"

echo "── 4/5 找设备 ──"
UDID=$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ && /available/ {print $3; exit}')
if [ -z "$UDID" ]; then
  echo "❌ 无可用物理 iPhone。请插线并解锁。"
  echo "   （模拟器可先用：npm run ios）"
  exit 1
fi
echo "   ✅ $UDID"

if [ "$BUILD_ONLY" = 1 ]; then
  echo "── 5/5 跳过安装（--build-only）──"
  exit 0
fi

echo "── 5/5 安装 ──"
xcrun devicectl device install app --device "$UDID" "$APP"
echo
echo "🎉 安装完成"
echo
echo "⚠️  首次启动提示「不受信任的开发者」："
echo "    设置 → 通用 → VPN与设备管理 → 信任 MW795KJMTY"
echo
echo "⚠️  写入功能当前全锁（level=source-defined，7 道闸门第 1 道）"
echo "    装机后先只做【只读对照】，确认无误再考虑升 level。"
