# 네이버 예약 매크로 Chrome Extension

네이버 지도 예약 서비스의 상품 목록과 달력을 자동으로 탐색하여, 원하는 날짜에 빈 자리가 있으면 예약 요청까지 수행하는 Chrome Extension입니다.

---

## 목차

1. [주요 기능](#주요-기능)
2. [시스템 아키텍처](#시스템-아키텍처)
3. [디렉토리 구조](#디렉토리-구조)
4. [메시지 통신 흐름](#메시지-통신-흐름)
5. [개발 환경](#개발-환경)
6. [설치 및 실행 방법](#설치-및-실행-방법)
7. [사용 방법](#사용-방법)
8. [새로운 서비스 추가 방법](#새로운-서비스-추가-방법)
9. [디버깅](#디버깅)

---

## 주요 기능

- **특정 날짜 지정 예약**: 원하는 날짜를 직접 선택하여 예약 탐색
- **요일 반복 예약**: 특정 요일 + N주 이내 범위로 날짜를 자동 계산하여 탐색
- **실시간 실행 로그**: 팝업 내 로그 패널에서 각 단계별 진행 상황 실시간 확인
- **독립 창 모드**: 팝업을 분리된 독립 창으로 띄워 사용 가능
- **다중 서비스 탭 구조**: 탭 기반으로 예약 서비스를 추가 확장하기 쉬운 설계

---

## 시스템 아키텍처

### 레이어 구성

```
┌─────────────────────────────────────────────────────┐
│                  Popup (UI Layer)                    │
│  popup.html / popup.css / popup.js                  │
│  - 날짜 입력, 탭 전환, 실행 제어, 로그 표시           │
└────────────────────┬────────────────────────────────┘
                     │ chrome.runtime.sendMessage
                     ▼
┌─────────────────────────────────────────────────────┐
│            Background Service Worker                │
│  background/service_worker.js                       │
│  - 탭 열기/관리, Content Script 로드 대기           │
│  - 로그 메시지 Popup으로 포워딩                      │
│  - chrome.storage.local 상태 관리                   │
└────────────────────┬────────────────────────────────┘
                     │ chrome.tabs.sendMessage
                     ▼
┌─────────────────────────────────────────────────────┐
│              Content Script Layer                   │
│  (m.booking.naver.com 에 주입)                       │
│                                                     │
│  content_main.js         ← 메시지 수신 · 라우팅      │
│  services/               ← 서비스별 자동화 구현       │
│    base_service.js       ← 추상 베이스 클래스         │
│    jungnang_camping.js   ← 중랑가족 캠핑장 구현체     │
│  utils/                                             │
│    dom_helper.js         ← waitForElement, sleep 등  │
│    date_helper.js        ← 날짜 생성 · 파싱 유틸      │
└─────────────────────────────────────────────────────┘
```

### 주요 설계 원칙

| 원칙 | 내용 |
|------|------|
| **MV3 준수** | Manifest V3 기준, Background는 Service Worker |
| **jQuery 미사용** | Vanilla JS + `dispatchEvent(MouseEvent)` |
| **서비스 레지스트리** | `SERVICE_REGISTRY` 객체에 등록하여 새 서비스를 쉽게 추가 |
| **단방향 메시지 흐름** | Popup → Background → Content Script → (로그) → Background → Popup |
| **직접 URL 진입** | 네이버 지도 "예약" 버튼의 href를 분석하여 `m.booking.naver.com`에 직접 진입 |

---

## 디렉토리 구조

```
ai_navermap_booking_extension/
├── manifest.json                  # Chrome Extension 설정 (MV3)
├── popup/
│   ├── popup.html                 # 팝업 UI
│   ├── popup.css                  # 팝업 스타일 (네이버 그린 테마)
│   └── popup.js                   # 팝업 로직
├── background/
│   └── service_worker.js          # Background Service Worker
├── content/
│   ├── content_main.js            # 메시지 수신 진입점 · 서비스 라우팅
│   ├── services/
│   │   ├── base_service.js        # 추상 베이스 클래스
│   │   └── jungnang_camping.js    # 중랑가족 캠핑장 예약 자동화
│   └── utils/
│       ├── dom_helper.js          # DOM 조작 유틸
│       └── date_helper.js         # 날짜 유틸
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 메시지 통신 흐름

```
[Popup] 예약 시작 버튼 클릭
    │
    │  { action: 'START_RESERVATION', serviceId, targetDates }
    ▼
[Background] 탭 열기 또는 기존 탭 URL 갱신
    │         PING으로 Content Script 로드 완료 확인
    │
    │  { action: 'RUN_SERVICE', serviceId, targetDates }
    ▼
[Content Script: content_main.js]
    │  SERVICE_REGISTRY[serviceId].run(targetDates, logCallback)
    ▼
[JungnangCampingService.run()]
    │
    ├─ STEP1: 예약 페이지 로딩 대기
    ├─ STEP2: 더보기 버튼 클릭 (있을 경우)
    ├─ STEP3: 상품 목록 수집
    └─ STEP4: 상품별 순차 처리
         ├─ 달력 탐색 (월 이동 포함)
         ├─ 날짜 매칭 · 매진 확인
         └─ STEP5: 다음 버튼 → 결제 버튼 클릭
    │
    │  { action: 'LOG', level, message }   (각 단계마다)
    ▼
[Background] forwardLogToPopup()
    │
    ▼
[Popup] addLog() → 로그 패널에 실시간 출력
```

### 메시지 액션 목록

| 액션 | 방향 | 설명 |
|------|------|------|
| `START_RESERVATION` | Popup → Background | 예약 시작 요청 |
| `STOP_RESERVATION` | Popup → Background | 예약 중단 요청 |
| `RUN_SERVICE` | Background → Content | 서비스 실행 명령 |
| `STOP_SERVICE` | Background → Content | 서비스 중단 명령 |
| `PING` | Background → Content | Content Script 로드 확인 |
| `LOG` | Content → Background → Popup | 실시간 로그 전달 |
| `SERVICE_DONE` | Content → Popup | 서비스 정상 완료 |
| `SERVICE_ERROR` | Content → Popup | 서비스 오류 종료 |

---

## 개발 환경

### 요구 사항

| 항목 | 버전 |
|------|------|
| Chrome | 최신 버전 권장 (Manifest V3 지원) |
| Node.js | 불필요 (빌드 도구 없음, 순수 Vanilla JS) |
| 별도 패키지 | 없음 (`npm install` 불필요) |

### 권장 개발 도구

- **VS Code** — 코드 편집
- **Chrome DevTools** — 팝업 · Content Script 디버깅
- **Chrome Extensions** 탭 — `chrome://extensions/` 에서 리로드 관리

---

## 설치 및 실행 방법

### 1. 소스 코드 준비

```bash
git clone <repository-url>
cd ai_navermap_booking_extension
```

또는 ZIP 다운로드 후 압축 해제.

### 2. Chrome에 Extension 로드

1. Chrome 주소창에 `chrome://extensions/` 입력
2. 우측 상단 **개발자 모드** 토글 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `ai_navermap_booking_extension/` 폴더 선택
5. Extension 카드가 목록에 나타나면 설치 완료

### 3. 코드 수정 후 재로드

코드를 수정한 경우 `chrome://extensions/`에서 해당 Extension의 **새로고침 버튼(↺)** 을 클릭합니다.  
Content Script 변경 사항은 대상 페이지를 새로고침해야 반영됩니다.

---

## 사용 방법

### 팝업 열기

Chrome 툴바의 Extension 아이콘을 클릭합니다.

### 독립 창 모드

팝업 우측 상단 **↗ 버튼** 을 클릭하면 고정 크기 제한 없는 독립 창으로 열립니다.

### 날짜 선택 모드

**특정 날짜 모드**
1. 날짜 피커에서 날짜 선택 후 **추가** 버튼 클릭
2. 추가된 날짜는 태그로 표시 (개별 삭제 가능)
3. 중복 날짜, 과거 날짜는 자동으로 거부

**요일 반복 모드**
1. 원하는 요일 체크박스 선택 (다중 선택 가능)
2. 검색 범위 주 수 설정 (기본 4주)
3. 오늘 이후 ~ N주 이내의 해당 요일 날짜가 자동 계산됨

### 예약 실행

1. 날짜 선택 후 **▶ 예약 시작** 클릭
2. Background가 `m.booking.naver.com` 탭을 자동으로 열거나 기존 탭을 재사용
3. Content Script가 상품 목록 → 달력 → 날짜 매칭 → 예약 요청 순서로 자동 진행
4. 하단 **실행 로그** 패널에서 각 단계별 상태 실시간 확인
5. 실행 중 **■ 중단** 버튼으로 즉시 중지 가능

### 로그 레벨

| 아이콘 | 레벨 | 의미 |
|--------|------|------|
| ✅ | success | 단계 성공 |
| 🔍 | info | 진행 중 상태 정보 |
| ❌ | error | 실패 · 매진 · 오류 |
| ⚠️ | warn | 경고 (스킵 후 계속 진행) |
| ⏳ | loading | 로딩 · 대기 중 |

---

## 새로운 서비스 추가 방법

새로운 네이버 예약 서비스(예: 서울숲 캠핑장)를 추가하는 절차입니다.

### 1. 서비스 클래스 파일 생성

`content/services/seoul_forest_camping.js` 생성:

```javascript
class SeoulForestCampingService extends BaseReservationService {
  constructor() {
    super({
      serviceId: 'seoul_forest',
      serviceName: '서울숲 캠핑장',
      entryUrl: 'https://m.booking.naver.com/booking/5/bizes/XXXXXXX?theme=place&...'
    });
  }

  async run(targetDates, logCallback) {
    // 서비스별 예약 자동화 구현
  }
}
```

### 2. 서비스 레지스트리 등록

`content/content_main.js`:

```javascript
const SERVICE_REGISTRY = {
  jungnang_camping: new JungnangCampingService(),
  seoul_forest: new SeoulForestCampingService(), // 추가
};
```

### 3. Background URL 매핑 추가

`background/service_worker.js` 내 `getOrOpenNaverMapTab()`:

```javascript
const SERVICE_URLS = {
  jungnang_camping: 'https://m.booking.naver.com/...',
  seoul_forest: 'https://m.booking.naver.com/booking/5/bizes/XXXXXXX?...' // 추가
};
```

### 4. 팝업 탭 추가

`popup/popup.html`:

```html
<div class="tab-item" data-service-id="seoul_forest">서울숲 캠핑장</div>
```

### 5. manifest.json에 파일 추가

```json
"js": [
  "content/utils/dom_helper.js",
  "content/utils/date_helper.js",
  "content/services/base_service.js",
  "content/services/jungnang_camping.js",
  "content/services/seoul_forest_camping.js",
  "content/content_main.js"
]
```

---

## 디버깅

### 팝업 DevTools 열기

`chrome://extensions/` → Extension 카드 → **서비스 워커** 링크 클릭 (Background 디버깅)  
팝업을 우클릭 → **검사** (Popup DevTools)

### Content Script 로그 확인

1. `m.booking.naver.com` 탭에서 **F12** → **Console** 탭
2. 필터에 `[STEP` 또는 `[날짜탐색]` 입력

### 자주 발생하는 문제

| 증상 | 확인 사항 |
|------|---------|
| 상품 목록 0개 | 로그의 `body 앞부분` 힌트로 실제 셀렉터 확인 |
| 달력 셀 0개 | `table.calendar_table` 셀렉터가 실제 DOM과 다를 수 있음. 로그의 `달력 관련 요소` 확인 |
| 다음 버튼 없음 | 로그의 `현재 button 목록` 출력에서 실제 버튼 class/data 확인 후 셀렉터 수정 |
| Content Script 타임아웃 | 페이지가 완전히 로드되기 전에 메시지 전송 시도. `waitForContentScript` 타임아웃(15초) 확인 |
| 팝업 닫히면 로그 사라짐 | 독립 창 모드(↗ 버튼)로 실행하면 닫힘 없이 로그 유지 가능 |
