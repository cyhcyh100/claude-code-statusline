# statusline 플러그인 내부 문서

이 디렉터리는 `claude-code-statusline` 마켓플레이스에 포함되는 실제 플러그인 루트입니다. 설치와 사용법은 저장소의 [메인 README](../../README.md)를 먼저 참고하세요. 이 문서는 유지보수에 필요한 설치 흐름, 런타임 구조, 캐시와 로컬 검증 방법을 설명합니다.

## 빠른 설치

Claude Code 안에서 다음 명령을 실행한 뒤 새 세션을 시작합니다.

```text
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

플러그인의 `SessionStart` 훅이 실행되어야 사용자 `statusLine.command`가 등록되므로 최초 설치 후에는 Claude Code를 한 번 재시작하는 것이 가장 확실합니다.

## 디렉터리 구조

```text
plugins/statusline/
├── .claude-plugin/plugin.json  # 플러그인 이름, 버전, 작성자
├── hooks/hooks.json            # SessionStart 설치 훅
├── scripts/
│   ├── install.mjs             # 사용자 설정과 wrapper 설치
│   └── bootstrap.mjs           # 최신 캐시 버전 탐색·실행
├── statusline/
│   ├── find-node.sh            # Node.js 실행 파일 탐색
│   ├── index.mjs               # 렌더러 진입점
│   └── lib/                    # Git, PR, 사용량, transcript, layout 모듈
├── test-fixtures/              # 결정적인 입력·응답 fixture
└── tests/                      # node:test 단위 테스트
```

런타임 의존성은 Node.js 표준 라이브러리뿐이며 `npm install` 과정이나 `package.json`이 없습니다.

## 설치 흐름

Claude Code는 마켓플레이스 플러그인을 `~/.claude/plugins/cache/` 아래에 복사합니다. 이 플러그인은 manifest만으로 기본 status line을 등록하지 않고 다음 흐름을 사용합니다.

1. `hooks/hooks.json`의 `SessionStart` 훅이 `scripts/install.mjs`를 실행합니다.
2. 설치기는 `bootstrap.mjs`와 `find-node.sh`를 `<CLAUDE_CONFIG_DIR>/claude-code-statusline/`에 복사합니다.
3. 사용자 `settings.json`의 `statusLine.command`를 복사된 wrapper를 실행하도록 변경합니다.
4. wrapper는 렌더링할 때마다 `<CLAUDE_CONFIG_DIR>/plugins/cache/claude-code-statusline/statusline/`을 스캔하고 가장 높은 SemVer 버전의 `statusline/index.mjs`를 import합니다.

설치기는 플러그인 버전과 설치 파일을 확인하는 방식으로 멱등성을 유지합니다. 기존 `statusLine`이 이 플러그인의 것이 아니라면 `_statusLineBackup`에 보관합니다. 잘못된 JSON인 `settings.json`은 덮어쓰지 않습니다.

## 렌더링 흐름

`statusline/index.mjs`는 Claude Code가 stdin으로 전달한 JSON을 읽고 최대 8줄을 출력합니다.

1. `cwd`를 기준으로 기본 Git 모드 또는 멀티 저장소 모드를 선택합니다.
2. Git 브랜치와 PR을 조회합니다.
3. Claude OAuth 사용량을 조회합니다.
4. transcript 마지막 64 KiB에서 thinking, todo, skill, 백그라운드 작업을 추출합니다.
5. ANSI 색상과 OSC 8 링크를 적용하고 설정된 폭에 맞춰 줄을 자릅니다.

각 데이터 소스의 실패는 출력 전체의 실패로 전파하지 않습니다. 최상위 렌더러도 예외를 삼켜 Claude Code UI에 오류 텍스트나 stack trace를 출력하지 않습니다.

### 멀티 저장소 판정

- 현재 `cwd`가 Git 저장소면 기본 모드를 사용합니다.
- 현재 `cwd`는 저장소가 아니고 직속 하위 Git 저장소가 2개 이상이면 fleet 요약을 표시합니다.
- 직속 하위 저장소가 1개면 부모 경로와 자식 저장소의 브랜치를 기본 형식으로 표시합니다.
- `.git` 디렉터리뿐 아니라 submodule·worktree의 `.git` 포인터 파일도 인식합니다.
- `STATUSLINE_MULTI_REPO=0`이면 이 판정을 건너뜁니다.

멀티 저장소의 dirty/ahead/behind 정보는 각 저장소에 대해 `git status --porcelain=v2 --branch`를 병렬 실행해 계산합니다. PR은 GitHub `origin`을 해석할 수 있는 저장소만 모아 한 번의 `gh api graphql` 호출로 조회합니다.

## 외부 데이터와 캐시

기본 캐시 위치는 `~/.claude/claude-code-statusline/cache/`이며 `CLAUDE_CONFIG_DIR`을 설정하면 그 아래로 이동합니다.

| 데이터 | 캐시 파일 | 정상 TTL | 실패 시 동작 |
| --- | --- | --- | --- |
| 5시간·주간 사용량 | `usage.json` | 90초 | 인증 15초, 네트워크 2분 후 재시도 |
| 기본 모드 PR | `pr-<hash>.json` | 60초 | `gh` 사용 불가 시 5분 숨김 |
| 멀티 저장소 목록 | `parent-repos-<hash>.json` | 부모 디렉터리 mtime 기준 | 읽기 실패 시 멀티 모드 생략 |
| 저장소 dirty 상태 | `repo-status-<hash>.json` | 5초 | stale 값을 사용하며 백그라운드 갱신 |
| 멀티 저장소 PR | `parent-prs-<hash>.json` | 60초 | 조회 실패 시 5분 숨김 |

캐시는 삭제해도 다음 렌더링에서 다시 생성됩니다. OAuth access/refresh token과 transcript 본문은 캐시에 기록하지 않습니다.

## 환경 변수

| 변수 | 용도 |
| --- | --- |
| `STATUSLINE_WIDTH` | 렌더링 폭 강제 지정. 없으면 `COLUMNS`, 그마저 없으면 80열 |
| `STATUSLINE_MULTI_REPO=0` | 멀티 저장소 모드 비활성화 |
| `STATUSLINE_DEBUG=1` | 설치기와 wrapper가 삼킨 예외를 stderr로 출력 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` 대신 사용할 Claude 설정 루트 |
| `STATUSLINE_MULTI_REPO_FORCE_FIXTURE` | 테스트에서만 사용하는 GraphQL 응답 fixture 경로 |

