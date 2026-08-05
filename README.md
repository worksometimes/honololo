<div align="center">
  <img src="assets/honololo-supreme-auditor.png" alt="증거철과 승인 도장을 든 HONOLOLO 최고감사관" width="520" />

  <h1>HONOLOLO</h1>

  <p><strong>통과는 주장하는 것이 아니다. 증거와 함께 선고되는 것이다.</strong></p>
  <p>Claude Code와 Codex를 위한 증거 우선 브라우저 QA · 스크린샷 매뉴얼 하네스</p>
</div>

## 최고감사위원회 포고문

브라우저 에이전트는 흔히 “완료했습니다”라고 보고한다.
HONOLOLO는 그 보고를 믿지 않는다.

본 위원회는 URL과 목표를 접수하고, 현장을 정찰하며, 승인된 계획만 집행한다. 모든 판정에는
URL, 스냅샷, 스크린샷 또는 행동 기록이 따라야 한다. 증거가 모자라면 결과는 통과가 아니라
`needs_human`이다. 이 원칙에는 예외가 없다.

HONOLOLO는 또 하나의 브라우저 CLI가 아니다. 이미 충분히 유능한 Claude Code와 Codex 위에
설치되어, 그들의 행동을 계획·증거·검증의 질서 아래 두는 Skill-first 하네스다.

```text
URL + 목표
  → 정찰
  → 계획 제안
  → 사용자 승인 및 동결
  → 실제 브라우저 실행
  → 증거 수집
  → 결정론적 검증
  → 필요 시 독립 의미 평가
  → 휴대 가능한 결과물
```

## 본 위원회가 통제하는 것

- **승인 없는 집행은 없다.** 실행 전 계획을 제안하고 승인된 바이트를 동결한다.
- **증거 없는 통과는 없다.** 모든 기준은 검증된 run-relative 증거를 인용한다.
- **실패의 말소는 없다.** 실패·중단·재시도는 시도 이력에 영구히 남는다.
- **주관적 자기채점은 없다.** 의미 판단은 실행 대화와 분리된 fresh evaluator가 맡는다.
- **사생활의 공개는 없다.** 실제 타깃과 생성 산출물은 `.honololo/` 아래에만 보관되고
  Git에는 올라가지 않는다.

## 사용 허가

필수 조건:

- Node.js 20 이상
- [agent-browser](https://github.com/vercel-labs/agent-browser)
- Codex 또는 Claude Code

Codex에서:

```text
$honololo https://app.example.com — 설정 화면의 동작을 검증하라
```

Claude Code에서:

```text
/honololo https://app.example.com — 설정 화면의 스크린샷 매뉴얼을 작성하라
```

Codex는 [.agents/skills/honololo/SKILL.md](.agents/skills/honololo/SKILL.md)를 사용한다.
Claude Code는 [.claude/skills/honololo/SKILL.md](.claude/skills/honololo/SKILL.md)를 통해
같은 규율을 따른다. 최종 권위는 [harness/workflow.md](harness/workflow.md)에 있다.

## 산출물 보관령

```text
.honololo/runs/<run>/
├── run.json
├── plan/
│   ├── proposal.md
│   └── approved.json
├── attempts/001/
│   ├── evidence/
│   ├── evidence.json
│   ├── status.json
│   ├── verifier.initial.json
│   ├── fresh.json
│   └── verifier.final.json
└── output/
    ├── result.md
    └── manual.md
```

`.honololo/`는 Git에서 제외된다. 실제 URL, 자격증명, 쿠키, 토큰, 개인정보를 tracked
파일에 넣는 행위는 허가되지 않는다. 인증이 필요하면 런타임이 통제하는 브라우저에서 사용자가
직접 수행한다.

## 판정 체계

| 판정 | 위원회의 해석 |
| --- | --- |
| `pass` | 승인된 기준과 검증된 증거가 일치한다 |
| `fail` | 기준을 충족하지 못했다 |
| `needs_human` | 증거 또는 의미 판단이 충분하지 않다 |
| `blocked` | 필요한 권한이나 입력이 없다 |
| `interrupted` | 시도가 끝까지 완료되지 않았다 |

나중의 통과가 앞선 실패를 지우지는 않는다. HONOLOLO는 기억력이 좋다.

## 개발자 심사

```bash
npm ci
npm run check
npm audit --audit-level=high
git diff --check
```

결정론적 코어는 의도적으로 작다. JSON Schema 계약, 불변 계획, 증거 해시, 시도 이력,
검증기와 렌더러만 책임진다. 브라우징은 에이전트가 하고, 믿을지 말지는 HONOLOLO가 결정한다.

## 면허

MIT. 위원회는 관대하다.
