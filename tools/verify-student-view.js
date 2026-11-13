#!/usr/bin/env node
/**
 * tools/verify-student-view.js —— 用「学员的目录结构」验一遍安装流程
 *
 * 为什么需要它（2026-11-13）：
 *   这台开发机上 Node / museav / git 全都装好了，很多问题在本机【永远不会出现】。
 *   前几轮踩到的坑（文案模板没人生成、museav 装不上、store.active 指向老板的店、
 *   装完提示要自己替换占位符）都是靠"假装自己是学员"才发现的。
 *   而假装的方法每次都得手打一遍命令、还得盯输出——很容易漏。
 *   这个脚本把那一套固化下来：解压最新包 → 造一份假 service.local.json →
 *   跑 install.ps1 -DryRun → 逐项断言。
 *
 * ⚠️ 它只验【安装器这一侧】能验的东西。真机上才有的差异（没装 Node、
 *    Chromium 首次下载、真扫码、真发布）这里验不了，见 真机首装验证清单.md。
 *
 * 用法:
 *   node tools/verify-student-view.js                  # 用 D:\xianyu-release 里最新的包
 *   node tools/verify-student-view.js --zip=<路径>      # 指定包
 *   node tools/verify-student-view.js --store=我的测试店 # 指定假店名
 *   node tools/verify-student-view.js --keep            # 保留临时目录便于排查
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (!a.startsWith('--')) return;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); return; }
  A[a.slice(2)] = (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true;
});

const STORE = String(A.store || '验证用测试店');
const KEEP = !!A.keep;

function findZip() {
  if (A.zip) return A.zip;
  const dir = 'D:\\xianyu-release';
  if (!fs.existsSync(dir)) return '';
  const zips = fs.readdirSync(dir).filter(f => /^xianyu-install-.*\.zip$/.test(f));
  if (!zips.length) return '';
  // 按【修改时间】取最新（按字母序会选错：f4f4968 排在 7ed762d 后面）
  zips.sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
  return path.join(dir, zips[zips.length - 1]);
}

const ZIP = findZip();
if (!ZIP || !fs.existsSync(ZIP)) {
  console.log('❌ 找不到分发包。先跑：');
  console.log('   node tools/make-release.js      （打三个仓）');
  console.log('   node tools/_build-install-bundle.js   （合成学员包）');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail: detail || '' });
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + name + (detail ? '   ' + detail : ''));
};

(async () => {
  console.log('\n════ 学员视角验证 ════');
  console.log('包     : ' + path.basename(ZIP));
  console.log('假店名 : ' + STORE);

  const stage = path.join(os.tmpdir(), 'xy-verify-' + Date.now());
  fs.mkdirSync(stage, { recursive: true });

  // ── ① 解压 ──
  console.log('\n① 解压');
  try {
    execFileSync('tar', ['-xf', ZIP, '-C', stage], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    check('解压成功', false, String(e.message).slice(0, 80));
    process.exit(1);
  }
  const roots = fs.readdirSync(stage, { withFileTypes: true }).filter(d => d.isDirectory());
  if (!roots.length) { check('找到解压后的目录', false); process.exit(1); }
  const root = path.join(stage, roots[0].name);
  const achun = path.join(root, 'xianyu-achun');
  check('解压后能定位到 xianyu-achun', fs.existsSync(achun));

  // ── ② 三目录并排 ──
  console.log('\n② 目录结构（学员最容易搞错的地方）');
  ['xianyu-achun', 'xianyu-playwright-service', 'xianyu-monitor'].forEach(d => {
    check(d + ' 并排存在', fs.existsSync(path.join(root, d)));
  });
  check('install.cmd 在根层', fs.existsSync(path.join(root, 'install.cmd')));
  check('install-guide.html 在根层', fs.existsSync(path.join(root, 'install-guide.html')));

  // ── ③ 造一份学员的 service.local.json ──
  console.log('\n③ 造学员的账号配置');
  const svcLocal = path.join(root, 'xianyu-playwright-service', 'service.local.json');
  const fakeId = '00000000-1111-2222-3333-444444444444';
  fs.writeFileSync(svcLocal, JSON.stringify({
    _说明: 'verify-student-view.js 造的假配置，只用于验证',
    localAccounts: [{ id: fakeId, name: STORE, username: '', password: '' }],
  }, null, 2), 'utf8');
  check('service.local.json 已写入', fs.existsSync(svcLocal), 'id=' + fakeId.slice(0, 8) + '… name=' + STORE);

  // ── ④ 跑 install.cmd（学员真实入口，不是 install.ps1）──
  // ⚠️【2026-11-13 改】原来这里直接跑 install.ps1 —— 那是【跳过 launcher】的。
  //   结果 launcher 里一个裸的 ')' 让整个安装器崩掉（退出码 255）好几轮都没被发现，
  //   而这个脚本一直报 16/16 通过。学员双击的可是 install.cmd，不是 install.ps1。
  //   现在两层都跑：先 install.cmd（含 launcher 的 6 个 if 检查），再核对输出。
  console.log('\n④ 跑安装预演（-DryRun，经 install.cmd —— 学员双击的就是这个）');
  let out = '';
  let exitCode = null;
  try {
    // 用 cmd 调 .cmd 才能复现学员环境；< nul 是为了跳过脚本末尾的 pause
    // 注意：不要自己给路径套一层引号再拼进参数（Node 会再转义一次，cmd 收到的是 \"C:\...\"）
    // 注意：不要自己给路径套引号再拼进参数（Node 会再转义一次，cmd 收到 \"C:\...\"）。
    //   实测两种写法都不可靠：execFileSync('cmd', ['/c', '"..." -DryRun']) 和临时 .bat。
    //   最稳的：直接执行 .cmd（Windows 上 Node 会自己经 cmd.exe），
    //   末尾的 pause 用 input 喂回车跳过。
    // Node 在 Windows 上【不能直接 spawn .cmd】（spawnSync EINVAL）。
    // 必须经 cmd.exe，且路径要作为【独立参数】传（自己拼字符串会被 Node 再转义一次，
    // cmd 收到的是 \"C:\...\" 反而认不出来）。
    const r = execFileSync('cmd.exe', ['/c', path.join(root, 'install.cmd'), '-DryRun'],
      { cwd: root, encoding: 'utf8', timeout: 600000, input: '\r\n\r\n' });
    out = r;
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    exitCode = (e.status === undefined || e.status === null) ? -1 : e.status;
  }
  // launcher 崩掉的典型症状：退出码非 0 且没有任何"闲鱼自动化 · 安装"的横幅
  check('install.cmd 正常跑完（没在 launcher 阶段崩）', exitCode === 0 || exitCode === null,
    exitCode === null ? '' : ('退出码 ' + exitCode));
  check('launcher 横幅打印了', /Xianyu automation - installer/.test(out));
  check('没出现 cmd 语法错误', !/was unexpected at this time|is not recognized as an internal/i.test(out),
    (/was unexpected at this time/.test(out) ? '出现 "was unexpected at this time" → launcher 里有未转义的括号' : ''));

  // ── ⑤ 逐项断言 ──
  console.log('\n⑤ 断言');

  check('node 被识别', /\[ok\]\s+node:/.test(out), (out.match(/\[ok\]\s+node:.*/) || [''])[0].trim().slice(0, 70));

  // npm 必须和 node 同源（2026-11-12 修过的坑）
  const npmLine = (out.match(/\[DryRun\]\s+(\S*npm(?:\.cmd|\.exe|\.ps1))\s+install/) || [])[1] || '';
  const nodePath = (out.match(/\[ok\]\s+node:\s*(\S+)/) || [])[1] || '';
  const nodeDir = nodePath ? path.dirname(nodePath).toLowerCase() : '';
  check('npm 与 node 同源', !!npmLine && (!nodeDir || npmLine.toLowerCase().includes(nodeDir.slice(-30))),
    npmLine ? path.basename(npmLine.split(/\s+/)[0]) : '(没找到 npm install 行)');

  check('两个依赖仓都就位', /xianyu-playwright-service 已就位/.test(out) && /xianyu-monitor 已就位/.test(out));

  check('文案模板库这一步跑到了', /文案模板库/.test(out),
    (out.match(/已生成: .*xianyu-templates\.json|已存在，不覆盖: .*xianyu-templates\.json/) || [''])[0].trim().slice(0, 60));

  check('出图客户端这一步跑到了', /出图客户端/.test(out),
    (out.match(/museav 已装: .*|\[DryRun\] .*museav-cli@latest/) || [''])[0].trim().slice(0, 60));

  check('没有缺失项', /没有缺失项/.test(out));
  check('没有 FAIL', !/\[FAIL\]/.test(out));

  // 最关键的：装完提示必须用学员的店名，不能是占位符
  const tail = out.slice(out.indexOf('剩下必须人工做的三件事'));
  check('装完提示用了学员店名', tail.includes(STORE), tail.includes(STORE) ? '✓ 含 "' + STORE + '"' : '⚠️ 还是占位符');
  check('装完提示没有残留占位符', !/<你的店铺名>|<店铺名>/.test(tail),
    /<你的店铺名>|<店铺名>/.test(tail) ? '出现了 <你的店铺名>' : '');

  // ── ⑥ 学员的另一个入口：启动.cmd ──
  //   这个文件【不能真跑】（它前台起 node 服务、会阻塞，而且会抢 8099 端口）。
  //   但它有两个极易被改坏的点，静态检查就能抓：
  //     ① 必须用 GBK 存（中文系统 cmd 按 936 解析；存成 UTF-8 会印一屏乱码）
  //     ② 跑 node 之前必须 chcp 65001（node 输出是 UTF-8，936 下日志全乱码）
  console.log('\n⑥ 学员的日常入口 启动.cmd');
  const launchPath = path.join(achun, 'tools', 'staff-ui', '启动.cmd');
  if (!fs.existsSync(launchPath)) {
    check('启动.cmd 存在', false, 'tools/staff-ui/ 下没找到');
  } else {
    const buf = fs.readFileSync(launchPath);
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    // 用 GBK 解码，看中文能不能正常出来
    let asGbk = '';
    try { asGbk = buf.toString('latin1'); } catch (e) {}
    // Node 不内置 GBK 解码，用 TextDecoder
    let gbkOk = false;
    let gbkText = '';
    try {
      gbkText = new TextDecoder('gbk').decode(buf);
      gbkOk = /闲鱼上架助手|正在启动/.test(gbkText);
    } catch (e) { gbkOk = false; }
    check('启动.cmd 用 GBK 存（中文能正确解码）', gbkOk && !hasBom,
      hasBom ? '带 UTF-8 BOM（cmd 下会乱码）' : (gbkOk ? '' : 'GBK 解码后读不到中文，可能被存成了 UTF-8'));
    check('启动.cmd 里有 chcp 65001（给 node 日志用）', /chcp\s+65001/i.test(gbkText || ''));
    const idxChcp = (gbkText || '').toLowerCase().indexOf('chcp 65001');
    const idxNode = (gbkText || '').toLowerCase().indexOf('node tools');
    check('chcp 在 node 之前（顺序对了）', idxChcp >= 0 && idxNode > idxChcp,
      (idxChcp < 0 || idxNode < 0) ? '没找到 chcp 或 node 行' : '');
    check('启动.cmd 指向 server.js', /tools\\staff-ui\\server\.js/.test(gbkText || ''));
  }

  // ── ⑦ install-guide.html 里的命令对不对 ──
  //   为什么加（2026-11-13）：_install-guide.html.js 是 JS 模板字符串（反引号），
  //   里面写 `node tools\store-login.js` 时 `\s` 被当转义符 → 生成出来变成
  //   `node toolsstore-login.js`。整份说明里【所有 Windows 路径】都错了，
  //   学员照着敲一个都跑不起来。而程序本身完全正常，所以任何功能测试都发现不了。
  //   这里检查三件事：命令里的脚本在包里存在、路径有反斜杠、没有转义留下的痕迹。
  console.log('\n⑦ install-guide.html 里的命令');
  const guidePath = path.join(root, 'install-guide.html');
  if (!fs.existsSync(guidePath)) {
    check('install-guide.html 存在', false);
  } else {
    const html = fs.readFileSync(guidePath, 'utf8');
    // 提取 <pre><code>...</code></pre> 里的内容
    const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => m[1]);
    check('guide 里有命令块', blocks.length > 0, blocks.length + ' 块');

    // ① 明显被转义吃掉的痕迹
    const tabbed = blocks.filter(b => /\t/.test(b));
    check('没有 TAB 混进命令（\\t 被当转义符的症状）', tabbed.length === 0,
      tabbed.length ? tabbed[0].slice(0, 50).replace(/\t/g, '<TAB>') : '');
    const glued = blocks.filter(b => /tools[a-zA-Z]/.test(b));   // node toolsstore-login.js
    check('没有 tools 和脚本名粘连（\\s 被吃掉的症状）', glued.length === 0,
      glued.length ? glued[0].slice(0, 50) : '');

    // ② 命令里引用的脚本，包里真的有吗
    const missing = [];
    for (const b of blocks) {
      const refs = [...b.matchAll(/(?:node\s+)?(tools\\[\w\u4e00-\u9fa5.-]+\.js)/g)].map(m => m[1]);
      for (const rel of refs) {
        const abs = path.join(achun, rel.replace(/\\/g, path.sep));
        if (!fs.existsSync(abs)) missing.push(rel);
      }
    }
    check('命令引用的脚本都在包里', missing.length === 0,
      missing.length ? '缺: ' + [...new Set(missing)].slice(0, 3).join(', ') : '');

    // ③ 关键路径的完整性（这几个是学员一定会照着敲/点的）
    const mustHave = [
      'xianyu-achun\\tools\\staff-ui\\启动.cmd',
      'node tools\\store-login.js',
      'node tools\\store-init.js',
    ];
    const broken = mustHave.filter(k => html.indexOf(k) < 0);
    check('关键路径完整（反斜杠没被吃）', broken.length === 0,
      broken.length ? '缺: ' + broken.join(' / ') : '');
  }

  // ── ⑧ 扩展代码（monitor）的语法检查 ──
  //   为什么单独一组（2026-11-13）：xianyu-monitor 是 Chrome 扩展，里面的 js 是
  //   【浏览器代码】—— 有 importScripts、顶层 await、chrome.* API。
  //   用 `node -c`（CommonJS）检查会误报；必须复制成 .mjs 用 `node --check`。
  //
  //   但那天的教训是：**误报里也藏着真错**。background.js 报
  //     SyntaxError: await is only valid in async functions
  //   —— 这不是"浏览器专有语法"，是语法层的，Chrome 同样会拒。
  //   实际确认：PD_STOP_PUBLISH 分支的 await 没包 async IIFE，
  //   而外层 onMessage.addListener 不是 async → 整个 background.js 不加载。
  //   它活了三个多月没人发现，因为发布主流程走 content script，不依赖 background。
  console.log('\n⑧ xianyu-monitor 的浏览器代码语法');
  const monDir = path.join(root, 'xianyu-monitor');
  if (!fs.existsSync(monDir)) {
    check('xianyu-monitor 目录存在', false);
  } else {
    const jsFiles = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (/\.js$/i.test(name)) jsFiles.push(p);
      }
    })(monDir);

    const synBad = [];
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-syn-'));
    for (const f of jsFiles) {
      const dst = path.join(tmpd, path.basename(f).replace(/\.js$/i, '') + '_' + Math.random().toString(36).slice(2, 8) + '.mjs');
      fs.copyFileSync(f, dst);
      try {
        execFileSync('node', ['--check', dst], { stdio: 'pipe', timeout: 30000 });
      } catch (e) {
        // 只报语法层错误；importScripts / chrome is not defined 这类是运行时，不算
        const msg = String((e.stderr || '') + (e.stdout || ''));
        if (/SyntaxError/.test(msg)) {
          const firstLine = (msg.split(/\r?\n/).find(l => /SyntaxError/.test(l)) || '').trim();
          synBad.push(path.basename(f) + ': ' + firstLine);
        }
      }
    }
    try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) {}

    check('monitor 的 js 没有语法错误（按 ES module 解析）', synBad.length === 0,
      synBad.length ? synBad.slice(0, 2).join(' | ') : jsFiles.length + ' 个文件');
  }

  // ── ⑨ xianyu-achun 自己的 Node 代码语法 ──
  //   为什么加（2026-11-13）：前面几十轮一直在验"装得上吗、文档对不对"，
  //   但从没验过【包里那 293 个 js 文件本身有没有语法错】。
  //   一个语法错 = 学员点某个按钮时 `SyntaxError: Unexpected token`，
  //   而且报错位置在文件里，学员完全看不懂。
  //   achun 是纯 Node 工具集（CommonJS），用 `node -c` 就够。
  console.log('\n⑨ xianyu-achun 的 Node 代码语法');
  {
    const jsFiles = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (/\.js$/i.test(name)) jsFiles.push(p);
      }
    })(achun);

    const bad = [];
    for (const f of jsFiles) {
      try {
        execFileSync('node', ['-c', f], { stdio: 'pipe', timeout: 20000 });
      } catch (e) {
        const msg = String((e.stderr || '') + (e.stdout || ''));
        const first = (msg.split(/\r?\n/).find(l => /Error/.test(l)) || '').trim();
        bad.push(path.relative(achun, f).replace(/\\/g, '/') + ': ' + first.slice(0, 80));
      }
    }
    check('achun 的 js 全部语法正确', bad.length === 0,
      bad.length ? bad.slice(0, 2).join(' | ') : jsFiles.length + ' 个文件');
  }

  // ── ⑩ 所有 HTML 里的内联 <script> ──
  //   为什么加（2026-11-13）：学员天天用的 staff-ui 页面（ui.html）有 11.7 KB 内联 JS。
  //   一个语法错 = 打开网页一片空白，浏览器控制台里的报错学员根本不会去看。
  //   内联脚本不在任何 .js 文件里，所以 ⑧⑨ 两组都覆盖不到。
  console.log('\n⑩ HTML 里的内联脚本语法');
  {
    const htmlFiles = [];
    (function rec(d) {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git') continue;
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { rec(p); continue; }
        if (/\.html$/i.test(name)) htmlFiles.push(p);
      }
    })(root);

    let totalBlocks = 0;
    const htmlBad = [];
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-inl-'));
    let bi = 0;
    for (const f of htmlFiles) {
      const html = fs.readFileSync(f, 'utf8');
      const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
      for (const m of matches) {
        const js = m[1];
        if (!js.trim()) continue;
        totalBlocks++;
        const dst = path.join(tmpd, 'blk' + (++bi) + '.mjs');
        fs.writeFileSync(dst, js, 'utf8');
        try {
          execFileSync('node', ['--check', dst], { stdio: 'pipe', timeout: 20000 });
        } catch (e) {
          const msg = String((e.stderr || '') + (e.stdout || ''));
          const first = (msg.split(/\r?\n/).find(l => /SyntaxError/.test(l)) || '').trim();
          if (first) htmlBad.push(path.relative(root, f).replace(/\\/g, '/') + ': ' + first.slice(0, 70));
        }
      }
    }
    try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) {}

    check('HTML 内联脚本没有语法错误', htmlBad.length === 0,
      htmlBad.length ? htmlBad.slice(0, 2).join(' | ') : htmlFiles.length + ' 个 HTML / ' + totalBlocks + ' 块脚本');
  }

  // ── ⑪ staff-ui 页面的 id 引用完整性 ──
  //   为什么加（2026-11-13）：语法对了不等于运行时不炸。
  //   ui.html 里 JS 通过 getElementById('x') / val('x') 拿元素，
  //   如果 HTML 里那个 id 不存在 → 返回 null → 调用 .value 时抛
  //     TypeError: Cannot read properties of null
  //   学员看到的是「点了按钮没反应」，控制台里才有这句。
  //   这条检查是我用 ego 真的打开页面、连续调 refreshOnboard/refreshStoreLabel 之后
  //   想到的：那一步能验到运行时，但它依赖浏览器环境，进不了这个脚本；
  //   而「引用的 id 存不存在」是纯静态就能查的，覆盖了同一类故障。
  console.log('\n⑪ staff-ui 页面的 id 引用');
  {
    const uiPath = path.join(achun, 'tools', 'staff-ui', 'ui.html');
    if (!fs.existsSync(uiPath)) {
      check('staff-ui/ui.html 存在', false);
    } else {
      const html = fs.readFileSync(uiPath, 'utf8');
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
      const refs = new Set();
      for (const m of html.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
      for (const m of html.matchAll(/\bval\('([^']+)'\)/g)) refs.add(m[1]);
      for (const m of html.matchAll(/querySelector\('#([^']+)'\)/g)) refs.add(m[1]);

      const missingIds = [...refs].filter(x => !ids.has(x));
      check('JS 引用的 id 在 HTML 里都存在', missingIds.length === 0,
        missingIds.length ? '缺: ' + missingIds.slice(0, 4).join(', ')
                          : ids.size + ' 个 id / ' + refs.size + ' 个引用');
    }
  }

  // ── ⑫ 前端 ↔ 后端的跨文件一致性 ──
  //   两件（2026-11-13 加）：
  //   ① 前端 apiFetch('/api/xxx') 调的接口，server.js 里有没有实现？
  //      没实现 = 点了按钮一直转圈或 404，学员以为是"卡住了"。
  //   ② onclick="xxx()" 里的函数，ui.html 的 js 里有没有定义？
  //      没定义 = ReferenceError，点了没反应。
  //   这两条都是【跨文件】的 —— 单个文件语法全对，组合起来才出问题。
  console.log('\n⑫ 前端 ↔ 后端一致性');
  {
    const uiPath = path.join(achun, 'tools', 'staff-ui', 'ui.html');
    const srvPath = path.join(achun, 'tools', 'staff-ui', 'server.js');
    if (!fs.existsSync(uiPath) || !fs.existsSync(srvPath)) {
      check('staff-ui 的前后端文件都存在', false);
    } else {
      const ui = fs.readFileSync(uiPath, 'utf8');
      const srv = fs.readFileSync(srvPath, 'utf8');

      // ① 接口
      const called = new Set([...ui.matchAll(/apiFetch\('(\/api\/[^'?]+)/g)].map(m => m[1]));
      // 后端：把 server.js 里出现的所有 /api/xxx 字面量都算作"已实现"
      //   （不管它是 p === '/api/x' 还是 p.match(/^\/api\/x\//)，
      //    提取字面量比解析路由语法可靠 —— 第一版想匹配 p.match 的正则，转义层级搞错了）
      // 先把源码里的正则转义 \/ 还原成 /，再提取 —— 否则
      //   p.match(/^\/api\/task\/(\d+)$/) 里的 /api/task 一个都提不到
      const srvNorm = srv.replace(/\\\//g, '/');
      const defined = new Set([...srvNorm.matchAll(/\/api\/[a-z][a-z0-9-]*/g)].map(m => m[0]));
      const noImpl = [...called].filter(c => {
        if (defined.has(c)) return false;
        // 动态路由：前端写 /api/task/（带尾斜杠），后端有 /api/task
        if (c.endsWith('/')) return !defined.has(c.slice(0, -1));
        return true;
      });
      check('前端调的接口后端都实现了', noImpl.length === 0,
        noImpl.length ? '未实现: ' + noImpl.join(', ') : called.size + ' 个接口');

      // ② onclick 里的函数
      const onclickFns = new Set(
        [...ui.matchAll(/on(?:click|change|input)="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1])
      );
      // 在 ui.html 的 js 里找 function xxx( / const xxx = / var xxx =
      const definedFns = new Set();
      for (const m of ui.matchAll(/(?:function\s+|const\s+|let\s+|var\s+)([a-zA-Z_$][\w$]*)\s*(?:\(|=)/g)) definedFns.add(m[1]);
      const missingFns = [...onclickFns].filter(f => !definedFns.has(f));
      check('onclick 里的函数都有定义', missingFns.length === 0,
        missingFns.length ? '未定义: ' + missingFns.join(', ') : onclickFns.size + ' 个事件处理函数');
    }
  }

  // ── ⑬ 汇总 ──
  const bad = results.filter(r => !r.ok);
  console.log('\n════ 结果 ════');
  console.log('  ' + (results.length - bad.length) + '/' + results.length + ' 通过');
  if (bad.length) {
    console.log('\n  ❌ 没过的：');
    bad.forEach(r => console.log('     · ' + r.name + (r.detail ? '  ' + r.detail : '')));
  } else {
    console.log('  ✅ 安装器这一侧没问题。真机上才有的差异见 真机首装验证清单.md');
  }

  if (!KEEP) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  } else {
    console.log('\n  临时目录保留在: ' + stage);
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('❌ ' + (e && e.message || e)); process.exit(1); });
