# AGENTS.md — 给其他 Agent 的维护手册

本文件面向接手修改 dsh-subvision 的 AI Agent。所有信息自包含, 无需原对话上下文即可照做。

## 0. 这是什么

DSH(DeepSeek Harness)web 插件: **一张图片 = 一台可追问的 vision 识别子代理**。

- 服务端插件(`src/*.ts` → `dist/index.js`): 注册 `image_recognize` 工具 + `/dsh-subvision/v1/*` 设备页 API + `subvision` settings 命名空间。
- 客户端插件(`client.js`, 手写 ModuleLoader bundle, 无构建): Settings → 「图片代理」独立页(`settings.section` id `subvision-devices`)。
- 默认数据文件(跟随 `DSH_HOME=/root/.dsh`):
  - 注册表(哈希→childId): `/root/.dsh/subvision-state/<父会话id(非法字符→_)>.json`, schema `{children:[{childId,imagePath,hash,provider?,model?,createdAt,lastUsedAt}]}`
  - 缓存: `/root/.dsh/subvision-cache/standardized/`(`<hash>-s<longEdge><ext>`)、`/root/.dsh/subvision-cache/downloads/`(`<hash><ext>`)、`/root/.dsh/subvision-cache/thumbnails/`(缩略图 `<hash>.png` 或原格式快照 `<hash><ext>`)
  - 归档清单: `/root/.dsh/storages/workspace.json` → `global.archivedSessionIds`
  - 会话文件: `/root/.dsh/sessions/<workspace>/<sessionId>/session.jsonl.zstd`

## 1. 文件职责与改动指引

### src/config.ts(无副作用)
- schemastery `Config` + `normalizeConfig(input)`。**校验规则**: model 必须 provider+model 成对; maxTokens 正整数; normalizeLongEdge 128–8192 步进 16(默认 1024); questionDefault 非空; toolName 默认 `image_recognize`。改动 schema 后**同步 dist**(`npm run build`)并重启。

### src/image.ts
- `resolveImage(image)` — 本地绝对路径直接读; `http(s)://` 下载进 `downloads/<hash><ext>`, 按内容 SHA-256 去重(`wx` 防并发覆盖)。`hashMarker(hash)` = sha256 hex 前 16 位, 标题标记。`cacheRoot()` 跟随 `DSH_HOME`。

### src/image-std.ts
- `standardizeImage(resolved, longEdge, enabled)` — 开 `normalize` 且存在 `magick`/`convert` 时: 生成 `standardized/<hash>-s<longEdge><ext|.png>`, 参数 `原图 -auto-orient -strip -resize <L>x<L>> 输出`(仅缩不放)。readable 扩展名 png/jpg/jpeg/webp/gif 保留, 其余(heic/avif/bmp)→ PNG 转码。缓存命中直接复用。**任何失败回退原图**(`changed:false`)。
- `findConverter()` 已导出(进程内缓存探测 magick/convert), 供 `thumb.ts` 复用。

### src/thumb.ts(缩略图缓存, 与原图解耦)
- `ensureThumbnail(hash, {originalPath, fallbackPaths?})` — 目标: 设备页缩略图不再依赖原图存活。策略(首个命中即返回): ① `thumbnails/` 已有该 hash 的缓存文件(任意名字)直接复用; ② 有 magick/convert 且任一源可读: `源[0] -auto-orient -strip -resize 192x192> thumbnails/<hash>.png`(取首帧, 仅缩不放, 20s 超时); ③ 否则把第一个浏览器可读(png/jpg/jpeg/webp/gif)的源**原样快照**到 `thumbnails/<hash><ext>`; ④ 都不行返回 `null`(UI 显示占位)。正常 IO/图像错误不抛异常, 逐级降级。
- 关键调用点: `index.ts` 工具流(识别时原图必在, **热生成**)、`vision-devices.ts` 的 `/thumbnail`(缺失时原图还在则**冷补**, 没有缓存且原图已消失才 404)、`device/recreate`(顺带补齐)。

### src/vision-registry.ts
- `VisionRegistry(parentSessionId)`: 每父会话一张表, 文件 `<stateDir>/<sanitize(parentSessionId)>.json`; `find(hash)/remember(record)/forget(hash)/all()`; 落盘先写 `.tmp` 再 rename(失败直接写)。损坏文件 warn 后忽略。`VisionRegistry.allSessions()` 静态扫全目录(忽略 `.tmp`), 按首个 createdAt 升序。
- **跨重启续问的唯一依据**: 改动 childId 归属/文件命名必须保持可迁移, 否则重启后续问会重建子代理。

