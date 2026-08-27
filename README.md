# Claude Code Statusline

Claude Code 세션에 필요한 정보를 여러 줄로 정리해 보여주는 status line 플러그인입니다. 현재 경로와 모델뿐 아니라 Git 브랜치·Pull Request, Claude 사용량, 컨텍스트 사용률, 진행 중인 작업까지 한 화면에서 확인할 수 있습니다.

```text
~/work/project | main | #42
🤖 Opus 4.1 | 5h:24%(2m) | wk:37%(2d20h) | ctx:41% | *thinking*
▶ Build feature foo | ☐ Test foo | ☐ Document
🔧 superpowers:brainstorming | ⚙ 2 bg
```

정보를 가져올 수 없을 때는 오류를 표시하는 대신 해당 항목만 숨깁니다. Git 저장소가 아니거나, `gh` 인증이 없거나, 사용량 API를 이용할 수 없는 환경에서도 나머지 status line은 계속 동작합니다.

## 주요 기능

- 현재 경로, Claude 모델, Git 브랜치와 연결된 PR 표시
- 5시간·주간 Claude 사용량과 다음 초기화까지 남은 시간 표시
- 컨텍스트 사용률에 따른 색상 표시와 80% 이상 경고
- 최근 thinking, todo, skill, 백그라운드 Bash 작업 표시
- 여러 저장소를 한 디렉터리에서 관리할 때 자동으로 요약하는 멀티 저장소 모드
- PR 번호를 지원 터미널에서 바로 열 수 있는 링크로 출력
- 외부 명령이나 네트워크 요청 실패 시 해당 정보만 생략

## 설치

### 요구 사항

