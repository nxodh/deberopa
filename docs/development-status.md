# 개발 상태와 검증 범위

## 목표

Deberopa(CLI와 Deberopa Desktop 모두)의 큰 목표는 **코딩 에이전트로서 로컬 LLM의 사용성을 극대화**하는 것입니다. 클라우드 모델도 지원하지만 로컬 모델 쪽 기능과 편의성이 우선입니다. 개발 중인 버전의 로컬 우선 항목: 로컬 서버 감지와 시작 안내, 도구 호출 점검(Ollama 네이티브 포함), Ollama 모델 내려받기, 짧은 프롬프트·텍스트 도구 호출 복구 상태 표시, 토큰 속도와 슬롯 사용량. 세부는 `CHANGELOG.md`의 Unreleased 절과 `docs/desktop-design.md`를 참고하세요.

2026-10-14에 준비한 0.1.2 릴리스의 구현 및 로컬 검증 기록입니다. 변경 전 기준
커밋은 `85f5876`입니다. 최종 원격 CI 및 배포 결과는 저장소의 Actions와 Releases에서
확인할 수 있습니다.

## 구현

| 항목 | 현재 상태 | 주요 코드 |
| --- | --- | --- |
| 보안 강화 | 프로젝트 신뢰, 셸 실행 권한, 경로·심볼릭 링크, 서버 인증·출처·본문 크기, 비밀정보 출력, 리다이렉트, 세션 가져오기·스냅샷 경계 수정 | `src/config/trust.ts`, `src/server/server.ts`, `src/tool/`, `src/session/export.ts` |
| 자동 실행 | 신뢰하지 않은 프로젝트의 Markdown 명령·에이전트, 포매터·LSP 실행 차단. 자동 Git 조회의 fsmonitor 실행 차단. 계획·탐색 에이전트의 셸 명령도 승인 필요 | `src/agent/agent.ts`, `src/command/command.ts`, `src/git/git.ts` |
| 키 바인딩 | 프롬프트 입력·편집·모델·세션 등의 키 변경, 충돌하는 기본 키보다 사용자 설정 우선, 도움말·하단 안내 반영 | `src/tui/keybinds.ts`, `src/tui/prompt.tsx` |
| npm 플러그인 | 정확한 버전으로 명시적 설치·활성화·비활성화, 설치 스크립트 차단, 잠금 파일 유지. 시작 시 자동 설치 없음 | `src/plugin/package.ts`, `src/cli/commands/plugin.ts` |
| SDK | 기존 JS에 Python 3.10+와 Go 1.22+ 추가. HTTP API·SSE·권한 응답, 인증 및 원격 HTTPS. Python은 서버 실행 도우미 포함 | `sdk/js`, `sdk/python`, `sdk/go` |
| LSP 설치 | clangd, ZLS, Ruby LSP, LuaLS 추가. 공식 바이너리의 SHA-256 확인, 안전한 압축 해제, 사용자 동의와 필요한 도구 확인 | `src/lsp/download.ts`, `src/lsp/install.ts` |
| Linux musl | x64·arm64 빌드, 설치기·업데이트 libc 감지, Alpine CI 추가 | `script/build.ts`, `install.sh`, `src/update/update.ts` |
| 세션 공유 | 읽기 전용 HTML과 만료되는 loopback 뷰어. 도구 출력·추론·첨부 본문 제외. 외부 접근은 별도로 구성한 HTTPS 프록시 필요 | `src/session/share.ts`, `src/cli/commands/share.ts` |
| 압축 오류 | 출력 한도가 작은 컨텍스트를 모두 차지할 때 매 턴 압축하던 문제 수정 | `src/session/compaction.ts` |

## 인증 범위

Bedrock·Vertex·Azure는 요청에 따라 제외했습니다. MCP OAuth와 구독 계정 OAuth는
구현하지 않았습니다. 공식 문서가 제공하는 경로와 금지 사항을 구분하고,
대상 서비스의 허용 범위 및 완전한 안전 구현이 확인되지 않은 상태에서
진행하지 않기로 했습니다. [검토 근거와 공식 출처](oauth-policy.md)를 참고하세요.

## 검증

- TypeScript 본체·JS SDK·VS Code 확장 타입 검사 및 VSIX 패키징 통과.
- Bun 테스트 292개, 34개 파일, 1,825개 assertion 통과.
- Go SDK 테스트와 Python의 실제 HTTP API·인증·SSE 통합 검사 통과.
- 7개 배포 대상 빌드와 체크섬 생성 통과: macOS x64/arm64, Windows x64,
  Linux glibc x64/arm64, Linux musl x64/arm64.
