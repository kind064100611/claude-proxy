# claude-proxy

本机运行的 Claude Code 网关，通过 ChatGPT / Codex 设备授权或 OpenAI API key 调用 GPT，通过 GitHub Copilot 设备授权调用 Claude。提供动态模型目录、本机登录页面、受保护的 Claude CLI 路由配置、工具/图片转换、流式响应、Observation Pack 和完整缓存兼容逻辑。

## 目录

- [用途与架构](#用途与架构)
- [前置条件](#前置条件)
- [启动代理](#启动代理)
- [登录与凭据](#登录与凭据)
- [配置 Claude CLI](#配置-claude-cli)
- [模型选择与 API](#模型选择与-api)
- [流式、工具、图片与推理](#流式工具图片与推理)
- [缓存行为](#缓存行为)
- [Observation Pack](#observation-pack)
- [环境变量](#环境变量)
- [安全与故障排查](#安全与故障排查)
- [离线测试](#离线测试)
- [许可证](#许可证)

## 用途与架构

```text
Claude Code / Anthropic Messages 客户端
                    │
             127.0.0.1:8082
                    │
          POST /v1/messages
           ┌────────┴────────┐
           │                 │
       GPT 系列          Claude 系列
   OpenAI Responses    原生 Anthropic Messages
           │                 │
 OpenAI API 或 Codex     GitHub Copilot
```

- GPT 请求转换为 Responses API，响应转换回 Anthropic Messages / SSE。
- Claude 请求经 Copilot 的原生 Messages 接口转发，保留其 thinking、签名、工具事件与 cache usage。
- `/v1/models` 合并当前凭据可访问的两个动态目录，不内置静态账号模型列表。
- `/login` 只管理本机设备授权与 CLI 路由设置，不收集账号密码。
- 项目使用 CommonJS 与 Node.js 内置模块，无构建步骤、无 npm 运行时依赖。

源码布局：`lib/` 为提供商、登录、安全存储、配置和缓存模块，`web/login.html` 为本机页面，`mac/` 与 `windows/` 为平台代理与启动脚本，`scripts/` 为功能开关，`test/` 为离线测试。两个 `proxy.js` 内容相同。

## 前置条件

1. **Node.js 18.17 或更新版本**，推荐使用当前受支持的 Node.js LTS。需要内置 `fetch`、Web Streams、`structuredClone` 等能力。
2. 使用 CLI 配置按钮时，须先安装 **Claude Code**，并确保 CLI 可被版本探测找到。网关不会自动安装 CLI。
3. 至少具备一种上游访问权限：
   - ChatGPT 账号允许 Codex 设备授权及相应模型访问；或具备 OpenAI API key 和 API 额度。
   - GitHub 账号具备 Copilot 权限，且允许调用所选 Claude 模型。
4. 网络可访问相应官方授权与 API 服务，本机端口 **8082** 空闲。

账号登录成功不等于所有模型均有权限。订阅、组织策略、模型启用状态、地区与额度均由上游决定；网关不会绕过这些限制。ChatGPT 订阅和 OpenAI API 计费属于不同访问方式。

## 启动代理

以下命令均在项目根目录运行。

### macOS / Linux

```bash
node --version
bash mac/start-proxy.sh
```

也可以直接运行：

```bash
node mac/proxy.js
```

脚本以前台方式运行代理，保持该终端打开；按 `Ctrl+C` 停止。启动后打开：

```text
http://127.0.0.1:8082/login
```

### Windows

在命令提示符中运行：

```bat
node --version
windows\start-proxy.bat
```

批处理使用 `start /min node` 启动独立进程。若需查看日志或明确停止代理，推荐在前台运行：

```bat
node windows\proxy.js
```

同样打开 `http://127.0.0.1:8082/login`。启动脚本不安装服务、不修改 CLI settings；初始化设置由页面按钮显式执行。

代理固定监听 `127.0.0.1:8082`，没有端口或远程监听环境变量。无需同时启动两份平台代理。

## 登录与凭据

### ChatGPT / Codex 设备授权

1. 在 `/login` 点击 **Login ChatGPT**。
2. 复制设备码，打开页面给出的官方 OpenAI 授权链接。
3. 在 `https://auth.openai.com/codex/device` 完成授权。仅在官方页面输入账号密码。
4. 返回本机页面，等待轮询状态显示完成。到期或失败时重新发起登录。

当前设备登录写入 `openai-codex` 凭据。运行时自动刷新过期凭据，Codex 请求使用 token 中的 ChatGPT account ID。

### GitHub Copilot 设备授权

1. 点击 **Login Copilot**，复制设备码。
2. 在 `https://github.com/login/device` 完成 GitHub 授权。
3. 本机页面轮询流程；授权后校验 Copilot 访问能力并保存凭据。

GitHub 登录 token 与短期 Copilot API token 的交换由代理完成。Copilot Claude 模型仍受账号和组织策略控制，目录可能为空。

### OpenAI API key 环境覆盖

可在启动代理的进程环境中设置 `OPENAI_API_KEY`。此方式优先于存储的 ChatGPT 凭据，不通过网页保存，也不写入 Claude settings。

```bash
# 值仅为占位符；使用你自己的安全环境注入方式。
OPENAI_API_KEY='<your-api-key>' node mac/proxy.js
```

不要把真实 key 写进仓库、截图或共享命令历史。Windows 可通过当前终端或系统的环境变量管理方式设置，再启动代理。修改环境变量后需要重新启动代理。

### 凭据位置与导入

默认存储为：

```text
~/.claude/claude-proxy/auth.json
```

仅存储 `openai`、`openai-codex`、`github-copilot` 对应的认证数据；refresh token 更新保留现有格式，并用 refresh token 与 `loginVersion` 防止旧刷新覆盖新登录。新登录会替换该提供商的旧登录字段，保留其他提供商。

在支持 Unix 权限的平台，目录为 `0700`、文件为 `0600`，使用同目录临时文件和原子发布。Windows 应同时依赖账号隔离与文件 ACL，不能将 Unix mode 当作完整的访问控制。

如需从已有 Pi 认证文件导入，请显式提供 `PI_AUTH_FILE`：

```bash
PI_AUTH_FILE='/path/to/pi/auth.json' node mac/proxy.js
```

启动时仅在目标 `auth.json` 不存在时导入受支持凭据；来源文件只读，不修改、不删除。目标存在或损坏时不覆盖，冲突会给出提示；无效来源或不受支持的条目不会被当作有效凭据。没有 `PI_AUTH_FILE` 时不查找仓库内的认证文件。

模块导入不会创建凭据目录或迁移文件。`CLAUDE_CONFIG_DIR` 不改变凭据根目录；它只影响 CLI settings 与备份位置。

## 配置 Claude CLI

1. 保持代理运行，先完成一种上游认证。
2. 在 `/login` 确认 **Configure Claude CLI** 按钮可用，再点击。
3. 代理验证 CLI 安装、凭据、配置结构及认证冲突，从动态目录选择与当前凭据匹配的可用模型。
4. **重新打开终端**，运行 `claude`；在交互会话中使用 `/model` 切换。

默认读取 `~/.claude/settings.json`；设置 `CLAUDE_CONFIG_DIR` 时读取该目录的实际 `settings.json`，支持 `~` 路径展开。代理读取模型配置时使用 mtime 缓存，修改 settings 后会在后续请求重新读取。

配置按钮合并下列字段：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8082",
    "ANTHROPIC_API_KEY": "sk-placeholder",
    "CLAUDE_CODE_USE_GATEWAY": "1",
    "CLAUDE_GATEWAY_ALLOW_LOOPBACK": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "<从当前动态目录选择的网关模型 ID>"
  }
}
```

`sk-placeholder` 只是本地路由占位值，不是上游 API key。操作会移除被替代的 `env.ANTHROPIC_AUTH_TOKEN`，保留其他 env、hooks、permissions、plugins、`model` 和已有 `statusLine` 等无关字段。已有可用的显式模型优先保留，否则选择与凭据匹配的目录首项；不会设置固定模型或子代理默认模型。

设置原始字节（包括 BOM 与格式）在写入前备份至：

```text
<实际 CLI 配置目录>/claude-proxy/settings-backups/settings-<SHA-256>.json
```

备份目录为私有目录，备份文件为私有常规文件。操作串行执行，在提交前重读最新设置、重新检查冲突并合并，使用临时文件原子更新。损坏配置、符号链接、目录型目标、过大文件、不安全备份路径或不可写目标均被拒绝。

如存在 `apiKeyHelper`、`proxyAuthHelper`、强制登录设置、其他云认证模式或 gateway helper 等冲突，需用户手动处理；按钮不会擅自删除它们。shell、项目、local 和 managed 配置仍可能覆盖用户 settings。代理不读取或写入 Claude 的 `.credentials.json`。

**启动代理、导入模块、打开页面、查询状态均不会写入 CLI settings。** 唯有带本机 nonce、同源 JSON 且 body 为 `{}` 的 `POST /api/auth/claude/configure` 会执行配置。若需恢复，先停止使用网关，再检查相应私有备份，手动恢复需要的字段；不要直接覆盖已经新增的个人设置。

## 模型选择与 API

```bash
curl http://127.0.0.1:8082/health
curl http://127.0.0.1:8082/v1/models
curl http://127.0.0.1:8082/features
```

目录返回 `claude-gateway/<模型 ID>`；适用模型可能带 `[1m]` 扩展上下文标记，转发前会去除该后缀。标记不是对账号实际上下文额度的承诺，上游能力仍以账号目录和请求结果为准。

直接请求可使用目录中的完整网关 ID，也可使用明确的 GPT / Claude 原始 ID。`sonnet`、`opus`、`haiku`、`default` 等 CLI 短别名使用 settings 中的配置模型。没有配置默认模型时应发送明确模型 ID。其他模型类型返回 HTTP 400，不会被转发到错误提供商。

从 `/v1/models` 复制一个当前账号可用的 GPT ID，替换下例的 `gpt-<available-id>`：

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-gateway/gpt-<available-id>",
    "max_tokens": 256,
    "stream": false,
    "messages": [{"role":"user","content":"用一句话解释这个网关的用途。"}]
  }'
```

对 Claude，将 `model` 替换为目录中的 `claude-gateway/claude-...`。流式请求使用相同 body，将 `stream` 设为 `true`，并为 curl 加 `-N`。Windows PowerShell 建议使用 `curl.exe` 并将 body 存入自己创建的 JSON 文件，以避免 shell 引号差异。

主要端点：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 进程存活检查，不代表上游权限可用 |
| `GET /v1/models` | 两个提供商的动态网关目录，支持 query 参数访问 |
| `POST /v1/messages` | Anthropic Messages 输入，JSON 或 SSE 输出 |
| `GET /features` | Observation Pack 当前开关状态，只读 |
| `GET /login` | 本机账户和 CLI 配置页面 |
| `GET /api/auth/status` | nonce 保护的凭据/CLI 状态，不返回 token |
| `POST /api/auth/chatgpt/start` | 发起 ChatGPT 设备授权，页面发送 `{}` |
| `POST /api/auth/copilot/start` | 发起 Copilot 设备授权，页面发送 `{}` |
| `GET /api/auth/flow/<id>` | 设备流程状态快照 |
| `POST /api/auth/claude/configure` | 受保护的空对象配置请求 |

登录与配置端点应由 `/login` 操作，不能通过普通跨域 API 调用。提供的 Messages 接口不是完整 Anthropic API 实现，不应假设所有其他 Anthropic 端点均可用。

## 流式、工具、图片与推理

- **GPT 非流式**：转换请求后收集 Responses 结果，映射 text、tool calls、stop reason 与 usage。Codex 上游即使必须使用 SSE，本地非流式客户端仍得到完整 JSON。
- **GPT 流式**：发送 Anthropic `message_start`，实时转换 Responses 的文本、推理摘要与完整工具调用事件，最后发送 usage、`message_delta` 和 `message_stop`。等待期间发送 SSE keepalive，写入遵守背压；客户端真正断连时取消上游请求。
- **Copilot Claude**：转发原生 Messages JSON 或 SSE，保留原始响应字节、签名、工具参数片段与错误事件，支持背压和客户端取消。
- **工具**：映射 `tool_use` / `tool_result`，结果紧跟相应工具调用，随后才发送与结果一起附带的用户文本。上游输出工具调用后，真正的工具执行仍由客户端完成。
- **图片**：GPT 的普通图片块转换为 Responses `input_image`；工具结果中的图片放入随后一条 multimodal user 消息。Copilot 接收原生图片结构并附带 vision 请求头。图片能力由所选模型和账号决定，无效来源会用说明文本替代。
- **推理**：GPT 支持公开 reasoning summaries，不能把它当作原生 Claude 的完整 thinking/signature。回答正文中的字面 `<think>` 不会被误判为 GPT 推理块。Copilot 根据目录适配 adaptive thinking，保留原生签名及兼容性回退。

请求体上限为 32 MiB。OpenAI 请求总超时为 1 小时，收到上游响应头后连续 90 秒没有数据会取消；GPT SSE 每 10 秒尝试发送 keepalive。Copilot 请求总超时为 1 小时，行为与 OpenAI 的 idle timer 不完全相同。

## 缓存行为

### GPT prompt cache 与统计

默认生成稳定的 `prompt_cache_key`：同一会话增长时尽量保持缓存身份，不同会话分离；system/tools 中移动的原生 cache 标记不会改变 fallback key。日志只输出 key/prefix 的哈希标识和 token 统计，不打印 prompt 或完整请求体。

Responses `input_tokens_details.cached_tokens` 转换为 Anthropic `usage.cache_read_input_tokens`，JSON 和 SSE 路径均保留；`input_tokens` 为扣除缓存读取部分后的普通输入量，`output_tokens` 保留上游输出量。日志可见总输入、缓存读取、未缓存输入和命中比例；上游未命中时数值可能为 0。key 稳定不保证缓存一定命中，缓存策略与费用由上游决定。

### Claude prompt cache 与统计

在没有显式顶层 `cache_control` 或禁用开关时，代理按已有标记和 TTL 顺序，为适用的 tools、system、最后 user 内容补充 `ephemeral` 标记；最多四个 block 标记，不覆盖已有标记。长/短缓存顺序及邻近 TTL 保持兼容。

Copilot 原生 `cache_read_input_tokens`、`cache_creation_input_tokens` 等 usage 原样返回。独立 observer 观察 JSON/SSE 统计并立即转发原始字节；未知或过大的事件只跳过诊断，不改变响应。统计回调失败不会破坏原生响应。

### Responses replay 与其他本地缓存

- Anthropic 客户端不能直接携带 Responses item IDs / encrypted reasoning。代理在**进程内存**保存与账号、模型、会话和历史匹配的原生输出，在后续轮次重放；不会把这些数据写入日志或磁盘。
- Replay 有 512 项 / 16 MiB 上限并按最近使用淘汰；代理重启会清空，不与其他独立客户端随意混用。
- 模型目录使用 pending 请求合并、单来源 12 秒上限、约 2.2 秒客户端返回预算。全部来源成功时 TTL 为 5 分钟，有来源失败时为 30 秒；失败来源保留曾成功获取的旧目录，首次失败则暂时缺席。
- 登录成功会使目录 generation 失效；较早的 pending 发现不能重新填充当前缓存。
- CLI settings 的模型读取缓存按 mtime 更新，与上游 prompt cache、Responses replay、Observation Pack 是不同机制。

## Observation Pack

Observation Pack 对后续轮次的新大文本工具结果进行本地归档，将完整内容替换为包含 SHA-256、原文件路径、开头和结尾节选的提示；这是**节选而非摘要**。客户端可以使用原生 `Read` 的 `file_path` / `offset` / `limit` 取回完整证据，不能依据节选臆测中间内容。

默认开启。开关固定在实际 HOME 下：

```text
~/.claude/gateway-features.json
```

启动时若该文件不存在，安全导入项目根目录 `gateway-features.json` 的有效原始字节，保留项目文件；已有用户开关优先。开关缺失时默认开，损坏或不安全时禁用新增打包。

在项目根目录运行：

```bash
node scripts/toggle-observation-pack.js status
node scripts/toggle-observation-pack.js off
node scripts/toggle-observation-pack.js on
curl http://127.0.0.1:8082/features
```

`on` / `off` 是用户主动写入开关的命令；`status` 和 `GET /features` 只读。开关按请求热加载，无需重启；历史已发送的内容保持固定投影，关闭仅影响后续新结果，不恢复或改写已发送历史。

归档固定在：

```text
~/.claude/gateway-observations/<会话身份 SHA-256>/
  state.json
  <内容 SHA-256>.txt
```

需客户端提供 `metadata.session_id` 或 `metadata.user_id`，以及具有 `file_path` 参数的 `Read` 工具；没有可靠会话身份不打包。首个已观察请求建立基线，后续满足条件的新结果才打包；阈值为 16 KiB，单结果最多 8 MiB，每会话归档最多 128 MiB，状态最多 4 MiB / 20,000 条。

只处理可还原的纯文本工具结果，不打包图片、错误结果、归档回读或已经固定为原文的历史结果。归档/状态采用私有文件；写入中断会冻结该会话的新打包，已有状态不可读时返回 503，而不是重写不可信的历史。

**归档包含工具输出原文，可能包含敏感代码或数据。** 不共享整个归档目录。归档不自动清理；仅在确定对应会话不再需要历史与回读后，用户自行清理。它不是上游缓存，也不保证与上游计费相同的节省比例。`CLAUDE_CONFIG_DIR` 不移动功能开关或归档路径。

## 环境变量

环境变量须传给**代理进程**，不是只设在另一个 Claude 终端。运行时开关读取方式不同：改变账号/URL/CLI 根目录后建议重启代理。

| 变量 | 实际行为 |
| --- | --- |
| `OPENAI_API_KEY` | 优先使用 OpenAI API key，覆盖存储的 ChatGPT 凭据，不持久化 |
| `OPENAI_BASE_URL` | API-key 模式的 `/models` 与 `/responses` 基址；默认 `https://api.openai.com/v1`，不改写 Codex/ChatGPT OAuth 的官方地址 |
| `PI_AUTH_FILE` | 启动时显式只读导入来源；目标已存在则不覆盖 |
| `CLAUDE_CONFIG_DIR` | 实际 CLI settings / 私有备份根目录；默认 `~/.claude` |
| `CODEX_CLIENT_VERSION` | Codex 模型目录的 client version query，默认 `0.162.1` |
| `OPENAI_PROMPT_CACHE=0` | 不生成 GPT fallback prompt cache key；不承诺关闭上游服务自身的一切缓存 |
| `CLAUDE_PROMPT_CACHE=0` | 不自动补充 Claude cache 标记，已有客户端标记仍保留 |
| `DISABLE_PROMPT_CACHING=1` | 禁用自动 Claude 标记 |
| `DISABLE_PROMPT_CACHING_HAIKU=1` / `..._SONNET=1` / `..._OPUS=1` | 按 Claude 模型家族禁用自动标记 |
| `PI_CACHE_RETENTION=long` | 没有邻近标记约束时，自动 Claude 标记使用 `ttl: "1h"`；其他值使用短期默认 |
| `HOME` | 决定凭据、功能开关与归档的默认位置；自动测试使用临时 HOME |
| `PATH`、Windows `APPDATA` / `ProgramFiles` | CLI 版本探测安装位置；不代表自动安装 |
| `RUN_CLAUDE_CLI_TESTS=1` | 测试专用：显式启用需要已安装 Claude Code 的隔离用例，默认跳过 |

CLI 配置写入的 `ANTHROPIC_*` 和 gateway 环境字段供 **Claude Code 客户端**使用，见配置章节；不能用它们替代代理自己的上游认证。

自定义 `OPENAI_BASE_URL` 时，该地址会收到 API key、模型请求与对话内容，只能指向可信的兼容服务。不要关闭 TLS 校验；如企业网络需要额外 CA，应按 Node.js 的可信证书方式配置。

## 安全与故障排查

### 安全边界

- 固定本机监听。Messages API 的 CORS 兼容不是鉴权，API 本身不校验占位 key；不要通过端口转发、反向代理或公网映射暴露它，也不要把本机页面发布到外部。
- 登录/配置路由先于通配 API CORS，校验 loopback 地址、精确 Host/端口和页面随机 nonce；POST 还需同源 Origin 与 `application/json`。使用 nonce CSP、`no-store`、禁止 framing 与跳转。
- 认证 body 上限 16 KiB、读取超时 10 秒；配置 body 必须为 `{}`。页面不使用浏览器持久存储保存 token，不返回真实 token 给页面。
- 只在官方页面输入密码，设备码也应保密。不共享 auth 文件、私有 settings 备份或 observation 原始归档。
- Claude 工具仍可操作本机文件或执行命令，继续使用客户端权限确认与项目隔离；网关不代替权限控制。

### 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 代理不能监听 / 端口占用 | 确认只启动一份进程；检查端口 8082，再手动停止不需要的进程 |
| 页面打不开 | 使用 `127.0.0.1:8082/login`；代理只绑定 IPv4 loopback，某些 localhost/IPv6 解析环境可能不同 |
| 登录状态 403 | 从本机页面刷新 nonce；不要经其他 Host、代理、跨域页面或无 Origin 的 POST 操作 |
| 设备码到期 / 登录失败 | 在官方页面完成授权，检查账号权限、网络与上游设备授权可用性，再重新开始 |
| OpenAI 401 / 刷新失败 | 检查环境覆盖、存储权限和 token 有效性；从页面重新登录；不要粘贴 token 到日志 |
| Copilot 403 / 无 Claude 模型 | 检查 Copilot 订阅、组织授权、model picker 与策略，确认当前账号允许目标模型 |
| `/v1/models` 暂时为空 | 首次发现可能超过返回预算；稍后重试。无认证、上游故障或无权限不会生成虚假的默认模型 |
| 配置按钮不可用 | 确认 Claude CLI 可探测、已有匹配凭据、settings 有效且可写，并手动处理认证冲突 |
| 配置成功但 Claude 不走网关 | 重开终端，检查 shell/project/local/managed overrides，确认代理和 CLI 使用同一 `CLAUDE_CONFIG_DIR` |
| 未知模型 400 | 从当前 `/v1/models` 复制可用 ID；显式其他类型不会自动回退 |
| 429 / 配额错误 | 按上游限额等待或调整账号/模型，检查上游用量与配额 |
| 流式中途错误 / 空内容 | 查看状态与 SSE error；检查网络、上游 terminal event、模型权限和请求超时 |
| cache hit 为 0 | 缓存由上游决定，检查 key/session、system/tools 稳定性和开关；不要将 replay 命中等同于计费缓存命中 |
| observation state 不可读 | 检查该会话归档完整性与权限，恢复可信状态或新建会话；不要在活跃会话中直接删 ledger |

## 离线测试

在项目根目录运行：

```bash
node --test test/*.test.js
node --check mac/proxy.js
node --check windows/proxy.js
bash -n mac/start-proxy.sh
cmp mac/proxy.js windows/proxy.js
git diff --check
```

为确保功能开关、归档和配置测试不触及个人目录，macOS / Linux 推荐：

```bash
TEST_HOME="$(mktemp -d)"
HOME="$TEST_HOME" CLAUDE_CONFIG_DIR="$TEST_HOME/config" \
  node --test test/*.test.js
# 检查完成后，用户可自行删除刚创建的 TEST_HOME。
```

Windows PowerShell 可以创建独立临时目录，并为该次测试设置 `HOME`、`USERPROFILE` 和 `CLAUDE_CONFIG_DIR`，测试后恢复原环境。`node --check` 同样适用；`bash -n` / `cmp` 需要 Git Bash 或相应工具。

默认套件使用模拟上游和临时目录，覆盖设备授权、token 刷新竞态、目录缓存失效、JSON/SSE、工具/图片、cache usage、Responses replay、真实客户端断连、登录路由安全和私有配置备份。HTTP 端到端测试同时验证 GPT / Copilot 两条路径，并拒绝未知模型。

`claude-cli.test.js` 与 `observation-pack-cli.test.js` 默认跳过。只有明确想运行本机已安装 CLI 的隔离检查时，才设置 `RUN_CLAUDE_CLI_TESTS=1`；这些检查依然使用模拟网关，不代表真实账号授权或真实上游验证。

当前迁入实现的验证以 macOS 上的离线测试为依据；Windows 批处理与探测代码进行了静态/模拟检查，未宣称在真实 Windows 或真实账号环境中执行成功。

## 许可证

项目保留根目录 [MIT LICENSE](LICENSE)。`lib/device-login.js` 中保留 Pi 来源声明，对应第三方 MIT 许可证见 [third-party/pi/LICENSE](third-party/pi/LICENSE)。
