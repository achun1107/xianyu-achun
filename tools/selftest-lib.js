/**
 * tools/selftest-lib.js — 公共库自检
 *
 * 不连网也能跑（测配置与纯函数）；服务在跑时顺带验证真实链路。
 * 用法: node tools/selftest-lib.js [--live]
 */
const out = require('../lib/out');
const env = require('../lib/env');
const http = require('../lib/http');
const agent = require('../lib/agent');
const mtop = require('../lib/mtop');
const args = require('../lib/args');
const logmod = require('../lib/log');

(async () => {
  out.head('公共库自检');

  // ── 配置 ──
  out.kv('项目根', env.ROOT);
  out.kv('服务', env.serviceBase);
  out.kv('默认店铺', env.STORE);
  out.kv('运营店铺', env.ACTIVE.join('、') + '（名册共 ' + env.STORES.length + ' 个账号）');
  out.kv('店铺数', env.STORES.length);
  out.kv('Key 长度', String(env.SVC.apiKey || '').length);
  out.kv('阈值', JSON.stringify(env.TH));
  out.kv('永久规则', '咨询≤' + env.RULES.chatCap + ' 订单≤' + env.RULES.orderCap + ' 集合前缀=' + env.RULES.collectionPrefix);

  let bad = 0;
  const assert = (cond, msg) => { if (cond) out.ok(msg); else { out.bad(msg); bad++; } };

  assert(env.SVC.apiKey && env.SVC.apiKey.length > 20, 'Key 已加载');
  // ⚠️ 【2026-10-09 修·真实缺陷】原来这里断言 `env.STORE === '好易美代拍'`。
  //   而 tools/update.js 把这个自检当成【更新后的门禁】—— 于是任何默认店不是
  //   「好易美代拍」的学员机，每次更新都会自检失败 → 回滚 → 退出码 2，
  //   整套「自动更新」等于不存在（而需求书 9.2 说「没有这个就不要分发」）。
  //   这个断言本来要防的是【店铺名被编码搞坏】（BOM/GBK 那类），不是防"店名不是老板的店"。
  //   所以改成查那件事本身：非空、无替换字符、且在名册里。
  assert(!!env.STORE && env.STORE.indexOf('\uFFFD') < 0, '店铺名非空且不含乱码字符（' + env.STORE + '）');
  assert(env.STORES.indexOf(env.STORE) >= 0, '默认店铺在名册里：' + env.STORE);
  assert(env.ACTIVE.length >= 1 && env.ACTIVE.every((n) => env.STORES.indexOf(n) >= 0),
    'active 店铺是名册的子集：' + env.ACTIVE.join('、'));
  assert(env.ACTIVE.indexOf(env.STORE) >= 0, '默认店铺在 active 里');
  assert(env.p('lib', 'config.json').endsWith('lib/config.json'), 'p() 路径拼接正确');

  // ── 纯函数 ──
  assert(mtop.planVerdict({ statusGroup: 'online', statusDescTitle: '' }) === 'online', '状态判定 online');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '手动暂停' }) === 'manual_paused', '状态判定 手动暂停');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '账户余额不足，系统暂停' }) === 'balance_paused', '状态判定 余额不足');
  assert(mtop.planVerdict({ statusGroup: 'paused', statusDescTitle: '超过日预算上限，系统暂停' }) === 'budget_paused', '状态判定 超预算');
  assert(mtop.isCollection('擦亮宝贝20260927113406') === true, '集合计划识别');
  assert(mtop.isCollection('孙燕姿广州-订单120') === false, '单链接识别');
  assert(mtop.yuan(2750) === 27.5, '分转元');

  const np = mtop.normalizePlan({ campaignId: 1, title: '擦亮宝贝X', statusGroup: 'online', bidTarget: 'chat',
    cpm: 500, maxDayBudget: 15000, adDataDetailVO: { cost: 6000, chatPv: 3 }, infoTab: { todayCost: 1200 }, todayAdDataDetail: { chatPv: 2 }, entityList: [{ entityId: 9 }] });
  assert(np.budgetYuan === 150 && np.isCollection === true && Math.abs(np.costPerChat - 20) < 0.01, 'normalizePlan 计算正确');

  const a = args.parse(['广州', '宋雨琦', '--n=3', '--dry', '--store', '好易美代拍']);
  assert(a._.length === 2 && a.n === '3' && a.dry === true && a.store === '好易美代拍', 'args 解析（含中文）');

  // ── 服务 ──
  const up = await http.alive();
  out.kv('服务存活', up ? '是' : '否');
  if (!up) {
    out.warn('服务没在跑，跳过联机检查（--live 也需要它）');
  } else if (process.argv.includes('--live')) {
    try {
      const st = await agent.status();
      out.kv('agent 状态', JSON.stringify(st).slice(0, 120));
      await agent.ready();
      out.ok('店铺页面已打开');
      const plans = await mtop.adPlans({ days: 7 });
      out.ok('拉到计划 ' + plans.length + ' 条');
      out.table(mtop.PLAN_HEADERS, plans.slice(0, 14).map(mtop.planRow), { maxCol: [12, 24, 6, 12, 10, 10, 8, 6, 5] });
      out.full(plans, 'selftest-plans');
    } catch (e) {
      out.bad('联机检查失败：' + e.message);
      bad++;
    }
  }

  out.head('结果');
  if (bad) out.bad(bad + ' 项未通过');
  else out.ok('全部通过');
  out.done(bad ? 1 : 0);
})().catch((e) => out.fail(e));
