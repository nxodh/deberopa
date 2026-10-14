<p align="center">
  <img src="assets/logo.png" alt="Deberopa" width="140">
</p>

<h1 align="center">Deberopa</h1>

<p align="center">터미널에서 동작하는 AI 코딩 에이전트 · <a href="README.en.md">English</a></p>

Deberopa는 터미널에서 코드를 읽고, 고치고, 명령을 실행하는 AI 코딩 에이전트입니다. [OpenCode](https://opencode.ai)와 같은 종류의 도구이며, Windows 11과 Debian 13 계열 Linux에서 단일 실행 파일로 동작합니다(macOS 빌드도 제공).

```
█████████▄
 ▀█████████   D E B E R O P A
██▄ ▀▀██████
████    ████
████▄▄██████
██████████▀
▀▀▀▀▀▀▀▀▀
```

> **이름이 바뀌었습니다**: Vedecaps는 0.2.0부터 **Deberopa**입니다. 실행 파일은 `deberopa`, 설정은 `~/.config/deberopa/deberopa.json`(Windows는 `%APPDATA%\deberopa`), 프로젝트 폴더는 `.deberopa/`, 환경 변수는 `DEBEROPA_*`입니다. 처음 실행할 때 새 설정 폴더가 없고 옛 폴더가 있으면 설정, 저장된 로그인, 세션, 신뢰한 프로젝트를 새 폴더로 **복사**합니다(옛 폴더는 그대로 두고 더 이상 쓰지 않습니다). 프로젝트의 옛 이름 설정 파일과 폴더도 계속 읽으며, 새 이름이 우선합니다. 옛 환경 변수 이름은 이번 릴리스까지 읽고 사용 중단 안내를 한 줄 냅니다.

**목표**: Deberopa(CLI와 Deberopa Desktop 모두)는 **로컬 LLM을 코딩 에이전트로 쓰기 가장 편한 도구**를 목표로 합니다. 클라우드 모델도 지원하지만, 기능과 편의성의 우선순위는 로컬 모델에 있습니다. 로컬 서버를 자동으로 찾고, 도구 호출이 되는지 점검하고, 작은 모델에 맞게 프롬프트를 줄이고, 속도·슬롯·컨텍스트를 보여 주고, Ollama 모델을 바로 내려받을 수 있습니다([로컬 모델](#모델-제공자)).

## 설치

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/nxodh/deberopa/main/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/nxodh/deberopa/main/install.ps1 | iex
```

설치 스크립트는 릴리스 파일의 SHA-256 체크섬을 확인한 뒤 실행 파일을 설치하고 PATH에 추가합니다.

| | 기본 설치 위치 | 바꾸려면 |
|---|---|---|
| Linux / macOS | `~/.deberopa/bin` | `DEBEROPA_INSTALL_DIR` |
| Windows | `%LOCALAPPDATA%\deberopa\bin` | `DEBEROPA_INSTALL_DIR` |

특정 버전은 `DEBEROPA_VERSION=0.1.0`으로 지정합니다. PATH를 건드리지 않으려면 `DEBEROPA_NO_MODIFY_PATH=1`을 설정하세요. 0.1.2부터 Alpine용 musl 빌드를 제공합니다. Alpine에는 `libstdc++`·`libgcc`가 필요합니다(`apk add --no-cache libstdc++ libgcc`).

업데이트는 `deberopa upgrade`, 제거는 `deberopa uninstall`입니다.

## Deberopa Desktop

터미널 대신 창으로 쓰는 데스크톱 앱입니다. Code - OSS 기반 에디터 안에 대화 패널(권한 요청, 도구 카드, 세션, 로컬 모델 카드)이 들어 있고, 같은 버전의 `deberopa`를 함께 담고 있어 따로 설치할 것이 없습니다. CLI와 같은 번호로 함께 릴리스됩니다.

| 대상 | 파일 | 실행 |
|---|---|---|
| Debian 13 · Opereta (x86-64) | `deberopa-desktop-linux-x64.tar.gz` | 풀어서 `deberopa-desktop-<버전>-linux-x64/deberopa-desktop` |
| Windows 11 (x86-64) | `deberopa-desktop-windows-x64.zip` | 풀어서 `Deberopa Desktop.exe` |

- 설치 프로그램과 자동 업데이트는 아직 없습니다. 새 버전은 새로 내려받아 풉니다.
- **서명되지 않았습니다.** Windows에서 SmartScreen이 경고하거나 Smart App Control이 막을 수 있습니다. `checksums.txt`(SHA-256)와 GitHub 빌드 증명(`gh attestation verify <파일> --repo nxodh/deberopa`)으로 확인하세요.
- Debian 13에서 Electron 샌드박스 때문에 바로 종료되면 `--no-sandbox`로 실행하거나, `chrome-sandbox`의 소유자를 root로 하고 `chmod 4755` 하세요.
- Microsoft 마켓플레이스와 원격 측정을 쓰지 않으며 Copilot 확장을 뺐습니다. 확장은 내장 확장과 VSIX 직접 설치만 지원합니다.
- 소스와 빌드 방법: `desktop/`, 설계: [docs/desktop-design.md](docs/desktop-design.md).

## 시작하기

```sh
deberopa auth login        # 모델 제공자의 API 키 등록 (또는 ANTHROPIC_API_KEY 같은 환경 변수 사용)
cd my-project
deberopa                   # 터미널 UI 시작
```

스크립트나 파이프에서는 `run`을 씁니다.

```sh
deberopa run "이 저장소가 무엇을 하는지 설명해줘"
git diff | deberopa run "이 변경에 대한 커밋 메시지를 써줘"
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
| `/undo`, `/redo` | 마지막 메시지와 파일 변경 되돌리기 / 다시 적용(git 저장소에서만 파일 복원, 아래 "Git과 GitHub" 참고) |
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

0.1.3부터 TUI는 터미널 전체 화면을 사용합니다. 입력창과 상태줄은 아래에 고정되며, `PageUp`·`PageDown`으로 대화를 스크롤하고 `Ctrl+Home`·`Ctrl+End`로 처음·끝으로 이동합니다. 맨 아래에서는 새 응답을 따라가고, 이전 대화를 읽는 동안에는 화면을 고정합니다. 종료하면 원래 터미널 화면으로 돌아옵니다. 0.1.2 사용자는 `deberopa upgrade`로 업데이트하세요.

## 모델 제공자

API 키는 `deberopa auth login`, TUI의 `/connect`, 또는 환경 변수로 등록합니다. 저장된 키는 데이터 디렉터리의 `auth.json`(소유자만 읽기 가능)에 들어가며, 로그·내보내기·`debug` 출력에서는 가려집니다.

| 제공자 | 환경 변수 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` 또는 `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI, Groq, DeepSeek, Mistral, Together, Fireworks, Cerebras 등 | 각 제공자의 키 |

모델 목록은 [models.dev](https://models.dev)에서 받아 하루 단위로 캐시합니다. `deberopa models`로 사용할 수 있는 모델을 확인하고, `-m provider/model` 또는 설정의 `model`로 선택합니다. 목록에 없는 모델 ID도 그대로 사용할 수 있습니다.

**로컬 모델** (Ollama, LM Studio, llama.cpp, vLLM)은 실행 중이면 시작할 때 자동으로 감지되어 `/models`와 `deberopa models`에 나타납니다. 별도 설정이나 API 키가 필요 없습니다. `deberopa debug local`로 감지된 서버, 모델별 컨텍스트 크기, 도구 호출 지원 여부를 확인할 수 있습니다.

| 서버 | 기본 주소 | 비고 |
|---|---|---|
| Ollama | `http://127.0.0.1:11434` (`OLLAMA_HOST`를 따름) | 네이티브 API 사용 |
| LM Studio | `http://127.0.0.1:1234` | 불러온 컨텍스트 크기를 그대로 사용 |
| llama.cpp (`llama-server`) | `http://127.0.0.1:8080` | `-c`로 지정한 컨텍스트 크기를 사용 |
| vLLM | `http://127.0.0.1:8000` | `max_model_len`을 사용 |

로컬 모델을 위해 다음을 처리합니다.

- **컨텍스트 크기 지정**: Ollama의 OpenAI 호환 API는 컨텍스트 창을 지정할 수 없어 2~4K 토큰을 넘는 프롬프트가 조용히 잘립니다. Deberopa는 Ollama 네이티브 API로 `num_ctx`를 명시합니다. 기본값은 모델 최대치와 16,384 중 작은 값이며(KV 캐시 메모리가 커지므로), 모델 설정의 `limit.context`나 `options.num_ctx`로 바꿀 수 있습니다.
- **작은 모델용 프롬프트**: 컨텍스트가 8K 이하이거나 파라미터가 40억 이하인 로컬 모델에는 짧은 시스템 프롬프트와 핵심 도구(`bash`, `read`, `edit`, `write`, `glob`, `grep`, `list`)만 보냅니다. 실제 측정에서 요청 크기가 약 4,800토큰에서 약 1,600토큰으로 줄었습니다. 모델 설정의 `options.compact_prompt`를 `true`/`false`로 지정하면 강제하거나 끌 수 있습니다.
- **텍스트로 쓴 도구 호출 복구**: 도구 호출을 구조화된 형식이 아니라 본문에 쓰는 모델(Hermes/Qwen `<tool_call>`, `<function=…>`, Mistral `[TOOL_CALLS]`, JSON 코드 블록)도 도구 호출로 인식합니다.
- **`<think>` 태그 분리**: 본문에 섞여 나오는 추론 과정을 추론 블록으로 분리합니다.
- **컨텍스트 사용량 보정**: Ollama가 캐시된 프롬프트를 사용량에서 빼고 보고해도 실제 크기를 추정해 자동 압축 시점과 상태 표시줄이 틀어지지 않게 합니다.
- **친절한 오류**: 모델이 없을 때(`ollama pull …`), 도구를 지원하지 않을 때, 서버가 꺼져 있을 때 해결 방법을 알려 줍니다.

**로컬 모델 도구**: 로컬 모델이 목적이므로 다음을 터미널 UI와 CLI, Deberopa Desktop에서 같은 방식으로 제공합니다.

| 하는 일 | 터미널 UI | CLI | HTTP API |
|---|---|---|---|
| 실행 중인 서버 확인, 꺼져 있으면 시작 방법 안내 | `/local` | `deberopa local` | `GET /local` |
| 이 모델이 도구를 호출할 수 있는지 한 번 확인 (Ollama 네이티브 API 포함) | `/toolcheck` | `deberopa local check [제공자/모델]` | `POST /local/toolcheck` |
| Ollama 모델 내려받기(진행률) | `/pull <모델>` | `deberopa local pull <모델>` | `POST /local/pull`, 이벤트 `local.pull` |
| 모델이 쓰이는 방식(짧은 프롬프트 여부와 이유, 컨텍스트, 슬롯) | 상태 표시줄의 `compact`, `slots 1/2` | `deberopa local status` | `GET /provider`의 `mode`, `GET /local/slots` |
| 응답 속도 | 상태 표시줄의 `34 tok/s` | | 메시지의 `timings` |

- **첫 실행**: 모델을 고르지 않았다면 이 컴퓨터에서 실행 중인 로컬 서버의 모델이 클라우드보다 먼저 기본값이 됩니다. 아무것도 없으면 키 입력을 요구하기 전에 서버를 시작하는 방법을 보여 줍니다.
- **속도**: Ollama의 `eval_duration`과 llama.cpp/Opereta의 `timings`처럼 서버가 알려 주는 생성 시간을 우선 쓰고, 없으면 응답 시간으로 계산해 `~`를 붙입니다.
- **텍스트 도구 호출**: 모델이 도구 호출을 본문에 텍스트로 쓰면 Deberopa가 복구해 실행합니다. 이렇게 복구된 호출은 기록에 `viaText`로 남습니다.
- **슬롯**: llama-server의 `/slots`가 켜져 있으면 작업 중에 사용 중인 슬롯 수를 보여 줍니다.

**API 키가 있는 서버와 Opereta 게이트웨이**: llama-server(`--api-key`)나 Opereta처럼 키를 요구하는 서버는 환경 변수 `OPERETA_API_KEY`(없으면 `LLAMA_API_KEY`)에 키를 두면 감지되고 요청에도 쓰입니다. 키는 감지된 주소와 직접 적은 제공자 주소로만 보내며, 리다이렉트는 따르지 않고, 로그와 `debug` 출력에서는 가려집니다. 키가 필요한데 없으면 `deberopa debug local`이 "이 서버는 API 키가 필요하다(401)"고 알려 줍니다. Opereta는 `X-Opereta` 헤더나 `GET /opereta/info`(인증 없음)로 알아보며, 슬롯 수와 슬롯당 컨텍스트를 읽습니다. 설정에 컨텍스트를 적지 않은 로컬 제공자는 그 값을 쓰고, 적은 값이 항상 우선합니다. 호스팅 API에는 이 경로를 요청하지 않습니다.

**동시 요청 상한**: 로컬 서버는 슬롯 수가 정해져 있어, 서브에이전트와 제목 생성이 그보다 많이 동시에 가면 429가 돌아옵니다. 제공자 설정의 `options.max_concurrency`(1~64의 정수)를 적으면 Deberopa가 그 수만큼만 동시에 보내고 나머지는 순서를 기다립니다. 기다리는 동안 중단하면 즉시 빠지고, 끝난 요청은 오류로 끝나도 자리를 반드시 돌려줍니다. 제목·요약은 본작업보다 뒤로 밀립니다. 설정하지 않으면 무제한이며, Opereta가 슬롯 수를 고정값으로 알려 주면 그 값을 씁니다(슬롯을 서버가 자동으로 정하면 숫자를 지어내지 않고 무제한). 적은 값이 항상 우선하며, 사용할 수 없는 값(0, 음수, 소수, 문자열)은 무시하고 `deberopa debug`에 이유를 표시합니다.

```jsonc
{ "provider": { "opereta": { "api": "http://127.0.0.1:8080/v1", "options": { "max_concurrency": 2 } } } }
```

**HTTPS와 `options.ca`**: 서버가 사설 CA(예: Opereta의 `opereta tls ca`)로 서명한 인증서로 HTTPS를 쓰면, 그 CA 파일을 제공자 설정에 적습니다. 인증서 검증과 호스트 이름 검증을 끄는 옵션은 없습니다.

```jsonc
{
  "provider": {
    "opereta": {
      "api": "https://spark.local:8444/v1",
      "options": { "ca": "~/.config/deberopa/opereta-ca.pem" }
    }
  }
}
```

- `ca`는 PEM 파일 경로, 경로 목록, 또는 PEM 본문 자체입니다. `~`는 홈 디렉터리이고, 상대 경로는 **그 설정을 적은 파일이 있는 폴더** 기준입니다(현재 디렉터리가 아닙니다. `DEBEROPA_CONFIG_CONTENT`만 현재 디렉터리 기준).
- 파일은 제공자를 만들 때 읽습니다. 파일이 없거나, 읽을 수 없거나, PEM 인증서가 아니면(개인 키가 들어 있어도) 그 제공자는 **사용할 수 없음**으로 표시되고 이유가 `deberopa debug`와 오류에 나옵니다. 시스템 인증서 저장소로 조용히 돌아가지 않습니다.
- `ca`를 적은 제공자는 **적은 CA만** 신뢰합니다(Bun의 `tls.ca`는 시스템 저장소를 대체합니다). 요청마다, 모델 목록·`/opereta/info` 조회·도구 호출 시험에도 같은 신뢰를 씁니다.
- 신뢰하지 않는 프로젝트(`deberopa trust` 전)의 `options.ca`는 무시되고 `debug`에 표시됩니다. 저장소가 어떤 CA를 믿을지 정할 수 없습니다.
- 자동 감지 대상(127.0.0.1의 일반 `http://`)에는 필요 없습니다. HTTP에서 HTTPS로의 리다이렉트는 따르지 않습니다.
- CA에 이름 제한(name constraints)을 쓸 때는 **DNS 이름만** 제한하세요. Bun은 IP 주소 제한이 있는 CA 아래의 IP 주소 SAN 인증서를 검증하지 못합니다(`UNSUPPORTED_CONSTRAINT_TYPE`).

인증서 오류와 해결 방법(`deberopa debug local`도 같은 문장을 보여 줍니다):

| 증상 | 의미 | 해결 |
|---|---|---|
| `The certificate of … is not trusted` | 서버 인증서의 CA를 모름 | `options.ca`에 서버의 CA 파일을 적습니다(Opereta: `opereta tls ca`) |
| `… is not signed by a CA listed in …options.ca` | 적은 CA가 이 서버의 CA가 아님 | 올바른 CA 파일인지 확인 |
| `The certificate does not cover <host>` | 접속한 이름·주소가 인증서에 없음 | 인증서에 있는 이름이나 주소로 접속(Opereta: `opereta tls status`) |
| `The certificate of … has expired` | 인증서 기간 만료 | 서버에서 갱신(`opereta tls renew`)하고 양쪽 시계를 확인 |
| `cannot read … The provider is not used…` | `ca` 파일 문제 | 경로와 PEM 형식을 확인 |

`deberopa debug local`은 `ca`를 적었거나 HTTPS인 제공자에 대해 `TLS: certificate accepted, trusted by ca.pem`과 CA의 SHA-256 지문(`AA:BB:…`)을 보여 줍니다. 서버 쪽 `opereta tls ca`가 보여 주는 지문과 비교해 같은 CA인지 확인할 수 있습니다.

**도구 호출 시험**: `deberopa debug local --check-tools`는 서버마다 모델 요청을 한 번 보내 도구 호출이 되는지 확인합니다(토큰이 소비되므로 기본은 꺼져 있습니다). 결과는 `ok`(구조화된 `tool_calls`), `recovered`(텍스트로 쓴 호출을 Deberopa가 복구해서 동작), `failed`(에이전트가 파일을 읽거나 고칠 수 없음)입니다.

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

설정 파일은 `deberopa.json` 또는 `deberopa.jsonc`(주석 허용)이며, 아래 순서로 병합됩니다(뒤가 우선).

1. 전역: Linux/macOS `~/.config/deberopa/`, Windows `%APPDATA%\deberopa\`
2. `DEBEROPA_CONFIG`가 가리키는 파일
3. 프로젝트 루트부터 현재 디렉터리까지의 `deberopa.json(c)`
4. 같은 경로의 `.deberopa/deberopa.json(c)`
5. `DEBEROPA_CONFIG_CONTENT` 환경 변수(JSON 문자열)

값 안에서 `{env:이름}`은 환경 변수로, `{file:경로}`는 파일 내용으로 치환됩니다. 편집기 자동완성용 스키마는 [`config.schema.json`](config.schema.json)입니다.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/nxodh/deberopa/main/config.schema.json",
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

데이터는 Linux/macOS에서 `~/.local/share/deberopa`, Windows에서 `%LOCALAPPDATA%\deberopa`에 저장됩니다(`XDG_*` 환경 변수를 따름). `deberopa debug paths`로 실제 경로를 확인할 수 있습니다.

## 에이전트

| 이름 | 종류 | 설명 |
|---|---|---|
| `build` | 기본 | 모든 도구를 쓰는 기본 에이전트 |
| `plan` | 기본 | 읽기 전용. 파일을 고치지 않고 계획만 세움 |
| `general` | 서브에이전트 | 여러 단계 작업을 위임받아 병렬로 처리 |
| `explore` | 서브에이전트 | 읽기 전용 코드베이스 탐색 |

직접 만들려면 `.deberopa/agent/이름.md`(또는 전역 설정 디렉터리의 `agent/`)에 둡니다. 파일 이름이 에이전트 이름이고 본문이 시스템 프롬프트입니다. `deberopa agent create`로 틀을 만들 수 있습니다.

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
| `websearch` | 웹 검색(검색어가 Exa로 전송됨, 기본값 `ask`) |
| `lsp_install` | 언어 서버 설치(기본값 `ask`) |
| `task`, `skill` | 서브에이전트, 스킬 |
| `external_directory` | 프로젝트 밖 경로 |
| `doom_loop` | 같은 도구를 같은 입력으로 3회 연속 호출 |
| `서버_도구` | MCP 도구 |

패턴은 `*` 와일드카드를 쓰며 뒤에 적은 규칙이 우선합니다. `&&`, `|`, `;`로 이어진 명령은 각각 평가합니다. 물어볼 때 "항상 허용"을 고르면 그 세션 동안 기억합니다. `deberopa run`은 물어볼 수 없으므로 `ask`를 거부하며, `--dangerously-skip-permissions`로 모두 허용할 수 있습니다.

## 도구

| 도구 | 설명 |
|---|---|
| `bash` | 셸 명령 실행. Windows에서는 Git Bash → PowerShell 7 → Windows PowerShell → cmd 순으로 선택 |
| `read` | 파일 읽기(줄 범위, 이미지·PDF 첨부) |
| `edit`, `multiedit`, `write` | 파일 수정·생성. 줄바꿈 형식(CRLF) 보존, 읽지 않은 파일은 수정 거부 |
| `patch` | `*** Begin Patch` 형식으로 여러 파일을 한 번에 생성·수정·이동·삭제(전부 적용되거나 아무것도 적용되지 않음) |
| `glob`, `grep`, `list` | 파일·내용 검색 (`.gitignore` 반영) |
| `webfetch` | 웹 페이지를 Markdown으로 가져오기 |
| `websearch` | 웹 검색([Exa](https://exa.ai) 경유). 처음 쓸 때 허락을 묻고, 검색어는 Exa로 전송됨 |
| `todowrite`, `todoread` | 작업 목록 |
| `task` | 서브에이전트에 위임 |
| `skill` | 스킬 불러오기 |

파일을 수정하면 프로젝트의 포매터(prettier, biome, gofmt, rustfmt, ruff 등)가 설치되어 있을 때 자동으로 실행되고, 설치된 언어 서버(TypeScript, gopls, pyright, rust-analyzer, clangd 등)의 오류가 에이전트에게 전달됩니다. 언어 서버가 없으면 TypeScript, Pyright, gopls, rust-analyzer, clangd, zls, ruby-lsp, lua-language-server에 대해 **설치할지 물어봅니다**(허락한 경우에만, Deberopa의 데이터 디렉터리 안에 설치하고 전역 설치는 하지 않음). `"lsp_install": false`로 끌 수 있습니다. 포매터는 자동 설치하지 않습니다.

## 커스텀 명령

`.deberopa/command/이름.md`에 두면 `/이름`으로 실행됩니다.

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

`SKILL.md`가 들어 있는 디렉터리를 `.deberopa/skill/이름/`에 두면 에이전트가 필요할 때 불러옵니다. `.claude/skills`와 `.agents/skills`(프로젝트·홈)에 있는 스킬도 그대로 인식합니다.

## MCP

```sh
deberopa mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
deberopa mcp add docs --url https://example.com/mcp --header 'Authorization: Bearer TOKEN'
deberopa mcp list
```

로컬(stdio) 서버와 원격(Streamable HTTP, 구형 SSE) 서버를 지원합니다. 도구는 `서버이름_도구이름`으로 노출됩니다. OAuth 인증이 필요한 서버는 아직 지원하지 않으며, 헤더로 토큰을 전달해야 합니다.

## 웹 검색

`websearch` 도구는 [Exa](https://exa.ai)의 호스팅 MCP 서버를 사용합니다. 키 없이도 쓸 수 있지만 무료 한도가 공유됩니다. 한도에 걸리면 [API 키](https://dashboard.exa.ai/api-keys)를 만들어 `EXA_API_KEY` 환경 변수 또는 설정의 `websearch.apiKey`에 넣으세요. 검색어가 외부(Exa)로 나가므로 처음 쓸 때 허락을 묻습니다. 끄려면 `"websearch": { "enabled": false }`.

## 프로젝트 신뢰

저장소 안의 `deberopa.json`은 "시작할 때 이 프로그램을 실행해라"(MCP·포매터·LSP·플러그인)나 "요청을 이 주소로 보내라"(프로바이더 `api`/`baseURL`/`env`/`headers`, API 키가 함께 전송됨) 같은 내용을 담을 수 있습니다. 그래서 **신뢰하지 않은 프로젝트의 이런 항목은 무시**하고, "묻지 않고 허용"하는 `permission` 규칙도 무시합니다. 나머지(모델, 에이전트, 명령 등)는 그대로 적용됩니다.

```sh
deberopa trust --status   # 무엇이 무시되고 있는지
deberopa trust            # 설정 파일을 읽어 본 뒤 이 프로젝트를 신뢰
deberopa trust --revoke
```

TUI에서는 `/trust`를 씁니다. CI에서는 `DEBEROPA_TRUST_PROJECT=1`로 체크아웃을 보증할 수 있습니다. 사용자 전역 설정과 `DEBEROPA_CONFIG_CONTENT`는 필터링하지 않습니다.

## 플러그인

플러그인은 ES 모듈 파일(`.js`, `.mjs`, `.ts`)이며, 함수를 default export하면 됩니다. 컴파일된 실행 파일에서도 Node나 Bun 없이 동작합니다.

```js
// ~/.config/deberopa/plugin/hello.js   (Windows: %APPDATA%\deberopa\plugin\hello.js)
/** @type {import("@deberopa/sdk").Plugin} */
export default async ({ directory }) => ({
  // 모델에게 주는 도구
  tool: {
    shout: {
      description: "문자열을 대문자로 바꿉니다",
      parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      execute: async ({ text }) => text.toUpperCase(),
    },
  },
  // 도구 실행 전: 인자 수정 또는 throw로 차단
  "tool.execute.before": async ({ tool }, output) => {
    if (tool === "bash" && /rm -rf/.test(output.args.command)) throw new Error("rm -rf 는 허용되지 않습니다")
  },
  // 도구 실행 후: 결과 수정
  "tool.execute.after": async ({ tool }, output) => {},
  // 시스템 프롬프트에 블록 추가
  "chat.system": async ({ agent }, output) => { output.system.push("항상 한국어로 답하세요.") },
  // 모든 이벤트(메시지, 권한 요청, 파일 수정 ...)
  event: async (event) => {},
})
```

로드 위치: 전역 설정 디렉터리의 `plugin/`, 설정의 `"plugin": ["./경로.js"]`, 그리고 **신뢰한** 프로젝트의 `.deberopa/plugin/`. 플러그인은 사용자 권한으로 실행되므로 직접 읽어 본 것만 설치하세요. `deberopa debug`에서 로드된 플러그인과 실패 원인을 볼 수 있습니다. 훅이 예외를 던져도 에이전트는 멈추지 않으며(`tool.execute.before`는 의도된 차단으로 취급), npm 패키지는 정확한 버전을 지정해 `deberopa plugin install @scope/plugin@1.2.3`으로 명시적으로 설치합니다. 설치 스크립트는 실행하지 않고 잠금 파일을 보관합니다. 설정에는 `"npm:@scope/plugin@1.2.3"`을 넣으며, 시작할 때 자동 설치하지 않습니다. 패키지는 Deberopa 플러그인 형식의 default export를 제공해야 합니다.

## SDK

[`sdk/js`](sdk/js)의 `@deberopa/sdk`는 HTTP API용 의존성 없는 TypeScript 클라이언트입니다(npm에는 아직 게시하지 않았습니다).

```ts
import { startServer, messageText } from "@deberopa/sdk"

const { client, close } = await startServer({ cwd: "/path/to/project" }) // `deberopa serve`를 띄움
const session = await client.session.create({ title: "demo" })
const reply = await client.session.prompt(session.id, { text: "README.md를 요약해줘" })
console.log(messageText(reply))
for await (const event of client.event.subscribe()) { /* message.part.updated, permission.asked ... */ }
await close()
```

## 에디터 연동

**ACP (Zed 등)**: `deberopa acp`는 [Agent Client Protocol](https://agentclientprotocol.com) 서버로 stdin/stdout에서 동작합니다. 스트리밍 응답, 도구 호출 표시, 권한 요청(허용/항상 허용/거부), 취소, 세션 불러오기, build/plan 모드 전환을 지원합니다. Zed 설정 예:

```json
{ "agent_servers": { "Deberopa": { "command": "deberopa", "args": ["acp"] } } }
```

한 `deberopa acp` 프로세스는 하나의 프로젝트 디렉터리만 다룹니다. 모델은 설정의 `model`을 따릅니다.

**VS Code**: [`ide/vscode`](ide/vscode)의 확장은 편집기 옆 터미널에서 Deberopa를 열고, 선택 영역을 `@경로#L10-20`으로 프롬프트에 넣어 줍니다(`Ctrl+Alt+V` 열기, `Ctrl+Alt+K` 선택 영역 추가). 릴리스 페이지의 `.vsix`를 `code --install-extension deberopa-vscode-<버전>.vsix`로 설치합니다.

프롬프트에서 `@파일#L10-20`처럼 줄 범위를 지정하면 그 줄만 첨부됩니다.

## Git과 GitHub

**상태 표시줄**: git 저장소에서는 하단에 `⎇ 브랜치 · N changed · ↑앞섬 ↓뒤처짐`이 표시됩니다. 턴이 끝날 때, 파일이 수정될 때, 그리고 20초마다 갱신되며 읽기 전용으로 동작합니다(`GIT_OPTIONAL_LOCKS=0`이라 사용자의 git과 잠금이 충돌하지 않습니다).

**되돌리기(`/undo`)의 범위**: 에이전트는 각 단계 전에 작업 트리를 Deberopa 전용 저장소에 기록하며 사용자의 `.git`(HEAD, 인덱스, ref, stash)은 건드리지 않습니다. 다음 경우 파일은 복원되지 않으며, 그때는 화면에 이유가 표시됩니다.

- git 저장소가 아니거나, `git`이 없거나, `"snapshot": false`인 경우: 대화만 되돌려집니다(첫 수정 때 한 번, `/undo`할 때 한 번 알려 줍니다).
- `.gitignore`에 걸린 파일(`.env`, 빌드 산출물 등): 해당 파일을 수정하면 한 번 알려 줍니다.
- 되돌리기는 파일을 그 시점의 내용으로 통째로 복원하므로, 그 사이에 직접 고친 내용은 사라집니다.

**커밋과 PR**: 요청하지 않으면 커밋·푸시·브랜치 생성을 하지 않습니다. 요청하면 `git status`/`git diff`/`git log`로 저장소의 메시지 스타일을 확인하고, 파일을 골라 스테이징하며(비밀·로컬 설정 제외), 훅을 건너뛰지 않고(`--no-verify` 금지), PR은 `gh pr create`로 만들고 URL을 알려 줍니다.

**PR 리뷰·작업: `deberopa pr`**

```sh
deberopa pr 123                       # PR을 체크아웃하고 읽기 전용(plan)으로 리뷰
deberopa pr https://github.com/owner/repo/pull/123
deberopa pr 123 "실패하는 테스트를 고쳐줘"   # 메시지를 주면 build 에이전트로 작업
deberopa pr 123 --no-ui > review.md   # UI 없이 결과만 출력
```

[GitHub CLI(`gh`)](https://cli.github.com)가 설치되어 있고 `gh auth login`이 되어 있어야 합니다. 포크에서 온 PR도 `gh`가 처리합니다. 커밋하지 않은 변경이 있으면 작업을 보호하기 위해 체크아웃을 거부합니다(`--force`로 무시). 작성자가 쓴 PR 설명은 신뢰할 수 없는 텍스트로 표시해 모델에 전달합니다. 다른 저장소의 URL을 주면 그 저장소의 클론 안에서 실행하라고 안내합니다. `/review 123`(TUI)도 PR 번호를 받습니다.

## GitHub Action

```yaml
- uses: nxodh/deberopa@v0.3.0
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    model: anthropic/claude-sonnet-5-5
    agent: plan            # 읽기 전용
    prompt: 이 변경을 리뷰해줘
```

출력 `response`에 최종 답변이 들어갑니다. 입력은 `prompt`, `model`, `agent`, `version`, `working-directory`, `config`(JSON), `allow-all`이며, 변경 사항을 올리는 옵션도 있습니다.

| 입력 | 설명 |
|---|---|
| `commit` | 에이전트가 바꾼 파일을 새 브랜치에 커밋하고 푸시(`contents: write` 필요). 바뀐 것이 없으면 아무것도 하지 않음 |
| `branch` | 브랜치 이름(기본 `deberopa/<run id>-<시도>`) |
| `commit-message` | 커밋 메시지(커밋은 `github-actions[bot]` 이름으로 생성) |
| `pull-request` | 그 브랜치로 PR 생성(`pull-requests: write` 필요, `commit` 포함) |
| `pr-title`, `pr-base` | PR 제목, 기준 브랜치(기본: 워크플로가 도는 브랜치) |
| `github-token` | 푸시와 PR에 쓸 토큰(기본 `github.token`) |

추가 출력: `changed`(`true`/`false`), `branch`, `commit`, `pull-request-url`. 에이전트가 실패하면(0이 아닌 종료 코드) 커밋하지 않습니다.

```yaml
permissions: { contents: write, pull-requests: write }
steps:
  - uses: actions/checkout@v4
  - uses: nxodh/deberopa@v0.3.0
    env: { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }
    with:
      prompt: 의존성 경고를 고쳐줘
      pull-request: "true"
      pr-title: "chore: fix dependency warnings"
```

PR 리뷰와 `/deberopa` 댓글 응답 예시는 [`examples/github`](examples/github)에 있습니다.

> **주의**: 에이전트는 워크플로 권한으로 명령을 실행할 수 있고, 이슈·PR 본문은 신뢰할 수 없는 입력(프롬프트 인젝션)입니다. 신뢰하는 사용자의 트리거에만 반응하게 하고, `permissions`를 최소로 하며, 읽기만 필요하면 `config: '{"permission":{"bash":"deny","edit":"deny"}}'`로 막으세요.

## CLI

| 명령 | 설명 |
|---|---|
| `deberopa [프로젝트]` | 터미널 UI (`-c` 마지막 세션, `-s <id>`, `-m <모델>`, `--agent`, `-p <프롬프트>`) |
| `deberopa run [메시지..]` | 비대화형 실행 (`--format json`, `-f <파일>`, `--command <이름>`) |
| `deberopa auth login\|list\|logout` | 자격 증명 관리 |
| `deberopa models [제공자]` | 모델 목록 (`--refresh`, `--all`, `-v`) |
| `deberopa agent list\|create` | 에이전트 목록·생성 |
| `deberopa session list\|delete` | 세션 관리 |
| `deberopa export [id]`, `import <파일>` | 세션 내보내기(JSON·Markdown)·가져오기 |
| `deberopa mcp list\|add\|remove` | MCP 서버 관리 |
| `deberopa stats` | 토큰 사용량·비용 |
| `deberopa serve` | HTTP API 서버 |
| `deberopa acp` | ACP 서버(에디터용) |
| `deberopa pr <번호\|URL> [메시지..]` | GitHub PR 체크아웃 후 리뷰·작업 (`--no-ui`, `--agent`, `--force`) |
| `deberopa trust [경로]` | 프로젝트 설정 신뢰 (`--status`, `--revoke`, `--list`) |
| `deberopa upgrade [버전]` | 업데이트 (`--check`) |
| `deberopa uninstall` | 제거 (`--dry-run`, `--keep-config`, `--keep-data`) |
| `deberopa local [servers\|check\|pull\|status]` | 로컬 모델 서버 확인, 도구 호출 점검, Ollama 모델 내려받기, 모델 사용 방식 |
| `deberopa debug [config\|local]` | 경로·설정·제공자·도구 상태, 로컬 모델 서버 진단 |

각 명령에 `--help`를 붙이면 옵션과 예시가 나옵니다.

## HTTP 서버

`deberopa serve`는 기본적으로 `127.0.0.1:4096`에서 JSON API를 엽니다. `DEBEROPA_SERVER_PASSWORD`를 설정하면 HTTP Basic 인증(사용자 이름은 아무 값)이 필요합니다. 이 서버는 사용자 권한으로 명령을 실행할 수 있으므로, 암호 없이 외부 인터페이스에 열지 마세요.

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
| `GET /local`, `POST /local/toolcheck`, `GET /local/slots?provider=`, `POST /local/pull` | 로컬 서버 감지, 도구 호출 점검, 슬롯 사용량, Ollama 모델 내려받기 |
| `GET\|PUT\|DELETE /auth`, `GET\|POST\|DELETE /trust`, `GET /skill`, `GET /stats` | 자격 증명(키는 반환하지 않음), 프로젝트 신뢰, 스킬, 사용량 |

## 0.1.2에 추가된 기능

0.1.1 사용자는 `deberopa upgrade`로 업데이트할 수 있습니다. 다음 기능은 0.1.2부터 지원합니다.

### 키 바인딩

사용자 설정 또는 신뢰한 프로젝트의 `deberopa.json`에서 지정합니다. 쉼표는 대체 키를 뜻하며 `none`은 해당 동작을 끕니다. 사용자 지정 키는 충돌하는 기본 키보다 우선합니다. 변경 후 재시작하면 적용되며 `/help`에 설정된 키가 표시됩니다.

```json
{
  "keybinds": {
    "submit": "ctrl+g",
    "newline": "enter,alt+enter",
    "models": "ctrl+p",
    "sessions": "ctrl+o"
  }
}
```

편집 동작: `up`, `down`, `left`, `right`, `word_left`, `word_right`, `line_start`, `line_end`, `backspace`, `delete`, `delete_word`, `delete_line_start`, `delete_line_end`. 화면 동작: `submit`, `newline`, `interrupt`, `clear_exit`, `quit`, `agent_next`, `models`, `sessions`, `new_session`, `help`, `editor`. 특수 키는 enter/escape/tab/backspace/delete/방향키/home/end를 지원하며 ctrl/alt/shift를 조합할 수 있습니다. 대화상자의 선택 키는 기존 기본값을 사용합니다.

### npm 플러그인·SDK

- `deberopa plugin install <이름@정확한버전>`: 검토한 패키지를 명시적으로 설치하고 활성화합니다. 비대화형 설치에는 `--yes`가 필요합니다. URL·Git·파일·버전 범위는 허용하지 않습니다.
- `deberopa plugin list`, `deberopa plugin remove <이름@버전>`: 상태 확인과 비활성화. 플러그인은 사용자 권한으로 실행되므로 패키지의 코드를 먼저 검토하세요. 제거는 캐시를 지우지 않습니다.
- [Python SDK](sdk/python/README.md): Python 3.10+, HTTP API·이벤트·권한·서버 실행. `python -m pip install ./sdk/python`으로 체크아웃에서 설치합니다.
- [Go SDK](sdk/go/README.md): Go 1.22+, HTTP API·이벤트·권한. 외부 런타임 의존성이 없습니다.
- Python SDK는 PyPI에 게시하지 않았고 Go SDK는 별도 모듈 태그가 없습니다. JavaScript SDK도 현재 npm 미게시 상태입니다.

### 추가 언어 서버·Alpine

언어 서버 설치는 프로젝트를 신뢰하고 해당 설치를 승인한 뒤에만 이루어집니다. clangd·ZLS·LuaLS는 공식 GitHub 배포본의 SHA-256을 검증하며 라이선스와 보조 파일도 유지합니다. 검증 가능한 체크섬이 없는 배포본은 거부합니다. clangd의 공식 Linux/Windows arm64 배포본이 없으면 시스템 패키지 설치를 안내합니다. ZLS는 설치된 안정 Zig의 major/minor 버전에 맞춰 다운로드합니다. Ruby LSP는 Ruby·RubyGems가 필요하며 의존성 설치 중 네이티브 코드를 빌드할 수 있습니다. LuaLS·clangd의 공식 Linux 바이너리가 glibc를 요구하는 Alpine 환경에서는 시스템 패키지를 사용하세요.

musl용 x64·arm64 실행파일, 설치기의 libc 감지, 자체 업데이트가 추가됐습니다. Alpine에는 `libstdc++`·`libgcc`가 필요합니다. 시스템 패키지를 몰래 설치하지 않습니다.

### 세션 공유

`/share [파일.html]` 또는 `deberopa share [id] -o session.html`은 실행 가능한 HTML을 이스케이프한 읽기 전용 대화 파일을 만듭니다. 도구 출력·추론·첨부 내용은 제외하며 알려진 비밀 값을 가립니다. 자동 가리기만 믿지 말고 개인적인 대화 내용을 직접 검토한 뒤 공유하세요.

```sh
deberopa share ses_example -o session.html
# 파일을 검토한 뒤 로컬 임시 링크를 만들기
deberopa share ses_example --serve --yes --ttl 3600
```

뷰어는 에이전트 API와 별개이며 읽기만 제공합니다. 주소는 loopback으로 제한하고 1시간 후 종료되며 Ctrl+C로 즉시 중단할 수 있습니다. 링크를 아는 사람은 읽을 수 있습니다. 다른 기기의 접근은 별도로 구성한 HTTPS 역방향 프록시가 필요합니다. 평문 HTTP로 대화를 네트워크에 직접 공개하는 기능은 제공하지 않습니다. 외부 호스팅 서비스로 자동 업로드하지 않습니다.

### 신뢰·인증

신뢰하지 않은 프로젝트의 명령·에이전트 Markdown, 환경변수·파일 치환, 자동 포매터·LSP 실행은 적용하지 않습니다. 셸 치환은 세션의 권한 규칙을 거칩니다. 네트워크에 공개하는 에이전트 API는 암호가 필수이며 SDK의 원격 연결은 HTTPS를 요구합니다. 구독 OAuth·MCP OAuth의 보류 근거는 [인증 정책 검토](docs/oauth-policy.md)를 참고하세요.

## OpenCode와의 차이

구조와 사용법은 OpenCode를 따랐습니다. 아직 **없는** 기능은 다음과 같습니다.

- 중앙 호스팅 세션 공유: HTML 파일과 만료되는 자가 호스팅 뷰어는 제공하지만 중앙 업로드 서비스는 없습니다.
- 구독 계정 OAuth 로그인: API 키만 지원합니다(의도적으로 구현하지 않았습니다).
- Amazon Bedrock, Google Vertex AI, Azure 전용 인증
- MCP OAuth: 연결 대상의 이용 조건·클라이언트 등록 허용 여부를 확인하기 전에는 보수적으로 제외합니다.

## 개발

Node.js 22 이상이 필요합니다. Bun은 개발 의존성으로 설치되므로 따로 설치하지 않아도 됩니다.

```sh
npm ci
npx bun run src/index.ts            # 소스에서 실행
npx tsc --noEmit                    # 타입 검사
npx bun test                        # 테스트
npx bun run script/build.ts         # 현재 플랫폼용 실행 파일 → dist/
npx bun run script/build.ts --all   # 모든 플랫폼 + 체크섬
npx bun run script/smoke.ts dist/<플랫폼>/deberopa   # 실행 파일 스모크 테스트
python3 script/tui-pty.py           # 가짜 모델로 터미널 UI 확인 (POSIX)
```

릴리스는 `package.json`의 버전과 같은 `v*` 태그를 푸시하면 GitHub Actions가 빌드해 게시합니다(실행 파일, 체크섬, VS Code `.vsix`).

## 라이선스

[MIT](LICENSE)
