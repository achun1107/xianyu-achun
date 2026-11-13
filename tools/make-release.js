/**
 * tools/make-release.js — 打「可分发给学员」的代码包（zip + sha256 + 清单）
 *
 * 为什么需要它、以及为什么它同时解决了「密钥还在 git 历史里」这个问题：
 *   泄漏在【git 历史】里（`git log -p` 能挖出中台 tenant key / Supabase service_role / 企微 chat id），
 *   而**当前工作树是干净的**（tools/scrub-secrets.js 一直报「跟踪文件里没有真实密钥」）。
 *   所以：给他一个**没有 .git 的快照包**，他就拿不到历史 ——
 *   不必等密钥轮换完才能发代码。（轮换仍然要做，因为只读 token 那条路依然会暴露历史。）
 *
 * 打包内容 = `git ls-files`（只含被跟踪文件）+ 排除清单。
 *   用 ls-files 而不是遍历目录：自动排除 .gitignore 里的东西（config.local.json、
 *   service.local.json、node_modules、日志）—— 这几样恰恰是最可能带密钥的。
 *
 * ⚠️ 打完必须【扫一遍包里的内容】再落盘。扫不过就拒绝产出。
 *    "应该没有密钥"不是结论，扫过才是。
 *
 * 用法:
 *   node tools/make-release.js                    # 打两个仓（achun + playwright-service）
 *   node tools/make-release.js --only=achun
 *   node tools/make-release.js --out=D:\release
 *   node tools/make-release.js --list             # 只列出会打进包的文件，不产包
 * 退出码: 0 成功 / 1 扫出密钥或打包失败 / 2 参数问题
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ARGV = process.argv.slice(2);
const opt = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const ONLY = opt('only', '');
const OUT = opt('out', path.join('D:\\', 'xianyu-release'));
const LIST_ONLY = ARGV.indexOf('--list') >= 0;

const ACHUN = path.resolve(__dirname, '..');
let SVC_REPO = '';
let MON_REPO = '';
try {
  const P = require('../lib/env').PATHS || {};
  SVC_REPO = P.playwrightService || '';
  MON_REPO = P.xianyuMonitor || '';
} catch (e) {}

/**
 * 排除清单 —— 学员要的是"能跑起来的代码 + 说明书"，不是老板的素材和台账。
 * 注意这里【不需要】再排除 config.local.json 之类：它们本来就没被 git 跟踪。
 */
