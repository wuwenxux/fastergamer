/**
 * 节点管理 KV 数据访问层
 * 所有节点存为单键 JSON 数组：KV.NODES -> Node[]
 */
import { KV, type Node } from "../../../../shared/types";
import type { Env } from "../types";

export const getNodes = async (env: Env): Promise<Node[]> => {
  const raw = await env.NODES.get(KV.NODES);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Node[];
  } catch {
    return [];
  }
};

export const saveNodes = (env: Env, nodes: Node[]): Promise<void> =>
  env.NODES.put(KV.NODES, JSON.stringify(nodes));

export const getNodeByKey = async (env: Env, key: string): Promise<Node | null> => {
  const nodes = await getNodes(env);
  return nodes.find((n) => n.key === key) ?? null;
};

export const getNodeById = async (env: Env, id: string): Promise<Node | null> => {
  const nodes = await getNodes(env);
  return nodes.find((n) => n.id === id) ?? null;
};

/** 当前自然月账期标识（UTC），如 "2026-08" */
export const currentMonthKey = (now = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

/** 节点当月流量是否已超配额（超配额节点应从订阅与同步中摘除） */
export const isBudgetExhausted = (node: Node, now = new Date()): boolean => {
  if (!node.monthly_budget_gb) return false;
  if (node.month_key !== currentMonthKey(now)) return false; // 跨月未重置时视为未超
  const usedGb = (node.month_bytes ?? 0) / 1024 ** 3;
  return usedGb >= node.monthly_budget_gb;
};
