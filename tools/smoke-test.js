#!/usr/bin/env node
/**
 * tools/smoke-test.js —— 在【刚打出来的包里】真跑一次体检
 *
 * 为什么有它（2026-11-13 第 142 轮）：
 *   静态检查（verify-student-view）能验「文件在不在」「语法对不对」，
 *   但验不了「跑起来会不会报错」和「提示文案指的地方对不对」。
 *   第 141 轮就是【在解压包里手跑了一次 healthcheck】，才发现：
 *     → node tools/store-new.js --name="<店铺名>" --from="好易美代拍"
 *   那句提示指的是【老板的店】，学员机器上根本没有 —— 静态检查永远看不出来。
 *
 * 它做什么：
 *   ① 解压最新的 xianyu-install-*.zip 到临时目录（模拟学员解压）
 *   ② 在 xianyu-achun 里跑 tools/healthcheck.js
 *   ③ 只把【意料之外】的失败报出来
 *      「config.local.json 不存在」「stores/ 下一份都没有」是正常的 ——
 *      学员装之前本来就没有，这两条不算问题。
 *
 * 用法:
 *   node tools/smoke-test.js
 *   node tools/smoke-test.js --keep     # 保留临时目录便于排查
 *
 * 退出码: 0 = 没有意料之外的失败；1 = 有
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const RELEASE = process.env.XY_RELEASE_DIR
  || path.join(ROOT, '..', '..', 'xianyu-release');

// 这些是【正常的】（学员装之前必然如此）
const EXPECTED = [
  'config.local.json：不存在',
  'stores/ 下一份都没有',
  'git 跟踪检查：跳过',
];

function main() {
  console.log('');
  console.log('  ════ 包内冒烟测试 ════');

  if (!fs.existsSync(RELEASE)) {
    console.log('  · 发布目录不存在: ' + RELEASE);
    console.log('    先跑 node tools\\_build-install-bundle.js');
    process.exit(2);
  }
  const zips = fs.readdirSync(RELEASE)
    .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(RELEASE, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!zips.length) {
    console.log('  · 发布目录里没有 zip');
    process.exit(2);
  }
  const zip = path.join(RELEASE, zips[0].f);
  console.log('  [1] 解压 ' + zips[0].f);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });
  const root = path.join(tmp, fs.readdirSync(tmp)[0]);
  const achun = path.join(root, 'xianyu-achun');
  if (!fs.existsSync(achun)) {
    console.log('  ❌ 解开后找不到 xianyu-achun');
    process.exit(1);
  }
  const top = fs.readdirSync(root);
  console.log('      ' + top.join(' / '));

  console.log('\n  [2] 在包内跑 healthcheck.js');
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [path.join('tools', 'healthcheck.js')],
      { cwd: achun, encoding: 'utf8', timeout: 180000, stdio: 'pipe' });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
    code = e.status == null ? 1 : e.status;
  }

  // 抓「必须先处理这些 ❌」那一段
  const m = out.match(/必须先处理这些 ❌：([\s\S]*?)(?:\n\n|$)/);
  const fails = m
    ? m[1].split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('·'))
    : [];

  const unexpected = fails.filter((f) => !EXPECTED.some((x) => f.includes(x)));

  console.log('      退出码 ' + code + '，❌ 项 ' + fails.length + ' 个');
  fails.forEach((f) => {
    const isExpected = EXPECTED.some((x) => f.includes(x));
    console.log('        ' + (isExpected ? '·（正常）' : '❌') + ' ' + f.replace(/^·\s*/, '').slice(0, 80));
  });

  // 顺便看结论行
  const sum = out.match(/✅ (\d+) 项通过\s+⚠️ (\d+) 项待办\s+❌ (\d+) 项有问题/);
  if (sum) console.log('\n      汇总: ' + sum[1] + ' ✅ / ' + sum[2] + ' ⚠️ / ' + sum[3] + ' ❌');

  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log('\n      临时目录保留: ' + tmp);

  console.log('');
  if (unexpected.length) {
    console.log('  ❌ 有 ' + unexpected.length + ' 项意料之外的失败 —— 这个包发出去学员会卡住');
    console.log('');
    process.exit(1);
  }
  console.log('  ✅ 没有意料之外的失败（「没装过」那两条是正常的）');
  console.log('');
}

main();
