# dsh-codearts-connect

把 **CodeArts Agent（码道）** 的模型接入 DeepSeek Harness 的 DSH 插件。

形态与 `dsh-workbuddy-connect` 相同：插件自己启动一个只监听 `127.0.0.1` 的
OpenAI 兼容 shim，通过公开的 `PiAiAdapter` 注册一个 `codearts` provider；
不需要单独的 Python 桥接进程，也不需要手写 `llm-pi-ai` provider 配置。

## 工作原理

码道桌面端登录后拿到一组华为云 STS 临时凭据（AK / SK / security-token），
并对每个模型请求做 `SDK-HMAC-SHA256` 签名，调用：

```
https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions
```

插件负责：

1. 读取 `$DSH_HOME/.codearts-session.json`（登录态文档）；
2. 凭据过期后从码道桌面端重新导入登录态，**不轮换 refresh token**
   （轮换会让码道客户端自己掉线）；
3. 在本机回环端口启动 OpenAI 兼容 shim；
4. 把 shim 注册成 DSH 的 `codearts` provider。

## 安装

从仓库克隆后装进 profile：

```powershell
git clone https://github.com/yysbhub/dsh-codearts-connect-plugin.git `
  "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect"
dsh plugin --profile desktop add "file:$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect"
```

也可以从 Releases 里下载 `dsh-codearts-connect-<version>.zip` 解包到同一位置，
在目标机上运行其中自带的 `scripts/install-windows.ps1`（它会解包、注册、
补 profile bundles 并检查登录态，可重复执行）。

并在 profile 的 `cordis.patch.yml` 或 bundle 列表中挂载：

```yaml
- insert:
    - id: llm-codearts
      name: dsh-codearts-connect
```

## 登录态

默认读取 `$DSH_HOME/.codearts-session.json`。可以从码道桌面端重新导入：

```powershell
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" login
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" status
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" sync
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" models
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" probe
```

`login` 通过 Windows DPAPI 解密码道 Electron 的 `HuaweiCloudSession`，
写入 session 文档并立即刷新一次。需要 Python 3（含 `cryptography`）。
`models` 从码道桌面端本地缓存读出模型目录（含上下文窗口、最大输出、是否支持
图片、属于哪些 agent），只读本地 SQLite、不需要登录态——但**缓存会过期**，
码道下线的模型仍会留在里面。`probe` 才是真相：它按 `lib/models.js` 里的清单
逐个向网关发一次极小的真实请求，报告 `OK / DEAD / THRT / ERR`，其中 `DEAD`
（无权调用或未注册）就是已经下线的模型，删掉对应行重新打包即可。

已有旧桥接的 `state.json` 也可以直接导入：

```powershell
node "...\dsh-codearts-connect\bin.js" import D:\path\to\state.json
```

### 切换账号

插件跟着**码道客户端当前登录的账号**走，不需要手动改配置：

- 每次发请求前，插件用内置 `node:sqlite` 直读码道 state 库里的
  `userInfoKey.id`（一次索引查询，结果缓存 60 秒），和自身 session 文档里的
  `account_id` 比对；
- 不一致就立刻回读客户端的 DPAPI 登录态并切换（**不轮换 refresh token**），
  所以换账号后最多一分钟内自动生效，无需重启 DSH；
- 插件启动时也会主动对齐一次，并在日志里写明 `codearts account switched A → B`；
- `status` 会同时打印 `account`（插件记录）和 `appAccount`（客户端当前），
  不一致时给出提示；`sync` 可立即强制对齐：

```powershell
node "...\bin.js" sync
```

注意：AK/SK 是按账号签发的，旧账号的凭据即使还没过期也不能用于新账号——
这正是"换了账号但插件还在用旧账号"的原因，现在由上面的比对逻辑解决。

refresh token 是一次性轮换的：如果码道客户端和插件各自刷新导致 token 链断裂，
在码道 Agent 里重新登录一次，再运行 `login` 即可。

## 配置

插件配置（`cordis.patch.yml` 中可覆盖）：

```yaml
- id: llm-codearts
  config:
    sessionFile: ''              # 默认 $DSH_HOME/.codearts-session.json
    visionModel: kimi-k3         # 文本模型的图片轮次改道到这里（需账号可调用）
    maxRequestBytes: 8388608     # 超过 8 MiB 的请求先把图片降级成文字说明
    streamIdleTimeoutMs: 300000
    models:
      # 一般情况下不用写 models：默认就是码道当前授予账号的完整目录。
      # 只有想收窄选择器列表时才覆盖，写法见下表。
      - id: glm-5.3
        name: GLM-5.3
        contextWindow: 1048576
        maxTokens: 65536
        supportsImages: false
        # 思考级别：可写简写列表，也可写"级别 → reasoning_effort 值"的映射，
        # null 表示该模型不支持这一级（不会出现在 DSH 的选择器里）
        reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }
