# dsh-subvision

**DeepSeek Harness (DSH) 图片识别插件** —— **一张图片 = 一台可追问的识别子代理**。

主管（主会话模型）调用工具 `image_recognize` 识别图片；对同一张图再次调用即**继续同一个子代理**（它记得之前的识别与结论），即使 **dsh-web 重启后**也能凭图片内容哈希冷恢复同一子代理续问。Settings 里有独立的「图片代理」页（识图设备页），可查看每一台图片代理、指定/重建其识别模型、按会话或全局清理图片缓存。

- 服务端: `image_recognize` 工具注册(每图一个 durable vision subagent, 重启后 followup 冷恢复) + `/dsh-subvision/v1/*` 设备页 API(同源)
- 客户端: Settings → 图片代理 独立页(默认模型/图片标准化/缓存占用/按会话分组的代理卡与跳转/换模型重建/删除记录/归档置灰)
- 设置: Plugin Settings → subvision 命名空间(默认模型、标准化开关与最长边、maxTokens、缺省提问)

## 特性

- **一图一代理**: 图片身份 = 文件内容 **SHA-256**(前 16 hex 作为标题标记)。第一次识别时经 `ctx.subagents.startContinuable` 创建专属子代理; 之后同图追问走 `ctx.subagents.sendMessage`(dsh 0.1.5 起取代旧 `followup`), 全程是同一个 child session, 记忆连续。
- **重启可续问**: 哈希 → childId 路由持久化在 `~/.dsh/subvision-state/<父会话id>.json`, 进程重启后 `image_recognize` 命中记录即冷恢复原子代理; 子代理标题恒为 `识图 | <图片路径> | <哈希前16位>`(哈希放末尾作持久标记)。
- **不嵌套委派**: 识图子代理创建时经 `SubagentStartRequest.toolFilter` 摘掉委派类工具(`subagent`/`subagent_fork`/`workflow`/`ralph`/`image_recognize` 及子代理控制类), 它既不能再起子代理、也不能递归识图 —— 识别永远是**单层**委派, 不会在触发它的会话里套娃。名单可用 `denyChildTools` 配置, 本部署未注册的工具名自动跳过(避免 `tools.restrict()` 未知名报错)。
- **模型自动选择**: 未设 `model` 时按**自动**解析 —— 取 LLM 目录里第一个声明 `inputModalities` 含 `image` 的模型(本部署为 `deepseek-official/deepseek-flash`), 因此识图子代理绝不会继承纯文本的主管模型(主管 `deepseek-v4-flash` 读不了图); 只有目录里没有任何视觉模型时才回落到主管模型。也可显式设 `model`, 或每次调用传 `model` 覆盖(`provider/model` 或裸模型名=沿用主管 provider); 仅在**新建**子代理时生效, 已建的保持创建时模型; 设备页可随时「重建为所选模型」。
- **图片大小标准化(用户自定义)**: `normalize` 开关 + `normalizeLongEdge`(默认 1024px) —— 超过上限才等比缩小(仅缩不放、自动扶正、去元数据), 并把 read_image 不支持的格式(heic/avif/bmp…)转码成 PNG; 依赖本机 ImageMagick(`magick`/`convert`), 缺失或失败时自动回退原图。标准化副本按内容哈希缓存。
- **URL 图缓存**: `image` 支持 http(s) URL, 自动下载进缓存并按哈希去重; 本地绝对路径直接读取。
- **缩略图缓存(原图失效不丢图)**: 识别时(原图确保存在)顺手把一张小图(最长边 192px, 首帧 PNG)写进 `~/.dsh/subvision-cache/thumbnails/`, 设备页缩略图只读这个缓存副本; 原图之后被移动/删除(如临时目录被清)卡片缩略图依然显示。无 ImageMagick 时退化为把原图原样快照进缓存, 都没有才显示占位图。
- **识图设备页(Settings → 图片代理)**: 每台代理一张缩略图卡片 + 所属会话分组; 顶部可改默认模型(Agent 预设样式浮窗, 带「视觉」标注)与标准化参数, 显示缓存占用; 每台卡片提供 主对话/子代理 跳转、识别模型下拉与「重建为所选模型」、「删除记录(顺带清理该图缓存)」; 会话头提供「清该会话缓存」。主会话被归档(workspace.json `archivedSessionIds`)时该组自动置灰并隐藏跳转/模型/重建操作。3s 自动刷新。

## 工具

`image_recognize`(默认注册名, 可在配置里改 `toolName`)