function excluded(rel) {
  const f = rel.replace(/\\/g, '/');
  if (f === 'stores/_template.json') return false;                 // 例外：建店模板要发
  // 【2026-11-13 加】tools/_syntax-check-all.js 是【学员包里的 verify-student-view 要调用的】。
  //   原来它被下面的「下划线开头 = 一次性脚本」规则排除，结果：
  //     · git 里加了（git add -f）→ 但 make-release 还是不带它
  //     · 包里 verify-student-view 的⑨组 execFileSync 调它 → ENOENT
  //   这和 install.cmd 那次是同一类错：多个环节各有一套排除规则，改一个不够。
  if (f === 'tools/_syntax-check-all.js') return false;             // 例外：自检要用
  // 【2026-11-13 第 116 轮加】ad-cost-breaker.js 是【广告花费熔断器】，
  //   每 30 分钟跑一次，学员配置手册里明确让学员用 `node ad-cost-breaker.js --dry` 预演。
  //   底下那条 /^ad-[\w-]+\.js$/ 把它一起排了 —— 自检 ⑦ 组抓到的（「缺 ad-cost-breaker.js」）。
  //   根层 39 个 ad-*.js 里只有它一个是给员工用的，其余 38 个都是老板的一次性脚本。
  if (f === 'ad-cost-breaker.js') return false;                      // 例外：学员手册要用
  const rules = [
    /^stores\//,                    // 老板各店的档案（含价格策略、素材路径）
    /^publish-assets\//,            // 85MB 素材，学员自己出
    /^publish-out\//,               // 出图产物
    /^_archive\//,                  // 历史脚本
    /^logs\//, /^_backup\//, /^release\//,
    /\.log$/, /\.ndjson$/,          // 运行日志（含真实计划名/花费）
    /\.(jpe?g|png|webp|gif|zip|pdf|psd|sqlite)$/i,   // 图片/包/账本
    /^上架台账\.json$/,              // 含 itemId + 标题 + 本地路径
    /^config\.local\.json$/, /service\.local\.json$/,
    /(^|\/)\.[^/]+$/,               // 隐藏文件
    // 【2026-10-09 加】内部文档不进学员包：
    //   index/ = 我自己的环境与账号笔记（含两个真实闲鱼手机号 + 账号 UUID）
    //   给王恩博/给小美/发给吴伟龙 这些是【发给老板或同事】的沟通件，不是学员材料，
    //   而且里面为方便对方核对写了真实账号。
    //   这不是"看着不专业"的问题 —— §9.3 明写要剥离老板的闲鱼登录信息。
    /^index\//,
    // 注意别把「给学员的一页说明.md」也排掉 —— 第一版我的模式里有 `给学员`，
    // 结果把学员最需要的安装说明从包里剔了（校验脚本抓到的）。
    // 要排的是【给同事/老板】的沟通件，不是给学员的说明书。
      /(给王恩博|发给吴伟龙|给小美|协同小美)/,
      // 【2026-11-13 加】还有几份内部件混在根层，学员打开包会看到「密钥清理说明」这种标题：
      //   - 交付说明-* / 说明与分析 / 密钥清理说明：都是给老板或我自己看的
      //   - 企微智能表格指令通道：内部通道说明
      //   学员真正需要的只有：发放说明-给学员.md / 学员安装-给学员DSH.md / install-guide.html
      /(交付说明-|说明与分析|密钥清理说明|指令通道)/,
    // 【2026-10-09 加】`tools/_*` = 本仓自己的约定「下划线开头是一次性脚本」。
    //   学员不需要它们（安装流程只用 install.ps1 / print-paths / install-config /
    //   store-init / healthcheck / install-tasks，没有一个下划线开头），
    //   而它们里常有测试用的假账号/假号码，留在包里只会让 PII 扫描狼来了。
    /(^|\/)_[^/]*$/,
  // 【2026-11-13 加】老板自己的定时任务和内部协作件 —— 学员包里不该有这些东西。
  //   实测（第 108 轮）：包里带着 111 处写死的 D:\DSH\achun，分布在 49 个文件里，
  //   其中就包括「暂停发布.cmd」「继续发布.cmd」「ad-*.cmd」「publish-*.cmd」。
  //   风险不是"看着乱"，是【误点】：
  //     · 点「暂停发布.cmd」→ 自动发布整个停掉
  //     · 点「ad-window-8am.cmd」→ 在学员机器上跑广告任务，八成报错
  //   而且这些 .cmd 里写死的都是 D:\DSH\achun，学员的目录不是这个，跑了必然失败。
  //
  //   ⚠️ 注意只排【.cmd】。`publish-one.js` / `publish-group.js` 是学员要用的，
  //      光写 /^publish-/ 会把它们一起排掉 —— 这是这类规则最容易犯的错。
  /^(ad-|publish-|stop-|jg-snapshot|night-quiet)[\w.-]*\.cmd$/,
  /^(暂停发布|继续发布)\.cmd$/,
  // 内部协作 / 交接 / 立项文档：学员看这些只会困惑
  /^(workbuddy-task-|协作|交接-|项目瘦身|管理员竞选|管理员交接|派活模板)/,
  /^(闲鱼自动化-操作手册|中台账号与Key-对照|住宅代理采购|聚光取数清单|巡检日常动作清单)\.md$/,
  /^(闲鱼项目-|闲鱼自动化项目-|票务Hope-|主图规范-|文案对照-|贴图模板-|出图SOP-|采集SOP-|多店铺快速配置|员工使用方案|中台需求|企微CLI|好易美中台-|闲鱼上架与擦亮)/,
  // 【2026-11-13 加·第二批】包里的【内部 PowerShell 脚本】。
  //   第 108 轮只排了 .cmd，这轮扫 .ps1 才发现还有一整套：
  //     ad-*.ps1（4 个）—— 老板的广告定时任务，由 Windows 计划任务唤醒
  //     wecom-send.ps1  —— 企微发消息
  //     workbuddy-*.ps1/.cmd —— 内部 CLI 登录与运行
  //     ask-dsh / make-channel / ss-call / test-guard-live / add-cmd-sheet —— 内部工具
  //     wake-publish-sleep.* —— 保活任务（注释里直接写着 D:\DSH\achun\暂停发布.cmd）
  //   学员拿到这些只会困惑（双击了多半报错），而且里面有内部地址和调用方式。
  //
  //   要保留的（学员真会双击的）：install.ps1 / install.cmd / 体检.cmd /
  //   启动.cmd / run-node.cmd / start.bat，以及 lib\ps\*.ps1（被 run-node 那条链用）。
  /^(ad-[\w-]+|wecom-send|ask-dsh|make-channel|ss-call|test-guard-live|add-cmd-sheet|workbuddy-[\w-]+|login-workbuddy|wake-publish-sleep)\.(ps1|cmd|bat)$/,
  /(^|\/)(workbuddy-[\w-]*|login-workbuddy)\.(ps1|cmd)$/,
  /(^|\/)(verify-config|test-utf8-writer)\.ps1$/,
  // 【2026-11-13 加·第三批】和闲鱼自动化无关的东西。
  //   第 110 轮按扩展名统计包里 2.35 MB 时发现的：
  //     dsh-bloom-theme-0.13.2.tgz（141 KB）/ dsh-llm-hub-0.6.1.tgz（47 KB）
  //         —— 这是【DSH 编辑器自己的主题/插件包】，和闲鱼一点关系没有
  //     dc4.txt（129 KB）—— 我早期探 goofish 接口时的探测记录（不敏感，但学员用不上）
  //     dsh-data-backend-prompt.md —— 内部提示词
  //   这类东西的特征是：在 git 里（所以会被打包），但没人想到要排。
  /^dsh-.*\.(tgz|md)$/,
  /^dc4\.txt$/,
  // 各种「探测/抓包」留下的 .txt / .json（都是开发时的中间产物）
  /^(probe|dc\d+|netcap|_netcap)[\w.-]*\.(txt|json)$/,
  // 【2026-11-13 加·第四批】根层那一堆探测记录和业务文档。
  //   第 111 轮扫 .txt 发现包里有 39 个，其中绝大部分是：
  //     · 我探 goofish 接口时 dump 下来的（recon / dc-* / label-* / items-* / seller-api …）
  //     · 老板的业务交底书（票务业务-交底书-微信版.txt 25 KB）—— 这是【业务机密】
  //     · publish-groups/*.log.txt —— 发布日志，里面有真实商品名和 D:\DSH\achun 路径
  //   都不是学员该看的。
  //   ⚠️ PACKAGE-README.txt 要保留（三个仓库各一份，说明这个目录是什么）。
  /^(datacompass\d*|dc-[\w-]+|label-[\w-]+|recon\d*|status-[\w-]+|dig-[\w-]+|nav-links|card-shape|item-perf|items-[\w-]+|seller-api\d*|stat-probe|newest|scripts|user-tpl|param-cap|after-click|cap\d+|q|ad-[\w-]+)\.txt$/,
  /^(票务业务-|票务交底书|xy-copy-report)/,
  /(^|\/)publish-groups\/.*\.log\.txt$/,
  // 【2026-11-13 加·第五批】根层那一堆内部复盘文档。
  //   第 111 轮扫 .md 发现包里有 69 个，其中 47 个是【老板和我自己的执行记录】：
  //     · *-执行结果.md（十来个）—— 某次推广/补齐链接的结果
  //     · 出价变更记录.md（34 KB）/ 上架执行记录-*.md / 推广开启记录-*.md
  //     · 闲鱼同行数据-14明星*.md（24 KB）—— 竞品数据，业务机密
  //     · 今日表现分析-*.md / 状态快照-*.md / 教训-*.md / 私董会功能测试反馈-*.md
  //   这些是"我做完了什么"的记录，不是"学员怎么用"的说明。
  //   ⚠️ 别把「学员配置手册.md」「给学员的一页说明.md」这类排掉 —— 名字里没有这些关键词。
  /(执行结果|变更记录|上架执行记录|推广开启记录|停推广-|暂停计划-方法|状态快照-|今日表现分析|教训-|私董会功能测试反馈|同行数据|同行文案分析|商品与表现细读|主图AB测试|模板测试|验证清单-第|全流程测试与配置向导|未覆盖商品-可投机会|订单量目标-平台限制|六明星-单明星计划|单明星-三计划|单明星-补齐链接|热销Top5计划|十八轮变更清单|最终验收报告|广州守望先锋-上架|广州王嘉尔-上架|守望先锋-王嘉尔-推广|刘宪华-模板测试|徐良-三计划|三角洲-近期开抢)/,
  // 0 KB 的测试消息
  /^(wecom-test-msg|ad-cost-breaker-msg|stuck-recovered-msg)\.md$/,
  // 【2026-11-13 加·第六批】最后两个
  //   「待办-等登录后执行.md」—— 我自己的 TODO，和学员无关
  //   「标价对照表-14明星.md」—— 168 条同行代拍商品的实测标价（2026-09-21 抓取），业务机密
  /^(待办-|标价对照表-)/,
  // 【2026-11-13 加·第七批】根层那一堆【业务抓取数据】。
  //   第 112 轮扫 .json 发现根层有 248 个，1491 KB，绝大多数是我从闲鱼后台 dump 下来的：
  //     ad-*.json   112 个 —— 广告后台（真实花费 / 余额 / 点击成本 / 擦亮中计划）
  //     xy-*.json    30 个 —— 扫店/竞品汇总（xy-competitor-summary 45 KB）
  //     items-*.json 12 个 —— 商品列表快照
  //     damai-*.json      —— 大麦在架数据
  //   这些是【老板的经营数据】，发给学员既没用又泄露。
  //
  //   ⚠️ 必须限定根层（^）。子目录里的同名要留：
  //      lib/config.json（运行时配置）/ presets/*（建店预设）/
  //      stores/_template.json（建店模板）/ package.json
  /^(ad|xy|items|item|damai|plans?|verify|consol|raise150|half|ab|all-items|提到150)[-_.][\w.\u4e00-\u9fa5-]*\.json$/,
  /^(item-data|items-want|xy-[\w-]+|ad-[\w-]+|all-items\d*)\.json$/,
  // 【2026-11-13 加·第八批】剩下的几个业务数据文件。
  //   onsale.json         —— 在售商品快照（真实 itemId + 标题 + 销量）
  //   my-plans.json       —— 广告计划全字段
  //   AD-EXCLUDE.json     —— 排除名单，里面写着老板的原话指令
  //   shows-hold.json     —— 暂存任务（含真实商品标题）
  //   publish-schedule.json —— 10-11 的上架排期（老板的原话也在里面）
  //   webkubor-baseline.json —— GitHub 仓库基线，和闲鱼完全无关
  //   poster-templates.backup_*.json —— 备份文件
  //   console-out-*.json  —— 控制台抓取输出
  //   ⚠️ 检查过：publish-one.js 里提到 publish-schedule.js 只是【注释】，
  //      不是真的读那个 json，排掉不会让发布链报错。
  /^(my-plans|onsale|AD-EXCLUDE|webkubor-baseline|shows-hold|publish-schedule|combined|console-out-[\d]+|poster-templates\.backup_[\w]+|待删除清单-)/,
  // 【2026-11-13 加·第九批】四个【纯业务数据目录】。
  //   第 113 轮扫包发现：492 个文本文件里有 982 处真实 itemId、118 处「老板原话」。
  //   来源就是这四个目录：
  //     xy-daily/*.json       —— 每日抓取快照（无任何代码引用，纯数据）
  //     data/ad-daily.json    —— 广告日报，442 处真实 itemId
  //     publish-groups/*.json —— 发布方案（140 个，引用它的脚本不在包里）
  //     shows/*.json          —— 场次档案（56 个，含「老板 2026-10-15」这种指令原文）
  //
  //   已核实：学员会用的五个脚本（publish-one / first-publish / store-wizard /
  //   store-init / healthcheck）【一个都不引用这些目录】。排掉不影响学员。
  /^(xy-daily|publish-groups|shows)\//,
  /^data\//,
  // 【2026-11-13 加·第十批】根层剩下的运行产物（跑一次就生成一个，含真实 itemId）。
  //   第 113 轮扫完还剩 260 处 itemId，主要来自这几个：
  //     healthcheck.json（43 处）—— 一键体检的缓存结果
  //     campaigns-now.json（21 处）/ pause-result-*.json（14 处）
  //     cz-diag.json / cz-probe.json（各 12 处）—— 排查时 dump 的
  //   这些都是"跑完就有、下次跑会重新生成"的东西，学员机器上第一次跑自己会写。
  /^(healthcheck|campaigns-now|cz-diag|cz-probe|pause-result-[\d]+|ad-pending|dig-\w+)[\w.-]*\.json$/,
  // 【2026-11-13 加·第十一批】老板的广告【脚本】（.js）。
  //   前面排 ad-*.ps1 / ad-*.cmd / ad-*.json，漏了 .js ——
  //   第 113 轮 scan-package 扫出来 ad-stop-two.js（8 处真实 itemId）、
  //   ad-stop-shows.js（7 处）还在包里。这些是"停某几个计划"的专用脚本，
  //   里面写死了老板的 itemId，学员双击/运行只会报错。
  //
  //   ⚠️【2026-11-13 第 116 轮修】这条规则误伤了 ad-cost-breaker.js ——
  //      它是【广告花费熔断器】，每 30 分钟跑一次，学员配置手册里明确让学员
  //      用 `node ad-cost-breaker.js --dry` 做熔断预演。自检 ⑦ 组抓到的（缺 ad-cost-breaker.js）。
  //      根层 39 个 ad-*.js 里只有它一个是给员工用的，其余 38 个都是老板的一次性脚本。
  /^ad-[\w-]+\.js$/,
  /^(pause|resume|stop|start)-[\w-]+\.js$/,
  // 【2026-11-13 加·第十二批】打包工具本身。第 114 轮扫 tools\ 时发现它还在包里：
  //   make-release.js 是"打三个仓 + 生成 zip"的工具，只在打包机上跑。
  //   学员拿到它没有任何用途，而且它里面有 D:\xianyu-release / D:\xianyu-public 这些
  //   本机路径，跑了必然报错。
  //   （verify-student-view.js 和 _syntax-check-all.js 保留 —— 技术负责人
  //     拿到包之后可以用它们复核，而且它们找不到包时会自己说明"这是给技术负责人用的"。）
  /^tools\/make-release\.js$/,
  /^make-release\.js$/,
  ];
  return rules.some((r) => r.test(f));
}

