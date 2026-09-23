import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { EffectScatterChart } from "echarts/charts";
import { GeoComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { GeoCityStat } from "../../../shared/types";

// 按需注册：全量 echarts 约 1MB，只注册地图散点所需模块控制 admin chunk 体积
echarts.use([EffectScatterChart, GeoComponent, TooltipComponent, CanvasRenderer]);

let mapRegistered = false;
/** 中国地图 geoJSON 体积较大（约 580KB），运行时按需加载一次后全局复用 */
const registerChinaMap = async () => {
  if (mapRegistered) return;
  const res = await fetch("/geo/china.json");
  if (!res.ok) throw new Error(`地图数据加载失败 (${res.status})`);
  echarts.registerMap("china", await res.json());
  mapRegistered = true;
};

/** 散点数据项：[经度, 纬度, 城市名, token 数, IP 数, 流量 bytes] */
type ScatterDatum = [number, number, string, number, number, number];

export default function GeoMap({ cities }: { cities: GeoCityStat[] }) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;
    void registerChinaMap()
      .catch(() => {
        /* 地图数据加载失败时保留空底图，不阻塞页面 */
      })
      .then(() => {
        if (cancelled || !chartRef.current) return;
        // 海外城市（countryCode 非 CN）不上中国地图，由国家汇总列表展示；点大小按 token 数分档
        const cn: ScatterDatum[] = cities
          .filter((c) => c.countryCode === "CN")
          .map((c) => [c.lon, c.lat, c.name, c.tokens, c.ips, c.bytes]);
        const max = Math.max(1, ...cn.map((d) => d[3]));
        chart.setOption({
          backgroundColor: "transparent",
          tooltip: {
            trigger: "item",
            formatter: (p: { data?: ScatterDatum }) => {
              const d = p.data;
              if (!d) return "";
              return `${d[2]}<br/>Token：${d[3]} · IP：${d[4]}<br/>流量：${(d[5] / 1e9).toFixed(2)} GB`;
            },
          },
          geo: {
            map: "china",
            roam: false,
            itemStyle: { areaColor: "#1e293b", borderColor: "#475569" },
            emphasis: { itemStyle: { areaColor: "#334155" }, label: { show: false } },
          },
          series: [
            {
              type: "effectScatter",
              coordinateSystem: "geo",
              rippleEffect: { scale: 2.5 },
              symbolSize: (val: ScatterDatum) => 6 + (val[3] / max) * 18,
              itemStyle: { color: "#38bdf8", shadowBlur: 8, shadowColor: "rgba(56,189,248,0.6)" },
              data: cn,
            },
          ],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cities]);

  return <div ref={elRef} className="h-[420px] w-full" />;
}