```

默认发布码道当前授予账号的完整模型目录：

| 模型 id | 名称 | 上下文 | 最大输出 | 图片 |
| --- | --- | --- | --- | --- |
| `kimi-k3.1-pro` | Kimi-K3.1-Pro | 1,048,576 | 65,536 | ✅ |
| `kimi-k3` | Kimi-K3 | 1,048,576 | 65,536 | ✅ |
| `glm-5.3` | GLM-5.3 | 1,048,576 | 65,536 | — |
| `GLM-5.2` | GLM-5.2 | 202,752 | 65,536 | — |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | 1,048,576 | 65,536 | — |
| `deepseek-v4.1-flash-1017` | DeepSeek-V4.1-Flash-1017 | 1,048,576 | 65,536 | — |
| `openpangu-2.0-pro` | OpenPangu-2.0-Pro | 524,288 | 131,072 | — |
| `openpangu-2.0-flash` | OpenPangu-2.0-Flash | 524,288 | 131,072 | — |
| `glm-5.2-sft-harmony` | GLM-5.2-ArkTS-SPARK | 202,752 | 131,072 | — |

清单只保留 `bin.js probe` 实测可路由的模型。码道会不定期下线模型
（2026-11 下线了 `Qwen3-VL-235B`、`kimi-k2.6-vl`、`qwen2.5-coder-32b-internal`，
本地缓存目录里仍会显示它们），下线后插件若继续发布，选中就会报
"您当前无权调用该模型"。所以升级码道后先跑一次 `probe`，把 `DEAD` 的行从
`lib/models.js` 删掉再重新打包。

目录外条目（探活确认可路由，但码道目录里没有）：`kimi-k3.1-pro`、
`deepseek-v4.1-flash-1017`。前者是码道新上线的模型（客户端缓存里已是
CodeAgent 的当前选中模型，上下文 1M、输出 65536），后者是 v4.1-flash 的
1017 快照。码道目录同步后这两行可以保留，也可以改成目录里的正式条目。

`id` 必须与网关完全一致，插件原样转发。注意大小写混用：
`glm-5.3`、`deepseek-v4.1-flash`、`openpangu-2.0-pro`、`kimi-k3.1-pro` 是小写，
而 `GLM-5.2` 是大写，两者不能互换。

### 思考级别（reasoning effort）

插件把 DSH 的思考级别改名成 `reasoning_effort` 发给网关（字段名由 pi-ai 的
`thinkingLevelMap` 决定），网关侧实测**确实生效**。默认声明五级：

```
low / medium / high / xhigh / max
```

`off`、`minimal` 统一声明为不支持——实测网关没有任何取值能让推理模型真正停止
思考（`none` / `minimal` 仍会产生推理内容），所以界面上不提供"关闭"这个假开关。

各模型对级别的敏感度差别很大（同题实测，思考字数）：

| 模型 | low | medium | high | xhigh | max |
| --- | --- | --- | --- | --- | --- |
| `glm-5.3` | 129 | 0 | 48 | 1495 | 1144 |
| `kimi-k3.1-pro` | 199 | — | 466 | — | 484 |
| `deepseek-v4.1-flash` | 235 | — | 500 | — | 1064 |

也就是说 `glm-5.3` 在 low/medium/high 之间几乎没有区别，**只有 xhigh / max 才
真的加长思考**；在这三级之间来回切会觉得"调了没反应"，属于模型侧特性。

`glm-5.3` 会拒绝 `reasoning_effort: none/minimal`（返回"参数值非法"），因此这两级
没有声明；如果哪天某个模型拒绝某个已声明的级别，`bin.js probe` 的
"思考级别验收"会直接报出来。

`maxTokens` 是 **DSH 单轮输出上限**，两个方向都会出问题：

- 设得偏低：DSH 用 `reason: max-tokens` 结束这一轮，UI 显示"回答被截断"。
- 设得过高：码道网关返回 in-stream `InferHub.001001005.400`，pi-ai 读不到
  `finish_reason`，于是报 `Stream ended without finish_reason`（TRANSPORT）。

shim 会把 `max_tokens` 钳到 `MAX_UPSTREAM_TOKENS`（65536，实测网关上限），
所以配置里写大写小都不影响上游。默认值即 65536。

注意：`openpangu-2.0-*`、`glm-5.2-sft-harmony` 申报的最大输出是 131072，
但网关侧统一按 65536 收口，所以钳制值对所有模型一视同仁。`models` 命令
输出的 `maxTokens` 是目录申报值，不是网关实收值。

多模态模型：`kimi-k3.1-pro`、`kimi-k3`（实测直接读图验证：纯色测试图能正确
答出颜色）。其余在列模型不支持图片。

图片路由规则：

- 所选模型本身支持图片 → 图片直接发给它，不改道；
- 所选模型是文本模型 → 把这一轮改道到 `visionModel`（默认 `kimi-k3`）；
- `visionModel` 不可用（比如当前账号无权调用，网关会以流内错误返回
  "您当前无权调用该模型"）→ 自动去掉图片重试一次，把图片换成一段文字说明，
  这一轮不会因此失败；
- 把 `visionModel` 设为空字符串 → 直接按文字说明处理，不做改道。

授权也按账号/企业开通，不同账号可用模型可能不同。遇到
"您当前无权调用该模型"，用 `bin.js probe` 确认后从 `lib/models.js`
（或用 `models` 配置项覆盖）里去掉对应条目即可；插件对视觉模型不可用
的情况已经做了降级处理，不会让整轮请求失败。

码道 APIG 对请求体大小有上限，超限会返回 `413 Request entity too large`
（`APIG.0201`）。shim 在发送前会检查 `maxRequestBytes`：

- 带图请求超过上限：先把图片降级成文字说明，保留对话继续；
- 上游仍返回 413：自动去掉图片重试一次；
- 纯文本仍超过上限：返回明确的 413，提示删除附件或新开会话。

图片在交给 pi-ai 前还会按 `requestImageMaxBytes`（默认 512 KiB/张）和
`requestImagePixelBudget`（默认 2 MP）压缩，通常单个截图不会触发上限。

> 修改插件代码后，DSH 需要重启一次才会重新加载模块；只改 `cordis.patch.yml`
> 会热加载配置，但不会替换已缓存的 JS 模块。

## 迁移到另一台机器

打包产物在 `dist/` 下（`npm run pack:dist` 或手工 `npm pack` 生成）：

- `dsh-codearts-connect-<version>.zip`：插件目录压缩包，解包即用；
- `dsh-codearts-connect-<version>.tgz`：npm 包，`dsh plugin add` 可直接安装。

目标机前提：装好 DeepSeek Harness 桌面版（0.2.x）、装好码道桌面端并登录过一次；
`bin.js login` 另需 Python 3 + `cryptography`（仅用于解 DPAPI 登录态）。

> 版本兼容：本包按 DSH `0.2.1-rc.2` 的 `PiAiAdapter` 接口编写
> （peerDependencies 已钉该版本）。目标机 DSH 若不是同一版本线，
> 插件可能因接口变化无法加载；此时按目标机版本调整 `lib/index.js` 后重新打包。
> 包管理器安装时若报 `ERR_PNPM_IGNORED_BUILDS`，属正常现象（被忽略的是
> DSH 运行时自带的 peer 依赖构建脚本），插件已经装好。

一条命令（在本包解开的目录里执行）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
# 自定义 profile / 用压缩包作来源：
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Profile desktop -Source .\dsh-codearts-connect-0.4.0.zip
```

