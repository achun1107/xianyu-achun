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

console.log('');
console.log('  ─────────────');
console.log('  ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('');

if (fail) {
  console.log('  有修复被覆盖了。看上面 ❌ 的项，对应的轮次在注释里。');
  console.log('  全套自检：node tools/verify-student-view.js');
  console.log('');
}
process.exit(fail ? 1 : 0);