| 参数 | 必填 | 说明 |
|---|---|---|
| `image` | ✅ | 本地图片绝对路径(推荐)或 http(s) URL(自动下载进缓存) |
| `question` | | 对图片的问题; 缺省为配置的 `questionDefault`(详细识别描述) |
| `model` | | 本次识别模型覆盖: `provider/model` 或裸模型名(沿用当前 provider); 仅创建新子代理时生效 |

返回值: `{ action: "created" | "followup", imageKey, subagentId, title, note }`。
识别/追问的回答在子代理跑完后以**完成通知**送达主管(与内置后台 subagent 一致), 输出渲染即 note 文案。

## 图片身份与子代理标题

- 图片身份 = 文件内容 SHA-256(**内容变即新图**); 标题标记取前 16 hex。
- 子代理标题: `识图 | <图片路径> | <哈希前16位>` —— 前缀 `识图` 标类型、路径供人读、**哈希放末尾**作持久匹配标记。
- 追问路由: 内存注册表 → 进程重启后读 `~/.dsh/subvision-state/<父会话id>.json`(哈希→childId), 命中即 `ctx.subagents.followup` 冷恢复; 未命中才新建。同一 (父会话, 哈希) 并发调用有进程内锁, 不会重复建子代理。

## 配置(Plugin Settings → subvision)

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `spawn` | 子代理后端(spawn provider = 全新子 Agent) |
| `toolName` | `image_recognize` | 注册给模型的工具名 |
| `model` | 空(自动) | 默认识别模型 `{provider, model}`; **留空=自动**: 取目录里第一个声明 `image` 模态的模型, 目录无视觉模型时才回落主管模型 |
| `maxTokens` | 空 | 子代理 token 上限 |
| `denyChildTools` | 见 §特性 | 从识图子代理里移除的工具名(默认 `subagent`/`subagent_fork`/`workflow`/`ralph`/`image_recognize`/`list_agents`/`send_message`/`interrupt_agent`); 本部署未注册的名字自动跳过, 用于**禁止识图子代理再嵌套调用子代理** |
| `questionDefault` | 见 schema | 未给 question 时的缺省识别指令 |
| `normalize` | `true` | 图片大小标准化开关 |
| `normalizeLongEdge` | `1024` | 自定义最长边上限(px, 128–8192, 步进 16): 超过才缩小(仅缩不放、保比例、自动扶正), heic/avif/bmp 等转 PNG; 无转换工具自动回退原图 |

模型必须支持图片输入(vision); 插件只把声明 `inputModalities` 含 `image` 的模型在设备页标「视觉」, 子代理读图走标准 `read_image` 工具(该工具对模型视觉能力有强校验, 不支持会返回明确拒绝信息)。

## 文件职责

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口: settings 命名空间 + `image_recognize` 工具注册 + 每图子代理创建/追问路由(进程内锁) |
| `src/config.ts` | 配置 schema(schemastery)与 `normalizeConfig` 校验/归一 |
| `src/image.ts` | 图片解析(本地路径/URL 下载缓存)、SHA-256、标题标记、缓存根 |
| `src/image-std.ts` | 图片标准化: ImageMagick 缩放/转码到 `standardized/`, 失败回退原图 |
| `src/thumb.ts` | 缩略图缓存: 识别时/按需把 192px 缩略图写入 `thumbnails/`(无转换工具则原样快照), 与原图解耦 |
| `src/vision-registry.ts` | 哈希→childId 路由表(内存 + 落盘 `~/.dsh/subvision-state/`), 跨重启续问依据 |
| `src/vision-devices.ts` | 设备页服务端 API: 注册表/模型目录/缓存统计/缩略图/清理/重建 |
| `dist/` | tsc 编译产物(`main: dist/index.js`, `npm run build`) |
| `client.js` | DSH web 客户端: Settings → 图片代理 页(3s 轮询设备 API) |
| `cordis.patch.yml` | 插件组合声明(`id: subvision`) |

## API(同源, 经 DSH web 服务, 前缀 `/dsh-subvision/v1`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-subvision/v1/devices` | 全量: 每会话代理记录(带 `exists`/`archived`)、模型/视觉模型/提供方目录(60s 缓存)、缓存占用、当前配置 |
| GET | `/dsh-subvision/v1/thumbnail?session=&hash=` | 该代理的**缓存缩略图**(192px; 识别时已生成, 缺失时原图还在则即时生成, 两者都无才 404)。不再直读原图, 原图被清不影响显示 |
| POST | `/dsh-subvision/v1/cache` | 清空全局缓存(standardized + downloads + thumbnails) |
| POST | `/dsh-subvision/v1/cache/session` | 清空某会话下全部代理对应的缓存文件(记录保留) |
| POST | `/dsh-subvision/v1/device/delete` | 删除某代理记录并顺带清理该图缓存(子代理会话本身保留) |
| POST | `/dsh-subvision/v1/device/recreate` | 以指定 provider/model **重建**该图代理: 打断旧子代理 → 起新子代理 → 更新注册表 |

