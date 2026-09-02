#!/usr/bin/env python3
"""
跨境专线/SD-WAN 渠道询价邮件发送（foxmail SMTP）

用法：
  1. foxmail 网页版 → 设置 → 账户 → 开启 SMTP 服务 → 生成授权码（不是登录密码）
  2. 本地执行（授权码只走环境变量，不要写进命令历史可见的地方之外的文件）：
     SMTP_USER=wwx0306@foxmail.com SMTP_PASS=授权码 \
     SIGN_COMPANY=你的公司名 SIGN_NAME=你的名字 SIGN_PHONE=你的电话 \
     python3 scripts/send-inquiry.py

  先自测：加 --dry-run 只打印不发；加 --to-self 先发给自己看排版。

收件人：CMI iSolutions、第一线 DYXnet（联通国际/南凌只有在线表单，见 README 输出提示）
"""
import os
import smtplib
import sys
from email.header import Header
from email.mime.text import MIMEText

RECIPIENTS = [
    ("CMI iSolutions", "solutions@cmi.chinamobile.com"),
    ("第一线 DYXnet", "cnmkt@dyxnet.com"),
]

SUBJECT = "跨境网络服务渠道合作咨询——中小企业出海加速方案"

BODY_TEMPLATE = """您好，

我们是一家面向跨境电商与出海团队的网络服务提供商（客户以 10~40 人团队为主），目前为企业客户提供国际网络加速服务，现计划引入持牌合规的跨境专线/SD-WAN 资源，咨询渠道合作事宜：

1. 产品：IPLC/IEPL 或 SD-WAN 国际加速，方向以香港、日本为主，美国为辅
2. 带宽：5~10 Mbps 起订，希望按月计费、无最低消费，后续按季度扩容
3. 合作模式：是否支持渠道代理/转售（白牌或联名），代理折扣政策
4. SLA：故障恢复时限与赔偿条款，是否提供测试线路
5. 合规：贵司牌照资质文件，能否以我方名义与终端客户签合同

方便的话请提供面向渠道的产品手册与价格表，或安排一次电话沟通。

此致
{signature}
"""


def main() -> None:
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASS")
    company = os.environ.get("SIGN_COMPANY", "").strip()
    name = os.environ.get("SIGN_NAME", "").strip()
    phone = os.environ.get("SIGN_PHONE", "").strip()
    # 签名缺省时落到发件邮箱，不出现占位符
    signature = "\n".join(x for x in (company, name, phone) if x) or user or ""
    body = BODY_TEMPLATE.format(signature=signature)

    dry = "--dry-run" in sys.argv
    to_self = "--to-self" in sys.argv
    targets = [("自测", user)] if to_self else RECIPIENTS

    if dry:
        for label, addr in targets:
            print(f"--- {label} <{addr}> ---\n主题: {SUBJECT}\n{body}")
        return
    if not user or not password:
        sys.exit("缺少 SMTP_USER / SMTP_PASS 环境变量（授权码非登录密码）")

    with smtplib.SMTP_SSL("smtp.qq.com", 465, timeout=20) as smtp:
        smtp.login(user, password)
        for label, addr in targets:
            msg = MIMEText(body, "plain", "utf-8")
            msg["From"] = user
            msg["To"] = addr
            msg["Subject"] = Header(SUBJECT, "utf-8")
            smtp.sendmail(user, [addr], msg.as_string())
            print(f"✓ 已发送 → {label} <{addr}>")


if __name__ == "__main__":
    main()