마지막 변수는 개발·테스트 전용이므로 사용자 설정에 넣지 않습니다.

## 로컬 개발

### 마켓플레이스 설치

Claude Code 안에서 저장소의 절대 경로를 추가합니다.

```text
/plugin marketplace add /absolute/path/to/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

로컬 마켓플레이스는 자동 업데이트되지 않습니다. 새 캐시 버전을 만들려면 `.claude-plugin/plugin.json`의 버전을 변경한 후 플러그인을 다시 설치해야 합니다. 버전 변경 정책은 [CONTRIBUTING.md](../../CONTRIBUTING.md)를 따릅니다.

일회성 개발 세션에서는 Claude Code의 `--plugin-dir` 방식도 사용할 수 있습니다. 자세한 내용은 공식 [Plugins reference](https://code.claude.com/docs/en/plugins-reference)를 참고하세요.

### 직접 렌더링

```sh
node plugins/statusline/statusline/index.mjs \
  < plugins/statusline/test-fixtures/stdin-basic.json

node plugins/statusline/statusline/index.mjs \
  < plugins/statusline/test-fixtures/stdin-with-transcript.json
```

설치된 wrapper까지 확인하려면 stdin JSON을 전달합니다.

```sh
printf '%s' '{"cwd":"/tmp","model":{"display_name":"Test"}}' \
  | STATUSLINE_DEBUG=1 sh ~/.claude/claude-code-statusline/find-node.sh \
      ~/.claude/claude-code-statusline/bootstrap.mjs
```

### 전체 검증

저장소 루트에서 다음 명령 하나를 사용합니다.

```sh
bash scripts/verify.sh
```

검증 스크립트는 단위 테스트, 모든 `.mjs` 구문 검사, JSON 파싱, 기본·멀티 저장소 smoke test와 터미널 제어 문자 sanitization을 확인합니다. CI도 동일한 명령을 실행합니다.

## 제거 시 주의

`/plugin uninstall statusline@claude-code-statusline`은 플러그인 등록만 제거합니다. 설치기가 만든 wrapper, 캐시, `settings.json`의 `statusLine`은 자동으로 되돌리지 않습니다. 전체 제거 절차는 [메인 README의 제거 섹션](../../README.md#제거)을 따르세요.

## 관련 문서

- 사용자 안내: [README.md](../../README.md)
- 기여와 릴리스: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- 설계 기록 안내: [docs/README.md](../../docs/README.md)