/**
 * 手机号检测 —— 必须带【数字边界】。
 *
 * ⚠️ 第一版我写的是 `1[3-9]\d{9}`（不带边界），结果在 70 个文件里报了 270 个"手机号" ——
 *   而那些几乎全是 13 位闲鱼 itemId 的前 11 位（正则从一个更长的数字里截了一段）。
 *   一个会在 70 个文件上狼来了的检查器，比没有检查器更糟（见 工程纪律.md 纪律二）。
 *   加上 (?<!\d) / (?!\d) 之后，真命中从 270 降到 6（4 个文件、2 个号码）。
 */
const PHONE_RE = /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g;

/**
 * 明显是假号的白名单 —— 否则"我把测试桩里的真号换成假号"这个动作本身会把发版卡住
 * （实测：换完立刻扫出 13800000001/13800000002 并拒绝产出）。假号必须放行，真号必须拦。
 */
const FAKE_PHONES = new Set(['13800000001', '13800000002', '13800000003', '13800138000']);
/** 自检用的号码在源码里【不许写成连续 11 位】——否则扫描器会把自己的源码当命中 */
const SELFTEST_PHONE = ['139', '1234', '5678'].join('');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * 载入本机已知的真实【凭证】，用来扫包。
 *
 * ⚠️ 这里必须区分「凭证」和「端点」—— 第一版把 adminHost / supaUrl 也当密钥，
 *   结果 server.js 立刻"命中"，把发版整个卡住。那是假阳性：
 *   `https://xxx.supabase.co` 和后台主机名是【配置里的地址】，出现在代码里天经地义。
 *   假阳性比漏报更快毁掉一个检查器（参见 工程纪律.md 纪律二）。
 *
 * 判定规则：
 *   凭证  → 必须扫，命中就拒绝产出
 *   端点  → 不扫（URL/主机名）；除非 URL 里带 token/key 查询参数（那种 webhook 就是凭证）
 */
