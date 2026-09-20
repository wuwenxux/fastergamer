import { Link, Route, Routes } from "react-router-dom";
import Admin from "./pages/Admin";
import AuthMagic from "./pages/AuthMagic";
import Home from "./pages/Home";
import Guide from "./pages/Guide";
import OrderStatus from "./pages/OrderStatus";
import Purchase from "./pages/Purchase";
import Recover from "./pages/Recover";
import Register from "./pages/Register";
import Support from "./pages/Support";
import Tokens from "./pages/Tokens";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="border-b border-slate-800 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="font-bold text-xl sm:text-lg tracking-wide">
          🎮 GameBoost
        </Link>
        <div className="space-x-4 sm:space-x-5 text-[15px] sm:text-sm">
          <Link to="/" className="hover:text-sky-400 transition-colors">
            套餐
          </Link>
          <Link to="/tokens" className="hover:text-sky-400 transition-colors">
            我的 Token
          </Link>
          <Link to="/guide" className="hover:text-sky-400 transition-colors">
            使用教程
          </Link>
          <Link to="/support" className="hover:text-sky-400 transition-colors">
            帮助反馈
          </Link>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/buy" element={<Purchase />} />
          {/* 订单查询：凭订单号查进度/继续支付（刷新丢单、换设备续付都走这里） */}
          <Route path="/orders" element={<OrderStatus />} />
          <Route path="/orders/:id" element={<OrderStatus />} />
          <Route path="/tokens" element={<Tokens />} />
          {/* 找回 Token：发货邮件里固定的找回入口（邮箱收一键登录链接） */}
          <Route path="/recover" element={<Recover />} />
          <Route path="/auth/magic" element={<AuthMagic />} />
          {/* 防失联登记：隐藏路由，不进导航，仅登录用户从「我的 Token」页进入 */}
          <Route path="/register" element={<Register />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="/support" element={<Support />} />
          {/* 站长数据看板：无任何站内链接，只有知道 URL 的人能到登录页（接口仍需 x-admin-key + IP 白名单） */}
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>

      <footer className="border-t border-slate-800 px-6 py-6 text-center text-sm sm:text-xs text-slate-500">
        遇到问题？
        <Link to="/support" className="text-sky-400 hover:underline mx-1">
          提交反馈
        </Link>
        或邮件联系
        <a href="mailto:support@fastergamer.cn" className="text-sky-400 hover:underline mx-1">
          support@fastergamer.cn
        </a>
        <Link to="/recover" className="text-sky-400 hover:underline mx-1">
          找回 Token
        </Link>
        或
        <Link to="/orders" className="text-sky-400 hover:underline mx-1">
          查询订单
        </Link>
      </footer>
    </div>
  );
}
