/** 行业方案页：按行业场景拆解出海网络痛点与三层方案映射，挂在 /enterprise/solutions */
import { Link } from "react-router-dom";

export default function EnterpriseSolutions() {
  return (
    <div className="space-y-12">
      <section className="text-center py-6 space-y-4">
        <h1 className="text-3xl font-bold">行业解决方案</h1>
        <p className="text-slate-400 max-w-2xl mx-auto">
          不同出海业务对网络的诉求不同。以下按四类典型场景拆解痛点，
          并给出共享加速池、独享 VPS 专用节点、合规国际专线三层方案的对应关系。
        </p>
        <p className="text-xs text-slate-500">
          节点覆盖：香港 ×6 · 日本 ×4 · 马来西亚 ×1，均为实测在线的生产节点
        </p>
      </section>

      {/* 跨境电商 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">跨境电商</h2>
          <span className="text-xs text-sky-400 border border-sky-500/40 rounded-full px-3 py-0.5">
            推荐：共享加速池 → 独享 VPS
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">典型痛点</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>晚高峰跨境链路抖动，店铺后台、广告后台加载缓慢甚至超时</li>
              <li>多人共用出口 IP，机房 IP 信誉参差，易被目标平台风控关联</li>
              <li>运营、客服、选品成员各自持有凭证，离职回收困难，用量无人审计</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">对应方案</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>10~20 人小团队从<strong className="text-sky-300">共享加速池</strong>起步：当天开通，多地域节点自动切换</li>
              <li>店铺矩阵或风控敏感业务升级<strong className="text-amber-300">独享 VPS 专用节点</strong>：出口 IP 独享，不与外部用户混用</li>
              <li>企业管理面板统一归集成员凭证，开通、回收、重置集中操作</li>
              <li>按成员流量审计，异常用量自动预警，一张账单覆盖全部成员</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 游戏发行 / 出海发行 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">游戏发行 / 出海发行</h2>
          <span className="text-xs text-amber-400 border border-amber-500/40 rounded-full px-3 py-0.5">
            推荐：独享 VPS → 合规专线
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">典型痛点</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>国内研发团队访问海外发行平台、商店后台、SDK 控制台延迟高</li>
              <li>版本提审、买量投放等关键窗口期，链路波动直接影响排期</li>
              <li>发行、运营、研发多角色跨国协作，网络条件不一致、问题难复现</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">对应方案</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>20~40 人团队采用<strong className="text-amber-300">独享 VPS 专用节点</strong>（≥500 Mbps 大带宽），付费后 24 小时内交付</li>
              <li>独享节点故障自动回落共享池，关键窗口期不留空档</li>
              <li>对稳定性与合规资质有硬性要求的发行商，可评估<strong className="text-rose-300">合规国际专线</strong>：对接持牌基础运营商线路，国内入口中转</li>
              <li>SLA：节点故障 24 小时内恢复或更换，重大故障主动通报</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 外贸与海外运营 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">外贸与海外运营</h2>
          <span className="text-xs text-sky-400 border border-sky-500/40 rounded-full px-3 py-0.5">
            推荐：共享加速池
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">典型痛点</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>海外社媒、邮件系统、客户管理平台访问慢，业务员效率受影响</li>
              <li>获客渠道依赖海外平台后台，登录环境频繁变化触发安全验证</li>
              <li>业务员流动性大，个人凭证散落各处，企业资产无法统一管理</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">对应方案</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li><strong className="text-sky-300">共享加速池</strong>开箱即用：¥998 / 年起，流量不限量（公平使用），当天开通</li>
              <li>香港、日本等多地域节点，可固定使用同一地域节点保持登录环境稳定</li>
              <li>企业账户归集全部成员凭证，员工离职即时回收，业务连续性不受影响</li>
              <li>统一账单 + 按周期续费提醒，行政侧无需逐人催缴</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 远程办公团队 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">远程办公团队</h2>
          <span className="text-xs text-amber-400 border border-amber-500/40 rounded-full px-3 py-0.5">
            推荐：共享加速池 → 独享 VPS
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">典型痛点</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>成员分布各地，访问海外协作工具（代码托管、文档、视频会议）体验参差</li>
              <li>各自采购个人服务，费用报销混乱，安全基线无法统一</li>
              <li>团队扩张时逐个开通账号，缺少批量化的开通与回收手段</li>
            </ul>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium text-slate-300">对应方案</h3>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li><strong className="text-sky-300">共享加速池</strong>覆盖全员日常协作流量，多地域节点自动切换</li>
              <li>对带宽敏感的研发协作（大仓库拉取、持续集成）可叠加<strong className="text-amber-300">独享 VPS 专用节点</strong></li>
              <li>企业管理面板集中开通、回收、重置成员凭证，扩张与缩编都快</li>
              <li>按成员流量审计，用量异常自动预警，费用支出可预期</li>
            </ul>
          </div>
        </div>
      </section>

      {/* 统一事实面板 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-4">
        <h2 className="text-xl font-semibold text-center">所有方案共享的基础能力</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-center">
            <div className="text-2xl font-black text-sky-300">11 个</div>
            <p className="text-slate-400 mt-1">在线生产节点：香港 ×6、日本 ×4、马来西亚 ×1</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-center">
            <div className="text-2xl font-black text-sky-300">24 小时</div>
            <p className="text-slate-400 mt-1">SLA：节点故障 24 小时内恢复或更换</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-center">
            <div className="text-2xl font-black text-sky-300">当天开通</div>
            <p className="text-slate-400 mt-1">共享加速池当天自助开通，独享节点 24 小时内交付</p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 text-center">
            <div className="text-2xl font-black text-sky-300">统一管理</div>
            <p className="text-slate-400 mt-1">成员凭证集中管理、按成员流量审计、统一账单</p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4">
        <a
          href="mailto:support@fastergamer.cn?subject=%E4%BC%81%E4%B8%9A%E6%9C%8D%E5%8A%A1%E5%92%A8%E8%AF%A2%EF%BC%88%E8%A1%8C%E4%B8%9A%E6%96%B9%E6%A1%88%EF%BC%89&body=%E5%85%AC%E5%8F%B8%EF%BC%9A%0A%E6%89%80%E5%B1%9E%E8%A1%8C%E4%B8%9A%EF%BC%9A%0A%E5%9B%A2%E9%98%9F%E4%BA%BA%E6%95%B0%EF%BC%9A%0A%E4%B8%BB%E8%A6%81%E4%B8%9A%E5%8A%A1%EF%BC%9A"
          className="inline-block rounded-xl bg-sky-500 px-8 py-3 text-lg font-bold text-slate-950 hover:bg-sky-400 transition-colors"
        >
          告诉我们你的行业与团队规模 →
        </a>
        <p className="text-xs text-slate-500">
          24 小时内回复方案与报价 · 也可先浏览
          <Link to="/enterprise" className="text-sky-400 hover:underline mx-1">企业服务总览</Link>
          或
          <Link to="/enterprise/whitepaper" className="text-sky-400 hover:underline mx-1">跨境网络白皮书</Link>
        </p>
      </section>
    </div>
  );
}