const ENDPOINT_KEYS = ['adminHost', 'supaUrl', 'base', 'host', 'url', 'apiBase', 'middleBase', 'smtpHost'];
const CREDENTIAL_KEYS = ['apiKey', 'hymKey', 'hymPass', 'hymUser', 'supaKey', 'SUPABASE_SERVICE_KEY',
  'tenant', 'key', 'chatId', 'webhook', 'feishuWebhook', 'password', 'passwd', 'secret', 'token'];

/** URL 里带 token/key/signature 这类查询参数 → 它本身就是凭证 */
function urlIsCredential(v) {
  return /^https?:\/\//i.test(v) && /[?&](key|token|secret|sign|signature|access_token|apikey)=/i.test(v);
}

function secretValues() {
  const vals = [];
  const add = (k, v) => {
    const s = String(v || '').trim();
    if (s.length < 8) return;
    const isUrl = /^https?:\/\//i.test(s);
    if (ENDPOINT_KEYS.some((e) => k === e) && !urlIsCredential(s)) return;   // 纯端点 → 不是凭证
    if (CREDENTIAL_KEYS.some((c) => k.toLowerCase().indexOf(c.toLowerCase()) >= 0)) { vals.push({ k, v: s }); return; }
    // 键名不认识时保守处理：URL 默认不算，其它算
    if (!isUrl) vals.push({ k, v: s });
  };
  const j = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } };
  const c = j(path.join(ACHUN, 'config.local.json'));
  Object.keys(c.service || {}).forEach((k) => add(k, c.service[k]));
  Object.keys(c.middle || {}).forEach((k) => add(k, c.middle[k]));
  Object.keys(c.wecom || {}).forEach((k) => add(k, c.wecom[k]));
  if (SVC_REPO) {
    const s = j(path.join(SVC_REPO, 'service.local.json'));
    Object.keys(s).forEach((k) => add(k, s[k]));
  }
  return vals;
}

