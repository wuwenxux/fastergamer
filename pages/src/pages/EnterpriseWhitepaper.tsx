/** 出海企业跨境网络白皮书：风险科普 → 自建 vs 采购对比 → 选型清单 → 方案对应，挂在 /enterprise/whitepaper */
import { Link } from "react-router-dom";

export default function EnterpriseWhitepaper() {
  return (
    <div className="space-y-12">
      <section className="text-center py-6 space-y-4">
        <h1 className="text-3xl font-bold">出海企业跨境网络白皮书</h1>
        <p className="text-slate-400 max-w-2xl mx-auto">
          一份面向出海企业决策者的选型参考：跨境网络的常见风险、自建与采购的取舍，
          以及一份可直接使用的选型清单。
        </p>
        <p className="text-xs text-slate-500">最后更新：2026 年 9 月</p>
      </section>

      {/* 一、常见风险 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <h2 className="text-xl font-semibold">一、跨境网络的三个常见风险</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-5 space-y-2">
            <div className="font-medium text-sky-300">链路拥塞</div>
            <p className="text-slate-400">
              公共国际出口在晚高峰（约 20:00–24:00）拥塞明显，丢包与抖动上升。
              对后台操作类业务表现为加载慢，对实时协作类业务表现为卡顿与掉线。
              这是物理链路容量问题，换设备、换浏览器都无法解决。
            </p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-5 space-y-2">
            <div className="font-medium text-sky-300">IP 信誉</div>
            <p className="text-slate-400">
              海外平台普遍对访问来源 IP 做信誉评估。数据中心 IP 段被大量未知用户
              混用时，整体信誉下降，容易触发额外验证甚至账号关联限制。
              对跨境电商、广告投放等账号资产型业务，这是最直接的资产风险。
            </p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-5 space-y-2">
            <div className="font-medium text-sky-300">合规资质</div>
            <p className="text-slate-400">
              企业跨境联网需要关注服务商的线路来源与经营资质。面向对合规有硬性
              要求的场景，应选择对接持牌基础运营商的线路服务，并保留合同与
              发票等凭证，避免使用来源不明的个人搭建服务。
            </p>
          </div>
        </div>
      </section>

      {/* 二、自建 vs 采购 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <h2 className="text-xl font-semibold">二、自建还是采购：一笔实际账</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-5 space-y-3">
            <div className="font-medium">自建（团队自行租 VPS 搭建）</div>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>显性成本低（一台 VPS 每月几十元），但隐性成本高：需要专人维护</li>
              <li>节点故障时没有替补，恢复时间取决于值班同事何时看到告警</li>
              <li>成员凭证靠群文件流转，离职回收靠自觉，无流量审计能力</li>
              <li>多地域覆盖意味着多倍维护量，规模越大越失控</li>
            </ul>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-5 space-y-3">
            <div className="font-medium">采购（成熟的分层服务）</div>
            <ul className="text-slate-400 space-y-2 list-disc list-inside">
              <li>按年付费即可覆盖团队全部成员，无需专职维护人力</li>
              <li>有明确 SLA（故障恢复时限）与故障回落机制</li>
              <li>管理面板提供成员凭证集中管理与按成员流量审计</li>
              <li>多地域节点由服务商统一运维，扩容只需升档</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          经验值：团队超过 5 人、或业务对网络中断敏感时，采购的综合成本通常低于自建。
          这只是经验参考，具体取决于团队现有运维能力。
        </p>
      </section>

      {/* 三、选型清单 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <h2 className="text-xl font-semibold">三、选型清单（Checklist）</h2>
        <p className="text-sm text-slate-400">
          评估任一跨境网络服务商时，建议逐项确认以下问题。回答不上来的项，就是风险项：
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {[
            "节点覆盖哪些地域？是自有运维还是转售？在线率如何验证？",
            "晚高峰时段是否有实测数据？是否允许先试用再付费？",
            "出口 IP 是共享还是独享？能否满足账号资产型业务的隔离要求？",
            "是否有明确的 SLA？故障后的恢复时限与替补机制是什么？",
            "成员凭证能否集中开通、回收、重置？有无按成员的流量审计？",
            "计费方式是否透明？能否提供统一账单、合同与发票？",
            "线路来源是否合规？能否说明与持牌运营商的关系？",
            "支持渠道与响应时限是什么？重大故障是否主动通报？",
          ].map((item) => (
            <div key={item} className="flex items-start gap-2 rounded-xl bg-slate-950/60 border border-slate-800 p-4">
              <span className="text-sky-400 mt-0.5">☐</span>
              <span className="text-slate-300">{item}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 四、我们的方案对应 */}
      <section className="rounded-2xl border border-slate-700 bg-slate-900 p-8 space-y-5">
        <h2 className="text-xl font-semibold">四、GameBoost 企业方案如何作答</h2>
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            <div className="font-medium text-sky-300 shrink-0 sm:w-40">共享加速池</div>
            <p className="text-slate-400">
              ¥998 / 年起，覆盖 10~20 人团队，流量不限量（公平使用），当天开通；
              香港 ×6、日本 ×4、马来西亚 ×1 共 11 个在线节点多地域自动切换。
            </p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            <div className="font-medium text-amber-300 shrink-0 sm:w-40">独享 VPS 专用节点</div>
            <p className="text-slate-400">
              ¥1988 / 年，≥500 Mbps 大带宽独享，出口 IP 不与他人混用，适合账号资产型业务；
              付费后 24 小时内交付，专用节点故障自动回落共享池。
            </p>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            <div className="font-medium text-rose-300 shrink-0 sm:w-40">合规国际专线</div>
            <p className="text-slate-400">
              对接持牌基础运营商线路，国内入口中转，带宽按需配置、按月扩容，
              可提供合同与发票，适合有合规硬性要求的企业，定制报价。
            </p>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          所有企业方案共享：SLA 为节点故障 24 小时内恢复或更换；企业管理面板提供成员统一管理、
          按成员流量审计与统一账单。我们不在此页承诺无法验证的性能数字，
          建议先以共享加速池做小规模实测，再决定升档。
        </p>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4">
        <a
          href="mailto:support@fastergamer.cn?subject=%E7%99%BD%E7%9A%AE%E4%B9%A6%E8%AF%BB%E8%80%85%E5%92%A8%E8%AF%A2&body=%E5%85%AC%E5%8F%B8%EF%BC%9A%0A%E5%9B%A2%E9%98%9F%E4%BA%BA%E6%95%B0%EF%BC%9A%0A%E5%85%B3%E6%B3%A8%E7%9A%84%E9%97%AE%E9%A2%98%EF%BC%9A"
          className="inline-block rounded-xl bg-sky-500 px-8 py-3 text-lg font-bold text-slate-950 hover:bg-sky-400 transition-colors"
        >
          邮件索取方案与报价 →
        </a>
        <p className="text-xs text-slate-500">
          support@fastergamer.cn · 24 小时内回复 · 返回
          <Link to="/enterprise" className="text-sky-400 hover:underline mx-1">企业服务总览</Link>
          或查看
          <Link to="/enterprise/solutions" className="text-sky-400 hover:underline mx-1">行业解决方案</Link>
        </p>
      </section>
    </div>
  );
}