脚本会：解包到 `%USERPROFILE%\.dsh\plugins\dsh-codearts-connect` →
`dsh plugin --profile desktop add "file:..."` → 把插件名补进
profile 的 `dsh.profile.bundles` → 提示下一步登录。

手工安装等价步骤：

```powershell
# 1. 复制插件目录
Copy-Item .\dsh-codearts-connect "$env:USERPROFILE\.dsh\plugins\" -Recurse -Force
# 2. 装进 profile
dsh plugin --profile desktop add "file:$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect"
# 3. 确认 profile package.json 的 dsh.profile.bundles 里有 "dsh-codearts-connect"
# 4. 生成登录态（或从旧机器复制 .codearts-session.json）
node "$env:USERPROFILE\.dsh\plugins\dsh-codearts-connect\bin.js" login
```

登录态可以整份复制：`.codearts-session.json` 里含 DPoP 私钥与 refresh token，
同一账号在另一台机器上可直接使用，无需在目标机重新登录码道。
注意 refresh token 一次性轮换，复制后建议只在其中一台机器上跑 `login`。

重启 DeepSeek Harness 后，模型选择器出现「CodeArts Agent（码道）」分组即成功；
再用 `bin.js status` / `bin.js models` 核对登录态与模型目录。

## 安全

- shim 只监听 `127.0.0.1`，并要求每次进程随机生成的 Bearer token；
- session 文档含临时 AK/SK、refresh token 与 DPoP 私钥，写入时权限为 `0600`，
  且已被 `.gitignore` 排除，**不要提交进任何仓库**；
- 插件对码道 `state.vscdb` 只做两种只读访问：发请求前查一次
  `userInfoKey.id`（用于跟随账号切换），以及 `bin.js models` / `login`
  读取目录与登录态；从不写入或改写它；
- 插件不轮换码道的 refresh token（那是一次的，轮换会让客户端掉线），
  只在凭据过期或账号变更时重新采纳客户端自己维护的登录态。

## 许可

MIT，见 [LICENSE](LICENSE)。
