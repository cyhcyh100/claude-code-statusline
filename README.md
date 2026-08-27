# claude-code-statusline

Claude Code 용 멀티라인 statusline 플러그인. 브랜치·열린 PR·5h/주간 사용량·컨텍스트 %·현재 thinking/todo/skill/백그라운드 태스크를 한눈에 보여줍니다.

## What's here

- **`plugins/statusline/`** — 플러그인 본체. 세그먼트별 의미·디버깅·언인스톨은 `plugins/statusline/README.md` 참고.
- **`docs/superpowers/specs/`** — 설계 스펙 문서.
- **`docs/superpowers/plans/`** — 스펙을 구현하기 위한 구현 플랜.
- **`CLAUDE.md`** — 레포 규약. Claude Code 가 작업할 때 자동으로 로드됩니다.

## Install

Claude Code 안에서 두 줄이면 끝입니다.

```
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

그 다음 Claude Code 한 번 재시작. `SessionStart` 훅이 `~/.claude/settings.json` 의 `statusLine.command` 를 자동으로 패치합니다.


## Contributing

### Plugin 버전 정책: 한 PR = 한 버전 bump

플러그인을 수정할 때는 **PR 하나당 `plugin.json` `version` 한 번만 올립니다.** 리뷰 중 추가 커밋을 쌓아도 중간에 버전을 올리지 말고, 머지 시점에 한 번 bump 된 상태로 squash-merge 합니다. 이유는 `CLAUDE.md` 를 참고하세요 — Claude Code 가 버전을 캐시 키로 쓰기 때문에 mid-PR bump 는 사용자 머신에 불필요한 재추출을 일으킵니다.

머지된 뒤에는 머지 커밋에 `<plugin>-v<version>` 태그를 붙이고 푸시합니다 (예: `statusline-v1.0.0`).

### Spec-first 워크플로 (superpowers)

새 기능이나 큰 변경은 **spec → plan → 구현 → spec 동기화** 순서로 진행합니다.

1. **Spec 먼저** — `docs/superpowers/specs/YYYY-MM-DD-<name>.md` 에 무엇을·왜 만드는지, 입출력·동작·실패 모드·체크리스트를 적습니다. 구현 디테일이 아니라 "완성된 상태가 어떤 모습이어야 하는가" 를 담습니다.
2. **Plan 작성** — `docs/superpowers/plans/YYYY-MM-DD-<name>.md` 에 spec 을 구현하기 위한 단계별 태스크를 적습니다. 체크박스 (`- [ ]`) 형태로 한 줄씩 추적 가능한 단위로 쪼개고, 각 단계마다 검증 방법을 함께 적습니다.
3. **구현 중에는 두 문서를 살아있는 상태로 유지** — 구현하다가 설계가 바뀌면 spec 과 plan 을 함께 갱신합니다. plan 만 따라가고 spec 을 방치하면 머지 후에 "왜 이 모양이 됐는지" 가 사라집니다.
4. **PR 올리기 직전에 spec 동기화 (필수)** — 코드와 spec 의 최종 상태가 일치하는지 한 번 더 점검하고, 다른 부분이 있으면 spec 을 실제 구현에 맞춰 업데이트한 뒤 PR 을 엽니다. spec 은 "릴리스 시점의 진실" 로 머지됩니다.

### Code review 후속 처리
