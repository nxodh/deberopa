# 개발 상태와 검증 범위

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

## 0.1.4 (개발 중): Diparnux 호환과 동시 요청 상한

설계서 `vedecaps-repo-changes-design.md`의 VE1·VE4(PR A)와 VE3(PR B)를 구현합니다.
VE2(`options.ca`)는 Diparnux의 TLS가 나올 때까지 미룹니다.

**PR A (VE1 + VE4)**: 키가 필요한 서버 감지(`DIPARNUX_API_KEY`, `LLAMA_API_KEY`), 401/403 보고,
Diparnux 표식과 `/diparnux/info` 인식(값 검증, 제어 문자 제거), 구성된 로컬 제공자의 컨텍스트
보강, `debug local`의 슬롯 정보와 `--check-tools`. 호스팅 주소에는 요청하지 않고 리다이렉트는
오류로 처리합니다. 모의 서버로 시험 23개를 추가했습니다(T1.1~T1.11, T4.1~T4.7).