### src/index.ts(服务端插件入口)
- `inject = ["tools","subagents","agents","llm","webServer"]`。`apply` 做: 装 settings 命名空间(`subvision`, 经 `installSettingsSection`), 装设备 API, 注册 `image_recognize`。
- 工具执行流程: `resolveImage` → `standardizeImage` → `ensureThumbnail`(趁原图必在, 热生成缩略图缓存; 失败不阻断) → 查注册表(命中→`ctx.subagents.followup` 冷恢复续问; 未命中→`ctx.subagents.startContinuable` 新建, `agentOptions` = provider/model/maxTokens) → `remember`。
- 标题恒为 `识图 | <路径> | <哈希前16>`, prompt 内附路径/哈希/标准化说明(标准化时注明缩放比例换算)。
- **同 (父会话,哈希) 并发**: `createLocks` 进程内 promise 队列, 防双建。
- model 覆盖解析 `parseModelOverride`: 含 `/` → provider/model; 裸名 → 沿用 parent provider; 空 → 无覆盖。

### src/vision-devices.ts(设备页 API, 前缀 `/dsh-subvision/v1`)
- 端点与行为见 README「API」表。要点:
  - 模型目录: `ctx.llm.listProviders → listModels → resolveModelInfo`; 每 provider 缓存 60s; 每模型 resolve 4s 超时、整 provider 10s 超时; `ctx.llm` 可能不可用(用 try/catch 包), 目录为空则 UI 只剩默认/跟随。
  - `archived` 以 `workspace.json global.archivedSessionIds` 为准(10s 缓存); `exists` 是跨 workspace 扫 `session.jsonl.zstd`。**不要用磁盘存在性代替归档判定**。
  - 缩略图: 经 `ensureThumbnail` 走 `thumbnails/` 缓存(识别时热生成; 端点缺失且原图还在则冷补); **不再直读 `record.imagePath`**。找不到缓存且原图已消失 → 404(仅占位图)。
  - `device/recreate`: 需父会话在线(`ctx.agents.get`), 先 `ctx.subagents.interrupt` 旧 child, 再 `startContinuable` 新 child 并 `remember`; 顺带补齐缩略图缓存。**注意 `interrupt` 缺失场景为 no-op**。
  - `removeHashFiles`/`cacheStats`/全局清缓存都覆盖 `thumbnails/` 目录, 别漏。
- 服务端改动必须**重启 DSH** 生效(ESM 模块缓存), 用 `restart_harness` 工具(见 §4)。

### client.js(浏览器端, settings.section 页面)
- `NS="subvision-devices"`(locale 字典 zh:图片代理/en:Image Agents); `SETTINGS_NS="subvision"`(与 settings 命名空间对应, 保存走 `api.settings.mutate`); `API="/dsh-subvision/v1"`; 轮询 3s。
- 注册: `ctx.slots.inject("settings.section")` + `ctx.slots.register({... id:"subvision-devices", order:27}, comp)`, 入参 ownerProps 带 `close`; `exports.inject=["slots","locale","settingsScope","connection","sessions"]`。
- 行样式 `settingsRowStyle` 与 meili/hot-ssh 同款(16px padding/borderBottom/gap24, 标题 14/22, 说明 12/18, 右侧 maxWidth 58%); 模型选择用 Agent 预设式胶囊+浮窗 `ModelPicker`(视觉模型带「视觉」标注)。
- 跳转: `sessions.open(id)` 开主对话; `sessions.openSubagent(subagentAddress(childId))` 开子代理视图, 失败退化为直接 open child/parent。跳转成功即 `closeSettings()`。
- 归档卡(`group.archived===true`)置灰(整卡 opacity .55)、隐藏 主对话/子代理/识别模型/重建, 保留 删除记录 与「清该会话缓存」; 会话头显示「已归档, 不可跳转」。
- 默认模型/标准化改动经 `api.settings.mutate({ns:SETTINGS_NS,...})`(`set`/`unset`), 保存后 `refresh()`。
- **客户端改动重启后生效**(启动载荷带 rev; 无 pnpm dev:web 时无 HMR)。

## 2. 测试 SOP

