# Komari IPQA 告警报告插件 (komari-plugin-ipqa-alert-report)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Komari Version](https://img.shields.io/badge/Komari-%3E%3D1.4.3-blue)](https://github.com/komari-monitor)
[![Compatible With](https://img.shields.io/badge/IPQA-IP--Quality--Archive-green)](https://github.com/Chen017/IP-Quality-Archive)

**Komari IPQA 告警报告插件** 是为 [Komari](https://github.com/komari-monitor) 探针监控系统深度定制的自动化汇总与通知插件。

本插件专为部署了 [IP-Quality-Archive (IPQA)](https://github.com/Chen017/IP-Quality-Archive) 的节点设计：每天固定于**北京时间 07:00** 自动聚合各节点的每日 IP 质量变化告警，将分散的检测结果汇编为排版优雅的单条消息，通过 Komari 统一通知渠道（Telegram 等）推送到管理员终端。

---

## 核心特性

- 🌐 **定时精准聚合**：每日固定于北京时间 07:00 触发，收集当天 00:00:00 至 07:00:59 的告警，完美覆盖 IPQA 凌晨 04:00 的日常巡检窗口。
- 🤫 **智能静默机制**：所有监控节点均正常且无告警时自动保持静默，绝不发送打扰消息；仅当发现真实告警或节点采集异常时主动提醒。
- 📦 **单条聚合推送**：所有异常节点的告警汇总为单条消息发送，彻底杜绝多节点、多日志轰炸通知通道。
- 🛡️ **双重防重与幂等**：内置本地执行状态追踪与内存锁，支持节点任务 10 分钟窗口自动补采，严格保障同一天仅成功执行一次完整推送。
- 🔍 **严重级别过滤**：支持自定义最低通知等级（`INFO` / `WARNING` / `CRITICAL`），可自动过滤初始建档事件（如「首次完成数据存档监测」）。
- ⚠️ **节点故障排查**：节点离线、Agent 超时或找不到 `alerts.log` 时，以清晰的采集异常段落进行分流标注，方便运维快速定位。
- 📝 **智能防超长保护**：严格遵循 Telegram 消息规范，正文自动控制在 3800 字符内，超长部分自动截断并展示超额统计与提示。
- 🎨 **高度可定制模板**：支持自定义通知模板，内置丰富的占位符（如 `{{date}}`、`{{alert_count}}`、`{{message}}` 等）。

---

## 工作流程

```
[各 VPS 节点] 04:00 自动执行 IPQA 检测
       │
       ▼ (结果记录至 ~/.ipqa/data/alerts.log)
       │
[Komari Server 插件] 07:00 (Asia/Shanghai) 定时调度触发
       │
       ├─► 过滤选定节点 (支持全部节点或指定节点列表)
       ├─► 通过 Komari System RPC 并发远程读取 alerts.log
       ├─► 统一换算节点本地时区至标准时间戳进行窗口匹配
       ├─► 级别过滤 (按 min_severity 与 ignore_initial_archive 规则)
       │
       ├─► [全节点无告警且正常] ──► 保持静默，更新状态
       │
       └─► [存在告警或采集异常] ──► 渲染报告正文 ──► 调用 Komari Notification 推送 (Telegram)
```

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

## 关联项目

- [IP-Quality-Archive (IPQA)](https://github.com/Chen017/IP-Quality-Archive)：基于 IPQuality 的 Linux IP 质量定时归档与历史监测工具。
- [Komari](https://github.com/komari-monitor)：轻量、现代化的高颜值服务器监控探针系统。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。
