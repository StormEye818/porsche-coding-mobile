#!/usr/bin/env node
/**
 * check-bundle.mjs — 打包门禁：app.js 必须能被 esbuild 完整打出来。
 *
 * 为什么需要：smoke/e2e/walkthrough 都 import 的是 coder/probe/elm 等子模块，
 * **没有一条测试会解析 app.js 本身**。删代码留下孤立的 `}` / 括号不配对时，
 * 全部单测仍会绿，直到打包或真机启动才炸（2026-11-10 实际踩到）。
 *
 * 跑法: node tools/check-bundle.mjs
 */
import { build } from 'esbuild';

try {
  const r = await build({
    entryPoints: ['src/app.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const bytes = r.outputFiles?.[0]?.contents?.length || 0;
  console.log(`  ok  app.js 可打包（${(bytes / 1024).toFixed(0)}KB）`);
  process.exit(0);
} catch (e) {
  console.error('  FAIL app.js 打包失败：');
  for (const err of e.errors || []) {
    console.error(`    ${err.location?.file}:${err.location?.line}: ${err.text}`);
  }
  if (!e.errors) console.error('   ', e.message);
  process.exit(1);
}
