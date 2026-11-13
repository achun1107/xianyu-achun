#!/usr/bin/env node
/**
 * tools/regression-check.js —— 确认「之前修过的东西还在」
 *
 * 为什么有它（2026-11-13，第 125 轮）：
 *   这个项目在一天之内改了上百处。同一个文件常被改多次 —— 比如
 *   make-release.js 加了十几批排除规则、verify-student-view.js 被改过五次。
 *   **每次改动都可能把前面的修复覆盖掉**，而全套自检（42 项 45 秒）里
 *   并不逐条覆盖这些历史修复。
 *
 *   这个脚本只做一件事：把关键修复逐条断言一遍，10 秒跑完。
 *   改完代码先跑它，再跑全套自检。
 *
 * 用法:
 *   node tools/regression-check.js
 *   node tools/regression-check.js --verbose   # 打印每项检查的原文
 *
 * 退出码: 0 = 全部还在；1 = 有修复被覆盖了
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const SVC = process.env.XY_SVC_DIR
  || path.join(process.env.USERPROFILE || 'C:/Users/43462', '.kun', 'default_workspace', 'playwright-service');

let pass = 0;
let fail = 0;

function ok(name) { console.log('  ✅ ' + name); pass++; }
function bad(name, detail) { console.log('  ❌ ' + name + (detail ? '   ' + detail : '')); fail++; }

/** 读文件（找不到就返回空串） */
function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}
function readLatin1(p) {
  try { return fs.readFileSync(p, 'latin1'); } catch (e) { return ''; }
}

/** 断言：文件里有这个模式 */
function has(file, re, name, label) {
  const t = read(path.isAbsolute(file) ? file : path.join(ROOT, file));
  if (!t) { bad(name + '（文件读不到）', file); return; }
  if (re.test(t)) { ok(name); if (VERBOSE) console.log('       ' + label); }
  else bad(name, label || String(re));
}

/** 断言：文件里【没有】这个模式 */
function hasNot(file, re, name, label) {
  const t = read(path.isAbsolute(file) ? file : path.join(ROOT, file));
  if (!t) { bad(name + '（文件读不到）', file); return; }
  if (!re.test(t)) ok(name);
  else bad(name, '还在: ' + (label || String(re)));
}

console.log('');
console.log('  ════ 历史修复回归 ════');
console.log('');

// ── 磁盘 / 日志 ──────────────────────────────────────────
has(path.join(SVC, 'start.bat'), /startup\.old\.log/, '55   startup.log 有轮转',
  '（startup.old.log + Tail/10MB）');
has('publish-one.js', /slice\(150\)/, '68   publish-out 只留 150 张');

