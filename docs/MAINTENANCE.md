# IPQA Alert Report 工程维护指南

## 模块与运行边界

| 位置 | 职责 |
| --- | --- |
| `src/index.ts`、`src/scheduler.ts` | 在 Komari 注册 HTTP、RPC 和定时任务。根据北京时间执行归档同步和通知报告。 |
| `src/ipqa/archive-*.ts`、`src/remote.ts` | 通过 Komari Agent 查询和读取 VPS 归档，校验批次后缓存原始数据，按天配对 IPv4/IPv6 并计算语义变动。 |
| `src/state.ts`、`src/storage/` | 持久化每日通知去重键、重试和同步状态，以及原始归档、日报、最新快照和节点索引。 |
| `src/collection.ts`、`src/ipqa.ts`、`src/report.ts` | 合并归档语义变动和节点 `alerts.log`，执行严重度、跨来源去重和消息长度规则。 |
| `src/api/`、`src/rpc-jobs.ts` | 从本地缓存服务主题，区分公开 HTTP 归档和管理员操作，并以任务 ID 暴露异步 RPC 进度。 |
| `komari-plugin.json`、`build.mjs` | 定义 Komari 权限、配置、入口和版本，构建 Goja 可加载的 ZIP。 |

Komari 运行时注入持久化目录 `__storageDir__`。其中 `state.json` 保存任务状态，`ipqa/node-index.json` 保存集群快照，`ipqa/nodes/<uuid>/` 包含 `raw/{v4,v6}`、`raw-times.json`、`daily/` 和 `latest.json`。升级时保留这些文件。修改公开数据形状、节点筛选或日期语义时，应同时核对 Emerald Insights 的读取端。

## 本地开发、测试与打包

使用 Node.js 24、Linux/macOS 的 `unzip` 或 Windows 自带的 `tar`，在仓库根目录运行以下命令。

```sh
npm ci
npm run verify
```

`verify` 依次执行 `npm run typecheck`、`npm test`、`npm run build` 和 `npm run test:package`。开发时可单独执行任一步。Node 测试使用替身模拟 Komari、Agent 和通知服务，涉及持久化的用例使用临时目录。测试文件可并行执行，同一文件中使用全局存储注入的用例按默认串行执行。修改远程采集或状态写入时，应优先增加通过实际同步入口的故障回归。

正式 ZIP 为 `ipqa-alert-report.zip`，包含 `komari-plugin.json`、`script.js` 和 `assets/icon.svg`。esbuild 将 TypeScript 打成单一 CommonJS 脚本，保留 Komari 的 `server` 模块和 Goja 全局 `load` / `unload`。源码测试中的版本标识是 `development`，打包时注入实际包内 manifest 版本。

`npm run build:beta` 生成带提交号的 `ipqa-alert-report-beta-<sha>.zip`。Beta 版本写入包内 manifest 和脚本，源文件版本、插件标识及存储目录保持一致。

## CI 与发布

CI 在面向 `main` 的 PR、涉及工程文件的 `main` 推送和手动运行时执行。工作流使用 Node.js 24、npm 下载缓存和锁文件安装依赖，依次运行 `verify` 的全部步骤。README 和 `docs/` 的纯文档推送跳过 CI，PR 仍执行检查。手动运行可下载已验证的正式 ZIP。

发布前用 `npm version <版本> --no-git-tag-version` 同步 `package.json` 与 `package-lock.json`，同时更新 `komari-plugin.json`。推送到 `main` 后，工作流检查 `v<版本>` 是否已有完整 ZIP。需要发布时，发布任务校验标签指向该提交，复用同次验证生成的 `ipqa-alert-report.zip` 并上传到 Release。发布失败可检查 Actions 日志并重跑原工作流。标签指向其他提交时，核对版本是否被复用。仓库写权限仅由发布任务取得。

## 兼容约定与故障排查

| 约定 | 维护和回归入口 |
| --- | --- |
| 北京时间与文件 mtime | VPS 文件名使用其本地时间。存在有效 mtime 时由该时间确定北京时间日键，`raw-times.json` 在远程清理后保留历史时间依据。`time.test.mjs`、`review_regressions.test.mjs` 覆盖。 |
| 下载完整性和缓存重建 | 同批响应必须与请求的协议和文件名一一对应，验证后才写入该批文件。重建校验全部日键，写完日报只发布一次 `latest.json`，再清理失效日报。参见 `auto_sync_risk_freshness.test.mjs`、`storage-performance.test.mjs`。 |
| 报告重试与去重 | 04:10–04:59 每五分钟尝试归档同步。07:00–07:09 报告窗口内按规则重试，已发送条目和跨来源重合键保存在 `state.json`。归档语义结果优先，旧 `alerts.log` 补充。状态文件先写临时文件再原子替换，替换失败时保留旧状态。可重建的归档缓存仍支持原有文件锁回退。参见 `scheduler.test.mjs`、`alert_unification.test.mjs`、`state.test.mjs`。 |
| 数据未知值、隐私与 RPC | 缺失评分保持 Unknown。公开 HTTP 仅包含当前可见节点，隐藏 IP 和原始扩展数据，响应使用 `private, no-store`。只读 RPC 同步返回缓存，手动 RPC 返回任务 ID。参见 `security_and_semantics.test.mjs`、`api.test.mjs`。 |

`plugin:*` RPC 由 Komari 的统一 ACL 限制为管理员调用。公开 HTTP 归档使用插件自己的节点可见性检查和脱敏规则。修改入口前核对 [Komari 插件开发指南](https://komari-monitor.github.io/komari-document/dev/plugin/index) 中的 RPC 约定。

- 无归档或同步失败时，先检查目标节点在线状态、IPQA 归档路径及 `[IPQA-SYNC]` 日志。手动同步后可检查节点的最新归档日期和 freshness。
- 报告没有送达时，检查 Komari 通知渠道、所选节点、最低严重度、首次建档过滤及当日发送状态。当天没有符合规则的条目时，报告保持静默。
- 包校验失败时，检查 npm 锁文件、manifest 版本和 ZIP 入口。源测试使用 Node 模拟宿主，部署前可在独立 Komari 实例验证实际安装与后台日志。

变更公开 API、归档格式、构建或发布流程时，同步更新 README、维护指南及相关回归。
