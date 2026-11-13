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

  // ── [3] 跑【学员最可能手贱试的那条】：publish-one 城市 明星 --dry ──
  //   第 144 轮实测：它在「还没装依赖」时抛的是英文
  //   「Cannot find module '...\node_modules\playwright'」—— 和 healthcheck 的失败
  //   完全不是一回事，只有真跑一次才看得见。
  //   --dry 不发（只出图），产物落在临时目录里，跑完整个 tmp 一起删掉。
  console.log('\n  [3] 在包内跑 publish-one 广州 王嘉尔 --dry');
  let pOut = '';
  try {
    pOut = execFileSync('node', [path.join('publish-one.js'), '广州', '王嘉尔', '--dry'],
      { cwd: achun, encoding: 'utf8', timeout: 240000, stdio: 'pipe' });
  } catch (e) {
    pOut = String((e.stdout || '') + (e.stderr || ''));
  }
  const pLines = pOut.split(/\r?\n/);

  // 这些是【正常的】（学员装之前）：
  const P_EXPECTED = [
    /还没装依赖/,                    // 144 轮改的中文提示（上面那三行）
    /依赖未安装/,                    // 144 轮 throw 的那一行（也是正常的）
    /Cannot find module .*playwright/i,  // 万一中文提示没生效，也别算致命
    /还没有自己的档案/,               // 店没配
    /先用一套通用默认值跑/,
    /出图: OK/,                      // 说明主链路通
  ];
  const pProblems = pLines.filter((l) => {
    if (/^(❌|Error:|TypeError|ReferenceError)/.test(l.trim())) {
      return !P_EXPECTED.some((re) => re.test(l));
    }
    return false;
  });

  // 关键正面信号：能出图 = 8093 通 + 大麦取数通 + 模板引擎通
  const gotImage = /出图: OK/.test(pOut);
  console.log('      ' + (gotImage ? '✅ 出图 OK（8093 + 大麦取数 + 模板引擎都通）' : '⚠️ 没看到「出图: OK」'));
  const noDep = /还没装依赖|Cannot find module .*playwright/i.test(pOut);
  if (noDep) console.log('      ·（正常）这台机器没装依赖，叠字那步做不了（中文提示已给）');

  if (pProblems.length) {
    console.log('      ❌ 意料之外的报错 ' + pProblems.length + ' 行:');
    pProblems.slice(0, 4).forEach((l) => console.log('          ' + l.trim().slice(0, 90)));
  }

  if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log('\n      临时目录保留: ' + tmp);

  console.log('');
  if (unexpected.length || pProblems.length) {
    console.log('  ❌ 有 ' + (unexpected.length + pProblems.length) + ' 项意料之外的失败 —— 这个包发出去学员会卡住');
    console.log('');
    process.exit(1);
  }
  console.log('  ✅ 没有意料之外的失败（「没装过」那几条是正常的）');
  console.log('');
}

main();
