# 性能优化 Beta（2026-10-28）

批量重建每日报告时直接写入各日报，并在全部日报写入后只发布一次 latest。保留单日报保存行为、日期验证和旧日期清理。90 天报告重建不再反复读取 latest（89 → 0 次）；不改变归档内容和 API。

102 项回归及 TypeScript 检查通过，涵盖归档、语义变动、通知、权限及新增批量写入检查。

```sh
npm run test
npx tsc --noEmit
npm run build:beta
```

Beta 包名包含提交号，只有包内 manifest 的版本添加 Beta 后缀；源文件的正式版本、插件标识、存储路径及配置不变。普通 `npm run build` 的包名保持不变。未发布 GitHub Release。
