<p align="center">
  <img src="assets/logo.png" alt="Vedecaps" width="140">
</p>

<h1 align="center">Vedecaps</h1>

<p align="center">터미널에서 동작하는 AI 코딩 에이전트 · <a href="README.en.md">English</a></p>

Vedecaps는 터미널에서 코드를 읽고, 고치고, 명령을 실행하는 AI 코딩 에이전트입니다. [OpenCode](https://opencode.ai)와 같은 종류의 도구이며, Windows 11과 Debian 13 계열 Linux에서 단일 실행 파일로 동작합니다(macOS 빌드도 제공).

```
 ▀███▄    ▄███▀
  ▀███▄  ▄███▀    V E D E C A P S
   ▀███▄ ███▀
    ▀███▄▀█
     ▀███▄
      ▀█▀
```

## 설치

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/nxodh/vedecaps/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/nxodh/vedecaps/main/install.ps1 | iex
```

설치 스크립트는 릴리스 파일의 SHA-256 체크섬을 확인한 뒤 실행 파일을 설치하고 PATH에 추가합니다.

| | 기본 설치 위치 | 바꾸려면 |
|---|---|---|
| Linux / macOS | `~/.vedecaps/bin` | `VEDECAPS_INSTALL_DIR` |
| Windows | `%LOCALAPPDATA%\vedecaps\bin` | `VEDECAPS_INSTALL_DIR` |

특정 버전은 `VEDECAPS_VERSION=0.1.0`으로 지정합니다. PATH를 건드리지 않으려면 `VEDECAPS_NO_MODIFY_PATH=1`을 설정하세요. Alpine 같은 musl 기반 배포판은 아직 지원하지 않습니다.

업데이트는 `vedecaps upgrade`, 제거는 `vedecaps uninstall`입니다.

## 시작하기

```sh
vedecaps auth login        # 모델 제공자의 API 키 등록 (또는 ANTHROPIC_API_KEY 같은 환경 변수 사용)
cd my-project
vedecaps                   # 터미널 UI 시작
```

스크립트나 파이프에서는 `run`을 씁니다.

```sh
vedecaps run "이 저장소가 무엇을 하는지 설명해줘"
git diff | vedecaps run "이 변경에 대한 커밋 메시지를 써줘"
```

프로젝트에서 처음 쓸 때 `/init`을 실행하면 에이전트가 저장소를 분석해 `AGENTS.md`를 만듭니다. 이 파일은 매 세션 시작 시 에이전트에게 전달됩니다.

## 터미널 UI

| 입력 | 동작 |
|---|---|
| `enter` | 전송 |
| `\` + `enter`, `alt+enter`, `ctrl+j` | 줄바꿈 |
| `tab` | 에이전트 전환 (build ↔ plan) |
| `esc` `esc` | 실행 중인 작업 중단 |
| `↑` / `↓` | 줄 이동, 첫/마지막 줄에서는 이전 입력 불러오기 |
| `ctrl+c` | 입력 지우기, 두 번 누르면 종료 |
| `@경로` | 파일·디렉터리 첨부 (퍼지 자동완성) |
| `!명령` | 셸 명령을 실행하고 결과를 에이전트와 공유 |
| `/명령` | 명령 실행 |

작업 중에 입력한 메시지는 대기열에 들어가 현재 작업이 끝나면 전송됩니다. 한글·일본어·중국어 조합 입력을 위해 실제 터미널 커서를 입력 위치에 둡니다.

**슬래시 명령**

| 명령 | 설명 |
|---|---|
| `/new` | 새 세션 |
| `/sessions` | 세션 이어가기·삭제 |
| `/models` | 모델 전환 |
| `/agents` | 에이전트 전환 |
| `/connect` | 제공자 API 키 추가 |
| `/undo`, `/redo` | 마지막 메시지와 파일 변경 되돌리기 / 다시 적용 |
| `/compact` | 대화를 요약해 컨텍스트 확보 |
| `/details` | 도구 출력·추론 전체 보기 전환 |
| `/export [파일]` | 대화를 Markdown으로 저장 |
| `/editor` | `$EDITOR`에서 프롬프트 작성 |
| `/fork` | 세션 복사본에서 계속 |
| `/rename` | 세션 이름 변경 |
| `/theme` | 테마 전환 (`mono`, `ink`, `paper`) |
| `/mcp` | MCP·LSP 상태 |
| `/init` | `AGENTS.md` 생성·갱신 |
| `/review` | 변경 사항 리뷰 |
| `/help`, `/exit` | 도움말, 종료 |

디자인은 로고를 따라 흑백만 사용합니다. 강조는 굵기·흐림·반전으로만 표현합니다.

## 모델 제공자

API 키는 `vedecaps auth login`, TUI의 `/connect`, 또는 환경 변수로 등록합니다. 저장된 키는 데이터 디렉터리의 `auth.json`(소유자만 읽기 가능)에 들어가며, 로그·내보내기·`debug` 출력에서는 가려집니다.

| 제공자 | 환경 변수 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` 또는 `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI, Groq, DeepSeek, Mistral, Together, Fireworks, Cerebras 등 | 각 제공자의 키 |

모델 목록은 [models.dev](https://models.dev)에서 받아 하루 단위로 캐시합니다. `vedecaps models`로 사용할 수 있는 모델을 확인하고, `-m provider/model` 또는 설정의 `model`로 선택합니다. 목록에 없는 모델 ID도 그대로 사용할 수 있습니다.

**로컬 모델** (Ollama, LM Studio, llama.cpp, vLLM)은 실행 중이면 시작할 때 자동으로 감지되어 `/models`와 `vedecaps models`에 나타납니다. 별도 설정이나 API 키가 필요 없습니다. `vedecaps debug local`로 감지된 서버, 모델별 컨텍스트 크기, 도구 호출 지원 여부를 확인할 수 있습니다.

| 서버 | 기본 주소 | 비고 |
|---|---|---|
| Ollama | `http://127.0.0.1:11434` (`OLLAMA_HOST`를 따름) | 네이티브 API 사용 |
| LM Studio | `http://127.0.0.1:1234` | 불러온 컨텍스트 크기를 그대로 사용 |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080` | `-c`로 지정한 컨텍스트 크기를 사용 |
| vLLM | `http://127.0.0.1:8000` | `max_model_len`을 사용 |

로컬 모델을 위해 다음을 처리합니다.

- **컨텍스트 크기 지정**: Ollama의 OpenAI 호환 API는 컨텍스트 창을 지정할 수 없어 2~4K 토큰을 넘는 프롬프트가 조용히 잘립니다. Vedecaps는 Ollama 네이티브 API로 `num_ctx`를 명시합니다. 기본값은 모델 최대치와 16,384 중 작은 값이며(KV 캐시 메모리가 커지므로), 모델 설정의 `limit.context`나 `options.num_ctx`로 바꿀 수 있습니다.
- **작은 모델용 프롬프트**: 컨텍스트가 8K 이하이거나 파라미터가 40억 이하인 로컬 모델에는 짧은 시스템 프롬프트와 핵심 도구(`bash`, `read`, `edit`, `write`, `glob`, `grep`, `list`)만 보냅니다. 실제 측정에서 요청 크기가 약 4,800토큰에서 약 1,600토큰으로 줄었습니다. 모델 설정의 `options.compact_prompt`를 `true`/`false`로 지정하면 강제하거나 끌 수 있습니다.
- **텍스트로 쓴 도구 호출 복구**: 도구 호출을 구조화된 형식이 아니라 본문에 쓰는 모델(Hermes/Qwen `<tool_call>`, `<function=…>`, Mistral `[TOOL_CALLS]`, JSON 코드 블록)도 도구 호출로 인식합니다.
- **`<think>` 태그 분리**: 본문에 섞여 나오는 추론 과정을 추론 블록으로 분리합니다.
- **컨텍스트 사용량 보정**: Ollama가 캐시된 프롬프트를 사용량에서 빼고 보고해도 실제 크기를 추정해 자동 압축 시점과 상태 표시줄이 틀어지지 않게 합니다.
- **친절한 오류**: 모델이 없을 때(`ollama pull …`), 도구를 지원하지 않을 때, 서버가 꺼져 있을 때 해결 방법을 알려 줍니다.

감지를 끄려면 설정에 `"local_detect": false`를 넣습니다. 그 밖의 OpenAI 호환 서버(사내 프록시 등)는 직접 추가합니다. 모델을 적지 않으면 `/models` 엔드포인트에서 목록을 가져옵니다.

```jsonc
{
  "provider": {
    "gpu-box": {
      "name": "GPU box",
      "api": "http://192.168.0.20:8000/v1",
      "models": {
        "qwen3-coder": { "name": "Qwen3 Coder", "tool_call": true, "limit": { "context": 64000, "output": 8000 } }
      }
    }
  },
  "model": "gpu-box/qwen3-coder"
}
```

Anthropic 프로토콜을 쓰는 게이트웨이는 `"protocol": "anthropic"`을 지정합니다. 주소가 Ollama(`:11434`)로 보이면 네이티브 API를 쓰며, `"protocol": "openai"`로 호환 API를 강제할 수 있습니다.

## 설정

설정 파일은 `vedecaps.json` 또는 `vedecaps.jsonc`(주석 허용)이며, 아래 순서로 병합됩니다(뒤가 우선).

1. 전역: Linux/macOS `~/.config/vedecaps/`, Windows `%APPDATA%\vedecaps\`
2. `VEDECAPS_CONFIG`가 가리키는 파일
3. 프로젝트 루트부터 현재 디렉터리까지의 `vedecaps.json(c)`
4. 같은 경로의 `.vedecaps/vedecaps.json(c)`
5. `VEDECAPS_CONFIG_CONTENT` 환경 변수(JSON 문자열)

값 안에서 `{env:이름}`은 환경 변수로, `{file:경로}`는 파일 내용으로 치환됩니다. 편집기 자동완성용 스키마는 [`config.schema.json`](config.schema.json)입니다.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/nxodh/vedecaps/main/config.schema.json",
  "model": "anthropic/claude-sonnet-5-5",
  "small_model": "anthropic/claude-haiku-5-5",   // 제목 생성용
  "default_agent": "build",
  "reasoning_effort": "high",                     // low | medium | high | xhigh | max
  "instructions": ["docs/conventions.md"],        // AGENTS.md 외에 추가로 읽을 지침
  "permission": {
    "edit": "ask",
    "bash": { "*": "ask", "git status *": "allow", "rm -rf *": "deny" }
  },
  "mcp": {
    "files": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }
  },
  "formatter": { "prettier": { "disabled": true } },
  "lsp": false,
  "snapshot": true,
  "autoupdate": true,
  "compaction": { "auto": true }
}
```

데이터는 Linux/macOS에서 `~/.local/share/vedecaps`, Windows에서 `%LOCALAPPDATA%\vedecaps`에 저장됩니다(`XDG_*` 환경 변수를 따름). `vedecaps debug paths`로 실제 경로를 확인할 수 있습니다.

## 에이전트

| 이름 | 종류 | 설명 |
|---|---|---|
| `build` | 기본 | 모든 도구를 쓰는 기본 에이전트 |
| `plan` | 기본 | 읽기 전용. 파일을 고치지 않고 계획만 세움 |
| `general` | 서브에이전트 | 여러 단계 작업을 위임받아 병렬로 처리 |
| `explore` | 서브에이전트 | 읽기 전용 코드베이스 탐색 |

직접 만들려면 `.vedecaps/agent/이름.md`(또는 전역 설정 디렉터리의 `agent/`)에 둡니다. 파일 이름이 에이전트 이름이고 본문이 시스템 프롬프트입니다. `vedecaps agent create`로 틀을 만들 수 있습니다.

```markdown
---
description: 변경 사항을 리뷰합니다
mode: subagent
model: anthropic/claude-sonnet-5-5
tools:
  write: false
  edit: false
permission:
  bash: ask
---
당신은 코드 리뷰어입니다. 버그와 누락된 테스트를 찾으세요.
```

프롬프트에서 `@에이전트이름`으로 서브에이전트에게 맡길 수 있습니다.

## 권한

각 도구 호출은 `allow`(허용), `ask`(물어봄), `deny`(차단) 중 하나로 평가됩니다. 기본값은 대부분 `allow`이고, 프로젝트 밖 경로 접근과 `.env` 파일 읽기, 같은 호출의 반복은 `ask`입니다.

| 키 | 대상 |
|---|---|
| `edit` | `edit`, `multiedit`, `write`, `patch` |
| `bash` | 셸 명령 (패턴으로 세분화 가능) |
| `read` | 파일 읽기 |
| `webfetch` | URL 가져오기 |
| `task`, `skill` | 서브에이전트, 스킬 |
| `external_directory` | 프로젝트 밖 경로 |
| `doom_loop` | 같은 도구를 같은 입력으로 3회 연속 호출 |
| `서버_도구` | MCP 도구 |

패턴은 `*` 와일드카드를 쓰며 뒤에 적은 규칙이 우선합니다. `&&`, `|`, `;`로 이어진 명령은 각각 평가합니다. 물어볼 때 "항상 허용"을 고르면 그 세션 동안 기억합니다. `vedecaps run`은 물어볼 수 없으므로 `ask`를 거부하며, `--dangerously-skip-permissions`로 모두 허용할 수 있습니다.

## 도구

| 도구 | 설명 |
|---|---|
| `bash` | 셸 명령 실행. Windows에서는 Git Bash → PowerShell 7 → Windows PowerShell → cmd 순으로 선택 |
| `read` | 파일 읽기(줄 범위, 이미지·PDF 첨부) |
| `edit`, `multiedit`, `write` | 파일 수정·생성. 줄바꿈 형식(CRLF) 보존, 읽지 않은 파일은 수정 거부 |
| `patch` | `*** Begin Patch` 형식으로 여러 파일을 한 번에 생성·수정·이동·삭제(전부 적용되거나 아무것도 적용되지 않음) |
| `glob`, `grep`, `list` | 파일·내용 검색 (`.gitignore` 반영) |
| `webfetch` | 웹 페이지를 Markdown으로 가져오기 |
| `todowrite`, `todoread` | 작업 목록 |
| `task` | 서브에이전트에 위임 |
| `skill` | 스킬 불러오기 |

파일을 수정하면 프로젝트의 포매터(prettier, biome, gofmt, rustfmt, ruff 등)가 설치되어 있을 때 자동으로 실행되고, 설치된 언어 서버(TypeScript, gopls, pyright, rust-analyzer, clangd 등)의 오류가 에이전트에게 전달됩니다. 언어 서버와 포매터를 자동으로 설치하지는 않습니다.

## 커스텀 명령

`.vedecaps/command/이름.md`에 두면 `/이름`으로 실행됩니다.

```markdown
---
description: 테스트를 실행하고 실패를 고칩니다
agent: build
---
다음 테스트를 실행하고 실패하면 고쳐줘: $ARGUMENTS

현재 상태:
!`git status --short`
```

`$ARGUMENTS`는 전체 인자, `$1`~`$9`는 개별 인자, `` !`명령` ``은 셸 출력, `@파일`은 파일 내용으로 바뀝니다. 프런트매터에는 `description`, `agent`, `model`, `subtask`를 쓸 수 있습니다.

## 스킬

`SKILL.md`가 들어 있는 디렉터리를 `.vedecaps/skill/이름/`에 두면 에이전트가 필요할 때 불러옵니다. `.claude/skills`와 `.agents/skills`(프로젝트·홈)에 있는 스킬도 그대로 인식합니다.

## MCP

```sh
vedecaps mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
vedecaps mcp add docs --url https://example.com/mcp --header 'Authorization: Bearer TOKEN'
vedecaps mcp list
```

로컬(stdio) 서버와 원격(Streamable HTTP, 구형 SSE) 서버를 지원합니다. 도구는 `서버이름_도구이름`으로 노출됩니다. OAuth 인증이 필요한 서버는 아직 지원하지 않으며, 헤더로 토큰을 전달해야 합니다.

## CLI

| 명령 | 설명 |
|---|---|
| `vedecaps [프로젝트]` | 터미널 UI (`-c` 마지막 세션, `-s <id>`, `-m <모델>`, `--agent`, `-p <프롬프트>`) |
| `vedecaps run [메시지..]` | 비대화형 실행 (`--format json`, `-f <파일>`, `--command <이름>`) |
| `vedecaps auth login\|list\|logout` | 자격 증명 관리 |
| `vedecaps models [제공자]` | 모델 목록 (`--refresh`, `--all`, `-v`) |
| `vedecaps agent list\|create` | 에이전트 목록·생성 |
| `vedecaps session list\|delete` | 세션 관리 |
| `vedecaps export [id]`, `import <파일>` | 세션 내보내기(JSON·Markdown)·가져오기 |
| `vedecaps mcp list\|add\|remove` | MCP 서버 관리 |
| `vedecaps stats` | 토큰 사용량·비용 |
| `vedecaps serve` | HTTP API 서버 |
| `vedecaps upgrade [버전]` | 업데이트 (`--check`) |
| `vedecaps uninstall` | 제거 (`--dry-run`, `--keep-config`, `--keep-data`) |
| `vedecaps debug [config\|local]` | 경로·설정·제공자·도구 상태, 로컬 모델 서버 진단 |

각 명령에 `--help`를 붙이면 옵션과 예시가 나옵니다.

## HTTP 서버

`vedecaps serve`는 기본적으로 `127.0.0.1:4096`에서 JSON API를 엽니다. `VEDECAPS_SERVER_PASSWORD`를 설정하면 HTTP Basic 인증(사용자 이름은 아무 값)이 필요합니다. 이 서버는 사용자 권한으로 명령을 실행할 수 있으므로, 암호 없이 외부 인터페이스에 열지 마세요.

| 경로 | 설명 |
|---|---|
| `GET /health` | 상태·버전 |
| `GET /event` | 모든 이벤트의 SSE 스트림 |
| `GET /session`, `POST /session` | 세션 목록·생성 |
| `GET\|PATCH\|DELETE /session/:id` | 조회·이름 변경·삭제 |
| `GET /session/:id/message` | 메시지 목록 |
| `POST /session/:id/message` | 프롬프트 전송, 끝날 때까지 대기 (`{ text, agent?, model? }`) |
| `POST /session/:id/prompt_async` | 프롬프트 전송, 즉시 반환(결과는 `/event`) |
| `POST /session/:id/abort` | 중단 |
| `POST /session/:id/command`, `/shell`, `/compact`, `/revert`, `/unrevert`, `/fork` | 명령·셸·요약·되돌리기·복사 |
| `GET /session/:id/export` | Markdown 내보내기 |
| `GET /permission`, `POST /permission/:id` | 대기 중인 권한 요청·응답 (`{ reply: "once"\|"always"\|"reject" }`) |
| `GET /agent`, `/provider`, `/command`, `/config`, `/project` | 정보 조회 (키는 포함되지 않음) |
| `GET /find/file?query=` | 파일 퍼지 검색 |

## OpenCode와의 차이

구조와 사용법은 OpenCode를 따랐습니다. 0.1.0에 **없는** 기능은 다음과 같습니다.

- 세션 공유(`/share`): 호스팅 서비스가 필요합니다. `/export`를 쓰세요.
- 구독 계정 OAuth 로그인: API 키만 지원합니다.
- Amazon Bedrock, Google Vertex AI, Azure 전용 인증
- 플러그인 시스템, SDK, IDE 확장, GitHub Action, ACP
- `websearch` 도구
- 언어 서버 자동 설치, MCP OAuth
- musl(Alpine) 빌드

## 개발

Node.js 22 이상이 필요합니다. Bun은 개발 의존성으로 설치되므로 따로 설치하지 않아도 됩니다.

```sh
npm ci
npx bun run src/index.ts            # 소스에서 실행
npx tsc --noEmit                    # 타입 검사
npx bun test                        # 테스트
npx bun run script/build.ts         # 현재 플랫폼용 실행 파일 → dist/
npx bun run script/build.ts --all   # 모든 플랫폼 + 체크섬
npx bun run script/smoke.ts dist/<플랫폼>/vedecaps   # 실행 파일 스모크 테스트
python3 script/tui-pty.py           # 가짜 모델로 터미널 UI 확인 (POSIX)
```

릴리스는 `package.json`의 버전과 같은 `v*` 태그를 푸시하면 GitHub Actions가 빌드해 게시합니다.

## 라이선스

[MIT](LICENSE)
