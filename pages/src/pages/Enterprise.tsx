/** 企业服务页：面向出海企业的网络加速方案总览，供客户了解与渠道洽谈展示 */
export default function Enterprise() {
  return (
    <div className="space-y-12">
      <section className="text-center py-6 space-y-4">
        <h1 className="text-3xl font-bold">出海企业网络加速服务</h1>
        <p className="text-slate-400 max-w-2xl mx-auto">
          面向跨境电商、外贸、游戏发行、海外运营团队的分层网络方案：
          从开箱即用的加速池，到独享节点，再到对接持牌运营商的合规国际专线。
        </p>
      </section>

      {/* 三层方案 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-3">
          <h3 className="text-lg font-semibold">共享加速池</h3>
          <p className="text-2xl font-black text-sky-300">¥588 <span className="text-sm font-normal text-slate-500">/ 年</span></p>
          <ul className="text-sm text-slate-400 space-y-1.5">
            <li>✓ 10~20 人团队</li>
            <li>✓ 流量不限量（公平使用）</li>
            <li>✓ 多地域节点自动切换</li>
            <li>✓ 当天开通，自助管理</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-amber-500/50 bg-slate-900 p-6 space-y-3">
          <h3 className="text-lg font-semibold">专用节点</h3>
          <p className="text-2xl font-black text-amber-300">¥988 <span className="text-sm font-normal text-slate-500">/ 年</span></p>
          <ul className="text-sm text-slate-400 space-y-1.5">
            <li>✓ 20~40 人团队</li>
            <li>✓ 500 Mbps 端口独享</li>
            <li>✓ 专用故障自动回落共享池</li>
            <li>✓ 付费后 24 小时内交付</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-rose-500/40 bg-slate-900 p-6 space-y-3">
          <h3 className="text-lg font-semibold">合规国际专线</h3>
          <p className="text-2xl font-black text-rose-300">定制报价</p>
          <ul className="text-sm text-slate-400 space-y-1.5">
            <li>✓ 对接持牌基础运营商线路</li>
            <li>✓ 国内入口中转，晚高峰稳定</li>
            <li>✓ 带宽按需配置，按月扩容</li>
            <li>✓ 可提供合同与发票</li>
          </ul>
        </div>
      </section>

      {/* 企业管理面板 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <h2 className="text-xl font-semibold text-center">企业管理面板</h2>
        <p className="text-sm text-slate-400 text-center max-w-2xl mx-auto">
          企业客户不止买线路，更买管理确定性。以下能力按企业套餐逐步开放：
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto text-sm">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <div className="font-medium mb-1">成员统一管理</div>
            <p className="text-slate-400">一个企业账户归集全部成员连接凭证，开通、回收、重置集中操作</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <div className="font-medium mb-1">按成员流量审计</div>
            <p className="text-slate-400">每个成员独立计量，谁用了多少一目了然，异常用量自动预警</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <div className="font-medium mb-1">统一账单</div>
            <p className="text-slate-400">一张账单覆盖全部成员和节点，支持按周期续费提醒</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4">
            <div className="font-medium mb-1">SLA 与专属支持</div>
            <p className="text-slate-400">节点故障 24 小时内恢复或更换，邮件优先响应，重大故障主动通报</p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4">
        <a
          href="mailto:support@fastergamer.cn?subject=%E4%BC%81%E4%B8%9A%E6%9C%8D%E5%8A%A1%E5%92%A8%E8%AF%A2&body=%E5%85%AC%E5%8F%B8%EF%BC%9A%0A%E5%9B%A2%E9%98%9F%E4%BA%BA%E6%95%B0%EF%BC%9A%0A%E4%B8%BB%E8%A6%81%E4%B8%9A%E5%8A%A1%EF%BC%9A%0A%E6%9C%9F%E6%9C%9B%E6%96%B9%E6%A1%88%EF%BC%9A"
          className="inline-block rounded-xl bg-sky-500 px-8 py-3 text-lg font-bold text-slate-950 hover:bg-sky-400 transition-colors"
        >
          邮件咨询企业方案 →
        </a>
        <p className="text-xs text-slate-500">
          说明公司、团队人数、主要业务，24 小时内回复方案与报价
        </p>
      </section>
    </div>
  );
}