/** 扫一个目录里的所有文本文件，返回命中（凭证 + 手机号） */
function scan(dir, secrets) {
  const hits = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > 4 * 1024 * 1024) continue;
      let buf;
      try { buf = fs.readFileSync(p); } catch (e) { continue; }
      if (buf.indexOf(0) >= 0) continue;                 // 二进制跳过
      const txt = buf.toString('utf8');
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      secrets.forEach((s) => {
        if (txt.indexOf(s.v) >= 0) hits.push({ file: rel, key: s.k, secret: s.v.slice(0, 6) + '****' });
      });
      // 手机号：学员包里不该出现任何人的真实号码（明显假号放行，见 FAKE_PHONES）
      const phones = txt.match(PHONE_RE);
      if (phones) [...new Set(phones)].filter((ph) => !FAKE_PHONES.has(ph))
        .forEach((ph) => hits.push({ file: rel, key: '手机号', secret: ph.slice(0, 3) + '****' + ph.slice(7) }));
    }
  };
  walk(dir);
  return hits;
}

function pack(repoDir, name, secrets) {
  if (!fs.existsSync(repoDir)) { console.log('❌ 找不到仓库: ' + repoDir); return null; }
  let files;
  try { files = git(repoDir, ['ls-files', '-z']).split('\0').filter(Boolean); }
  catch (e) { console.log('❌ ' + repoDir + ' 不是 git 仓库（' + e.message.slice(0, 60) + '）'); return null; }

  const keep = files.filter((f) => !excluded(f) && fs.existsSync(path.join(repoDir, f)));
  const skipped = files.length - keep.length;

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let head = 'nogit';
  try { head = git(repoDir, ['rev-parse', '--short', 'HEAD']); } catch (e) {}
  const version = stamp + '-' + head;
  const zipName = name + '-' + version + '.zip';

  console.log('\n════ ' + name + ' ════');
  console.log('  仓库      : ' + repoDir);
  console.log('  跟踪文件  : ' + files.length + '，打进包 ' + keep.length + '，排除 ' + skipped);
  const bytes = keep.reduce((s, f) => s + fs.statSync(path.join(repoDir, f)).size, 0);
  console.log('  原始体积  : ' + (bytes / 1048576).toFixed(1) + ' MB');
  if (LIST_ONLY) { keep.forEach((f) => console.log('    ' + f)); return null; }

  // ── 先在临时目录拼出来，扫过之后再打 zip ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-rel-'));
  const stage = path.join(tmp, name);
  keep.forEach((f) => {
    const dst = path.join(stage, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(repoDir, f), dst);
  });
  // 放一份「这个包是什么、怎么用」的说明在包根
  fs.writeFileSync(path.join(stage, 'PACKAGE-README.txt'),
    name + ' 代码包 ' + version + '\n' +
    '由 tools/make-release.js 生成；只含被 git 跟踪的代码文件，不含 .git、配置、素材、台账。\n' +
    '安装：解压到目标目录后跑 install.cmd（详见 给学员的一页说明.md）。\n', 'utf8');

  // ── version.json（需求书《中台需求-代码包分发与更新.md》§3.1 要点 5）──
  // 学员机靠它回答「我现在是哪一版」，tools/update.js --middle 会把 version 传给中台，
  // 中台比一下就直接回 upToDate（只传几百字节，不重复下 4MB）。
  // ⚠️ 格式必须是 { version, builtAt, commit }：update.js 的 readVersion() 读的是 .version。
  const builtAt = new Date().toISOString();
  fs.writeFileSync(path.join(stage, 'version.json'),
    JSON.stringify({ version, builtAt, commit: head, pack: name }, null, 2) + '\n', 'utf8');

  const hits = scan(stage, secrets);
  if (hits.length) {
    console.log('  ❌ 包里扫出 ' + hits.length + ' 处本机真实凭证 —— 拒绝产出：');
    hits.slice(0, 10).forEach((h) => console.log('       ' + h.file + '  ← ' + h.key + ' = ' + h.secret));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    return { fail: true };
  }
  console.log('  ✅ 凭证扫描通过（拿本机 ' + secrets.length + ' 个真实凭证逐个文件查过）');

  fs.mkdirSync(OUT, { recursive: true });

  // 【2026-10-10 加】产出前先删掉【同一个仓的老版本】。
  //   为什么必须自动做：这个目录里躺两个版本时，选文件的一方（人也好、脚本也好）
  //   极容易拿错 —— 我自己验证时就被 Get-ChildItem -Filter 按名字排序选中了旧包，
  //   差点据此得出"包里还有手机号"的错结论。**同名多版本是发错文件的头号原因。**
  ['zip', 'zip.sha256', 'manifest.json'].forEach((ext) => {
    const suffix = '.' + ext;
    fs.readdirSync(OUT).forEach((f) => {
      if (f.startsWith(name + '-') && f.endsWith(suffix) && f !== zipName + suffix && !f.startsWith(zipName)) {
        try { fs.unlinkSync(path.join(OUT, f)); console.log('  🗑  清掉同仓旧版本: ' + f); } catch (e) {}
      }
    });
  });

  const zipPath = path.join(OUT, zipName);
  let zipped = false;
  try { execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', tmp, name], { stdio: 'ignore' }); zipped = true; }
  catch (e) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Compress-Archive -Path "' + stage + '" -DestinationPath "' + zipPath + '" -Force'], { stdio: 'ignore' });
      zipped = true;
    } catch (e2) {}
  }
  if (!zipped) { console.log('  ❌ 压缩失败（tar 和 Compress-Archive 都不行）'); return { fail: true }; }

  const buf = fs.readFileSync(zipPath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(zipPath + '.sha256', sha + '  ' + zipName + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, name + '-' + version + '.manifest.json'),
    JSON.stringify({ name, version, head, at: new Date().toISOString(), files: keep.length, excluded: skipped, bytes: buf.length, sha256: sha, list: keep }, null, 2), 'utf8');

  console.log('  ✅ ' + zipPath);
  console.log('     体积 ' + (buf.length / 1048576).toFixed(1) + ' MB   sha256 ' + sha.slice(0, 16) + '…');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return { zipName, sha, bytes: buf.length, files: keep.length };
}

