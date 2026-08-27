# 설계 문서 안내

이 디렉터리는 사용자 매뉴얼이 아니라 기능을 설계하고 구현한 과정을 보존하는 기록입니다. 설치와 사용법은 루트 [README.md](../README.md), 개발 절차는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 기준으로 합니다.

## 문서 분류

- `superpowers/specs/`: 기능의 목표, 동작, 실패 모드와 설계 결정을 기록한 문서
- `superpowers/plans/`: 해당 spec을 구현할 당시 사용한 단계별 계획과 코드 초안

구현 계획에는 당시의 버전, 명령 예시와 중간 코드가 그대로 남아 있을 수 있습니다. 현재 동작이나 설치 절차를 확인할 때 plan을 기준 문서로 사용하지 마세요.

## 현재 구현과 연결되는 문서

| 기능 | 설계 기록 | 구현 기록 |
| --- | --- | --- |
| 기본 status line v1 | [statusline plugin design](superpowers/specs/2026-05-11-statusline-plugin-design.md) | [statusline plugin plan](superpowers/plans/2026-05-11-statusline-plugin.md) |
| 멀티 저장소 모드 v1.1 | [multi-repo statusline](superpowers/specs/2026-05-13-multi-repo-statusline.md) | [multi-repo plan](superpowers/plans/2026-05-13-multi-repo-statusline.md) |

## 새 설계 문서 작성

큰 기능이나 구조 변경은 다음 두 파일을 만듭니다.

```text
docs/superpowers/specs/YYYY-MM-DD-<name>.md
docs/superpowers/plans/YYYY-MM-DD-<name>.md
```

spec에는 사용자 관점의 완료 조건, 입출력, 실패 모드, 보안과 테스트 기준을 적습니다. plan에는 파일별 변경 순서와 각 단계의 검증 방법을 적습니다. 구현 중 설계가 달라졌다면 merge 전에 spec을 최종 코드와 동기화합니다.

완료된 plan은 실행 지침이 아니라 이력으로 유지합니다. 이후의 문서 수정은 현재 사용자 안내와 유지보수 문서를 우선 갱신하고, 과거 plan의 코드 초안을 일괄 수정하지 않습니다.
