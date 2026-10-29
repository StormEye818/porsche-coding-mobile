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

echo "── 3/5 找设备 ──"
# ⚠️ 默认装到 iPhone Duo（iPhone19,4）。2026-10-25 起用户换了新机，
#    不要再「取第一台物理机」——本机同时接着旧 iPhone 15 Pro Max，
#    会装错设备。要临时装旧机：DEVICE_UDID=<旧机UDID> ./scripts/install-device.sh
#
# ⚠️ 状态字可能是 connected/available 等，别写死一种（2026-10-17 装机时踩过：
#    写死 /available/ 但真机报 connected，导致误报「无可用物理 iPhone」）
DEFAULT_UDID="00008160-000C043A1420000A"   # iPhone Duo (iPhone19,4)
PHYSICAL=$(xcrun devicectl list devices 2>/dev/null | awk '/physical/ {print $3; exit}')
if [ -n "$DEVICE_UDID" ]; then
  UDID="$DEVICE_UDID"
elif xcrun devicectl list devices 2>/dev/null | grep -q "$DEFAULT_UDID"; then
  UDID="$DEFAULT_UDID"
else
  # 默认机不在线就回落到当前第一台物理机（换机/换线时不必改脚本）
  UDID="$PHYSICAL"
  [ -n "$UDID" ] && echo "   ⚠️ 默认机 (Duo) 不在线，回落到 $UDID"
fi
if [ -z "$UDID" ] || ! xcrun devicectl list devices 2>/dev/null | grep -q "$UDID"; then
  echo "❌ 没有可用的物理 iPhone。请插线并解锁。"
  echo "   当前在线的物理机："
  xcrun devicectl list devices 2>/dev/null | awk '/physical/'
  echo "   （模拟器可先用：npm run ios）"
  exit 1
fi
echo "   ✅ $UDID"

# Developer Mode 关着装不上，先把话说明白（devicectl 只给一句很绕的报错）
if xcrun devicectl device info details --device "$UDID" 2>&1 | grep -q "Developer Mode is turned off"; then
  echo "❌ iPhone Duo 的开发者模式没开，装不进去。"
  echo "   手机上：设置 → 隐私与安全性 → 开发者模式 → 打开，重启后再跑本脚本。"
  exit 1
fi

echo "── 4/5 编真机包 ──"
# ⚠️ 2026-10-17 踩过：SourcePackages 的 checkout 会烂掉，xcodebuild 报
#    "Package.swift doesn't exist in file system"。构建前清掉缓存即可。
#    （直接换 -derivedDataPath 也能绕，但会一直堆垃圾，还是清干净。）
rm -rf /tmp/pc-build-device/SourcePackages
#
# ⚠️ 2026-10-25 踩过：换新机后装机报 0xe8008012「provisioning profile cannot
#    be installed on this device」——团队 profile 里只有旧机的 UDID。
#    两个开关缺一不可，而且 -destination 必须写具体 id=UDID：
#      · 写 generic/platform=iOS 时「destination device」不存在，
#        -allowProvisioningDeviceRegistration 等于没开
#      · 该开关才会把这台机注册到开发者门户并重出团队 profile
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath /tmp/pc-build-device \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  build 2>&1 | tail -5

APP=/tmp/pc-build-device/Build/Products/Debug-iphoneos/App.app
[ -d "$APP" ] || { echo "❌ 构建产物缺失"; exit 1; }
echo "   ✅ $APP"

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
echo "⚠️  写入默认开启，但参数 level 仍全部是 source-defined（未逐项实车验证）"
echo "    首次上车只做【只读对照】；写入前先导出备份，并逐项确认当前值/目标值。"
echo "    真正拦住错误写入的是：只读项 / 缺 LID / SID 不配对 / 变更越界 / 回读不一致。"
