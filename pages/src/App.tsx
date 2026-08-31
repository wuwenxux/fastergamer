import { Link, Route, Routes } from "react-router-dom";
import AuthMagic from "./pages/AuthMagic";
import Enterprise from "./pages/Enterprise";
import Home from "./pages/Home";
import Guide from "./pages/Guide";
import Purchase from "./pages/Purchase";
import Register from "./pages/Register";
import Support from "./pages/Support";
import Tokens from "./pages/Tokens";

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="border-b border-slate-800 bg-slate-900/60 px-6 py-4 flex items-center justify-between">
        <Link to="/" className="font-bold text-lg tracking-wide">
          🎮 GameBoost
        </Link>
        <div className="space-x-5 text-sm">
          <Link to="/" className="hover:text-sky-400 transition-colors">
            套餐
          </Link>
          <Link to="/tokens" className="hover:text-sky-400 transition-colors">
            我的 Token
          </Link>
          <Link to="/enterprise" className="hover:text-sky-400 transition-colors">
            企业服务
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
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/auth/magic" element={<AuthMagic />} />
          {/* 防失联登记：隐藏路由，不进导航，仅登录用户从「我的 Token」页进入 */}
          <Route path="/register" element={<Register />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="/enterprise" element={<Enterprise />} />
          <Route path="/support" element={<Support />} />
        </Routes>
      </main>

      <footer className="border-t border-slate-800 px-6 py-6 text-center text-xs text-slate-500">
        遇到问题？
        <Link to="/support" className="text-sky-400 hover:underline mx-1">
          提交反馈
        </Link>
        或邮件联系
        <a href="mailto:support@fastergamer.cn" className="text-sky-400 hover:underline mx-1">
          support@fastergamer.cn
        </a>
      </footer>
    </div>
  );
}
