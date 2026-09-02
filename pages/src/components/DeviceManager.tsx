import { useEffect, useState } from "react";
import type { Device, Token } from "../../../shared/types";
import { api } from "../services/api";

/**
 * 设备槽位管理 —— 每台设备独立 UUID / 订阅链接，流量按设备审计
 * 主设备（token 主 uuid）不在此列，它的订阅链接在上方 TokenStatus 里
 */
export default function DeviceManager({
  token,
  onChange,
}: {
  token: Token;
  onChange: (t: Token) => void;
}) {
  const [maxDevices, setMaxDevices] = useState(2);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [now, setNow] = useState(Date.now());

  // 每 15s 刷新一次，用于设备在线状态（last_active_at 90s 内视为在线）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        const plan = plans.find((p) => p.id === token.plan_id);
        // token 级 max_devices 优先（管理员单独放宽），否则套餐值
        setMaxDevices(token.max_devices ?? plan?.max_devices ?? 2);
      })
      .catch(() => {});
  }, [token.plan_id, token.max_devices]);

  const devices = token.devices ?? [];
  const used = 1 + devices.length; // 含主设备
  const full = used >= maxDevices;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const device = await api.addDevice(token.id, name.trim());
      onChange({ ...token, devices: [...devices, device] });
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (device: Device) => {
    if (!confirm(`确定解绑「${device.name}」？该设备的订阅会立即失效。`)) return;
    setError("");
    try {
      await api.removeDevice(token.id, device.id);
      onChange({ ...token, devices: devices.filter((d) => d.id !== device.id) });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copySub = async (device: Device) => {
    try {
      await navigator.clipboard.writeText(api.subUrl(device.uuid));
      setCopiedId(device.id);
      setTimeout(() => setCopiedId(""), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">📱 我的设备</h4>
        <span className="text-xs text-slate-500">
          已绑定 {used} / {maxDevices} 台
        </span>
      </div>

      <p className="text-xs text-slate-400">
        主设备使用上方的订阅链接。其他设备请在下方添加，每台设备有独立的订阅链接和流量统计，
        哪台设备用了多少流量一目了然。
      </p>

      {devices.length > 0 && (
        <div className="space-y-2">
          {devices.map((d) => {
            const online = (d.last_active_at ?? 0) > now - 90_000;
            return (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
              >
                <div className="text-sm min-w-0">
                  <div className="font-medium truncate flex items-center gap-2">
                    {d.name}
                    {online && (
                      <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-300">
                        在线中
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    已用 {d.traffic_used_gb.toFixed(2)} GB
                    {d.last_active_at &&
                      !online &&
                      ` · 最近活跃 ${new Date(d.last_active_at).toLocaleString()}`}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0 ml-3">
                  <button
                    onClick={() => copySub(d)}
                    className="rounded-lg bg-sky-500/20 border border-sky-500/40 px-3 py-1 text-xs text-sky-300 hover:bg-sky-500/30 transition-colors"
                  >
                    {copiedId === d.id ? "✓ 已复制" : "复制订阅"}
                  </button>
                  <button
                    onClick={() => remove(d)}
                    className="rounded-lg border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:text-rose-400 hover:border-rose-500/50 transition-colors"
                  >
                    解绑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!full ? (
        <form onSubmit={add} className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="设备名称，如：我的 iPhone"
            maxLength={30}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-50"
          >
            {busy ? "添加中…" : "添加设备"}
          </button>
        </form>
      ) : (
        <p className="text-xs text-amber-400">
          已达设备上限，解绑不用的设备后才能添加新设备。
        </p>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  );
}
