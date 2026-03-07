# FlowMap

> Swift 코드를 위한 AST 기반 구조/호출 그래프 탐색 도구입니다. 특히 AI 보조 코딩 환경에서 실제 코드 경로와 구조를 검증하는 데 초점을 맞췄습니다.

[English](README.md) · [日本語](README.ja.md)

## FlowMap이란?

FlowMap은 Swift 코드를 파싱해 파일, 타입, 함수, 호출 관계를 그래프로 만들고, 이를 VS Code 안에서 시각적으로 탐색할 수 있게 해주는 개발 도구입니다.

다음 같은 질문에 답하기 위해 만들어졌습니다.

- 이 함수는 실제로 어디서 호출되는가?
- 이 파일을 수정하면 어디까지 영향이 퍼지는가?
- AI가 만든 코드가 그럴듯해 보이기만 하고 실제 구조는 깨져 있지 않은가?
- 프로젝트 전체 구조를 한눈에 볼 수는 없는가?

FlowMap은 컴파일러 대체제가 아니라, **실용적인 워크스페이스 수준 분석/시각화 도구**입니다.

## 현재 기능

- SwiftSyntax 기반 Swift AST 파싱
- 파일 / 타입 / 함수 그래프 생성
- 같은 파일 내부 호출 + 보수적인 cross-file 호출 연결
- 변경 그래프(diff) 분석
- 호출 그래프 기반 영향 범위 분석
- VS Code 시각화 모드
  - **Overview** — 프로젝트 / 폴더 / 파일 구조
  - **File Detail** — 파일 내부 타입 / 함수 탐색
  - **Calls** — 호출 군집 탐색
- 저장 시 자동 분석
- 기본적인 source-available 라이선스 스캐폴딩

## 왜 만들었나

LLM이 만든 코드는 겉보기에는 맞아 보여도, 실제 구조까지 맞는 경우는 따로 검증해야 합니다.

FlowMap은 코드의 실제 관계를 눈으로 볼 수 있게 해서, 단순히 “그럴듯한 코드”가 아니라 **실제 연결된 코드**인지 확인할 수 있게 하려고 만들었습니다.

## 스크린샷

레포를 public으로 전환한 뒤 여기에 실제 이미지를 넣으면 됩니다.

### Overview 모드

![Overview mode](docs/screenshots/overview.png)

### File Detail 모드

![File detail mode](docs/screenshots/file-detail.png)

### Calls 모드

![Calls mode](docs/screenshots/calls.png)

## 데모 GIF

짧은 데모 GIF를 여기에 넣으면 됩니다.

![FlowMap demo](docs/demo/flowmap-demo.gif)

추천 데모 흐름:

1. Swift 워크스페이스 열기
2. **FlowMap: Analyze Workspace** 실행
3. Overview 모드 보여주기
4. File Detail 진입
5. Calls 모드 전환
6. 파일 수정 후 changed / impact 반영 보여주기

## 동작 구조

FlowMap은 크게 3개 층으로 구성됩니다.

- **Swift 파서**: 선언과 call-site 정보를 추출
- **Rust 엔진**: 그래프 생성, 보수적 cross-file 호출 연결, diff/impact 계산
- **VS Code 확장**: Overview / Detail / Calls 시각화 및 업데이트

## 현재 버전의 호출 해석 범위

현재 FlowMap은 다음 형태의 Swift 호출을 보수적으로 연결합니다.

- `foo()`
- `TypeName.method()`
- `self.method()`

후보가 여러 개라 애매한 경우에는 추측하지 않고 연결을 생략합니다.

## 설치

### 준비물

- 현재 Swift 파서 워크플로 기준 macOS 권장
- Rust toolchain
- Swift toolchain / Xcode command line tools
- Node.js
- VS Code

### 빌드

레포 루트에서:

```bash
cargo build
```

VS Code 확장 디렉터리에서:

```bash
npm install
npm run compile
```

### VS Code에서 실행

1. VS Code 확장 폴더를 VS Code로 엽니다
2. `F5`를 눌러 Extension Development Host를 실행합니다
3. 새 VS Code 창에서 Swift 워크스페이스를 엽니다
4. **FlowMap: Analyze Workspace**를 실행합니다
5. **FlowMap Graph**를 엽니다

## 로드맵

- Swift 해석 정확도 향상
- extension 등 더 다양한 cross-file 케이스 지원
- 추가 언어 플러그인 지원
- export / 공유 기능 강화
- diff / impact 시각화 개선

## 라이선스

FlowMap은 현재 source-available 모델을 따릅니다.

### Swift 지원

- 개인 / 비상업적 사용: 무료
- 상업적 / 팀 / 기업 사용: 라이선스 필요

### 추가 언어

향후 추가 언어 지원은 별도 상용 플러그인 형태로 제공될 수 있습니다.

상업적 사용 문의를 받을 연락처는 여기에 추가하면 됩니다.

## 기여

이슈와 PR은 환영합니다.

기여하기 좋은 영역:

- Swift 파싱 edge case
- 호출 해석 개선
- 그래프 레이아웃 / 시각화 개선
- 문서화
- VS Code UX 개선

## 상태

FlowMap은 계속 빠르게 발전 중입니다. 현재 공개 버전은 완성된 플랫폼이라기보다, 매우 공격적으로 발전 중인 초기 도구로 보는 편이 맞습니다.

## 공개 시 추가할 파일

레포 public 전환 후 아래 파일을 추가하면 됩니다.

- `docs/screenshots/overview.png`
- `docs/screenshots/file-detail.png`
- `docs/screenshots/calls.png`
- `docs/demo/flowmap-demo.gif`

