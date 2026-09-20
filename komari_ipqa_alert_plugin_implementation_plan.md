# Komari IPQA 告警报告插件：详细实现计划

> 目标读者：负责直接实现该插件的 AI / 开发者  
> 目标平台：Komari Plugin System  
> 参考插件：Komari 官方/社区「流量定期报告（Scheduled Traffic Reports）」插件  
> 数据源：[Chen017/IP-Quality-Archive](https://github.com/Chen017/IP-Quality-Archive)  
> 本文档是**实现规范**，不是讨论稿。除明确标记为“可选”的部分外，应按本文执行。

---

## 0. 最终目标

开发一个 Komari 原生插件，用于每天自动收集多个已安装 IP-Quality-Archive 的 Komari 节点上的 IP 质量告警，并通过 Komari 已配置好的通知渠道（当前用户使用 Telegram）发送**单条汇总通知**。

### 必须满足的业务规则

1. IP-Quality-Archive 已在目标 VPS 上自行运行，并且其自动检测时间为：
   - **每天北京时间 04:00**。
2. 本插件发送/检查时间固定为：
   - **每天北京时间 07:00**。
3. 插件只负责读取 IPQA 已产生的数据：
   - 不主动运行完整 IPQA 检测；
   - 不执行 `ipqa --check`；
   - 不改变 IPQA 自己的 cron。
4. 告警来源优先读取：
   - `~/.ipqa/data/alerts.log`
5. 当天没有符合条件的 IPQA 告警时：
   - **不发送任何“今日正常”通知**。
6. 当天有告警时：
   - 所有有告警的 VPS 必须合并到**同一条** Komari 通知；
   - 不允许每台 VPS 单独发一条。
7. 无告警的 VPS：
   - 不应出现在正常告警正文中。
8. 默认忽略 IPQA 初始化告警：
   - `首次完成数据存档监测`
9. 支持过滤告警等级：
   - INFO
   - WARNING
   - CRITICAL
10. 目标节点必须通过 Komari 原生节点选择器选择。
11. 不允许要求用户配置：
   - SSH 私钥；
   - SSH 用户名；
   - VPS IP；
   - Telegram Bot Token；
   - Telegram Chat ID。
12. 远程执行通过 Komari 自己的 Agent/RPC 完成。
13. 通知通过 Komari 自己的 Message Sender / `admin:sendNotification` 完成。

---

# 1. 核心设计结论

插件的数据链路应为：

```text
Komari Plugin
    │
    ├── 每分钟轻量检查一次“当前是否为北京时间 07:00”
    │
    ├── 到点后读取插件配置
    │
    ├── common:getNodes
    │       ↓
    │   得到选中的 Komari 节点 UUID
    │
    ├── admin:exec
    │       ↓
    │   一次任务下发到多个 Komari Agent
    │       ↓
    │   每个 Agent 只读 ~/.ipqa/data/alerts.log
    │
    ├── admin:getTaskResultsByTaskId
    │       ↓
    │   收集所有节点任务结果
    │
    ├── 解析 + 过滤 + 聚合
    │
    ├── 无告警
    │      └── return，不调用通知接口
    │
    └── 有告警
           ↓
       admin:sendNotification
           ↓
       Komari 已配置的 Telegram/其他通知 Provider
```

---

# 2. 明确不采用的方案

以下方案不要用于正式实现：

## 2.1 不使用 SSH

不要让插件保存：

```text
/root/.ssh/id_ed25519
VPS IP
SSH 用户名
SSH 密码
```

原因：

- Komari 本身已经具备 Agent 远程任务能力；
- 使用 SSH 会重复建设认证体系；
- 增加安全风险；
- 破坏“Komari 原生插件”的设计目标。

---

## 2.2 不自己调用 Telegram Bot API

不要实现：

```text
https://api.telegram.org/bot<TOKEN>/sendMessage
```

也不要在插件配置里添加：

```text
BOT_TOKEN
CHAT_ID
```

正式通知必须调用：

```text
admin:sendNotification
```

这样插件直接复用用户现有 Komari Telegram 配置。

---

## 2.3 不用 `ipqa --status` 作为告警判定源

`ipqa --status` 更适合作为给人看的状态概览，不应作为机器告警接口。

正式告警数据源：

```text
$IPQA_HOME/data/alerts.log
```

IPQA 当前默认：

```bash
IPQA_HOME="${IPQA_DIR:-$HOME/.ipqa}"
ALERT_LOG="$IPQA_HOME/data/alerts.log"
```

告警格式：

```text
时间|等级|消息|IP版本
```

例如：

```text
2026-09-21 04:10:02|WARNING|Netflix 地区发生变化: [US] -> [JP]|IPv4
2026-09-21 04:10:03|CRITICAL|IPQS 风险等级上升至 [高风险] ...|IPv4
```

---

## 2.4 不使用“上次运行时间 → 本次运行时间”的 cursor 作为日报时间窗口

本项目时间规则已经明确：

```text
IPQA 每天北京时间 04:00 检测
插件每天北京时间 07:00 汇总
```

因此 V1 不采用滚动 cursor 窗口。

日报固定统计：

```text
北京时间当天 00:00:00
        ↓
北京时间当天 07:00:59
```

即：

```text
[00:00:00, 07:00:59]
```

这是刻意设计，不要改回“昨日 07:00 → 今日 07:00”。

### 该设计的业务假设

用户依赖的是 IPQA 每天 04:00 的自动任务，因此当天主要告警会在 04:00 后产生，并由 07:00 报告。

如果用户在 07:00 之后手动运行 IPQA 并产生新告警，该记录不会自动滚入第二天日报；这是 V1 的已接受行为，不需要为了这一边缘场景引入 cursor。

---

# 3. 时间与时区：必须正确实现

这是本项目最重要的实现细节之一。

## 3.1 绝对要求

插件必须按：

```text
Asia/Shanghai
每天 07:00
```

触发。

不能假设 Komari 主控服务器本身就是北京时间。

例如主控可能运行在：

```text
UTC
America/Los_Angeles
Europe/Berlin
```

都必须在同一个真实时刻触发，即北京时间 07:00。

---

## 3.2 不要直接使用

```javascript
server.cron("0 7 * * *", ...)
```

除非 Komari 主控机器本身时区就是 Asia/Shanghai，否则这是错误的。

Komari `server.cron()` 接受 cron 表达式，但接口本身没有提供单任务 timezone 参数。

---

## 3.3 推荐调度方式

固定注册：

```javascript
server.cron("* * * * *", async () => {
    await schedulerTick();
});
```

每分钟仅执行一次极轻量的北京时间判断。

北京时间没有夏令时，固定 UTC+8，因此不需要依赖 `Intl.DateTimeFormat`。

推荐实现：

```javascript
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;

function getBeijingParts(now = new Date()) {
    const bj = new Date(now.getTime() + BJT_OFFSET_MS);
    return {
        year: bj.getUTCFullYear(),
        month: bj.getUTCMonth() + 1,
        day: bj.getUTCDate(),
        hour: bj.getUTCHours(),
        minute: bj.getUTCMinutes(),
        second: bj.getUTCSeconds(),
    };
}
```

禁止使用系统本地：

```javascript
new Date().getHours()
```

判断北京时间 07:00：

```javascript
if (bj.hour === 7 && bj.minute === 0) {
    // due
}
```

---

## 3.4 防止一分钟内重复执行

需要持久化：

```text
last_run_beijing_date
```

例如：

```json
{
  "schema_version": 1,
  "last_run_beijing_date": "2026-09-21",
  "last_success_at": "2026-09-20T23:00:08.000Z"
}
```

同一天如果：

```text
last_run_beijing_date === todayBeijingDate
```

则不要再次执行。

该字段仅用于**防止重复执行**，不是用于计算告警查询窗口。

---

## 3.5 推荐增加短暂补偿窗口

为了避免 Komari 恰好在 07:00:00 重启导致整日报告丢失，可以允许内部固定的 10 分钟恢复窗口：

```text
07:00 ≤ 北京时间 < 07:10
```

如果：

```text
当前在 07:00–07:09
且
last_run_beijing_date != 今天
```

则执行一次。

注意：

- 报告统计窗口仍固定结束于 07:00:59；
- 07:05 补跑时，不把 07:01–07:05 新数据混入日报；
- 恢复窗口只解决主控短暂重启。

如果实现者希望严格只在 07:00 分钟执行，也可以 V1 不做补偿，但推荐保留 10 分钟恢复窗口。

---

# 4. 北京时间日报窗口计算

## 4.1 开始时间

```text
YYYY-MM-DD 00:00:00 Asia/Shanghai
```

## 4.2 结束时间

```text
YYYY-MM-DD 07:00:59 Asia/Shanghai
```

## 4.3 转换成 UTC epoch

不要在插件中依赖主控时区。

推荐：

```javascript
function beijingEpochSeconds(year, month, day, hour, minute, second) {
    const utcMs = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second
    ) - BJT_OFFSET_MS;

    return Math.floor(utcMs / 1000);
}
```

然后：

```javascript
const startEpoch = beijingEpochSeconds(y, m, d, 0, 0, 0);
const endEpoch   = beijingEpochSeconds(y, m, d, 7, 0, 59);
```

---

# 5. 为什么远端不能直接 grep 北京日期

`alerts.log` 中的时间由 VPS 自己的：

```bash
date +"%Y-%m-%d %H:%M:%S"
```

生成，因此记录时间是**该 VPS 本地时区**，不是统一北京时间。

三台 VPS 可能分别为：

```text
UTC
PDT
JST
```

所以不能简单做：

```bash
grep '^2026-09-21' alerts.log
```

这会在不同时区节点上筛错。

---

# 6. 正确的远程时间过滤方案

插件先计算统一的：

```text
START_EPOCH
END_EPOCH
```

把这两个 epoch 数值写进远程命令。

每台 VPS 自己执行：

```bash
START_LOCAL=$(date -d "@$START_EPOCH" '+%Y-%m-%d %H:%M:%S')
END_LOCAL=$(date -d "@$END_EPOCH" '+%Y-%m-%d %H:%M:%S')
```

这样 epoch 会被转换成该节点本地时区的时间字符串。

然后：

```bash
awk -F'|' \
  -v start="$START_LOCAL" \
  -v end="$END_LOCAL" '
    $1 >= start && $1 <= end { print }
  ' "$ALERT_LOG"
```

因为格式固定为：

```text
YYYY-MM-DD HH:MM:SS
```

同一时区内可以安全进行字符串字典序比较。

---

# 7. 远程命令必须只读

Agent 上执行的命令只能：

1. 定位 IPQA 数据目录；
2. 检查 `alerts.log` 是否存在；
3. 转换 epoch 到本地时间；
4. 读取/筛选日志；
5. 输出机器可解析结果。

不得：

```text
修改 alerts.log
运行 ipqa --check
运行 ipqa --cron
修改 crontab
安装软件
升级 IPQA
删除文件
```

---

# 8. 远程输出协议

为了区分：

```text
真正没有告警
alerts.log 不存在
远端 date 转换失败
命令执行失败
```

不要只依赖“stdout 是否为空”。

定义简易输出协议。

## 8.1 正常

第一行：

```text
__IPQA_STATUS__|OK
```

后面输出原始告警行：

```text
2026-09-21 04:00:10|INFO|...|IPv4
2026-09-21 04:00:11|WARNING|...|IPv6
```

---

## 8.2 IPQA 告警文件不存在

```text
__IPQA_STATUS__|NOT_FOUND
```

---

## 8.3 时间转换失败

```text
__IPQA_STATUS__|DATE_CONVERSION_FAILED
```

---

## 8.4 读取失败

```text
__IPQA_STATUS__|READ_FAILED
```

---

# 9. 推荐远程 shell 逻辑

概念代码：

```bash
set -u

START_EPOCH="<plugin-generated integer>"
END_EPOCH="<plugin-generated integer>"

IPQA_HOME="${IPQA_DIR:-$HOME/.ipqa}"
ALERT_LOG="$IPQA_HOME/data/alerts.log"

if [ ! -f "$ALERT_LOG" ]; then
    printf '%s\n' '__IPQA_STATUS__|NOT_FOUND'
    exit 0
fi

START_LOCAL=$(date -d "@$START_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || {
    printf '%s\n' '__IPQA_STATUS__|DATE_CONVERSION_FAILED'
    exit 0
}

END_LOCAL=$(date -d "@$END_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || {
    printf '%s\n' '__IPQA_STATUS__|DATE_CONVERSION_FAILED'
    exit 0
}

printf '%s\n' '__IPQA_STATUS__|OK'

awk -F'|' \
    -v start="$START_LOCAL" \
    -v end="$END_LOCAL" '
        $1 >= start && $1 <= end { print }
    ' "$ALERT_LOG"
```

### 重要

- `START_EPOCH` / `END_EPOCH` 必须由插件生成纯整数；
- 不接受用户任意 shell 字符串；
- 如果以后允许自定义 IPQA 路径，必须进行 shell quoting；
- V1 推荐先只支持默认 `$HOME/.ipqa`，避免不必要的 shell 注入面。

---

# 10. Komari RPC 设计

## 10.1 获取节点

调用：

```javascript
await server.call("common:getNodes")
```

返回当前节点映射。

处理：

```text
all_nodes = true
    → 所有节点

all_nodes = false
    → configuration.nodes 中选择的节点
```

节点排序建议沿用流量报告插件：

```text
按 Komari node.weight 升序
```

这样通知顺序与 Komari UI 更一致。

---

## 10.2 远程执行

调用：

```javascript
await server.call("admin:exec", {
    command,
    clients: nodeIds
});
```

预期返回：

```text
{
  task_id,
  clients,
  queued_clients
}
```

尽量一次把所有目标节点放进同一个 `admin:exec`。

不要循环每台节点分别创建一个任务，除非实际 Komari 行为验证后确实必要。

---

## 10.3 获取任务结果

轮询：

```javascript
await server.call("admin:getTaskResultsByTaskId", {
    task_id
});
```

直到：

```text
所有选中节点都有终态结果
```

或者达到超时。

### 注意

`TaskResult` 的具体字段必须通过当前 Komari runtime 实测确认。

开发阶段必须：

1. 执行一个 PoC：

   ```bash
   printf 'IPQA_TEST\n'
   ```

2. 输出一次脱敏后的 TaskResult 结构到插件日志；
3. 再根据真实字段编写：
   - UUID 提取；
   - stdout 提取；
   - stderr 提取；
   - exit code / status 提取。

不要凭空假定 TaskResult 字段名称。

---

# 11. `admin:exec` 与 2FA：Phase 0 必测

Komari API 文档把 `admin:exec` 作为敏感操作，HTTP API 场景可能涉及 2FA。

但是插件的：

```text
server.call()
```

以管理员权限运行。

因此开发的第一阶段必须验证：

```text
插件内部 server.call("admin:exec", ...)
```

在当前 Komari 环境中是否可以直接成功。

## Phase 0 测试

目标单节点执行：

```bash
printf 'IPQA_PLUGIN_POC\n'
```

流程：

```text
server.call("admin:exec")
        ↓
拿到 task_id
        ↓
admin:getTaskResultsByTaskId
        ↓
stdout == IPQA_PLUGIN_POC
```

### 如果成功

继续正式开发。

### 如果被 2FA 拦截

不要：

- 存储 TOTP secret；
- 要求用户每天提供 2FA code；
- 在插件中保存 API key 作为旁路；
- 自动关闭 Komari 2FA。

应停止正式实现并明确报告该兼容性问题，再研究 Komari 是否需要提供专门的插件内部可信远程执行接口。

---

# 12. 插件 Manifest

建议插件标识：

```text
Name: IPQA Alert Report
short: ipqa-alert-report
```

建议最低 Komari：

```text
>=1.4.3
```

理由：

- 官方流量报告插件本身使用该下限；
- 1.4.3 已具备插件系统与 managed node selector。

但运行时仍应通过 `rpc.has()` 或实际 `server.call()` 做兼容性检查。

---

## 12.1 推荐权限

```json
{
  "permissions": {
    "node": true,
    "allowSystemRPC": true,
    "timeout": 120
  }
}
```

### `node: true`

用于读取/写入插件自己的持久化状态：

```text
__storageDir__/state.json
```

### `allowSystemRPC: true`

用于：

```text
common:getNodes
admin:exec
admin:getTaskResultsByTaskId
admin:sendNotification
rpc.methods / rpc.help（开发或兼容检查）
```

### `timeout: 120`

远程执行需要等待多个 Agent 返回结果，默认 30 秒可能偏紧。

---

## 12.2 明确不要申请的权限

```text
allowExec
allowAllFileAccess
allowRoutes
allowHooks
allowHTMLInject
allowListen
```

V1 全部不需要。

插件主控端不应使用 `child_process`。

---

# 13. Managed Configuration 设计

交互风格模仿「流量定期报告」插件。

## 13.1 推荐配置项

### A. 启用插件

```text
key: enabled
type: switch
default: true
```

---

### B. 全部节点

```text
key: all_nodes
type: switch
default: false
```

帮助文本：

```text
开启后忽略下方节点选择，将所有 Komari 节点纳入 IPQA 告警检查。
仅建议所有节点都安装了 IPQA 时开启。
```

---

### C. 节点选择器

```text
key: nodes
type: nodes
default: "[]"
```

帮助文本：

```text
选择安装了 IP-Quality-Archive 的 VPS。
```

---

### D. 固定调度说明

建议使用 `textbox` 或 `title`，不要让用户编辑 cron：

```text
每天北京时间 07:00 检查并汇总当天 00:00–07:00 的 IPQA 告警。
IPQA 预计已在北京时间 04:00 完成自动检测。
```

本项目不需要可编辑 cron。

---

### E. 最低通知等级

建议：

```text
key: min_severity
type: select
default: INFO
```

逻辑：

```text
INFO
    → INFO + WARNING + CRITICAL

WARNING
    → WARNING + CRITICAL

CRITICAL
    → CRITICAL only
```

如果当前 Komari managed `select.options` 字符串格式不明确，开发者应先在现有主题/插件配置实现中确认格式；不要猜。

若实在不方便，可以 V1 临时用：

```text
key: min_severity
type: string
default: INFO
```

并校验只允许：

```text
INFO | WARNING | CRITICAL
```

但最终优先使用 select。

---

### F. 忽略首次建档

```text
key: ignore_initial_archive
type: switch
default: true
```

过滤：

```text
首次完成数据存档监测
```

---

### G. 采集失败是否通知

```text
key: notify_collection_failures
type: switch
default: true
```

含义：

```text
Agent 无法执行
IPQA_NOT_FOUND
DATE_CONVERSION_FAILED
任务超时
stdout 无法解析
```

都作为“采集异常”处理。

如果只有采集异常、没有 IPQA 告警：

- 开启该配置 → 允许发一条异常通知；
- 关闭该配置 → 保持静默。

这与“无 IPQA 告警不发”不冲突，因为采集失败本身是监控系统故障告警。

---

### H. 通知模板

```text
key: template
type: richtext
default: ""
```

空值：

```text
使用插件默认正文
```

支持占位符建议：

```text
{{date}}
{{start}}
{{end}}
{{message}}
{{nodes}}
{{alert_nodes}}
{{alert_count}}
{{critical_count}}
{{warning_count}}
{{info_count}}
{{failed_nodes}}
{{event}}
{{emoji}}
{{time}}
```

---

# 14. 告警解析

原始行：

```text
timestamp|level|message|ip_version
```

不要使用简单：

```javascript
line.split("|")
```

后直接要求长度等于 4，因为未来 message 内可能出现 `|`。

建议用：

```regex
^([^|]+)\|([^|]+)\|(.*)\|([^|]+)$
```

解析为：

```typescript
interface IpqaAlert {
    timestamp: string;
    level: "INFO" | "WARNING" | "CRITICAL" | string;
    message: string;
    ipVersion: string;
}
```

---

# 15. 告警过滤顺序

每个节点 stdout：

1. 解析 `__IPQA_STATUS__`；
2. 如果不是 OK → 形成 collection failure；
3. 对剩余原始行逐行解析；
4. 丢弃空行；
5. 无法解析的行：
   - 记录插件日志；
   - 不要让整个节点任务崩溃；
6. `ignore_initial_archive=true` 时过滤：

   ```text
   message === "首次完成数据存档监测"
   ```

   或更稳妥：

   ```text
   message.includes("首次完成数据存档监测")
   ```

7. 按 `min_severity` 过滤；
8. 同一节点内完全重复的原始告警行去重；
9. 最后按时间排序。

---

# 16. 告警严重度顺序

定义：

```text
CRITICAL = 3
WARNING  = 2
INFO     = 1
unknown  = 0
```

用于：

- 最低级别过滤；
- 通知排序；
- 汇总计数。

默认：

```text
min_severity = INFO
```

原因：IPQA 会把“风险恢复”“普通状态变化”写为 INFO，这些信息对长期 IP 质量监控也有意义。

---

# 17. 多节点聚合模型

建议内部结构：

```typescript
interface NodeCollectionResult {
    uuid: string;
    name: string;
    weight: number;
    status:
        | "OK"
        | "NOT_FOUND"
        | "DATE_CONVERSION_FAILED"
        | "EXEC_FAILED"
        | "TIMEOUT"
        | "PARSE_FAILED";
    alerts: IpqaAlert[];
    error?: string;
}
```

最终：

```typescript
interface DailyReport {
    beijingDate: string;
    windowStart: string;
    windowEnd: string;
    selectedNodeCount: number;
    alertNodeCount: number;
    alertCount: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    alertNodes: NodeCollectionResult[];
    failedNodes: NodeCollectionResult[];
}
```

---

# 18. 通知触发条件

核心判定：

```javascript
const hasAlerts = report.alertCount > 0;
const hasCollectionFailures = report.failedNodes.length > 0;

if (!hasAlerts) {
    if (!(config.notify_collection_failures && hasCollectionFailures)) {
        return;
    }
}
```

即：

### 情况 1

```text
三台都无告警
三台采集成功
```

结果：

```text
不发送通知
```

---

### 情况 2

```text
LA 有 2 条
Tokyo 有 1 条
Germany 无告警
```

结果：

```text
只发 1 条通知
正文包含 LA + Tokyo
Germany 不显示
```

---

### 情况 3

```text
所有节点无 IPQA 告警
Germany Agent 采集失败
notify_collection_failures = true
```

结果：

```text
发 1 条“采集异常”通知
```

---

### 情况 4

```text
Tokyo 有告警
Germany 采集失败
```

结果：

```text
仍然只发 1 条
正文包括：
- Tokyo IPQA 告警
- Germany 采集异常
```

---

# 19. 通知格式

默认使用纯文本，不依赖 Markdown/HTML parse mode。

推荐格式：

```text
⚠️ IPQA 每日告警
2026-09-21 · 北京时间 07:00
异常节点：2 / 3 · 告警：3
🔴 1  🟠 1  🔵 1

━━━━━━━━━━━━━━
🖥 Los Angeles
━━━━━━━━━━━━━━
🔴 IPv4 · 04:11
IPQS 风险等级上升至 [高风险]

🟠 IPv4 · 04:12
Netflix 地区变化: [US] -> [JP]

━━━━━━━━━━━━━━
🖥 Tokyo
━━━━━━━━━━━━━━
🔵 IPv6 · 04:08
AbuseIPDB 风险等级改善恢复
```

如果存在采集异常：

```text
━━━━━━━━━━━━━━
❌ 采集异常
━━━━━━━━━━━━━━
🖥 Germany
无法读取 IPQA 告警：Agent task timeout
```

---

# 20. 时间显示

原始告警时间是节点本地时间。

V1 有两种实现选择：

## 推荐方案

在远程输出中额外把每条日志对应时间转换为 epoch 或北京时间。

但这会让远程脚本复杂很多。

## 可接受的 V1 方案

通知中只显示原始 `HH:MM`，并明确每个节点记录时间来自节点本地时间。

不过为了用户体验，建议实现者进一步将原始 alert timestamp 在远端转换为 epoch，再由插件统一展示为北京时间。

### 若实现北京时间统一显示

远端对每条日志时间：

```bash
local_epoch=$(date -d "$timestamp" +%s)
```

然后输出机器协议时同时带 epoch。

插件将 epoch 转换为 UTC+8 再显示。

这属于推荐增强，但不影响核心验收。

---

# 21. Telegram / 通知长度控制

用户明确要求：

```text
多个告警 VPS 必须在一条 TG 通知中
```

因此：

**禁止为了长度自动拆成多条消息。**

应进行摘要/截断。

推荐最大正文目标：

```text
3800 characters
```

策略：

1. 先保留标题与总体统计；
2. 节点按 Komari weight 排序；
3. 每节点告警优先级：

   ```text
   CRITICAL
   WARNING
   INFO
   ```

4. 优先截断 INFO；
5. 再截断 WARNING；
6. CRITICAL 尽量保留；
7. 单条 message 最长可限制例如 260 字符；
8. 被省略时增加：

   ```text
   …另有 8 条 INFO 未展开
   ```

9. 如果极端情况下仍超限，保留每节点最高严重度摘要，而不是拆成第二条通知。

---

# 22. 通知 RPC

最终只调用一次：

```javascript
await server.call("admin:sendNotification", {
    event: {
        event: "IPQAAlertReport",
        time: new Date().toISOString(),
        emoji: "⚠️",
        message
    }
});
```

不要循环 sendNotification。

`event.clients` 是否需要填写可选；V1 可以不填。

---

# 23. 模板系统

如果 `template` 为空：

```text
使用默认报告正文
```

如果非空：

支持简单：

```javascript
/{{([a-zA-Z0-9_]+)}}/g
```

替换。

建议变量：

```text
{{date}}
{{start}}
{{end}}
{{message}}
{{nodes}}
{{alert_nodes}}
{{alert_count}}
{{critical_count}}
{{warning_count}}
{{info_count}}
{{failed_nodes}}
{{event}}
{{emoji}}
{{time}}
```

其中：

```text
{{message}}
```

应为完整默认报告正文。

---

# 24. 插件状态持久化

使用：

```text
__storageDir__
```

该目录在插件更新/重装时可保留。

文件：

```text
__storageDir__/state.json
```

建议：

```json
{
  "schema_version": 1,
  "last_run_beijing_date": "2026-09-21",
  "last_success_at": "2026-09-20T23:00:08.000Z",
  "last_task_id": "abc123",
  "last_summary": {
    "selected_nodes": 3,
    "alert_nodes": 2,
    "alerts": 3,
    "collection_failures": 0
  }
}
```

---

# 25. 状态写入时机

需要避免重复发送。

推荐顺序：

```text
进入 due window
    ↓
检查 today 是否已完成
    ↓
设置内存 running = true
    ↓
采集
    ↓
生成报告
    ↓
若需要通知，则 sendNotification
    ↓
成功完成本次工作流
    ↓
写入 last_run_beijing_date = today
    ↓
running = false
```

如果通知发送失败：

- 不要把该日标记为成功完成；
- 在恢复窗口内下一分钟可重试；
- 需要限制重试次数，避免 TG Provider 持续故障造成每分钟重试。

推荐：

```text
max_attempts_per_day = 3
```

状态增加：

```json
{
  "attempt_date": "2026-09-21",
  "attempt_count": 2
}
```

成功后重置。

---

# 26. 本地去重

V1 不需要复杂的跨日 alert hash cursor。

需要的去重：

1. 同一节点同一次采集内：
   - 相同原始告警行用 Set 去重；
2. 同一天定时器：
   - `last_run_beijing_date` 防止重复日报；
3. 并发：
   - 内存 `running` 防止同一 runtime 同时执行两次。

不要把去重系统设计得比业务需求复杂。

---

# 27. 远程任务超时

推荐：

```text
总等待 30 秒
轮询间隔 1 秒
```

伪代码：

```javascript
const deadline = Date.now() + 30_000;

while (Date.now() < deadline) {
    const results = await server.call(
        "admin:getTaskResultsByTaskId",
        { task_id }
    );

    updateResultMap(results);

    if (allTargetNodesTerminal()) {
        break;
    }

    await sleep(1000);
}
```

到 deadline 仍无结果的节点：

```text
TIMEOUT
```

不要因为一台节点超时导致另外两台告警全部丢失。

---

# 28. 错误隔离原则

每个节点独立解析。

例如：

```text
LA       OK + 2 alerts
Tokyo    stdout malformed
Germany  OK + 1 alert
```

最终仍应得到：

```text
LA + Germany 告警
Tokyo 采集异常
```

不能因为 Tokyo parse error 直接 throw 终止整日报告。

---

# 29. 插件日志

插件日志必须易于排错，但不要泄露敏感信息。

建议：

```text
[IPQA] scheduler tick: due for 2026-09-21
[IPQA] selected nodes: 3
[IPQA] task submitted: <task_id>
[IPQA] Los Angeles: OK, raw=2, filtered=2
[IPQA] Tokyo: OK, raw=1, filtered=0
[IPQA] Germany: TIMEOUT
[IPQA] report: alert_nodes=1 alerts=2 failures=1
[IPQA] notification sent
[IPQA] run completed for Beijing date 2026-09-21
```

不应记录：

```text
Komari token
Telegram token
完整 Agent token
```

---

# 30. 建议 TypeScript 目录结构

开发源码：

```text
src/
├── index.ts
├── config.ts
├── scheduler.ts
├── time.ts
├── nodes.ts
├── remote.ts
├── ipqa.ts
├── report.ts
├── notify.ts
└── state.ts
```

职责：

## `index.ts`

```text
definePlugin
load()
注册 scheduler
启动 runtime compatibility check
```

## `config.ts`

```text
读取 server.getConfig()
类型转换
默认值
节点 ID 解析
severity 校验
```

## `scheduler.ts`

```text
每分钟 cron
北京时间 due 判断
并发锁
每日重复保护
重试次数
```

## `time.ts`

```text
UTC+8 计算
Beijing date key
日报 start/end epoch
格式化北京时间
```

## `nodes.ts`

```text
common:getNodes
选择 all / selected
按 weight 排序
```

## `remote.ts`

```text
buildReadCommand()
admin:exec
任务 polling
TaskResult normalization
timeout
```

## `ipqa.ts`

```text
解析 stdout status
解析 alerts.log 行
severity filter
initial archive filter
node result model
```

## `report.ts`

```text
统计
格式化节点块
长度控制
模板变量
```

## `notify.ts`

```text
admin:sendNotification
```

## `state.ts`

```text
__storageDir__/state.json
safe load
atomic save
schema version
```

---

# 31. 发布包结构

最终 ZIP 根目录：

```text
ipqa-alert-report.zip
├── komari-plugin.json
├── script.js
└── assets/
    └── icon.svg
```

不要把整个 `node_modules` 放进去。

---

# 32. 推荐开发方式

使用 Komari 官方 SDK：

```text
@komari-monitor/plugin-sdk
```

优先 TypeScript 开发，再 bundle 到：

```text
script.js
```

可以参考：

```text
npm create komari-plugin
```

以及当前流量定期报告插件的工程结构。

---

# 33. 兼容性检测

`load()` 时推荐检查关键 RPC：

```text
common:getNodes
admin:exec
admin:getTaskResultsByTaskId
admin:sendNotification
```

如果 SDK 提供：

```javascript
rpc.has(method)
```

可优先使用。

如果缺少关键 RPC：

- 插件日志明确输出；
- 当天不要尝试执行日报；
- 不要无限 throw 导致插件整体反复重载。

---

# 34. 核心主流程伪代码

```typescript
async function runDailyReport() {
    const config = await loadConfig();

    if (!config.enabled) {
        return;
    }

    const bj = getBeijingParts();
    const dateKey = formatBeijingDateKey(bj);

    if (state.last_run_beijing_date === dateKey) {
        return;
    }

    if (running) {
        return;
    }

    running = true;

    try {
        const nodeMap = await getNodeMap();
        const targets = resolveTargetNodes(config, nodeMap);

        if (targets.length === 0) {
            log("no selected nodes");
            markRunComplete(dateKey, emptySummary);
            return;
        }

        const { startEpoch, endEpoch } = getBeijingDailyWindow(dateKey);

        const command = buildIpqaReadCommand({
            startEpoch,
            endEpoch,
        });

        const task = await server.call("admin:exec", {
            command,
            clients: targets.map(n => n.uuid),
        });

        const remoteResults = await waitForTaskResults({
            taskId: task.task_id,
            targets,
            timeoutMs: 30_000,
        });

        const nodeResults = targets.map(node => {
            return parseNodeResult(
                node,
                remoteResults.get(node.uuid),
                config
            );
        });

        const report = buildDailyReport({
            dateKey,
            startEpoch,
            endEpoch,
            nodeResults,
        });

        const shouldNotify =
            report.alertCount > 0 ||
            (
                config.notify_collection_failures &&
                report.failedNodes.length > 0
            );

        if (shouldNotify) {
            const message = renderReport(report, config);
            await sendNotification(message, report);
        }

        await markRunComplete({
            dateKey,
            taskId: task.task_id,
            report,
        });

    } catch (error) {
        logError(error);
        await recordFailedAttempt(dateKey, error);
        throw error;
    } finally {
        running = false;
    }
}
```

---

# 35. Scheduler 伪代码

```typescript
function isBeijingDue(now = new Date()) {
    const bj = getBeijingParts(now);

    // 推荐 10 分钟恢复窗口
    return bj.hour === 7 && bj.minute >= 0 && bj.minute < 10;
}

async function schedulerTick() {
    const bj = getBeijingParts();
    const dateKey = formatBeijingDateKey(bj);

    if (!isBeijingDue()) {
        return;
    }

    if (state.last_run_beijing_date === dateKey) {
        return;
    }

    if (state.attempt_date === dateKey && state.attempt_count >= 3) {
        return;
    }

    await runDailyReport();
}

server.cron("* * * * *", async () => {
    try {
        await schedulerTick();
    } catch (err) {
        console.error("[IPQA] scheduled run failed", err);
    }
});
```

---

# 36. 配置草案示例

以下只是结构示意，`select.options` 的准确编码需要按当前 Komari UI 实现确认。

```json
{
  "$schema": "./node_modules/@komari-monitor/plugin-sdk/schema/komari-plugin.schema.json",
  "name": {
    "zh-CN": "IPQA 告警报告",
    "en": "IPQA Alert Report"
  },
  "short": "ipqa-alert-report",
  "version": "0.1.0",
  "komari": ">=1.4.3",
  "entry": "script.js",
  "author": "Your Name",
  "permissions": {
    "node": true,
    "allowSystemRPC": true,
    "timeout": 120
  },
  "configuration": {
    "type": "managed",
    "data": [
      {
        "key": "enabled",
        "name": {
          "zh-CN": "启用 IPQA 告警报告",
          "en": "Enable IPQA alert report"
        },
        "type": "switch",
        "default": true
      },
      {
        "key": "all_nodes",
        "name": {
          "zh-CN": "为全部节点启用",
          "en": "Enable for all nodes"
        },
        "type": "switch",
        "default": false
      },
      {
        "key": "nodes",
        "name": {
          "zh-CN": "选择节点",
          "en": "Select nodes"
        },
        "type": "nodes",
        "default": "[]"
      },
      {
        "name": {
          "zh-CN": "固定每天北京时间 07:00 汇总当天 00:00–07:00 的 IPQA 告警。IPQA 应已在北京时间 04:00 完成自动检测。",
          "en": "Runs daily at 07:00 Asia/Shanghai and summarizes IPQA alerts from 00:00 to 07:00. IPQA is expected to finish its scheduled check at 04:00 Asia/Shanghai."
        },
        "type": "textbox"
      },
      {
        "key": "min_severity",
        "name": {
          "zh-CN": "最低通知等级",
          "en": "Minimum severity"
        },
        "type": "select",
        "default": "INFO"
      },
      {
        "key": "ignore_initial_archive",
        "name": {
          "zh-CN": "忽略首次建档记录",
          "en": "Ignore initial archive event"
        },
        "type": "switch",
        "default": true
      },
      {
        "key": "notify_collection_failures",
        "name": {
          "zh-CN": "采集失败时通知",
          "en": "Notify on collection failures"
        },
        "type": "switch",
        "default": true
      },
      {
        "key": "template",
        "name": {
          "zh-CN": "通知模板",
          "en": "Notification template"
        },
        "type": "richtext",
        "default": ""
      }
    ]
  }
}
```

---

# 37. 测试计划

## Test 0：RPC 能力验证

单节点：

```text
admin:exec("printf IPQA_PLUGIN_POC")
```

通过条件：

```text
拿到 task_id
能读取任务结果
stdout 正确
不要求交互式 2FA
```

这是正式开发前的硬前置条件。

---

## Test 1：三节点全无告警

准备：

```text
A: 0 alerts
B: 0 alerts
C: 0 alerts
```

期望：

```text
admin:sendNotification 调用次数 = 0
```

---

## Test 2：单节点有告警

```text
A: WARNING x1
B: 0
C: 0
```

期望：

```text
只发送 1 条通知
只展示 A
```

---

## Test 3：多个节点都有告警

```text
A: WARNING x2
B: CRITICAL x1
C: INFO x1
```

期望：

```text
只发送 1 条通知
正文同时包含 A/B/C
```

---

## Test 4：初始化记录

日志：

```text
INFO|首次完成数据存档监测|IPv4
```

`ignore_initial_archive=true`

期望：

```text
不计入告警
如果没有其他告警，则完全静默
```

---

## Test 5：severity = WARNING

输入：

```text
INFO x3
WARNING x2
CRITICAL x1
```

期望：

```text
只保留 WARNING x2 + CRITICAL x1
```

---

## Test 6：severity = CRITICAL

期望：

```text
仅保留 CRITICAL
```

---

## Test 7：节点 alerts.log 不存在

期望：

```text
status = NOT_FOUND
```

如果：

```text
notify_collection_failures=true
```

则在同一条通知的“采集异常”区域出现。

---

## Test 8：一台 Agent 超时

```text
A: alerts x1
B: timeout
C: 0
```

期望：

```text
1 条通知
包含 A 告警
包含 B 采集异常
C 不显示
```

---

## Test 9：不同服务器时区

节点设置：

```text
A = UTC
B = America/Los_Angeles
C = Asia/Tokyo
```

给三台写入分别对应同一个北京时间 04:05 的日志。

期望：

```text
07:00 报告三台全部正确筛到
```

这是核心测试。

---

## Test 10：主控时区不是北京时间

Komari 主控设置：

```text
UTC
```

期望：

```text
插件仍在北京时间 07:00 运行
```

再测试：

```text
America/Los_Angeles
```

仍应是北京时间 07:00。

---

## Test 11：重复执行保护

同一天 07:00 窗口内多次调用 schedulerTick。

期望：

```text
日报只完成一次
通知最多一条
```

---

## Test 12：Komari 在 07:00 短暂重启

如果实现 10 分钟恢复窗口：

```text
07:00 down
07:04 plugin loaded
```

期望：

```text
07:04 补执行
统计窗口仍固定结束 07:00:59
```

---

## Test 13：超长消息

生成大量 INFO。

期望：

```text
始终最多调用一次 sendNotification
正文自动摘要/截断
不拆成第二条 TG
```

---

# 38. 验收标准

全部满足才算完成。

## 功能

- [ ] 可在 Komari 插件页面安装、启用；
- [ ] 配置页可以选择节点；
- [ ] 不需要 SSH；
- [ ] 不需要 TG Token；
- [ ] 每天北京时间 07:00 运行；
- [ ] 不受 Komari 主控时区影响；
- [ ] 读取 IPQA `alerts.log`；
- [ ] 正确统计北京时间当天 00:00–07:00；
- [ ] 正确处理节点本地时区差异；
- [ ] 默认忽略首次建档；
- [ ] 支持 INFO/WARNING/CRITICAL 过滤；
- [ ] 全部无告警时完全静默；
- [ ] 多个告警节点只发一条通知；
- [ ] 无告警节点不占正常告警正文；
- [ ] 节点失败不会阻断其他节点；
- [ ] 采集异常可配置是否通知；
- [ ] Telegram 长度过长时不拆多条；
- [ ] 插件重载不会导致同一天重复日报。

## 安全

- [ ] 不保存 SSH key；
- [ ] 不保存 Telegram token；
- [ ] 不申请 `allowExec`；
- [ ] 不申请 `allowAllFileAccess`；
- [ ] Agent 远程命令只读；
- [ ] 不允许用户输入任意远程 shell；
- [ ] 不运行 `ipqa --check`；
- [ ] 不修改 IPQA cron；
- [ ] 不禁用 Komari 2FA。

---

# 39. 推荐开发阶段

## Phase 0 — Compatibility PoC

只实现：

```text
插件 → admin:exec → 单 Agent → printf → task results
```

目标：确认插件内部远程执行不受 2FA 阻断。

**Phase 0 未通过，不进入后续阶段。**

---

## Phase 1 — 单节点 IPQA 读取

实现：

```text
固定单节点
固定今日北京时间窗口
读取 alerts.log
解析 status
打印 plugin log
```

不发 TG。

---

## Phase 2 — 多节点任务

实现：

```text
common:getNodes
nodes selector
admin:exec 多 clients
任务结果映射
单节点失败隔离
```

---

## Phase 3 — 告警解析/过滤

实现：

```text
INFO/WARNING/CRITICAL
初始化记录排除
重复行排除
统计模型
```

---

## Phase 4 — 单条通知

实现：

```text
report renderer
admin:sendNotification
无告警静默
多节点单消息
```

---

## Phase 5 — 北京时间调度

实现：

```text
每分钟 scheduler
UTC+8 gate
last_run_beijing_date
恢复窗口
重试限制
```

---

## Phase 6 — Managed Configuration

模仿 traffic report 插件完成配置页。

---

## Phase 7 — Hardening

完成：

```text
任务超时
消息长度限制
state atomic write
日志
兼容性检查
异常处理
```

---

## Phase 8 — Packaging

生成：

```text
komari-plugin.json
script.js
assets/icon.svg
ZIP
```

并在全新 Komari 环境测试安装。

---

# 40. 参考实现/文档

实现前应核对以下上游资源的当前版本：

1. Komari Plugin Development Guide  
   https://komari-document.pages.dev/en/dev/plugin/

2. Komari API / Remote Tasks / Notifications  
   https://komari-document.pages.dev/dev/api

3. Komari Plugin SDK  
   https://github.com/komari-monitor/plugin-sdk

4. Komari Server Plugin Runtime Source  
   https://github.com/komari-monitor/komari/blob/main/internal/plugin/plugin.go

5. Scheduled Traffic Reports Plugin  
   https://github.com/Akizon77/komari-traffic-report-plugin

6. IP-Quality-Archive  
   https://github.com/Chen017/IP-Quality-Archive

7. IPQA main script  
   https://raw.githubusercontent.com/Chen017/IP-Quality-Archive/main/ipqa.sh

---

# 41. 上游事实（实现时可依赖，但仍建议再次验证）

截至本文档生成时：

## Komari

- Plugin 使用 ZIP，根目录包含 `komari-plugin.json`；
- `allowSystemRPC` 允许插件通过 `server.call()` 以管理员权限调用系统 RPC；
- `server.cron()` 支持 5/6 字段 cron；
- `common:getNodes` 可获取节点；
- `admin:exec` 支持一次向多个 clients 下发 command；
- `admin:getTaskResultsByTaskId` 可查询任务结果；
- `admin:sendNotification` 可复用 Komari 当前消息发送 Provider；
- `__storageDir__` 是插件持久化目录，并可跨插件更新保留。

## 流量定期报告插件

- 使用 `allowSystemRPC`；
- 使用 managed configuration；
- 使用 `nodes` 类型的节点选择器；
- 通过 `common:getNodes` 获取节点；
- 通过 `admin:sendNotification` 发送报告。

## IPQA

- 默认 home：`$HOME/.ipqa`；
- 告警文件：`$HOME/.ipqa/data/alerts.log`；
- 告警结构：`时间|等级|消息|IP版本`；
- 存在 INFO / WARNING / CRITICAL；
- 首次存档会写入 `首次完成数据存档监测`；
- 默认推荐的自动检测时间是北京时间 04:00，并自动换算服务器本地 cron 时间。

---

# 42. 最终行为示例

假设选择三台：

```text
Los Angeles
Tokyo
Germany
```

北京时间 04:00 IPQA 自动检测后：

```text
Los Angeles:
  WARNING x1
  CRITICAL x1

Tokyo:
  0

Germany:
  INFO x1
```

北京时间 07:00：

插件完成一次 `admin:exec` 多节点读取。

最终只调用一次：

```text
admin:sendNotification
```

通知：

```text
⚠️ IPQA 每日告警
2026-09-21 · 北京时间 07:00
异常节点：2 / 3 · 告警：3
🔴 1  🟠 1  🔵 1

━━━━━━━━━━━━━━
🖥 Los Angeles
━━━━━━━━━━━━━━
🔴 IPv4 · ...
...

🟠 IPv4 · ...
...

━━━━━━━━━━━━━━
🖥 Germany
━━━━━━━━━━━━━━
🔵 IPv4 · ...
...
```

Tokyo 无告警，所以不显示。

若三台全部 0：

```text
不发任何消息。
```

---

# 43. 给实现 AI 的最后指令

实现时请遵守以下优先级：

```text
正确的北京时间调度
    >
不漏/不误筛当天 04:00 IPQA 告警
    >
多节点只发一条通知
    >
无告警完全静默
    >
节点失败隔离
    >
界面美化
```

不要为了 UI 复杂度牺牲核心可靠性。

V1 不需要独立 Dashboard，不需要自定义后台页面，不需要 HTTP route。

**优先做成一个类似“流量定期报告”的轻量 managed-config Komari 插件。**

