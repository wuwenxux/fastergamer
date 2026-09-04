/**
 * 一次性/临时邮箱域名黑名单。
 *
 * 为什么需要：试用与下单的「每邮箱限一次」防不住临时邮箱——它们能收信
 * （所以邮件直达凭证的设计拦不住），但用完即弃，等于无限新邮箱。
 * 命中即在下单/领取入口拒绝，顺带避免给假地址发信烧钱、拉低发信信誉。
 */
const DISPOSABLE_DOMAINS = new Set([
  // 国际常见
  "10minutemail.com", "10minutemail.net", "guerrillamail.com", "guerrillamail.net",
  "mailinator.com", "yopmail.com", "tempmail.com", "temp-mail.org", "tempmailo.com",
  "throwawaymail.com", "getnada.com", "mohmal.com", "sharklasers.com", "maildrop.cc",
  "dispostable.com", "mailnesia.com", "tempail.com", "emailondeck.com", "fakemail.net",
  "spamgourmet.com", "trashmail.com", "trashmail.net", "mailcatch.com", "mintemail.com",
  "mytemp.email", "temp-mail.io", "tempmail.dev", "inboxkitten.com", "mailsac.com",
  "mail.tm", "bugmenot.com", "spam4.me", "grr.la", "pokemail.net", "spambox.us",
  // 国内常见
  "24mail.chacuo.net", "linshiyouxiang.net", "linshiyou.com", "bccto.me",
  "mailto.plus", "tempmail.cn", "5mail.xyz", "onedrive365.cf",
]);

export const isDisposableEmail = (email: string): boolean => {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  return DISPOSABLE_DOMAINS.has(domain);
};
