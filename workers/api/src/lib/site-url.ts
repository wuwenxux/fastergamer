/**
 * 站点根 URL（邮件/推广链接的拼接基底）。
 * 集中一处：默认指向企业门面站 fastergamer.cn，可用 SITE_URL 绑定覆盖；
 * 去尾斜杠避免拼出 "//path" 双斜杠。参数用最小接口，兼容 Env 及其子集。
 */
export const siteUrl = (env: { SITE_URL?: string }): string =>
  (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