(async () => {
  // ── --selftest：给扫描器做阳性/阴性对照 ──
  //   为什么必须有：一个只会说"通过"的检查器等于没有检查器。
  //   而且第一版就是被假阳性卡住的（把 supaUrl 端点当成密钥）。所以两边都要验：
  //     阳性对照：把一个真凭证塞进临时文件 → 必须被抓到
  //     阴性对照：端点 URL / 主机名 → 必须不被抓
  if (ARGV.indexOf('--selftest') >= 0) {
    const secrets = secretValues();
    if (!secrets.length) { console.log('❌ 本机读不到任何凭证，自检无从谈起'); process.exit(2); }
    const real = secrets[0];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-scan-'));
    fs.writeFileSync(path.join(tmp, 'hit.js'), 'const k = "' + real.v + '";\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'endpoint.js'), 'const u = "https://abcdefg.supabase.co";\nconst h = "admin.example.com";\n', 'utf8');
    // 手机号对照：真号必须抓到；13 位 itemId 必须【不】抓（第一版就在这里狼来了 270 次）
    fs.writeFileSync(path.join(tmp, 'phone.js'), 'const p = "' + SELFTEST_PHONE + '";\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'itemid.js'), 'const id = "1788450123456";\nconst id2 = "1089153350454";\n', 'utf8');
    const hits = scan(tmp, secrets);
    const caughtReal = hits.some((h) => h.file === 'hit.js');
    const flaggedEndpoint = hits.some((h) => h.file === 'endpoint.js');
    const caughtPhone = hits.some((h) => h.file === 'phone.js' && h.key === '手机号');
    const flaggedItemId = hits.some((h) => h.file === 'itemid.js');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log('扫描器自检（本机 ' + secrets.length + ' 个凭证）');
    console.log('  ' + (caughtReal ? '✅' : '❌') + ' 阳性对照：真凭证被塞进文件 → ' + (caughtReal ? '抓到了' : '【漏报！扫描器是坏的】'));
    console.log('  ' + (!flaggedEndpoint ? '✅' : '❌') + ' 阴性对照：端点 URL / 主机名 → ' + (!flaggedEndpoint ? '正确忽略' : '【假阳性！会无谓卡住发版】'));
    console.log('  ' + (caughtPhone ? '✅' : '❌') + ' 手机号对照：11 位真号 → ' + (caughtPhone ? '抓到了' : '【漏报】'));
    console.log('  ' + (!flaggedItemId ? '✅' : '❌') + ' 手机号反例：13 位 itemId → ' + (!flaggedItemId ? '正确忽略（带数字边界）' : '【假阳性！itemId 被当成手机号】'));
    process.exit(caughtReal && !flaggedEndpoint && caughtPhone && !flaggedItemId ? 0 : 1);
  }

  console.log('输出目录 : ' + OUT);
  const secrets = secretValues();
  console.log('本机凭证 : 载入 ' + secrets.length + ' 个用于扫描');

  const jobs = [];
  if (!ONLY || ONLY === 'achun') jobs.push([ACHUN, 'xianyu-achun']);
  if ((!ONLY || ONLY === 'service') && SVC_REPO) jobs.push([SVC_REPO, 'xianyu-playwright-service']);
  // 【2026-10-10 加】xianyu-monitor 是【第三个仓】，而且不是可选的：
  //   playwright-service 的 server.js/agent.js 运行时要读它（MONITOR_DIR 静态目录、
  //   EXTENSION_PATH 注入脚本、native_host.py），缺文件时是 if(!exists) continue 静默跳过 ——
  //   学员机上「界面能开、/health 正常，但发布和广告全都不工作且零报错」就是缺这个仓造成的。
  //   吴卫龙的 agent 自己也点出来了：「找发件人要 xianyu-monitor」。
  if ((!ONLY || ONLY === 'monitor') && MON_REPO) jobs.push([MON_REPO, 'xianyu-monitor']);
  if (!jobs.length) { console.log('❌ 没有可打的仓（--only 写错了？或 playwright-service 路径解析不到）'); process.exit(2); }

  const results = jobs.map(([d, n]) => pack(d, n, secrets));
  const failed = results.filter((r) => !r || r.fail);
  if (failed.length) {
    if (LIST_ONLY) process.exit(0);
    console.log('\n❌ 有 ' + failed.length + '/' + results.length + ' 个包没打成（或扫出凭证）—— 不要发出去');
    process.exit(1);
  }

  console.log('\n════ 可以发的包 ════');
  results.forEach((r) => console.log('  ' + r.zipName + '   ' + (r.bytes / 1048576).toFixed(1) + ' MB   ' + r.files + ' 文件'));
  console.log('  sha256 都在同目录的 .sha256 里 —— 发的时候一起带上，让学员那边校验。');
  console.log('\n⚠️ 这个包【不含】.git，所以学员拿不到含密钥的历史；');
  console.log('   但也因此不能用 git 更新 —— 更新走 node tools/update.js --from=<新包URL> 或重新发包覆盖。');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
