# claude-proxy

A local gateway for Claude Code. Access GPT through ChatGPT / Codex device authorization or an OpenAI API key, and access Claude through GitHub Copilot device authorization. Includes dynamic model discovery, a local login page, protected Claude CLI routing and Statusline setup, optional current-user macOS service registration, guarded Project Code Memory skill installation, tool and image conversion, streaming responses, Observation Pack, and comprehensive cache compatibility.

## Contents

- [Overview and architecture](#overview-and-architecture)
- [Prerequisites](#prerequisites)
- [Starting the proxy](#starting-the-proxy)
- [Login and credentials](#login-and-credentials)
- [Configuring Claude CLI](#configuring-claude-cli)
- [Configuring Statusline](#configuring-statusline)
- [Registering a macOS service](#registering-a-macos-service)
- [Installing Project Code Memory](#installing-project-code-memory)
- [Model selection and API](#model-selection-and-api)
- [Streaming, tools, images, and reasoning](#streaming-tools-images-and-reasoning)
- [Cache behavior](#cache-behavior)
- [Observation Pack](#observation-pack)
- [Environment variables](#environment-variables)
- [Security and troubleshooting](#security-and-troubleshooting)
- [Offline tests](#offline-tests)
- [License](#license)

## Overview and architecture

```text
Claude Code / Anthropic Messages client
                    │
             127.0.0.1:8082
                    │
          POST /v1/messages
           ┌────────┴─────────────┐
           │                      │
       GPT models             Claude models
   OpenAI Responses      Native Anthropic Messages
           │                      │
 OpenAI API or Codex        GitHub Copilot
```

- GPT requests are converted to the Responses API, and responses are converted back to Anthropic Messages / SSE.
- Claude requests use Copilot's native Messages endpoint, preserving thinking, signatures, tool events, and cache usage.
- `/v1/models` merges the two dynamic catalogs available to the current credentials. There is no bundled static account model list.
- `/login` manages local device authorization, CLI routing, Statusline setup, optional macOS service registration, and Project Code Memory installation. It does not collect account passwords.
- The proxy uses CommonJS and Node.js built-in modules. The bundled MIT Claude HUD runtime is ESM; there is no build step or npm runtime dependency.

Source layout: `lib/` contains provider, login, secure storage, setup, and cache modules; `web/login.html` is the local page; `mac/` and `windows/` contain platform proxies and launchers; `scripts/` contains feature-toggle utilities; and `test/` contains offline tests. The two `proxy.js` files are identical.

## Prerequisites

1. **Node.js 18.17 or newer.** A currently supported Node.js LTS release is recommended. The implementation requires built-in `fetch`, Web Streams, `structuredClone`, and related APIs.
2. To use the CLI configuration button, install **Claude Code** first and ensure the CLI can be found by the version probe. The gateway does not install it automatically.
3. At least one type of upstream access:
   - A ChatGPT account that supports Codex device authorization and the requested models, or an OpenAI API key with API quota.
   - A GitHub account with Copilot access and permission to use the selected Claude model.
4. Network access to the relevant official authorization and API services, and an available local port **8082**.

Successful login does not grant access to every model. Subscriptions, organization policies, model availability, regions, and quotas are controlled by the upstream service; the gateway does not bypass these restrictions. ChatGPT subscriptions and OpenAI API billing are separate access methods.

## Starting the proxy

Run the following commands from the project root.

### macOS / Linux

```bash
node --version
bash mac/start-proxy.sh
```

Or run the proxy directly:

```bash
node mac/proxy.js
```

The launcher runs the proxy in the foreground. Keep the terminal open and press `Ctrl+C` to stop it. Then open:

```text
http://127.0.0.1:8082/login
```

### Windows

From Command Prompt:

```bat
node --version
windows\start-proxy.bat
```

The batch launcher uses `start /min node` to start a separate process. To view logs and stop the proxy explicitly, run it in the foreground instead:

```bat
node windows\proxy.js
```

Open `http://127.0.0.1:8082/login`. The launchers do not install services or modify CLI settings; configuration is performed explicitly through the page button.

The proxy listens only on `127.0.0.1:8082`. There is no environment variable for changing the port or enabling a remote listener. Do not start both platform proxies at once.

## Login and credentials

### ChatGPT / Codex device authorization

1. Click **Login ChatGPT** on `/login`.
2. Copy the device code and open the official OpenAI authorization link shown on the page.
3. Complete authorization at `https://auth.openai.com/codex/device`. Enter your account password only on the official website.
4. Return to the local page and wait for polling to report completion. Start again if the code expires or authorization fails.

Device login stores an `openai-codex` credential. Expired credentials are refreshed automatically at runtime, and Codex requests use the ChatGPT account ID from the token.

### GitHub Copilot device authorization

1. Click **Login Copilot** and copy the device code.
2. Complete GitHub authorization at `https://github.com/login/device`.
3. The local page polls the flow. After authorization, the proxy validates Copilot access and saves the credentials.

The proxy exchanges the GitHub login token for a short-lived Copilot API token. Copilot Claude models remain subject to account and organization policies, and the catalog may be empty.

### OpenAI API key environment override

Set `OPENAI_API_KEY` in the process environment before starting the proxy. It takes precedence over stored ChatGPT credentials, is not saved through the web page, and is not written to Claude settings.

```bash
# This is a placeholder. Use your own secure environment-injection method.
OPENAI_API_KEY='<your-api-key>' node mac/proxy.js
```

Do not put real keys in the repository, screenshots, or shared command history. On Windows, set the variable in the current terminal or through the system environment-variable settings before starting the proxy. Restart the proxy after changing its environment variables.

### Credential storage and import

The default store is:

```text
~/.claude/claude-proxy/auth.json
```

It stores authentication data for `openai`, `openai-codex`, and `github-copilot`. Refresh-token updates preserve the existing format and check both the refresh token and `loginVersion` to prevent an older refresh from overwriting a newer login. A new login replaces that provider's previous login fields while preserving other providers.

On platforms with Unix permissions, the directory uses `0700` and the file uses `0600`. Updates use temporary files in the same directory and atomic publication. On Windows, also rely on account isolation and file ACLs; Unix mode values are not a complete access-control mechanism.

To import an existing Pi authentication file, explicitly provide `PI_AUTH_FILE`:

```bash
PI_AUTH_FILE='/path/to/pi/auth.json' node mac/proxy.js
```

At startup, supported credentials are imported only if the destination `auth.json` does not exist. The source is read-only: it is neither modified nor deleted. Existing or damaged destinations are never overwritten, and conflicts produce a warning. Invalid sources and unsupported entries are not treated as valid credentials. Without `PI_AUTH_FILE`, the proxy does not search for authentication files in the repository.

Importing a module does not create credential directories or migrate files. `CLAUDE_CONFIG_DIR` does not change the credential root; it selects the actual CLI root for settings, backups, Statusline deployments, and macOS service state/logs.

## Configuring Claude CLI

1. Keep the proxy running and configure at least one upstream authentication method first.
2. On `/login`, wait until **Configure Claude CLI** is enabled, then click it.
3. The proxy validates the CLI installation, credentials, settings structure, and authentication conflicts, then selects an available model from the dynamic catalog that matches the current credentials.
4. **Open a new terminal** and run `claude`. Use `/model` in an interactive session to switch models.

The default settings file is `~/.claude/settings.json`. When `CLAUDE_CONFIG_DIR` is set, the proxy uses the actual `settings.json` in that directory, with support for `~` expansion. Model settings are cached by mtime and reread on later requests when the file changes.

The configuration button merges these fields:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8082",
    "ANTHROPIC_API_KEY": "sk-placeholder",
    "CLAUDE_CODE_USE_GATEWAY": "1",
    "CLAUDE_GATEWAY_ALLOW_LOOPBACK": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_MODEL": "<gateway model ID selected from the current dynamic catalog>"
  }
}
```

`sk-placeholder` is a local routing placeholder, not an upstream API key. The operation removes the superseded `env.ANTHROPIC_AUTH_TOKEN` while preserving unrelated environment variables, hooks, permissions, plugins, `model`, and an existing `statusLine`. An existing explicit model is retained when available; otherwise, the first catalog entry matching the credentials is selected. No fixed model or subagent default is installed.

Before writing, the original settings bytes, including any BOM and formatting, are backed up to:

```text
<actual CLI config directory>/claude-proxy/settings-backups/settings-<SHA-256>.json
```

The backup directory and regular backup files are private. Configuration operations run serially, reread the latest settings before committing, recheck conflicts, merge changes, and update atomically through a temporary file. Damaged settings, symbolic links, directory targets, oversized files, unsafe backup paths, and unwritable targets are rejected.

Conflicts such as `apiKeyHelper`, `proxyAuthHelper`, forced login settings, other cloud authentication modes, or gateway helpers must be resolved manually; the button does not silently delete them. Shell, project, local, and managed settings may still override user settings. The proxy does not read or write Claude's `.credentials.json`.

**Starting the proxy, importing modules, opening the page, and querying status do not write CLI settings.** Configuration runs only through a local nonce-protected, same-origin JSON `POST /api/auth/claude/configure` with a body of `{}`. To restore settings, first stop using the gateway, inspect the relevant private backup, and restore the required fields manually. Do not overwrite personal settings added since the backup.

## Configuring Statusline

**Configure Statusline** on `/login` is independent of ChatGPT / Copilot login and CLI routing. It requires a discoverable Claude CLI, **Bash 3+**, **jq 1.6+**, and **Node.js 18+**. On Windows, install Git Bash and jq manually. Missing dependencies are never downloaded automatically.

Clicking the button explicitly **replaces the existing `statusLine` command**. The original settings bytes are backed up to the same private `settings-backups/` directory described above. Gateway environment variables, authentication, hooks, permissions, and unrelated plugins remain unchanged. The operation accepts only an empty JSON object at `POST /api/auth/statusline/configure` under the local page's security guards.

The bundled MIT Claude HUD runtime and cache display are deployed into:

```text
<actual CLI config directory>/claude-proxy/statusline/<generation SHA-256>/
```

Each immutable generation includes the complete HUD runtime, its own display config/cache directory, the adapted wrapper, and a launcher that quotes the probed Node/Bash/jq paths. Dependency paths participate in the generation identity. Repeated installs verify deployed runtime bytes before reuse; changed or unsafe generations are not silently overwritten. Settings are committed only after successful deployment. If saving fails, cleanup removes only a newly created deployment that is not referenced by the latest settings; reused generations remain intact.

The deployed Statusline works independently after moving this repository, provided the selected executables remain available. Its HUD config/cache is isolated without hiding the actual Claude CLI config root. It displays warm/dropped/hit cache information from statusline input; upstream cache availability is not guaranteed. Refresh the Statusline or open a new Claude session after configuring. See [Statusline provenance](statusline/SOURCE.md) and [HUD MIT license](statusline/claude-hud/LICENSE). The personal non-runtime wrapper archive is not included.

## Registering a macOS service

On macOS, `/login` shows an independent **Register macOS Service** button. It requires a normal current-user GUI login session, safe writable directories, and available Node/repository paths. It creates a **LaunchAgent**, never a system LaunchDaemon and never using `sudo`. Windows and other platforms report this feature as unsupported; the card follows the backend platform, not the browser's platform.

```text
Label: com.shanshazhe.claude-proxy
Plist: $HOME/Library/LaunchAgents/com.shanshazhe.claude-proxy.plist
State/log root: <actual CLI config directory>/claude-proxy/macos-service/
Logs: stdout.log, stderr.log
```

Registration is explicit through a protected `{}` `POST /api/auth/macos/service/configure`. Importing modules, starting the proxy, opening the page, or querying status never registers a service or writes service files; status may run bounded, read-only service checks. A matching running job is a no-op. A matching stopped plist is reused byte-for-byte. Conflicting installations, disabled jobs, unsafe files, or incompatible settings require manual repair and are never overwritten. This identity is separate from the source toolkit's service.

**Immediate handoff can interrupt active requests and login flows.** The detached helper must be ready before HTTP 202, and activation waits until the response finishes; a client disconnect during preparation cancels handoff without stopping the original proxy. The original proxy drains for at most 10 seconds. The helper checks the old PID/birth identity and port release before bootstrap, then verifies launchd ownership, the listening socket, the page nonce, the operation ID, and installation identity. `/health` alone is not proof of successful registration.

The page polls the operation and reconnects with a fresh same-origin nonce. **An interrupted/lost POST is never automatically repeated.** If the result cannot be confirmed, inspect status before retrying. Failed registration reports whether the original proxy was `recovered` or `recovery_failed`; the latter requires manually starting `bash mac/start-proxy.sh` and inspecting the service. Recovery secrets stay in IPC/memory, not the plist, operation records, or logs.

New plists transfer only validated cache switches (`OPENAI_PROMPT_CACHE`, `CLAUDE_PROMPT_CACHE`, `DISABLE_PROMPT_CACHING`, and the HAIKU/SONNET/OPUS variants), `PI_CACHE_RETENTION`, `CODEX_CLIENT_VERSION`, the selected CLI root, and supported safe TLS/certificate options. They do not copy arbitrary shell environment variables. **Environment-only `OPENAI_API_KEY`, `PI_AUTH_FILE`, custom `OPENAI_BASE_URL`, insecure TLS, arbitrary `NODE_OPTIONS`/Node arguments, and verbose prompt logging prevent handoff.** Save supported credentials to the local store and remove unsupported overrides before restarting the proxy manually. A running-service no-op does not modify its environment.

The service depends on absolute Node and repository paths. Moving either requires manual repair; do not overwrite another installation's plist or blindly delete service state. Service logs may contain operational or model-request information: keep them private and inspect them before sharing.

## Installing Project Code Memory

**Install Project Code Memory** on `/login` installs the bundled code-memory skill independently of proxy login, CLI routing, Statusline, and macOS service registration. It requires an installed **Claude CLI** and **CPython 3.9+** with its standard library. Windows Python and the `py -3` launcher are supported by fixed, shell-free `-I -B` probes; automatic interpreter installation is explicitly disabled. Missing dependencies must be installed manually.

Installation is an explicit, local nonce-protected `{}` `POST /api/auth/project-memory/install`. The bundle is pinned to upstream commit `7dc7b0dad137fa8e1e65af31143f4ead8109ca03` and validated against its manifest. Only these files are deployed:

```text
<actual CLI config directory>/skills/project-code-memory/
  SKILL.md
  scripts/pcm.py
  references/record-format.md
  LICENSE
  SOURCE.md
```

The actual CLI root defaults to `~/.claude` and follows `CLAUDE_CONFIG_DIR`. The installer uses a serialized per-root queue, an exclusive `.project-code-memory-install.lock`, and private `.project-code-memory-stage-*` staging under `<actual CLI config directory>/claude-proxy/`. It creates the target exclusively and publishes `SKILL.md` last through an atomic, no-overwrite hard link. It never steals a lock on timeout; abandoned locks require manual inspection. On failure, cleanup removes only unchanged files/inodes and empty directories created by that attempt, retaining external edits and extras.

An identical complete deployed skill or matching pinned upstream core is a **read-only no-op**, preserving existing `.git`, caches, extras, and directory permissions. Different, partial, symlinked, or unsafe installations are refused rather than replaced. The installer does not execute `pcm.py`, create project caches, edit `.gitignore`, settings, hooks, or CLAUDE.md, or download code. Import, startup, status, and page load never install anything. Damaged CLI settings and absent proxy credentials do not block this independent feature.

**Open a new Claude session after installation.** Invoke `/project-code-memory` explicitly or allow the model to select it. This is model-driven guidance, not a hook. A later `query` intentionally creates the selected project's `projectCodeMemory/` cache, adds its ignore rule, and may prune stale records. Installing the skill does not perform that query. See the [bundled README](project-code-memory/README.md), [provenance](project-code-memory/SOURCE.md), and [MIT license](project-code-memory/LICENSE). The upstream Python implementation, reference, optional Codex agent metadata, and upstream tests are retained in the repository; only the five files above are installed.

## Model selection and API

```bash
curl http://127.0.0.1:8082/health
curl http://127.0.0.1:8082/v1/models
curl http://127.0.0.1:8082/features
```

The catalog returns `claude-gateway/<model ID>`. Eligible models may include a `[1m]` extended-context marker, which is removed before forwarding. This marker is not a guarantee of the account's actual context allowance; upstream capabilities depend on the account catalog and request results.

Requests may use the full gateway ID from the catalog or an explicit raw GPT / Claude model ID. CLI aliases such as `sonnet`, `opus`, `haiku`, and `default` use the model configured in settings. Send an explicit model ID if no default is configured. Other model types return HTTP 400 instead of being routed to the wrong provider.

Copy a GPT model ID available to your account from `/v1/models` and replace `gpt-<available-id>` below:

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-gateway/gpt-<available-id>",
    "max_tokens": 256,
    "stream": false,
    "messages": [{"role":"user","content":"Explain the purpose of this gateway in one sentence."}]
  }'
```

For Claude, replace `model` with a `claude-gateway/claude-...` entry from the catalog. To stream, use the same body with `stream` set to `true` and add `-N` to curl. In Windows PowerShell, use `curl.exe` and save the body to a JSON file you create yourself to avoid shell quoting differences.

Main endpoints:

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process liveness; does not validate upstream access |
| `GET /v1/models` | Dynamic gateway catalog from both providers; accepts requests with query parameters |
| `POST /v1/messages` | Anthropic Messages input with JSON or SSE output |
| `GET /features` | Read-only Observation Pack status |
| `GET /login` | Local account and CLI configuration page |
| `GET /api/auth/status` | Nonce-protected credential / CLI / Statusline / service / Project Code Memory status; never returns tokens |
| `POST /api/auth/chatgpt/start` | Starts ChatGPT device authorization; the page sends `{}` |
| `POST /api/auth/copilot/start` | Starts Copilot device authorization; the page sends `{}` |
| `GET /api/auth/flow/<id>` | Device-flow status snapshot |
| `POST /api/auth/claude/configure` | Protected CLI configuration with an empty JSON object |
| `POST /api/auth/statusline/configure` | Protected independent Statusline deployment with an empty JSON object |
| `POST /api/auth/macos/service/configure` | Protected macOS registration; 200 for a running no-op, 202 for a prepared asynchronous operation |
| `POST /api/auth/project-memory/install` | Protected independent skill installation with an empty JSON object |

Use `/login` for login and configuration operations; these endpoints do not support ordinary cross-origin API calls. The Messages endpoint is not a complete implementation of the Anthropic API. Do not assume other Anthropic endpoints are available.

## Streaming, tools, images, and reasoning

- **Non-streaming GPT:** Converts the request, collects the Responses result, and maps text, tool calls, stop reasons, and usage. A local non-streaming client still receives complete JSON even when the Codex upstream requires SSE.
- **Streaming GPT:** Sends Anthropic `message_start`, converts Responses text, reasoning summaries, and complete tool-call events as they arrive, then sends usage, `message_delta`, and `message_stop`. SSE keepalives are sent while waiting. Writes honor backpressure, and a genuine client disconnect cancels the upstream request.
- **Copilot Claude:** Forwards native Messages JSON or SSE, preserving response bytes, signatures, tool-argument fragments, and error events, with backpressure and client cancellation.
- **Tools:** Maps `tool_use` / `tool_result`. Results immediately follow their corresponding tool calls, before any user text supplied alongside them. The client remains responsible for executing tools requested by the upstream model.
- **Images:** Ordinary GPT image blocks become Responses `input_image` items. Images in tool results are attached to a following multimodal user message. Copilot receives native image structures and a vision request header. Image support depends on the selected model and account; unsupported or invalid sources are replaced with explanatory text.
- **Reasoning:** GPT supports public reasoning summaries, not native Claude's full thinking / signature protocol. Literal `<think>` text in an answer is not misclassified as a GPT reasoning block. Copilot adapts adaptive thinking using catalog capabilities while preserving native signatures and compatibility fallbacks.

The request-body limit is 32 MiB. OpenAI requests have a one-hour total timeout and are canceled after 90 seconds without data once upstream response headers have arrived. GPT SSE attempts a keepalive every 10 seconds. Copilot requests also have a one-hour total timeout, but do not use the same idle-timer behavior as OpenAI.

## Cache behavior

### GPT prompt caching and statistics

A stable `prompt_cache_key` is generated by default. It aims to preserve cache identity as a session grows while separating different sessions. Moving native cache annotations in system / tools does not change the fallback key. Logs contain only hashed key / prefix identifiers and token statistics, never prompts or full request bodies.

Responses `input_tokens_details.cached_tokens` maps to Anthropic `usage.cache_read_input_tokens` in both JSON and SSE output. `input_tokens` reports regular input after subtracting cache reads, and `output_tokens` retains the upstream output count. Logs show total input, cache reads, uncached input, and the hit percentage; an upstream cache miss may report 0. A stable key does not guarantee a hit. Cache policy and billing are controlled by the upstream service.

### Claude prompt caching and statistics

Unless an explicit top-level `cache_control` or a disable switch is present, the proxy adds `ephemeral` annotations to eligible tools, system content, and the last user content, respecting existing markers and TTL ordering. It allows at most four block markers and does not overwrite existing annotations. Long-before-short ordering and neighboring TTLs remain compatible.

Copilot's native usage fields, including `cache_read_input_tokens` and `cache_creation_input_tokens`, are returned unchanged. A separate observer inspects JSON / SSE usage while immediately forwarding the original bytes. Unknown or oversized events skip diagnostics without changing the response, and a failing statistics callback does not interrupt native output.

### Responses replay and other local caches

- Anthropic clients cannot directly carry Responses item IDs or encrypted reasoning. The proxy keeps matching native output in **process memory**, scoped to the account, model, session, and history, for replay on later turns. These data are not written to logs or disk.
- Replay is limited to 512 entries / 16 MiB with least-recently-used eviction. Restarting clears it, and unrelated clients are not arbitrarily mixed.
- Model discovery coalesces pending requests, limits each source to 12 seconds, and gives clients a response budget of approximately 2.2 seconds. The TTL is five minutes when every source succeeds and 30 seconds when a source fails. A failed source retains previously discovered entries; a source that has never succeeded remains absent.
- Successful login invalidates the catalog generation. An older pending discovery cannot repopulate the current cache.
- CLI model settings are cached by mtime. This is separate from upstream prompt caching, Responses replay, and Observation Pack.

## Observation Pack

Observation Pack archives new large text tool results on later turns and replaces the full content with a notice containing its SHA-256, original file path, and beginning / ending excerpts. These are **excerpts, not summaries**. Clients can retrieve the complete evidence through native `Read` using `file_path`, `offset`, and `limit`; they must not infer missing content from excerpts.

It is enabled by default. The toggle always lives under the actual HOME:

```text
~/.claude/gateway-features.json
```

If this file is absent at startup, the proxy safely imports valid original bytes from the project-root `gateway-features.json`, retaining the project file. Existing user configuration takes precedence. A missing toggle defaults to enabled; damaged or unsafe configuration disables new packing.

From the project root:

```bash
node scripts/toggle-observation-pack.js status
node scripts/toggle-observation-pack.js off
node scripts/toggle-observation-pack.js on
curl http://127.0.0.1:8082/features
```

`on` / `off` explicitly write the toggle. `status` and `GET /features` are read-only. The setting reloads per request without a restart. Previously sent history keeps its pinned projection: turning packing off affects new results only and does not restore or rewrite earlier history.

Archives always live at:

```text
~/.claude/gateway-observations/<session identity SHA-256>/
  state.json
  <content SHA-256>.txt
```

The client must supply `metadata.session_id` or `metadata.user_id` and a `Read` tool with a `file_path` parameter. Results are not packed without a reliable session identity. The first observed request establishes a baseline; only eligible new results on later requests are packed. The threshold is 16 KiB, with limits of 8 MiB per result, 128 MiB of archives per session, and 4 MiB / 20,000 entries for state.

Only recoverable plain-text tool results are processed. Images, error results, archive readbacks, and history already pinned as full text are not packed. Archives and state use private files. An interrupted write freezes new packing for that session. Unreadable existing state returns 503 rather than rewriting untrusted history.

**Archives contain the original tool output and may include sensitive code or data.** Do not share the entire archive directory. Archives are not cleaned up automatically; remove them manually only after confirming the session no longer needs its history or readbacks. Observation Pack is not an upstream cache and does not guarantee equivalent billing savings. `CLAUDE_CONFIG_DIR` does not relocate the toggle or archive paths.

## Environment variables

Pass these variables to the **proxy process**, not just to another terminal running Claude. Runtime switches are read in different ways; restart the proxy after changing accounts, URLs, or the CLI configuration root.

| Variable | Behavior |
| --- | --- |
| `OPENAI_API_KEY` | Uses an OpenAI API key instead of stored ChatGPT credentials; never persisted |
| `OPENAI_BASE_URL` | Base URL for `/models` and `/responses` in API-key mode; defaults to `https://api.openai.com/v1` and does not replace official Codex / ChatGPT OAuth endpoints |
| `PI_AUTH_FILE` | Explicit read-only import source at startup; an existing destination is never overwritten |
| `CLAUDE_CONFIG_DIR` | Actual CLI settings root; private backups, Statusline generations, and service state/logs live under its `claude-proxy/` directory; defaults to `~/.claude` |
| `CODEX_CLIENT_VERSION` | Client-version query value for the Codex model catalog; defaults to `0.162.1` |
| `OPENAI_PROMPT_CACHE=0` | Disables generation of the GPT fallback prompt-cache key; does not guarantee disabling every upstream cache mechanism |
| `CLAUDE_PROMPT_CACHE=0` | Disables automatic Claude cache annotations; existing client annotations are retained |
| `DISABLE_PROMPT_CACHING=1` | Disables automatic Claude cache annotations |
| `DISABLE_PROMPT_CACHING_HAIKU=1` / `..._SONNET=1` / `..._OPUS=1` | Disables automatic annotations for the corresponding Claude model family |
| `PI_CACHE_RETENTION=long` | Uses `ttl: "1h"` for automatic Claude annotations when neighboring markers do not constrain the TTL; other values use the short-lived default |
| `HOME` | Determines default credential, feature-toggle, and archive locations; automated tests use a temporary HOME |
| `PATH`, Windows `APPDATA` / `ProgramFiles` / `LOCALAPPDATA` / `SystemRoot` | Installation locations searched by CLI/dependency probes; no automatic installation |
| `RUN_CLAUDE_CLI_TESTS=1` | Test-only opt-in for isolated cases requiring an installed Claude Code CLI; skipped by default |

The `ANTHROPIC_*` and gateway environment fields written by CLI setup are for the **Claude Code client**, as described in the configuration section. They do not replace the proxy's upstream authentication.

A custom `OPENAI_BASE_URL` receives the API key, model requests, and conversation content. Point it only at a trusted compatible service. Do not disable TLS verification; if an enterprise network requires an additional CA, configure trusted certificates through Node.js.

## Security and troubleshooting

### Security boundaries

- The listener is local-only. Messages API CORS compatibility is not authentication, and the API does not validate the placeholder key. Do not expose it through port forwarding, a reverse proxy, or a public tunnel, and do not publish the local page externally.
- Login and configuration routes run before wildcard API CORS. They validate the loopback address, exact Host / port, and a random page nonce. POST requests also require a same-origin Origin and `application/json`. Protections include nonce-based CSP, `no-store`, framing restrictions, and redirect restrictions.
- Authentication bodies are limited to 16 KiB with a 10-second read timeout. Configuration bodies must be `{}`. The page does not persist tokens in browser storage or receive actual access tokens.
- Enter passwords only on official websites and keep device codes private. Do not share authentication files, private settings backups, or original observation archives.
- Claude tools can still access local files or execute commands. Continue using client-side permission prompts and project isolation; the gateway does not replace permission controls.

### Common issues

| Symptom | What to check |
| --- | --- |
| Proxy cannot listen / port already in use | Ensure only one proxy is running, inspect port 8082, and manually stop any unwanted process |
| Login page does not open | Use `127.0.0.1:8082/login`; the proxy binds only IPv4 loopback, and localhost / IPv6 resolution may differ by environment |
| Login status returns 403 | Reload the local page to refresh its nonce; do not use another Host, a proxy, a cross-origin page, or a POST without Origin |
| Device code expires / login fails | Complete authorization on the official website, check account permissions and network / device-authorization availability, then start again |
| OpenAI 401 / refresh failure | Check environment overrides, storage permissions, and token validity; log in again through the page, and do not paste tokens into logs |
| Copilot 403 / no Claude models | Check the Copilot subscription, organization authorization, model picker, and policies; confirm the account can access the model |
| `/v1/models` is temporarily empty | Initial discovery may exceed the response budget; retry later. Missing credentials, upstream outages, or unavailable permissions do not produce a fabricated default model |
| CLI configuration button is unavailable | Ensure Claude CLI is discoverable, matching credentials exist, settings are valid and writable, and authentication conflicts have been resolved manually |
| Statusline button is unavailable / deployment fails | Check CLI, Bash 3+, jq 1.6+, Node 18+, the bundled runtime, settings permissions, and private deployment integrity; login is not required |
| Project Code Memory button is unavailable / conflict | Check Claude CLI, CPython 3.9+, bundle integrity, safe skill/private directories, and installation lock; different or incomplete installations need manual handling |
| Service registration is unavailable | Confirm macOS GUI login, safe writable paths, matching label/installation, and supported environment/TLS options; no system service is created |
| Service request disconnects / result is unknown | Let the page reconnect and verify its operation; do not repeat a lost POST blindly. Inspect private logs and status |
| Service reports recovery_failed / fails after paths move | Start `bash mac/start-proxy.sh` manually, inspect the matching LaunchAgent and private logs, and repair paths without overwriting another installation |
| Setup succeeds but Claude bypasses the gateway | Open a new terminal, check shell / project / local / managed overrides, and ensure the proxy and CLI use the same `CLAUDE_CONFIG_DIR` |
| Unknown model returns 400 | Copy an available ID from the current `/v1/models`; explicit unsupported model types do not automatically fall back |
| 429 / quota error | Wait according to upstream limits or adjust the account / model, and inspect upstream usage and quota |
| Streaming fails midway / empty content | Inspect status and SSE errors; check the network, upstream terminal events, model permissions, and timeouts |
| Cache hit is 0 | Caching is controlled upstream; check key / session identity, system / tools stability, and switches. Replay hits are not the same as billable prompt-cache hits |
| Observation state is unreadable | Check archive integrity and permissions, restore trusted state, or start a new session. Do not delete the ledger during an active session |

## Offline tests

From the project root:

```bash
node --test test/*.test.js
node --check mac/proxy.js
node --check windows/proxy.js
bash -n mac/start-proxy.sh
bash -n statusline/statusline-command.sh
cmp mac/proxy.js windows/proxy.js
git diff --check
```

To keep feature-toggle, archive, and configuration tests away from personal directories, use an isolated HOME on macOS / Linux:

```bash
TEST_HOME="$(mktemp -d)"
HOME="$TEST_HOME" CLAUDE_CONFIG_DIR="$TEST_HOME/config" \
  node --test test/*.test.js
# After checking the results, remove the TEST_HOME you just created if desired.
```

In Windows PowerShell, create a separate temporary directory and set `HOME`, `USERPROFILE`, and `CLAUDE_CONFIG_DIR` for that test run, restoring the original environment afterward. `node --check` also works on Windows; `bash -n` / `cmp` require Git Bash or equivalent tools.

The default suite uses mocked upstreams and temporary directories. It covers device authorization, token-refresh races, catalog invalidation, JSON / SSE, tools / images, cache usage, Responses replay, genuine client disconnects, login-route security, and private settings backups. HTTP end-to-end tests exercise both GPT and Copilot paths and reject unknown models. Statusline tests deploy/run only in temporary roots with synthetic input. Service tests mock system-management commands and run fake proxies on random non-8082 ports; VM/e2e tests inject a fake service. Project Code Memory tests use temporary CLI roots and fake dependency probes, covering no-op preservation, conflicts, concurrent publication, short writes, and external-edit cleanup. No real Statusline configuration, global skill installation, or launchd registration/restart is performed.

`claude-cli.test.js` and `observation-pack-cli.test.js` are skipped by default. Set `RUN_CLAUDE_CLI_TESTS=1` only when explicitly choosing to run isolated checks with the locally installed CLI. They still use mocked gateways and do not validate real account authorization or real upstream access.

Validation is based on offline tests on macOS. Windows batch launchers and probe code have received static / mocked checks; successful execution on a real Windows installation or with real accounts has not been claimed.

## License

The project retains the root [MIT LICENSE](LICENSE). `lib/device-login.js` preserves its Pi source attribution; the corresponding third-party MIT license is in [third-party/pi/LICENSE](third-party/pi/LICENSE). The bundled Claude HUD runtime retains its [MIT LICENSE](statusline/claude-hud/LICENSE), copyright 2026 Jarrod Watts; its local source provenance, preserved vendor adaptations, and measured aggregate SHA-256 are documented in [statusline/SOURCE.md](statusline/SOURCE.md). Project Code Memory retains its [MIT LICENSE](project-code-memory/LICENSE); source-owner authorization and pinned bundle provenance are recorded in [project-code-memory/SOURCE.md](project-code-memory/SOURCE.md).