- macOS arm64, Debian 13 arm64, Alpine arm64에서 바이너리 실행·도구 호출·
  설치된 npm 플러그인·HTTP 서버·체크섬 업데이트·변조 다운로드 거부 검사 통과.
- 터미널 PTY에서 기본 입력 및 `ctrl+g`로 변경한 제출 키 검사 통과.
- 실제 Ollama `qwen3:0.6b`에서 두 턴 대화와 불필요한 압축이 없음을 확인.
- 실제 LuaLS 3.19.2의 체크섬 설치와 실행 확인.
- Alpine의 설치기 및 반복 설치 확인. CI workflow 검사와 설치기 셸 검사 통과.
- 본체와 VS Code 확장의 npm audit 취약점 0건. 신규 파일을 포함한 비밀정보 검사 통과.

확장 패키징 도구의 `braces` 의존성에 대한
[공식 보안 권고](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)를 확인했습니다.
패치된 braces 릴리스가 없어 해당 의존성 경로를 사용하지 않는 `@vscode/vsce` 4로
갱신했고, 별도 잠금 파일에서도 고위험 경로 6개가 제거됐음을 재검사했습니다.
확장 빌드 도구에는 Node.js 22 이상이 필요하며 기존 CI 설정이 이를 충족합니다.

## 남은 배포·검증 범위

Windows 실행 및 x64 Linux 실행은 이번 로컬 환경에서 직접 검증하지 않았습니다.
해당 검사는 CI에 포함되며 성공한 CI 커밋만 릴리스하도록 검사합니다.
clangd·ZLS·Ruby LSP의 모든 운영체제 조합을 실제 설치해 검증한 것은 아닙니다.
공식 자산 선택·압축 경계와 설치 동의는 테스트했고, LuaLS는 실제 설치했습니다.

Alpine에는 `libstdc++`와 `libgcc`가 필요합니다. glibc 전용 clangd·LuaLS 공식
배포본은 Alpine에서 자동 설치하지 않으며 시스템 패키지를 안내합니다.
ZLS는 설치된 안정 Zig 버전과 맞아야 하고 Ruby LSP는 Ruby·RubyGems 및
필요한 네이티브 빌드 도구가 있어야 합니다.

SDK는 레지스트리에 게시하지 않았고 Go SDK의 별도 모듈 태그도 없습니다.
플러그인은 사용자 권한으로 실행되므로 설치 전 패키지 코드 검토가 필요합니다.
공유 파일의 자동 가리기는 모든 개인 정보를 판별하지 못하므로 배포 전 대화를
직접 검토해야 합니다. 검증 결과는 이 범위의 근거이며 알려지지 않은 취약점이나
모든 서비스의 법적 적합성이 없음을 보증하는 의미는 아닙니다.

## 0.1.3: 전체 화면 터미널 UI

`feat/fullscreen-tui` 브랜치의 `d87ebe4`를 main에 병합했습니다. 입력창·상태줄을
고정하고, 대화를 PageUp/PageDown 및 Ctrl+Home/End로 스크롤합니다. 창 크기 변경,
한글 입력 커서, 긴 응답, 새 세션, 작은 창의 도움말·권한 확인창, 외부 편집기 복귀,
정상 종료 및 종료 신호의 화면 복원을 PTY 화면 에뮬레이터로 검사했습니다.

브랜치 검증에서는 테스트 293개와 Windows·Ubuntu·Debian·Alpine 실행파일, SDK 및
확장의 전체 CI가 통과했습니다. 릴리스는 버전을 0.1.3으로 맞춘 main 커밋의 CI가
성공한 뒤 생성하도록 검사합니다. 0.1.2 이전 구현 범위는 위 기록을 참고하세요.

## 0.1.4: Opereta 호환과 동시 요청 상한

Opereta 저장소의 저장소 변경 설계서의 VE1·VE4(PR A)와 VE3(PR B)를 구현합니다.
VE2(`options.ca`)는 Opereta의 TLS가 나올 때까지 미뤘고 0.1.5에서 구현했습니다.

**PR A (VE1 + VE4)**: 키가 필요한 서버 감지(`OPERETA_API_KEY`, `LLAMA_API_KEY`), 401/403 보고,
Opereta 표식과 `/opereta/info` 인식(값 검증, 제어 문자 제거), 구성된 로컬 제공자의 컨텍스트
보강, `debug local`의 슬롯 정보와 `--check-tools`. 호스팅 주소에는 요청하지 않고 리다이렉트는
오류로 처리합니다. 모의 서버로 시험 23개를 추가했습니다(T1.1~T1.11, T4.1~T4.7).

