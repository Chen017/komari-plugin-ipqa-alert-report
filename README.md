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

- 🔄 **增量同步归档**：拉取节点 `~/.ipqa/data/{v4,v6}` 下的归档，只下载新增或修改过的文件到本地缓存。
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

## 只读 API 接口说明

所有只读接口均挂载于 `/api/plugin/ipqa-alert-report/v1`，无需鉴权即可安全调用（纯缓存读取）：

| 接口 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/capabilities` | `GET` | 查询插件支持的 IPQA 功能特性与协议版本 |
| `/overview` | `GET` | 获取全部节点最新的 IPQA 概要信息与风险概况 |
| `/nodes/:uuid/latest` | `GET` | 获取指定节点最新一日的配对归档详情 |
| `/nodes/:uuid/archives` | `GET` | 分页获取指定节点已有的历史归档日期列表 (`?limit=30`) |
| `/nodes/:uuid/archives/:date` | `GET` | 获取指定节点在特定日期的配对归档详情及与前一天的变更 |
| `/nodes/:uuid/changes` | `GET` | 获取指定节点的历史语义变更时间轴 |
| `/nodes/:uuid/history/scores` | `GET` | 获取指定节点各评分引擎的历史趋势数据 |
| `/nodes/:uuid/history/media` | `GET` | 获取指定节点流媒体与 AI 解锁的历史趋势数据 |

---

## 配置说明

进入 Komari 后台插件设置页面，可配置以下参数：

| 配置项 | 键名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **启用 IPQA 告警报告** | `enabled` | `true` | 控制插件的总运行开关。 |
| **为全部节点启用** | `all_nodes` | `false` | 开启后忽略节点勾选，自动采集所有已接入 Komari 的节点。建议所有 VPS 均安装了 IPQA 时开启。 |
| **选择节点** | `nodes` | `[]` | 在未勾选全部节点时，手动选择安装了 IPQA 的节点。 |
| **同步 IPQA 历史归档** | `sync_archives` | `true` | 开启后自动将节点上的 IP-Quality-Archive 历史归档同步到 Komari，供 Emerald Insights 展示 IP 质量概览、历史和变动。 |
| **最低通知等级** | `min_severity` | `INFO` | 可选 `INFO`、`WARNING`、`CRITICAL`。设置为 `WARNING` 时将忽略 `INFO` 级轻微告警。 |
| **忽略首次建档记录** | `ignore_initial_archive` | `true` | 自动忽略 IPQA 初次部署时的「首次完成数据存档监测」告警。 |
| **采集失败时通知** | `notify_collection_failures` | `true` | 当无可用语义归档且回退采集失败（如节点离线、Agent 超时或找不到日志）时，是否在通知中提醒。 |
| **通知模板** | `template` | 留空 | 自定义报告格式。留空时使用插件内置的标准排版。 |

### 自定义模板占位符

若填写了「通知模板」，可在模板中使用以下占位符：

| 占位符 | 替换内容 | 示例 |
| :--- | :--- | :--- |
| `{{date}}` | 报告对应的北京时间日期 | `2026-09-21` |
| `{{time}}` | 报告触发时间（北京时间） | `07:00` |
| `{{message}}` | 插件内置渲染的核心告警报告正文 | 节点告警详情与失败列表 |
| `{{alert_count}}` | 过滤后的有效告警总数 | `3` |
| `{{alert_nodes}}` | 存在有效告警的节点数量 | `2` |
| `{{critical_count}}` | 严重级别告警数量 | `1` |
| `{{warning_count}}` | 警告级别告警数量 | `2` |
| `{{info_count}}` | 提示级别告警数量 | `0` |
| `{{failed_nodes}}` | 采集失败或离线的节点数 | `0` |
| `{{nodes}}` | 参与本次检查的节点总数 | `5` |

---

## 报告消息预览

### 场景 1：存在告警的标准多节点聚合推送

```text
[IPQA 每日告警报告]
日期: 2026-09-21 (北京时间)

[Tokyo-Pro-01]
- 04:02:15 [CRITICAL] IPv4 Scamalytics 风险分突增: 12 -> 82 (极高风险)
- 04:02:16 [WARNING] IPv4 Netflix 解锁失效 (原解锁: JP -> 现状态: 仅自制剧)

[Los-Angeles-CN2]
- 04:05:30 [WARNING] IPv6 出现 1 处 DNSBL 邮件黑名单拦截记录 (Spamhaus)

共发现 3 条变动告警 (涉及 2 个节点)
```

### 场景 2：伴随个别节点采集失败的混合报告

```text
[IPQA 每日告警报告]
日期: 2026-09-21 (北京时间)

[HongKong-Direct]
- 04:01:22 [WARNING] IPv4 欺诈分变动: 0 -> 25

[部分节点采集异常]
- London-Worker: 节点处于离线状态
- Frankfurt-02: 未找到 IPQA 告警日志 (~/.ipqa/data/alerts.log)

共发现 1 条变动告警 (涉及 1 个节点)
```

### 场景 3：全节点检测通过无告警
插件自动判定 `shouldSendNotification = false`，**完全静默**，不产生无意义消息。

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