```bash
# 1) 语法/类型
node --check client.js
npm run build        # 需 ts 5.9(devDeps 已声明), 产出 dist
npm run typecheck

# 2) 识别→续问→重启续问(核心契约)
#    在任一主管会话调 image_recognize 识别 /tmp/x.png → action=created, subagentId=A
#    再调一次 → action=followup, subagentId=A(同 child)
#    restart_harness 重启 dsh-web 后再调 → 仍 followup, subagentId=A(冷恢复)

# 3) API(设备页)
curl -s http://127.0.0.1:3080/dsh-subvision/v1/devices
#    sessions[].archived: 归档会话 true; exists: 磁盘存在
curl -s 'http://127.0.0.1:3080/dsh-subvision/v1/thumbnail?session=<sid>&hash=<hash>' -o /tmp/t.png
curl -s -X POST http://127.0.0.1:3080/dsh-subvision/v1/device/recreate -H 'content-type: application/json' \
  -d '{"session":"<sid>","hash":"<hash>","provider":"deepseek-official","model":"<vision-model>"}'
#    → newChildId 与旧不同; 注册表已换
curl -s -X POST http://127.0.0.1:3080/dsh-subvision/v1/cache/session -H 'content-type: application/json' -d '{"session":"<sid>"}'
curl -s -X POST http://127.0.0.1:3080/dsh-subvision/v1/device/delete -H 'content-type: application/json' -d '{"session":"<sid>","hash":"<hash>"}'

# 4) GUI 冒烟(浏览器, Settings → 图片代理)
#    - 顶部默认模型改 provider/model → 设置保存并刷新
#    - 标准化: 关闭/512/1024/2048/自定义 128–8192
#    - 代理卡: 缩略图、主对话/子代理跳转、识别模型浮窗选择后重建、删除记录
#    - 归档会话卡置灰、无跳转与模型/重建行; 非归档正常
#    - 缓存占用变化; 3s 自动刷新无闪烁
```

## 3. 已知坑(改代码前必读)

- **llm 注入可选**: 设备 API 通过 try/catch 读 `ctx.llm`, 目录为空时页面应优雅降级, 勿假设必有。
- **`resolveModelInfo` 可能慢/拒**: 远端目录(如 opencode)枚举慢, 逐项 4s/整表 10s 超时 + provider 级 60s 缓存; 别把目录改成每轮全量刷新。
- **归档判定**: 只信 `workspace.json global.archivedSessionIds`(10s 缓存); 会话语义上「不在列表」≠ 未归档, 且磁盘存在性 ≠ 可跳转。
- **注册表文件写坏/被清**: 损坏自动忽略(空表)→ 同图将新建子代理; 属可接受降级, 勿在 UI 声称必然续问成功。
- **recreate 前必查**: 父会话离线(agents.get 空)或原图文件丢失时返回明确 4xx, 不要静默。
- **child 复用判定**: `interrupt` 一个已结束/不存在的 child 是无害 no-op, 可放心调用。
- **删除 ≠ 销毁**: `device/delete` 只清注册表记录+缓存文件; child 会话留给用户手动处理(README 局限 4)。
- **client settingsScope 命名空间**: 写 `subvision` 配置用 `SETTINGS_NS`; section id 是 `subvision-devices`, 两者不同, 别混。
- **改 config/schema 或服务端必须重编译 + 重启**: dist 是 tsc 产物, 直接改 src 不生效; 重启用 `restart_harness` 工具(勿在会话内直接 systemctl 重启宿主服务)。
- **不要在 monorepo(/codebase)里嵌套 init git**: 会变 gitlink 子仓库, 污染主仓库; 独立发布用镜像目录(见 §4)。
- **codebase 镜像含 dist**: 根 .gitignore 忽略 `dist/`, 镜像提交需 `git add -f js/dsh-subvision/dist` 等(先例: dsh-subagent-pi)。

## 4. 发布与重启

- 本仓库 origin(独立发布仓): `git@github.com:zglinus-for-agent/dsh-subvision.git`(账号 zglinus-for-agent, 公开); 本地开发/留档镜像在 `/codebase/js/dsh-subvision`(monorepo)。
- 镜像目录 `/root/user/dsh-subvision`(运行安装 + 独立 git)与 codebase 留档从开发树同步(排除 node_modules / dist 按 §1 处理)。
- 流程: 开发树改好(src/client/README/AGENTS) → `npm run build` → 同步 dev → codebase 镜像与 /root/user 镜像 → codebase monorepo commit+push(`git add -f js/dsh-subvision/dist`) → /root/user 独立仓 commit+push(main) → `npm publish`(发布清单由 package.json `files` 白名单 + `publishConfig.access=public` 控制; 发布前 `npm pack --dry-run` 检查)。
- 发布身份: npm 账号 zglinus(本机 `/root/.npmrc` 有 token, 已绑定 dsh-meili-search 同账号); GitHub 推送用 SSH `~/.ssh/id_ed25519`(zglinus-for-agent)。
- 重启 DSH 使改动生效: `restart_harness`(延迟重启并返回日志路径); 重启后 `GET /dsh-subvision/v1/devices` 或页面 3s 轮询确认。

## 5. 环境备注

- 本机既有测试图: `/root/developer/subvision-test.png`(hash baa823c1…)、`/root/developer/v25_shot.png`(hash cf9335e1…), 会话 c97aec8b/06e2caf8/96682158 为历史识别样例; `/root/developer/dsh-subvision` 为开发树。
- 缓存/状态目录在 `/root/.dsh/subvision-cache`、`/root/.dsh/subvision-state`; 手工清理只影响缓存/续问路由, 不影响已有 child 会话文件。
