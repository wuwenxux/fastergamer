import { Link } from "react-router-dom";
import ClashGuide from "../components/ClashGuide";

export default function Guide() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">使用教程</h2>
      <ClashGuide />
      <p className="text-center text-sm text-slate-400">
        按教程操作仍无法使用？
        <Link to="/support" className="text-sky-400 hover:underline ml-1">
          提交反馈，客服邮件帮你解决 →
        </Link>
      </p>
    </div>
  );
}