**PR B (VE3)**: `provider.<id>.options.max_concurrency`와 Opereta 슬롯 수 자동값. 우선순위가 있는
세마포어(`src/provider/limiter.ts`)를 `streamModel` 앞에 두며 취소, 오류, 소비자의 조기 종료에서
자리를 반납합니다. 시험 22개(T3.1~T3.10, 수용 기준 4.7과 상한이 없을 때 429가 나는 대조군)를
추가했습니다. `max_concurrency: 1`에서 서브에이전트 2개를 부르는 세션이 끝까지 가는 것을 확인했습니다.

선택 사항이던 대기 중 상태 표시(TUI)는 넣지 않았습니다. `deberopa debug`의 제공자 줄에 상한과
그 출처가 표시됩니다.

릴리스는 PR #1을 병합한 main 커밋의 전체 CI(Windows·Ubuntu·Debian·Alpine 실행파일, SDK, 확장)가
성공한 뒤 만들도록 검사합니다. 실제 llama.cpp 서버(`--jinja`, `--api-key`)로 감지, 401 안내,
도구 호출 시험, 키 기반 실행을 확인했으나 실제 Opereta 서버는 확인하지 못했습니다(Opereta 쪽
CI의 범위).

## 0.1.5: 사설 CA(`options.ca`)

Opereta 저장소의 0.5.4 인계 문서 §3의 VE2를 구현합니다. 제공자의 `options.ca`(PEM 경로,
경로 목록, PEM 본문)를 제공자를 만들 때 읽어 `ProviderInfo.tls`로 두고, 채팅 요청(OpenAI·Ollama·
Anthropic 경로), 모델 목록, `/opereta/info`, 도구 호출 시험의 모든 `fetch`에 전달합니다.
파일 문제는 제공자를 사용 불가로 만들며 시스템 저장소로 돌아가지 않습니다. 인증서 검증을 끄는
옵션은 없고, 신뢰하지 않는 프로젝트의 `ca`는 `stripUntrusted`가 제거합니다.

Bun 1.4.3(macOS arm64)에서 측정한 사실: `tls.ca`는 시스템 저장소를 **대체**합니다. 오류 코드는
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`(알 수 없는 CA), `ERR_TLS_CERT_ALTNAME_INVALID`(이름 불일치),
`CERT_HAS_EXPIRED`(만료), `DEPTH_ZERO_SELF_SIGNED_CERT`, `PERMITTED_VIOLATION`(이름 제한 위반),
`UNSUPPORTED_CONSTRAINT_TYPE`(CA에 IP 이름 제한이 있고 리프에 IP SAN이 있을 때)입니다. DNS 이름
제한만 있는 CA는 IP SAN이 있는 리프도 검증합니다. 시험은 `test/tls.test.ts`(TC1~TC13, 일회용
인증서는 `test/fixtures/tls/`)입니다.

**범위**: 실제 Opereta 서버의 HTTPS 시험은 Opereta 쪽 CI의 몫입니다. 여기서는 Bun.serve의 `tls`로
같은 계약(별도 포트의 HTTPS, 리다이렉트 없음, 같은 `/opereta/info`와 키 규칙)을 모의해 확인했습니다.

## 0.2.0: Deberopa 이름 변경과 Opereta 인식

Opereta 저장소의 `deberopa-agent-handoff-0.6.1.md`를 따릅니다. 제품 이름을 Vedecaps에서 Deberopa로
바꾸고(실행 파일, 설정, 환경 변수, 릴리스 자산, SDK·Action·확장, 로고), 모델 서버 OS를 새 이름의
정보 주소(`/opereta/info`)와 응답 헤더(`X-Opereta`), 키 변수(`OPERETA_API_KEY`), 안내 명령으로 알아봅니다.
이전 OS 이름을 알아보는 코드는 남기지 않았습니다.

결정(사용자가 정하지 않은 것은 문서의 기본안으로 진행): D1 버전 0.2.0, D2 저장소 이름은 릴리스 전에
사용자가 바꿀 것(코드는 새 이름 `nxodh/deberopa`를 가리킴), D3 중간 릴리스 없음, D4 설정 폴더 이전(복사),
D5 `VEDECAPS_*`를 이번 릴리스까지 읽음. 이전은 설정 외에 로그인, 세션, 상태도 한 번 복사합니다(문서의 D4보다
넓은 범위이며, 옛 폴더는 건드리지 않습니다).

예외로 옛 이름이 남은 곳: `CHANGELOG.md`의 이전 버전 항목, 이전 코드(`src/legacy.ts`)와 그 시험
(`test/rename.test.ts`).

**범위**: 실제 Opereta 서버와 GPU 서버로는 확인하지 못했습니다(Opereta의 호환 시험 몫).

