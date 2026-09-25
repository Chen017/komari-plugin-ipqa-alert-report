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

本插件为 Komari 提供 IP-Quality-Archive 深度集成：一方面作为 **数据提供方 (Data Provider)**，增量同步 VPS 端的 IPQA 历史归档，提供版本化只读 HTTP API 供前端主题（如 Komari Emerald Insights）渲染集群质量概览与历史档案；另一方面支持语义变更追踪与定时聚合告警推送。

---

## 核心特性

- 🔄 **历史归档增量同步**：智能拉取 VPS 节点 `~/.ipqa/data/{v4,v6}` 原始归档清单，对比本地缓存仅下载新增或变更的归档文件，支持分批拉取与 base64 安全传输。
- 📊 **版本化只读 HTTP API**：提供 `/api/plugin/ipqa-alert-report/v1` 标准接口，所有访客端 GET 请求直接读取本地缓存，**绝不触发远程命令执行**，保障性能与安全。
- 🔍 **语义差异引擎**：每日自动计算并对比相邻归档，精准捕获 IP 归属、评分（IP2Location、Scamalytics、AbuseIPDB 等）、风险因子、流媒体/AI 解锁及 DNSBL 黑名单的细粒度变更。
- 🌐 **定时精准告警聚合**：每日固定于北京时间 07:00 触发，收集当天 00:00:00 至 07:00:59 的告警，完美覆盖 IPQA 凌晨 04:00 的日常巡检窗口。
- 🤫 **智能静默机制**：所有监控节点均正常且无告警时自动保持静默，绝不发送打扰消息；仅当发现真实告警或节点采集异常时主动提醒。
- 📦 **单条聚合推送**：所有异常节点的告警汇总为单条消息发送，彻底杜绝多节点、多日志轰炸通知通道。
- 🛡️ **双重防重与幂等**：内置本地执行状态追踪与内存锁，支持节点任务 10 分钟窗口自动补采，严格保障同一天仅成功执行一次完整推送。
- 🔍 **严重级别过滤**：支持自定义最低通知等级（`INFO` / `WARNING` / `CRITICAL`），可自动过滤初始建档事件（如「首次完成数据存档监测」）。
- ⚠️ **节点故障排查**：节点离线、Agent 超时或找不到 `alerts.log` 时，以清晰的采集异常段落进行分流标注，方便运维快速定位。
- 📝 **智能防超长保护**：严格遵循 Telegram 消息规范，正文自动控制在 3800 字符内，超长部分自动截断并展示超额统计与提示。
- 🎨 **高度可定制模板**：支持自定义通知模板，内置丰富的占位符（如 `{{date}}`、`{{alert_count}}`、`{{message}}` 等）。

---

## 工作流程

```text
[各 VPS]
   ├─ archive JSON (data/{v4,v6}/*.json)
   └─ alerts.log (变动日志)
         │
         ▼
[Komari plugin]
   ├─ 自动增量同步 archive 归档
   ├─ 运行语义差异引擎 (compareDailyReports) 生成核心语义变化
   ├─ 并发读取 alerts.log 补充事件 (如期望地区不符、DNSBL 增量等)
   ├─ 双来源智能合并与重叠事件抑制 (dedupe)
   ├─ 统一严重级别过滤 (min_severity & ignore_initial_archive)
   └─ 生成汇总报告推送到 Telegram (或在无告警时完全静默)
```

### 数据源架构说明

- **Archive Semantic Diff（核心事实来源）**：
  Telegram 告警的核心变化来源，与 Emerald Insights 消费完全相同的数据基准。每日通过规范化对比前后两日配对归档，生成精确的评分跳变、解锁升降级与身份因子变动。
- **Alerts.log（补充与兼容来源）**：
  作为 supplemental / fallback 来源，保留 IPQA 本地检测产生的特定补充事件（例如 `EXPECTED_YOUTUBE_REGION` / `EXPECTED_NETFLIX_REGION` 地区不符合预期、DNS 黑名单拦截数增加等）；当归档已覆盖同一事件时自动进行去重抑制。在关闭归档同步（`sync_archives=false`）时，系统自动无缝回退至纯 alerts.log 模式。

### 状态与归档新鲜度 (Freshness)

插件严格区分**数据归档新鲜度**与**采集执行故障**：
- `current`：已同步并就绪的当天归档。
- `pending_today`：北京时间 04:00–05:00 宽限期内，等待当天 04:00 IPQA 巡检归档生成。
- `stale`：05:00 宽限期后仍未获取到当天最新归档（例如节点暂停了 IPQA 每日定时检测）。**`stale` 仅代表归档数据的新鲜度状态，绝不视为节点通信异常或网络故障，也不会阻止其他正常节点的告警报告发送。**
- `failed`：仅在 Agent 通信超时、RPC 执行失败、远程命令异常等真正采集故障时触发。

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

## 安装使用

### 方式一：直接上传安装包（推荐）

1. 在 GitHub Releases 页面下载最新版本的发布包：`ipqa-alert-report.zip`。
2. 登录您的 Komari 管理后台，进入 **「插件管理」 (Plugins)**。
3. 点击 **「上传插件」**，选择并上传 `ipqa-alert-report.zip`。
4. 在插件列表中启用 **IPQA 告警报告**，并点击「配置」进入参数设置面板。

### 方式二：本地源码构建

如果您希望自行打包或二次开发：

```bash
# 克隆仓库
git clone https://github.com/Chen017/komari-plugin-ipqa-alert-report.git
cd komari-plugin-ipqa-alert-report

# 安装依赖
npm install

# 编译并打包
npm run build
```

构建完成后，根目录下会生成：
- `script.js`：编译打包后的运行时单文件。
- `ipqa-alert-report.zip`：可直接导入 Komari 的标准插件分发包。

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
| **采集失败时通知** | `notify_collection_failures` | `true` | 当节点离线、Agent 超时或未安装 IPQA 找不到日志时，是否在通知中提醒。 |
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

## 本地开发与测试

本插件使用 TypeScript 编写，基于 Node.js 原生测试运行器进行单元测试：

```bash
# 运行单元测试 (覆盖时间换算、协议解析、报告渲染、调度防重)
npm test

# 打包编译
npm run build
```

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

## Related Projects

- [Komari Emerald Insights](https://github.com/Chen017/komari-theme-emerald-insights)
- [Availability History](https://github.com/Chen017/komari-plugin-availability-history)
- [IP-Quality-Archive](https://github.com/Chen017/IP-Quality-Archive)
- [Komari](https://github.com/komari-monitor/komari)

---

## 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。
