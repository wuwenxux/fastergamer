/** 日志里的邮箱脱敏：保留首字符与域名（a***@b.com），非邮箱输入返回 *** */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}
