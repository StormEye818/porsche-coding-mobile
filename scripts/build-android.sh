#!/bin/bash
# build-android.sh — 构建安卓 APK
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/4 同步 web 产物 ──"
npm run sync
npx cap sync android

echo "── 2/4 发版面泄漏检查 ──"
LEAK=$(grep -rniE "X431|YZJM|DSTREAM|Unicorn|oracle|逆向|破解|libPORSCHE|flat-six|0x1e2b0|0x1e348|rijndael|反汇编" \
       android/app/src/main/assets/public/ 2>/dev/null || true)
if [ -n "$LEAK" ]; then
  echo "❌ 发版面有泄漏，中止"
  echo "$LEAK" | head -5
  exit 1
fi
echo "   ✅ 干净"

echo "── 3/4 构建 APK ──"
cd android
./gradlew assembleDebug 2>&1 | tail -10

APK=android/app/build/outputs/apk/debug/app-debug.apk
if [ -f "$APK" ]; then
  echo "── 4/4 构建完成 ──"
  echo "   ✅ $APK"
  ls -la "$APK"
else
  echo "❌ APK 未生成"
  exit 1
fi
