import { describe, expect, it, vi } from "vitest";
import { listKeys } from "../lib/kv";

interface ListPage {
  keys: { name: string }[];
  list_complete: boolean;
  cursor?: string;
}

/** 假 KV namespace：list 按预设分页依次返回 */
const mockNs = (pages: ListPage[]) => {
  let i = 0;
  const list = vi.fn(async () => pages[i++]);
  return { ns: { list } as unknown as KVNamespace, list };
};

describe("listKeys 分页", () => {
  it("单页（list_complete=true）直接返回，不再翻页", async () => {
    const { ns, list } = mockNs([
      { keys: [{ name: "token:a" }, { name: "token:b" }], list_complete: true },
    ]);
    const keys = await listKeys(ns, "token:");
    expect(keys.map((k) => k.name)).toEqual(["token:a", "token:b"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("list_complete=false 时按 cursor 翻页拿全", async () => {
    const { ns, list } = mockNs([
      { keys: [{ name: "token:a" }], list_complete: false, cursor: "cur1" },
      { keys: [{ name: "token:b" }], list_complete: false, cursor: "cur2" },
      { keys: [{ name: "token:c" }], list_complete: true },
    ]);
    const keys = await listKeys(ns, "token:");
    expect(keys.map((k) => k.name)).toEqual(["token:a", "token:b", "token:c"]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "token:", cursor: undefined });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "token:", cursor: "cur1" });
    expect(list).toHaveBeenNthCalledWith(3, { prefix: "token:", cursor: "cur2" });
  });
});