模型目录来源: `ctx.llm.listProviders` → `listModels` → `resolveModelInfo`(inputModalities 含 `image` 判视觉), 每 provider 缓存 60s, 逐模型探测 4s 超时、整表 10s 超时, 避免 3s 轮询打爆远端目录。

## 数据与状态文件

- 路由/记录: `~/.dsh/subvision-state/<sanitized-父会话id>.json`(`{ children: [{childId, imagePath, hash, provider?, model?, createdAt, lastUsedAt}] }`, 原子写)
- 缓存: `~/.dsh/subvision-cache/standardized/`(标准化副本 `<hash>-s<longEdge><ext>`)、`~/.dsh/subvision-cache/downloads/`(URL 下载原图 `<hash><ext>`)、`~/.dsh/subvision-cache/thumbnails/`(设备页缩略图 `<hash>.png` 或原格式快照 `<hash><ext>`, 与原图解耦)
- 归档判定: `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`(10s 缓存, 不以磁盘存在性代替)

以上路径均跟随 `DSH_HOME`(默认 `/root/.dsh`)。

## 安装(DSH profile)

```bash
# 在 DSH web profile 里以 link 方式安装(示例)
cd /root/.dsh/profiles/web && pnpm add "link:/path/to/dsh-subvision"
# 确认 bundle 登记(cordis.patch.yml, id: subvision)后重启 dsh web
```

需要: 支持图片输入(vision)的模型; 若开标准化则本机有 ImageMagick(`magick` 或 `convert`), 否则自动回退原图。无图形界面以外的浏览器页面依赖, 设备页在 Settings → 图片代理。

## 局限性(重要)

1. **依赖 DSH 内部契约**: 复用基座 `ctx.subagents`(`startContinuable`/`followup`/`interrupt`)与 `ctx.llm` 目录、`settings.section` 页面插槽、`sessions.open/openSubagent/subagentAddress`; DSH 升级可能改变这些接口, 需要回归适配; 非 rc.2 环境需自行验证。
2. **续问依赖记录与 durable 会话**: 冷恢复要求注册表 json 仍在且 child 会话仍可加载; 若 `~/.dsh/subvision-state/` 被清/损坏(损坏自动忽略并从空表重建)或子代理会话被清理, 同图会**新建**子代理。
3. **重建要求主管在线**: `device/recreate` 需 `ctx.agents.get(父会话)` 命中(409 否则), 且原图文件仍在(400 提示重新提交)。
4. **删记录 ≠ 删子代理会话**: 为安全起见删除仅清注册表记录与图片缓存, child 会话保留仅供追溯; 需要彻底删除请到对应会话的子代理区手动处理。
5. **缩略图与原图解耦(其余功能仍依赖原图)**: `/thumbnail` 只读 `subvision-cache/thumbnails/` 缓存副本(识别时生成, 缺失时原图还在则即时补), 原图被移动/删除后设备页缩略图仍显示; 但 `image_recognize` 续问、`device/recreate` 依然需要原图或 `standardized/`/`downloads/` 副本仍在(身份与识别以字节为准)。
6. **归档灰显语义**: 以 `workspace.json global.archivedSessionIds` 为准(10s 缓存), 归档组置灰并隐藏跳转/识别模型/重建, 仅保留记录删除与该会话缓存清理。
7. **无多用户鉴权**: API 仅做同源(Origin)校验, 不带用户权限; 适合单用户自托管场景。
8. **标准化是尽力而为**: 依赖本机 ImageMagick, 生成失败/超时(60s)/工具缺失都回退原图; 转码只为 read_image 可读性, 不改变原始语义。
9. **环境绑定**: 状态与缓存路径跟随 `DSH_HOME`; 多用户/多 profile 各自独立。
10. **模型目录探测开销**: 远端模型目录(如 opencode)枚举可能慢, 目录有 60s 缓存与超时兜底; 若 provider 不可用会静默从目录中缺失。

## 开发 / 供其他 Agent 修改

见 [AGENTS.md](./AGENTS.md)(架构、改动指引、测试 SOP、环境事实与已知坑、发布流程)。

## License

[GPL-3.0](./LICENSE) — GNU General Public License v3.0