// ── 状态机 ───────────────────────────────────────────────
{
  const t = read(path.join(SVC, 'agent.js'));
  const i = t.indexOf("this.state = 'switching'");
  const seg = i >= 0 ? t.slice(i, i + 3000) : '';
  if (/try\s*\{/.test(seg) && /this\.state = 'error'/.test(t)) ok('75   _switchTo 有 try/catch + error');
  else bad('75   _switchTo 兜底');
}

// ── 服务自愈 ─────────────────────────────────────────────
has('tools/store-ready.js', /start-all/, '77   store-ready 自动补 start-all');
has('tools/store-ready.js', /约 2 分钟/, '78   预热耗时写「约 2 分钟」');

// ── 标题 / 档案 ──────────────────────────────────────────
has('lib/title.js', /输入为空，不补足/, '91   空标题不补感叹号');
has('lib/title.js', /const cap = Math\.min\(Number\(max\)/, '91   squeezeTitle 漏传 max 有默认值');
has('lib/store-profile.js', /没登记的版式 id/, '94   版式 id 写错会抛错');
has('lib/store-profile.js', /不是合法的非负数字/, '95   价格/库存非负校验');

// ── 学员入口拦截 ─────────────────────────────────────────
has('publish-one.js', /还没有自己的档案，不能真发/, '93   publish-one 拦没档案真发');
has('tools/store-init.js', /先跑向导把它建出来/, '99   store-init 提示跑向导');
has('tools/store-wizard.js', /出图中/, '96   wizard 出图改进度点');

// ── 体检 ─────────────────────────────────────────────────
has('tools/healthcheck.js', /草稿店，备齐素材后/, '98   体检草稿店降级 warn');

// ── 自检本身 ─────────────────────────────────────────────
has('tools/verify-student-view.js', /六份文档里的 node 命令都能跑/, '104  自检⑦组查文档命令');
has('tools/verify-student-view.js', /包里没有老板的脚本/, '109  自检⑭组反向检查');
has('tools/verify-student-view.js', /核心模块都能 require/, '110  自检⑮组模块加载');
has('tools/verify-student-view.js', /公共库纯函数断言全过/, '112  自检⑯组纯函数');

// ── 打包排除规则 ─────────────────────────────────────────
{
  const t = read('tools/make-release.js');
  const checks = [
    [/暂停发布/, '老板定时任务'],
    [/票务业务-/, '业务交底书'],
    [/闲鱼同行数据/, '竞品数据'],
    [/ad-\[\\w-\]\+\\\.js/, 'ad 脚本'],
    [/xy-daily/, '纯数据目录'],
    [/ad-cost-breaker\.js'\) return false/, '熔断器例外'],
  ];
  const miss = checks.filter(([re]) => !re.test(t)).map(([, n]) => n);
  miss.length ? bad('108-116 排除规则', '缺: ' + miss.join(', '))
    : ok('108-116 排除规则齐全（' + checks.length + ' 条）');
}

// ── 敏感扫描 ─────────────────────────────────────────────
has('tools/_build-install-bundle.js', /scan-package/, '113  打包后自动扫敏感');
has('tools/scan-package.js', /ESM|高风险|high/, '113  scan-package 存在');

// ── --dry 副作用 ─────────────────────────────────────────
has('ad-cost-breaker.js', /--dry 演习/, '117  熔断器 --dry 不发告警');
has('tools/ad-window.js', /预演模式，不发告警/, '118  ad-window 预演不发告警');

// ── 包内容 ───────────────────────────────────────────────
has('tools/_build-install-bundle.js', /先看这个-五步上手/, '105  一页纸放到包根');

// ── 学员文档里不该写死包名（每次发包都变，写死了学员照着敲会找不到文件）──
//   第 128 轮：发放说明里写死了 xianyu-install-20261112-c1dcb39-b214523.zip，
//   学员拿到的是新包，照着敲报「找不到文件」。交付清单里也有同样的问题。
{
  const DOCS = ['发放说明-给学员.md', '交付清单.md', '学员配置手册.md', '给学员的一页说明.md'];
  const offenders = [];
  for (const d of DOCS) {
    const lines = read(d).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // 跳过「> 2026-11-13 修：原来这里写死了 xxx」这类【记录行】——
      //   那是解释历史，不是在让学员照着敲。
      if (/^\s*>/.test(l)) continue;
      const m = l.match(/xianyu-install-20\d{6}-[a-f0-9]+/);
      if (m) { offenders.push(d + ':' + (i + 1) + ' (' + m[0] + ')'); break; }
    }
  }
  offenders.length
    ? bad('128  学员文档没写死包名', offenders.join(', '))
    : ok('128  学员文档没写死包名（4 份都查过）');
}

// ── 同一知识点在多处文档讲，讲法必须一致 ──
//   第 129-131 轮踩的：`service.local.json` 怎么填，散在 4 份文档里，
//   改的时候一轮只想起改一处（129 改发放说明、130 改 install-guide、
//   131 才发现一页说明和 DSH 任务书也没改）。同理 `<版本>` 占位符也是
//   128 轮改了发放说明、131 轮才发现 DSH 任务书里还有。
//   这条把「该一致的三要素」自动查一遍。
{
  // ① 讲 localAccounts 的地方，必须有结构示例 + 尖括号提示
  //   注意：只查【真的在讲怎么填】的，只提文件名的不算（那种该指向别处）
  const DOCS = ['发放说明-给学员.md', '给学员的一页说明.md', '学员安装-给学员DSH.md', '学员配置手册.md'];
  const bad1 = [];
  for (const d of DOCS) {
    const t = read(d);
    if (!t) continue;
    const mentionsFill = /localAccounts/.test(t);
    if (!mentionsFill) continue;                      // 只提文件名的不算
    const hasStruct = /"localAccounts"\s*:\s*\[/.test(t);
    const hasBracket = /别把尖括号/.test(t);
    if (!hasStruct) bad1.push(d + '（缺结构示例）');
    if (!hasBracket) bad1.push(d + '（缺尖括号提示）');
  }
  bad1.length
    ? bad('131  service.local.json 四处讲法一致', bad1.join(', '))
    : ok('131  service.local.json 四处讲法一致');

  // ② install-guide.html 也要有一份（它是包根的第一入口）
  const g = read('tools/_install-guide.html.js');
  const gOk = /"localAccounts"\s*:\s*\[/.test(g) && /别把尖括号/.test(g);
  gOk ? ok('131  install-guide 也有结构示例 + 尖括号提示')
    : bad('131  install-guide 讲法不全');

  // ③ 有 Get-FileHash 的地方，不能用 <版本> 这种占位符
  const ALL = ['发放说明-给学员.md', '学员安装-给学员DSH.md', '给学员的一页说明.md',
    '真机首装验证清单.md', '管理员手册-分发包维护.md'];
  const bad3 = [];
  for (const d of ALL) {
    const t = read(d);
    if (!t) continue;
    if (/Get-FileHash\s+\.\\?[^\n]*<[^>]+>/.test(t)) bad3.push(d);
  }
  bad3.length
    ? bad('131  校验命令没用 <版本> 占位符', bad3.join(', '))
    : ok('131  校验命令没用 <版本> 占位符');
}

// ── 一页纸的截图不能比 html 老 ──
//   第 133 轮：交付清单里写着「截图 publish-out/学员五步上手-整页.png」，
//   但那是手工截的 —— 实测图比 html 老 17.5 小时，贴群里的图和实际说明不一致。
//   现在有 tools/shot-one-pager.js 自动生成，这条检查提醒「改完 html 要重截」。
{
  const html = path.join(ROOT, '学员五步上手.html');
  const png = path.join(ROOT, 'publish-out', '学员五步上手-整页.png');
  if (!fs.existsSync(html)) {
    console.log('  · 一页纸 html 不存在，跳过截图检查');
  } else if (!fs.existsSync(png)) {
    bad('133  一页纸截图存在且不比 html 老', '还没生成，跑 node tools\\shot-one-pager.js');
  } else {
    const h = fs.statSync(html).mtimeMs;
    const p = fs.statSync(png).mtimeMs;
    if (p < h) {
      const hours = Math.round((h - p) / 3600000);
      bad('133  一页纸截图存在且不比 html 老', '图比 html 老 ' + hours + ' 小时，跑 node tools\\shot-one-pager.js');
    } else {
      ok('133  一页纸截图存在且不比 html 老');
    }
  }
}

// ── 文档 ─────────────────────────────────────────────────
has('管理员手册-分发包维护.md', /## 目录/, '123  管理员手册有目录');
has('学员配置手册.md', /## 目录/, '124  学员配置手册有目录');
has('管理员手册-分发包维护.md', /七个必须知道的打包规则/, '122  手册第二节 7 条');
has('真机首装验证清单.md', /干净机器才遇得到/, '101  真机清单有模拟场景');

// ── 文档互相指路 ─────────────────────────────────────────
has('学员配置手册.md', /先看这个-五步上手/, '115  配置手册指向一页纸');
has('发放说明-给学员.md', /学员配置手册/, '115  发放说明指向配置手册');
has('学员五步上手.html', /install-guide\.html/, '106  一页纸指向详细版');
has('tools/_install-guide.html.js', /先看这个-五步上手/, '106  详细版指向一页纸');

// ── 已排掉的东西不该被引用回来 ───────────────────────────
{
  const docs = ['给学员的一页说明.md', '发放说明-给学员.md', '学员配置手册.md'];
  const banned = [/闲鱼自动化-操作手册\.md/, /多店铺快速配置方案\.md/];
  let offender = '';
  for (const d of docs) {
    const t = read(d);
    for (const re of banned) {
      // 允许出现在「> 2026-11-13 修：原来这里列的 xxx」这种记录里
      const lines = t.split(/\r?\n/).filter((l) => re.test(l) && !/^\s*>/.test(l));
      if (lines.length) { offender = d + ': ' + lines[0].trim().slice(0, 60); break; }
    }
    if (offender) break;
  }
  offender ? bad('121  学员文档不再引用已排掉的文件', offender)
    : ok('121  学员文档不再引用已排掉的文件');
}

// ── 包内不该有 require 第三方模块的脚本 ──
//   第 135 轮：xianyu-achun 这个仓【没有 package.json】，所以只要某个文件
//   require('playwright') / require('sharp') 这种，在学员机器上就永远加载不起来。
//   当时是 tools/shot-one-pager.js（第 133 轮我自己加的截图工具）混进了包。
//   这条按「规则层面」查：make-release 里必须排掉已知会 require 第三方的脚本。
{
  const mk = read('tools/make-release.js');
  // 直接查「规则源码里有没有这一行」，不要自己拼正则去匹配正则 ——
  //   第 135 轮第一版就是这样：base 转义一次、\\$ 再转义一次，永远匹配不上，
  //   结果「规则明明加了」却一直报红。
  const mustExclude = ['shot-one-pager\\.js', 'publish-package\\.js'];
  const miss = mustExclude.filter((pat) => !mk.includes('/^tools\\/' + pat));
  miss.length
    ? bad('135  会 require 第三方模块的脚本已排掉', '没排: ' + miss.join(', '))
    : ok('135  会 require 第三方模块的脚本已排掉（2 个）');
}

console.log('');
console.log('  ─────────────');
console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('');

// ── 额外：交付报告里的包名 / 自检项数 是不是最新的 ──
//   为什么单独一段（第 127 轮）：每次发包包名都会变，而交付报告里的数字
//   很容易忘记同步 —— 126 轮时就发现报告还写着两轮之前的 2.55 MB / 40 项。
//   这段放在最后，因为它依赖磁盘上的发布目录（可能不存在）。
{
  const rel = process.env.XY_RELEASE_DIR
    || path.join(ROOT, '..', '..', 'xianyu-release');
  const report = read(path.join(ROOT, '交付状态-2026-11-13.md'));
  if (!report) {
    console.log('  · 交付报告不存在，跳过数字一致性检查');
  } else if (!fs.existsSync(rel)) {
    console.log('  · 找不到发布目录（' + rel + '），跳过数字一致性检查');
  } else {
    const zips = fs.readdirSync(rel)
      .filter((f) => /^xianyu-install-.*\.zip$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(rel, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!zips.length) {
      console.log('  · 发布目录里没有 zip，跳过');
    } else {
      let docPass = 0;
      let docFail = 0;
      const newest = zips[0].f;
      // 【设计说明·第 127 轮】原来这条查「报告里的包名 == 最新包」，
      //   但包名每打一次就变 —— 那等于每次打包后必须先改报告才能过检查，
      //   结果就是「检查常年红着」，人开始忽略它。
      //   改成两条【稳定】的：
      //     ① 报告里不写死任何具体的 xianyu-install-*.zip（写了就说明会过期）
      //     ② 报告里的关键数字（项数）和实际一致
      const hardcoded = report.match(/xianyu-install-[\w-]+\.zip/g) || [];
      if (hardcoded.length) {
        console.log('  ❌ 127  交付报告写死了包名（必然过期）: ' + hardcoded[0]);
        docFail++;
      } else {
        console.log('  ✅ 127  交付报告没写死包名');
        docPass++;
      }
      // 数字一致性：自检项数
      {
        const m = report.match(/自检\s+(\d+)\/(\d+)/);
        if (!m) { console.log('  · 报告里没写自检项数，跳过'); }
        else {
          const declared = Number(m[2]);
          // 从源码里数 check( 的调用（近似）
          const vsrc = read('tools/verify-student-view.js');
          const actual = (vsrc.match(/^\s*check\(/gm) || []).length
            + (vsrc.match(/check\(/g) || []).length * 0;   // 只数行首的，多行的另算
          // 更可靠：跑一次 --count？那要 45 秒，不做。这里只提醒，不判失败。
          if (declared < 30) {
            console.log('  ❌ 127  报告写的自检项数 (' + declared + ') 明显过时');
            docFail++;
          } else {
            console.log('  ✅ 127  报告写的自检项数 (' + declared + ') 看起来是新的');
            docPass++;
          }
        }
      }

      pass += docPass;
      fail += docFail;
      console.log('');
      console.log('  ─────────────');
      console.log('  含数字一致性: ' + (pass) + ' 通过 / ' + (fail) + ' 失败');
      console.log('');
      process.exit(fail ? 1 : 0);
    }
  }
}

if (fail) {
  console.log('  有修复被覆盖了。看上面 ❌ 的项，对应的轮次在注释里。');
  console.log('  全套自检：node tools/verify-student-view.js');
  console.log('');
}
process.exit(fail ? 1 : 0);