- 플러그인을 지원하는 최신 [Claude Code](https://code.claude.com/docs/en/discover-plugins)
- Node.js 18 이상
- macOS 또는 Linux. Windows에서는 WSL 사용을 권장합니다.

`git`과 [GitHub CLI](https://cli.github.com/)는 선택 사항입니다. `git`이 없으면 저장소 정보가, 인증된 `gh`가 없으면 PR 정보가 표시되지 않습니다.

### 1. 마켓플레이스와 플러그인 추가

Claude Code 안에서 다음 명령을 실행합니다.

```text
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

### 2. Claude Code 재시작

Claude Code를 한 번 종료한 뒤 다시 실행합니다. 새 세션이 시작될 때 설치 훅이 다음 작업을 수행합니다.

1. 실행용 wrapper를 `~/.claude/claude-code-statusline/`에 복사합니다.
2. `~/.claude/settings.json`의 `statusLine.command`를 이 플러그인으로 설정합니다.
3. 기존에 다른 `statusLine` 설정이 있었다면 `_statusLineBackup`에 보관합니다.

> 플러그인은 사용자의 `settings.json`을 수정할 수 있는 신뢰된 코드입니다. 설치 전에 [설정 변경과 데이터 접근 범위](#설정-변경과-데이터-접근-범위)를 확인하세요.

## 화면 읽기

### 기본 모드

| 표시 | 의미 | 표시 조건 |
| --- | --- | --- |
| `~/work/project` | 현재 작업 디렉터리 | 항상 |
| `main` | 현재 Git 브랜치 | Git 저장소 안에서 실행할 때 |
| `#42`, `#42 (merged)` | 현재 브랜치의 PR | 인증된 `gh`로 PR을 조회할 수 있을 때 |
| `🤖 Opus 4.1` | Claude 모델 | 항상 |
| `5h:24%(2m)` | 5시간 사용량과 초기화까지 남은 시간 | Claude OAuth 사용량을 조회할 수 있을 때 |
| `wk:37%(2d20h)` | 주간 사용량과 초기화까지 남은 시간 | Claude OAuth 사용량을 조회할 수 있을 때 |
| `ctx:41%` | 현재 컨텍스트 사용률 | Claude Code가 값을 제공할 때 |
| `*thinking*` | 최근 30초 안에 thinking/reasoning 기록이 있음 | 활성 상태일 때 |
| `▶`, `☐` | 진행 중·대기 중 todo, 최대 5개 | transcript에 todo가 있을 때 |
| `🔧 skill-name` | 마지막으로 사용한 skill | transcript에 skill 호출이 있을 때 |
| `⚙ 2 bg` | 결과가 아직 기록되지 않은 백그라운드 Bash 작업 수 | 1개 이상일 때 |

컨텍스트 색상은 70% 미만 초록, 70~84% 노랑, 85% 이상 빨강입니다. 80%부터 `/compact`를 권하는 별도 경고 줄이 나타납니다.

### 멀티 저장소 모드

현재 디렉터리 자체는 Git 저장소가 아니지만 바로 아래에 Git 저장소가 둘 이상 있으면 자동으로 멀티 저장소 모드로 전환됩니다.

```text
~/infra | 5 repos · 2 dirty · 2 open PRs · 1 draft
 api main!  #42  ·   web fix-login  ~#17  ·   shared main
```

- `!`: 수정 사항이 있거나 upstream보다 ahead/behind 상태
- `#42`: 열린 PR
- `~#17`: draft PR
- `#5✓`: merge된 PR
- `#99✗`: 닫힌 PR
- `(rebase)`, `(merge)`, `(detached)`: 일반 브랜치 상태가 아님

직속 저장소가 하나뿐이면 부모 경로와 해당 저장소의 브랜치를 기본 모드 형식으로 표시합니다. 하위 디렉터리를 재귀적으로 탐색하지는 않습니다.

## 설정

별도 설정 파일은 없습니다. 필요한 경우 Claude Code를 시작하는 셸에서 환경 변수를 지정합니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `STATUSLINE_WIDTH` | `COLUMNS`, 없으면 `80` | 한 줄의 최대 표시 폭. 20보다 큰 정수만 사용합니다. |
| `STATUSLINE_MULTI_REPO` | 활성화 | `0`으로 설정하면 멀티 저장소 모드를 끕니다. |
| `STATUSLINE_DEBUG` | 비활성화 | `1`로 설정하면 설치·wrapper 오류를 stderr에 출력합니다. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code가 다른 설정 디렉터리를 사용할 때 그 위치를 따릅니다. |

예를 들어 넓은 터미널에서 140열을 사용하려면 다음을 셸 설정에 추가한 뒤 Claude Code를 다시 시작합니다.

```sh
export STATUSLINE_WIDTH=140
```

## 업데이트

타사 마켓플레이스의 자동 업데이트는 Claude Code에서 기본적으로 꺼져 있습니다. `/plugin` → **Marketplaces** → `claude-code-statusline`에서 자동 업데이트를 켤 수 있습니다. 업데이트 알림이 표시되면 안내에 따라 `/reload-plugins`를 실행하세요.

수동으로 갱신하려면 다음 명령을 실행합니다.

```text
/plugin marketplace update claude-code-statusline
/plugin install statusline@claude-code-statusline
```

플러그인이 바로 반영되지 않으면 `/reload-plugins`를 실행하거나 Claude Code를 다시 시작합니다. 자세한 동작은 Claude Code의 [플러그인 설치 및 업데이트 문서](https://code.claude.com/docs/en/discover-plugins)를 참고하세요.

## 설정 변경과 데이터 접근 범위

설치 전에 알아야 할 동작은 다음과 같습니다.

- 설치 훅이 사용자 `settings.json`의 `statusLine` 값을 변경합니다. 기존 설정은 `_statusLineBackup`에 한 번 보관하지만 제거 시 자동 복원하지는 않습니다.
- 현재 세션 transcript의 마지막 64 KiB를 로컬에서 읽어 thinking, todo, skill, 백그라운드 작업 상태를 계산합니다. transcript 내용 자체를 외부로 전송하지 않습니다.
- macOS Keychain 또는 `~/.claude/.credentials.json`에서 Claude OAuth 자격 증명을 읽고 `api.anthropic.com`의 사용량 API를 호출합니다.
- OAuth 토큰이 만료된 경우 `platform.claude.com`에서 갱신을 시도합니다. 파일 기반 자격 증명을 사용 중이면 갱신된 값을 권한 `0600`으로 다시 저장할 수 있습니다.
- GitHub PR 정보는 로컬 `gh` 명령으로 조회합니다.
- 계산 결과는 `~/.claude/claude-code-statusline/cache/`에 저장됩니다. 캐시에는 transcript 본문이나 OAuth 토큰을 저장하지 않습니다.

## 문제 해결

### Status line이 나타나지 않음

1. `node --version`으로 Node.js 18 이상이 설치되어 있는지 확인합니다.
2. `/plugin`의 **Installed**와 **Errors** 탭에서 플러그인 상태를 확인합니다.
3. Claude Code를 재시작해 `SessionStart` 설치 훅을 다시 실행합니다.
4. 디버그 로그가 필요하면 `STATUSLINE_DEBUG=1`을 설정하고 재시작합니다.

`settings.json`이 유효하지 않은 JSON이면 설치기는 파일을 덮어쓰지 않고 `settings.json.bak.<timestamp>` 백업을 만든 뒤 중단합니다. JSON 오류를 고친 후 새 세션을 시작하세요.

### PR이 나타나지 않음

```sh
gh auth status
gh pr view --json number,url,state
```

두 번째 명령은 status line을 사용하는 저장소 안에서 실행합니다. 현재 브랜치에 연결된 PR이 없거나 GitHub 인증·remote 정보가 없으면 PR 항목은 정상적으로 숨겨집니다.

### 사용량이 나타나지 않음

사용량 표시는 Claude OAuth 자격 증명과 비공개 사용량 API를 이용하는 선택 기능입니다. API 키, Bedrock, Vertex 등 다른 인증 방식에서는 표시되지 않을 수 있습니다. 일시적인 인증·네트워크 오류가 발생해도 나머지 status line에는 영향을 주지 않습니다.

### 로컬에서 출력 확인

저장소 루트에서 fixture를 직접 렌더링할 수 있습니다.

```sh
node plugins/statusline/statusline/index.mjs \
  < plugins/statusline/test-fixtures/stdin-with-transcript.json
```

## 제거

먼저 Claude Code 안에서 플러그인을 제거합니다.

```text
/plugin uninstall statusline@claude-code-statusline
```

그다음 `~/.claude/settings.json`에서 다음 중 하나를 직접 수행합니다.

- 다른 status line을 사용하지 않았다면 `statusLine` 키를 삭제합니다.
- `_statusLineBackup`이 있다면 그 값을 `statusLine`으로 옮기고 `_statusLineBackup`을 삭제합니다.

마지막으로 더 이상 필요 없는 `~/.claude/claude-code-statusline/` 디렉터리를 삭제할 수 있습니다. 플러그인 제거만으로는 이 디렉터리와 사용자 설정이 자동으로 정리되지 않습니다.

## 개발

- 기여 방법과 릴리스 절차: [CONTRIBUTING.md](CONTRIBUTING.md)
- 플러그인 구조와 캐시 상세: [plugins/statusline/README.md](plugins/statusline/README.md)
- 설계 기록과 구현 계획: [docs/README.md](docs/README.md)

변경 전 전체 검증은 저장소 루트에서 실행합니다.

```sh
bash scripts/verify.sh
```

## 라이선스

[MIT License](LICENSE)
