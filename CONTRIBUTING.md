# 기여 가이드

이 저장소의 변경은 사용자 머신에서 매 세션 실행되는 status line에 배포됩니다. 기능 추가뿐 아니라 문서 수정도 실제 구현과 설치 동작을 기준으로 검증해 주세요.

## 개발 환경

- Node.js 18 이상
- Bash
- 선택 사항: `git`, 인증된 `gh`

런타임 패키지 설치는 필요하지 않습니다. 저장소를 clone한 뒤 바로 검증할 수 있습니다.

```sh
bash scripts/verify.sh
```

## 저장소 구조

| 경로 | 역할 |
| --- | --- |
| `.claude-plugin/marketplace.json` | Claude Code 마켓플레이스 카탈로그 |
| `plugins/statusline/` | 배포되는 플러그인 루트 |
| `plugins/statusline/statusline/` | 렌더러와 라이브러리 |
| `plugins/statusline/tests/` | `node:test` 단위 테스트 |
| `plugins/statusline/test-fixtures/` | 테스트용 stdin, transcript, GitHub 응답 |
| `docs/superpowers/specs/` | 기능 설계 기록 |
| `docs/superpowers/plans/` | 구현 당시의 실행 계획 |
| `scripts/verify.sh` | 로컬·CI 공통 검증 진입점 |

## 변경 절차

1. 변경 목적과 사용자에게 보이는 결과를 정리합니다.
2. 동작을 바꾸는 경우 먼저 관련 테스트를 추가하거나 갱신합니다.
3. 코드와 사용자 문서를 함께 수정합니다.
4. `bash scripts/verify.sh`를 통과시킵니다.
5. PR을 열기 전에 diff에서 버전, 문서 링크, fixture의 절대 경로 포함 여부를 확인합니다.

새 기능이나 구조 변경은 `spec → plan → 구현 → spec 동기화` 순서로 진행합니다. 작은 버그 수정이나 문서 정리는 기존 spec을 억지로 확장하기보다 PR 설명에 근거와 검증 결과를 명확히 남겨도 됩니다.

## 테스트 원칙

- 순수 로직은 `plugins/statusline/tests/*.test.mjs`에서 테스트합니다.
- 시간, 네트워크, 프로세스 실행은 주입 가능한 함수나 옵션으로 분리해 결정적으로 테스트합니다.
- fixture에는 머신별 절대 경로를 넣지 않습니다.
- 렌더링 변경은 색상 코드가 아니라 ANSI를 제거한 가시 문자열 기준 검증도 포함합니다.
- 외부 명령과 네트워크가 실패해도 status line 전체가 실패하지 않는지 확인합니다.
- 터미널에 출력되는 외부 문자열은 제어 문자를 제거해야 합니다.

전체 검증에는 다음 항목이 포함됩니다.

- 모든 단위 테스트
- 모든 `.mjs` 파일의 `node --check`
- marketplace와 plugin JSON 파싱
- 기본 status line smoke render
- 멀티 저장소 smoke render
- 브랜치명 ANSI escape 제거 회귀 검사

## 코드 규칙

- ESM(`.mjs`)과 Node.js 표준 라이브러리만 사용합니다.
- 런타임 의존성과 별도 build/install 단계를 추가하지 않습니다.
- 외부 명령은 shell 문자열 조합 대신 `execFile`/`execFileSync`와 인자 배열로 실행합니다.
- 정상 동작 중에는 stderr를 출력하지 않습니다. 진단 메시지는 `STATUSLINE_DEBUG`가 설정된 경우로 제한합니다.
- 캐시 JSON은 `cache.mjs`의 `writeJsonAtomic()`으로 기록합니다.
- 파일·Git·GitHub·OAuth 오류는 가능한 한 해당 세그먼트만 숨기고 나머지 렌더링을 유지합니다.

## 문서 규칙

- 루트 `README.md`는 설치·사용·보안·문제 해결의 기준 문서입니다.
- `plugins/statusline/README.md`는 플러그인 내부 구조와 유지보수 정보를 설명합니다.
- `CONTRIBUTING.md`는 개발 및 릴리스 절차만 다룹니다.
- `docs/superpowers/plans/`의 문서는 구현 당시 기록이므로 현재 사용법을 설명하는 문서로 링크하지 않습니다.
- 명령, 경로, 환경 변수는 실제 코드나 공식 Claude Code 문서로 확인합니다.
- 동일한 설명을 여러 문서에 복사할 때는 한 문서를 기준으로 정하고 나머지는 링크와 최소 요약만 둡니다.

## 버전 정책

이 플러그인은 `plugins/statusline/.claude-plugin/plugin.json`의 명시적 SemVer를 사용합니다. Claude Code는 같은 버전을 이미 캐시한 경우 코드를 다시 추출하지 않으므로, 배포되는 변경에는 버전 변경이 필요합니다.

원칙은 **PR 하나당 버전 bump 한 번**입니다.

- `patch`: 버그 수정, 호환 가능한 문서·진단 개선
- `minor`: 하위 호환되는 기능 추가
- `major`: 설정·출력·지원 환경의 호환성을 깨는 변경

리뷰 중 커밋마다 버전을 반복해서 올리지 않습니다. PR의 최종 상태에서 한 번만 변경하고 squash merge합니다. 문서만 바뀌어 플러그인 캐시 내용의 재배포가 필요하지 않다면 버전을 올리지 않아도 됩니다.

## 릴리스 절차

1. `main` 기준 브랜치에서 변경합니다.
2. 배포가 필요한 PR이면 plugin version을 한 번 올립니다.
3. `bash scripts/verify.sh`를 실행합니다.
4. 코드·README·관련 spec이 최종 동작과 일치하는지 확인합니다.
5. PR을 squash merge합니다.
6. merge commit에 `statusline-v<version>` 태그를 만들고 push합니다.

예시:

```sh
git tag statusline-v1.2.0 <merge-commit>
git push origin statusline-v1.2.0
```

Claude Code의 plugin version 해석과 marketplace 검증 방식은 공식 [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) 문서를 기준으로 합니다.
