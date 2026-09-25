# Komari IPQA 质量集成与告警报告插件 (komari-plugin-ipqa-alert-report)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Komari Version](https://img.shields.io/badge/Komari-%3E%3D1.4.3-blue)](https://github.com/komari-monitor)
[![Compatible With](https://img.shields.io/badge/IPQA-IP--Quality--Archive-green)](https://github.com/Chen017/IP-Quality-Archive)
[![Theme Integration](https://img.shields.io/badge/Theme%20Integration-Komari%20Emerald%20Insights-emerald)](https://github.com/Chen017/komari-theme-emerald-insights)
[![Komari Emerald Ecosystem](https://img.shields.io/badge/Komari%20Emerald-Ecosystem-10b981)](https://github.com/Chen017/komari-emerald-suite)

> [!IMPORTANT]
> 本插件需要目标 VPS 已安装 [IP-Quality-Archive](https://github.com/Chen017/IP-Quality-Archive)。
>
> 推荐搭配 [Komari Emerald Insights](https://github.com/Chen017/komari-theme-emerald-insights) 使用，可在 Resource Insights 中直接查看 IPQA 概览、风险矩阵、流媒体解锁矩阵与节点历史档案。

本插件为 Komari 提供 IP-Quality-Archive 集成：一方面作为 **数据提供方**，增量同步 VPS 端的 IPQA 历史归档，另一方面支持语义变更追踪与定时聚合告警推送。

---

## 核心特性

- 🔄 **增量同步归档**：拉取节点 `~/.ipqa/data/{v4,v6}` 下的归档，只下载尚未缓存的归档文件到本地缓存。
- 📊 **只读 HTTP API**：提供 `/api/plugin/ipqa-alert-report/v1` 接口，前端请求直接读本地缓存，不执行远程命令。
- 🔍 **自动对比变动**：自动对比相邻两天的归档，检查 IP 归属、风控评分、流媒体与 AI 解锁、邮件黑名单等是否有变化。
- 🌐 **定时聚合通知**：每天早晨（默认 07:00）收集当天各节点的变动情况，汇总后发送通知。
- 🤫 **无异常不打扰**：如果所有节点都正常且没有变动，不会发送空消息打扰。
- 📦 **合并单条发送**：所有节点的告警合并为一条消息发出，避免多节点多条消息刷屏。
- 🛡️ **防止重复推送**：记录每天的推送状态，避免同一天内重复发送相同的报警。
- 🔍 **告警级别过滤**：支持按级别（INFO / WARNING / CRITICAL）过滤，也可忽略首次建档等常规提示。
- ⚠️ **采集失败提醒**：遇到节点离线、超时或日志缺失等情况时，单独列出失败原因方便排查。
- 📝 **长消息截断**：消息过长时自动按字数截断并提示，避免因超出 Telegram 等平台长度限制导致发送失败。
- 🎨 **通知模板自定义**：支持自定义消息格式，可用 `{{date}}`、`{{alert_count}}`、`{{message}}` 等变量。

---

## 前端主题适配

本插件设计与 **[Komari Emerald Insights](https://github.com/Chen017/komari-theme-emerald-insights)** 深度协同：
- **资源概览页**：自动读取 `/overview` 呈现集群 IPQA 统计卡片、节点网格、风险矩阵与流媒体解锁矩阵。
- **节点详情快照**：在常规节点监控页展示当前节点 IP 质量快照。
- **完整节点档案** (`/ip-quality/:uuid`)：支持按日历和归档日期逐日查阅历史测评、各引擎评分、风险因子树与原始 JSON。

---

## Komari Emerald Ecosystem

本插件是 **Komari Emerald Ecosystem** 的核心组件之一：

```text
                         Komari
                            │
               ┌────────────┴────────────┐
               │                         │
               ▼                         ▼
   Availability History          IPQA Alert Report
   WebSocket event ledger        Archive / API / Alerts
                                         │ (★ 本项目)
                                         ▼
                               IP-Quality-Archive
                               on monitored VPS
               │                         │
               └────────────┬────────────┘
                            ▼
                Komari Emerald Insights
                    Resource Insights
```

- [Komari Emerald Suite](https://github.com/Chen017/komari-emerald-suite)：生态聚合展示主页
- [Komari Emerald Insights](https://github.com/Chen017/komari-theme-emerald-insights)：现代化前端监控主题
- [Komari Plugin: Availability History](https://github.com/Chen017/komari-plugin-availability-history)：节点在线率历史账本插件
- [IP-Quality-Archive](https://github.com/Chen017/IP-Quality-Archive)：节点端 IP 质量采集工具

---

## 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。
