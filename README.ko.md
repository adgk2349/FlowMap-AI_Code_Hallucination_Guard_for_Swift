> **퍼블릭 베타 공지 (2026년 3월 8일):** FlowMap은 퍼블릭 베타 단계입니다. 라이선스 검증은 현재 로컬/개발용 프리뷰이며, 프로덕션 서버 강제 검증은 아직 구현되지 않았습니다.

# FlowMap

> Swift 코드의 구조와 호출 관계를 그래프로 분석하는 도구입니다. AI가 생성한 코드 변경을 검증할 때 특히 유용합니다.

[![CI](https://github.com/adgk2349/FlowMap/actions/workflows/ci.yml/badge.svg)](https://github.com/adgk2349/FlowMap/actions/workflows/ci.yml)

[English](README.md) · [日本語](README.ja.md)

## FlowMap이란?

FlowMap은 Swift 코드를 파싱해 파일, 타입, 함수, 호출 관계를 워크스페이스 단위로 그래프화하고, VS Code에서 시각적으로 탐색할 수 있게 해주는 개발 도구입니다.

이런 질문에 답해야 할 때 유용합니다.

- 이 함수는 실제로 어디서 호출되는가?
- 이 파일을 바꾸면 어디까지 영향이 가는가?
- AI가 생성한 코드가 겉보기엔 그럴듯하지만 실제 구조는 맞는가?
- 이 프로젝트의 전체 모양이 어떻게 생겼는가?

FlowMap은 컴파일러 대체제가 아닙니다. 실제 코드 관계를 눈으로 볼 수 있게 해주는 실용적인 워크스페이스 수준 분석 도구입니다.

## 이런 분께 유용합니다

- AI 보조 코딩 도구를 활용하면서 실제로 무엇이 바뀌었는지 검증하고 싶은 개발자
- 낯선 Swift 코드베이스를 리뷰하는 엔지니어
- 빌드 없이 Swift 프로젝트의 전체 구조를 파악하고 싶은 분

## 현재 기능

- SwiftSyntax 기반 Swift AST 파싱
- 파일 / 타입 / 함수 그래프 생성
- 파일 내 호출 + 보수적인 워크스페이스 단위 cross-file 호출 연결
- 변경 파일 기반 그래프 diff
- 호출 엣지 기반 영향 범위 분석
- VS Code 시각화 3가지 모드:
  - **Overview** — 프로젝트 / 폴더 / 파일 구조
  - **File Detail** — 파일 내 타입·함수 상세 탐색
  - **Calls** — 호출 군집 탐색
- 저장 시 자동 재분석

## 스크린샷

### Overview 모드

![Overview mode](docs/screenshots/overview.jpg)

### File Detail 모드

![File detail mode](docs/screenshots/file-detail.jpg)

### Calls 모드

![Calls mode](docs/screenshots/calls.jpg)

## 설치

### 준비물

- macOS (Swift 파서 실행에 필요)
- Rust toolchain ([rustup.rs](https://rustup.rs))
- Swift toolchain / Xcode command line tools
- Node.js v20 이상
- VS Code

### 빌드

**1. 레포 클론**

```bash
git clone https://github.com/adgk2349/FlowMap.git
cd FlowMap
```

**2. Rust 엔진 빌드**

```bash
cargo build
```

**3. Swift 파서 빌드**

```bash
cd parsers/swift-ast
swift build -c release
cd ../..
```

**4. VS Code 확장 컴파일**

```bash
cd editor/vscode
npm install
npm run compile
cd ../..
```

### VS Code에서 실행

1. `editor/vscode` 폴더를 VS Code로 엽니다
2. `F5`를 눌러 Extension Development Host를 실행합니다
3. 새로 열린 VS Code 창에서 Swift 워크스페이스를 엽니다
4. 커맨드 팔레트에서 **FlowMap: Analyze Workspace**를 실행합니다 (`Cmd+Shift+P`)
5. **FlowMap Graph** 패널을 엽니다

## 사용 방법

1. VS Code에서 Swift 워크스페이스를 엽니다
2. 커맨드 팔레트에서 **FlowMap: Analyze Workspace**를 실행합니다
3. 그래프를 탐색합니다:
   - **Overview** — 프로젝트 전체 구조를 한눈에 파악
   - **File Detail** — 파일 클릭으로 타입·함수 상세 탐색
   - **Calls** — 호출 군집과 함수 연결 흐름 추적
4. 파일을 저장하면 자동으로 재분석됩니다

## 검증 방식

FlowMap은 실제 Git 커밋 쌍을 리플레이해서 diff 검출 방향이 맞는지 확인하는 자동 검증을 제공합니다.

- 커밋 리플레이 러너: `scripts/run_commit_replay.mjs`
- 시나리오 러너(합성 회귀 세트): `scripts/run_sample_scenarios.mjs`
- 리플레이 요약 빌더: `scripts/build_replay_summary.mjs`
- 상세 검증 리포트 빌더: `scripts/build_validation_detail.mjs`

예시:

```bash
node scripts/run_commit_replay.mjs \
  --repo /path/to/swift-repo \
  --count 100 \
  --report reports/replay-100.json
```

현재 통합 검증 산출물:

- `reports/replay-validation-bundle.md`
- `reports/replay-validation-bundle.json`
- `reports/sample-scenarios-report.json`
- `reports/public-beta-validation-detail.md`
- `reports/public-beta-validation-detail.json`

최신 통합 지표(`reports/replay-validation-bundle.md`):

- 전체 커밋 페어: 209
- TP / TN / FP / FN: 106 / 97 / 0 / 6
- Non-Swift FP Rate: 0%
- Swift Detection Rate: 94.64%
- Overall Match Rate: 97.13%

최신 시나리오 회귀 검증(`reports/sample-scenarios-report.json`):

- 시나리오 수: 60
- 통과 / 실패: 60 / 0
- FP / FN 합계: 0 / 0

퍼블릭 베타 상세 검증(`reports/public-beta-validation-detail.md`):

- 비정상 케이스를 커밋 단위로 상세 기록
- Public beta gate: PASS

## 라이선스

FlowMap은 현재 **퍼블릭 베타** 단계입니다.

최종 라이선스 조건(상업용 조건 포함)은 베타 종료 후 공지됩니다.

그 전까지는 작성자가 모든 권리를 보유하며, 퍼블릭 베타 평가 목적 사용만 허용됩니다.

상업적 사용 또는 재배포 관련 문의: adgk2349b@gmail.com

## 로드맵

- Swift 호출 해석 정확도 향상
- extension, 프로토콜 등 cross-file 케이스 강화
- 추가 언어 지원
- diff / impact 시각화 개선
- export / 공유 기능 강화

## 기여

이슈와 PR은 환영합니다.

- 기여 가이드: [CONTRIBUTING.md](CONTRIBUTING.md)
- 시작용 작업 목록: [docs/good-first-issues.md](docs/good-first-issues.md)
- 이슈/PR 작성 시 `.github` 템플릿을 사용해주세요

기여하기 좋은 영역:

- Swift 파싱 edge case
- 호출 해석 개선
- 그래프 레이아웃 / 시각화 개선
- 문서화
- VS Code UX 개선

## 상태

FlowMap은 이제 **Public Beta** 단계입니다.

- 핵심 그래프/디프 파이프라인은 외부 테스트 가능한 수준으로 안정화되었습니다.
- 검증 산출물은 `reports/`에 공개하여 투명하게 확인할 수 있습니다.
- Swift 호출 해석의 일부 edge case는 지속적으로 개선 중입니다.
