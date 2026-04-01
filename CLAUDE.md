# CLAUDE.md — 네이버 지도 예약 자동화 매크로 Chrome Extension

## 프로젝트 개요

네이버 지도의 예약 기능을 자동화하는 Chrome Extension입니다.
사용자가 원하는 날짜/요일을 입력하면, 지정된 예약 서비스 페이지를 방문하여 매진되지 않은 날짜를 자동으로 탐색하고 예약 요청까지 수행합니다.

탭 기반 구조로 설계되어 추후 예약 서비스 확장이 용이하도록 합니다.
첫 번째 탭은 **중랑가족 캠핑장** 예약 자동화입니다.

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| Extension 구조 | Chrome Extension Manifest V3 |
| UI | HTML + CSS + Vanilla JS (Popup) |
| 자동화 실행 | Content Script + Background Service Worker |
| 메시지 통신 | Chrome Runtime Message Passing |
| 상태 저장 | chrome.storage.local |
| DOM 조작 | 네이버 지도 페이지 Content Script |

---

## 디렉토리 구조

```
naver-reservation-macro/
├── manifest.json                  # Extension 설정 (MV3)
├── popup/
│   ├── popup.html                 # 팝업 UI (탭 구조)
│   ├── popup.css                  # 팝업 스타일
│   └── popup.js                   # 팝업 로직 (날짜 입력, 탭 전환, 실행 제어)
├── background/
│   └── service_worker.js          # Background Service Worker
├── content/
│   ├── content_main.js            # 공통 진입점 (메시지 수신 → 서비스 라우팅)
│   ├── services/
│   │   ├── base_service.js        # 모든 서비스가 상속하는 추상 베이스 클래스
│   │   └── jungnang_camping.js    # 중랑가족 캠핑장 예약 자동화 구현체
│   └── utils/
│       ├── dom_helper.js          # DOM 조작 유틸 (waitForElement, sleep 등)
│       └── date_helper.js         # 날짜 파싱/비교 유틸
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## manifest.json 스펙

```json
{
  "manifest_version": 3,
  "name": "네이버 예약 매크로",
  "version": "1.0.0",
  "description": "네이버 지도 예약 서비스 자동화 매크로",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "tabs"
  ],
  "host_permissions": [
    "https://map.naver.com/*"
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "background": {
    "service_worker": "background/service_worker.js"
  },
  "content_scripts": [
    {
      "matches": ["https://map.naver.com/*"],
      "js": [
        "content/utils/dom_helper.js",
        "content/utils/date_helper.js",
        "content/services/base_service.js",
        "content/services/jungnang_camping.js",
        "content/content_main.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

---

## 팝업 UI 명세 (popup.html)

### 탭 구조

```
┌─────────────────────────────────────────┐
│  🏕 네이버 예약 매크로                    │
├──────────────┬──────────────────────────┤
│ 중랑가족캠핑장 │  (추후 탭 추가)           │
├──────────────┴──────────────────────────┤
│ [날짜 선택 모드]  ○ 특정 날짜  ○ 요일 반복  │
│                                         │
│ ▸ 특정 날짜 선택 시:                      │
│   [날짜 피커] + [추가] 버튼               │
│   선택된 날짜: 2025-05-10, 2025-05-17   │
│                                         │
│ ▸ 요일 반복 선택 시:                      │
│   [월][화][수][목][금][토][일] 체크박스    │
│   검색 범위: 오늘부터 [  N  ] 주 이내     │
│                                         │
│ [▶ 예약 시작] 버튼                        │
│                                         │
│ ─── 실행 로그 ───────────────────────────│
│ ✅ 캠핑장 페이지 진입 완료                 │
│ 🔍 상품 목록 탐색 중...                   │
│ ❌ [글램핑 A] 2025-05-10 매진             │
│ ✅ [글램핑 B] 2025-05-17 예약 가능 → 진행 │
└─────────────────────────────────────────┘
```

### 입력 방식

#### 1. 특정 날짜 선택 모드
- `<input type="date">` 날짜 피커
- "추가" 버튼 클릭 시 선택된 날짜를 목록에 추가
- 추가된 날짜는 태그(badge) 형태로 표시, 개별 삭제 가능
- 중복 날짜 추가 방지

#### 2. 요일 반복 선택 모드
- 월~일 체크박스 (다중 선택)
- "몇 주 이내" 숫자 입력 (기본값: 4주)
- 선택한 요일 기준으로 오늘 이후 N주 내의 날짜 자동 계산

### 실행 로그 패널
- 스크롤 가능한 로그 영역
- 아이콘으로 상태 구분: ✅ 성공, 🔍 탐색 중, ❌ 실패/매진, ⏳ 대기 중, ⚠️ 경고
- 가장 최신 로그가 하단에 추가 (자동 스크롤)

---

## 서비스 등록 구조 (확장 설계)

### base_service.js — 추상 베이스 클래스

```javascript
class BaseReservationService {
  constructor(config) {
    this.serviceId = config.serviceId;   // 고유 서비스 ID
    this.serviceName = config.serviceName; // 표시 이름
    this.entryUrl = config.entryUrl;     // 네이버 지도 URL
  }

  // 반드시 구현해야 하는 메서드
  async run(targetDates, logCallback) {
    throw new Error('run() must be implemented');
  }
}
```

### 서비스 레지스트리 (content_main.js)

```javascript
const SERVICE_REGISTRY = {
  jungnang_camping: new JungnangCampingService(),
  // 신규 서비스 추가 시 여기에 등록
  // new_service: new NewService(),
};
```

새로운 예약 서비스 추가 시:
1. `content/services/` 에 새 클래스 파일 생성 (`base_service.js` 상속)
2. `SERVICE_REGISTRY` 에 등록
3. `popup.html` 에 탭 항목 추가
4. `manifest.json` content_scripts에 파일 추가

---

## 자동화 실행 흐름 명세

### 전체 시퀀스 다이어그램

```
[Popup] 사용자 날짜 입력 + 예약 시작 클릭
    │
    ▼
[Popup.js] 대상 날짜 배열 생성
    │
    ▼
[chrome.runtime] → [background service_worker] 에 메시지 전송
    │                { action: 'START_RESERVATION',
    │                  serviceId: 'jungnang_camping',
    │                  targetDates: ['2025-05-10', ...] }
    ▼
[background] 네이버 지도 URL 탭 열기 또는 포커스
    │
    ▼
[content_main.js] 메시지 수신 → SERVICE_REGISTRY 라우팅
    │
    ▼
[JungnangCampingService.run(targetDates, log)]
    │
    ├─ STEP 1: 예약 버튼 클릭
    ├─ STEP 2: 더보기 버튼 클릭 (존재 시)
    ├─ STEP 3: 상품 목록 수집
    └─ STEP 4: 각 상품별 순차 처리
         │
         ├─ 상품 클릭 (상세 페이지 진입)
         ├─ 달력 로딩 대기
         ├─ 대상 날짜 탐색 (매진 여부 확인)
         │    ├─ 매진 → 다음 날짜 또는 다음 상품으로
         │    └─ 예약 가능 → 예약 요청 진행
         │         ├─ [다음] 버튼 클릭
         │         └─ [동의하고 결제하기] 버튼 클릭
         └─ 로그 콜백으로 진행 상황 팝업에 전송
```

---

## STEP별 상세 구현 명세

### STEP 1: 네이버 지도 예약 페이지 진입

- **진입 URL**: `https://map.naver.com/p/entry/place/13466661?c=13.86,0,0,0,dh`
- iframe 로딩 완료 대기 필요 (네이버 지도는 내부 iframe 구조)
- **예약 버튼 셀렉터**: `span:contains("예약")` 또는 `a[href*="booking"]` 탐색
  - 정확한 셀렉터: `span` 텍스트가 "예약"인 버튼의 부모 `<a>` 또는 `<button>` 클릭
- 클릭 후 예약 패널 로딩 대기 (waitForElement 사용)

### STEP 2: 더보기 버튼 처리

- **셀렉터**: `button.button_more`
- 존재 여부 확인 후 클릭 (없으면 스킵)
- 클릭 후 상품 목록 완전 로딩 대기 (500ms ~ 1000ms sleep)

### STEP 3: 상품 목록 수집

- **셀렉터**: `div.section_home.type_booking div ul li a`
- 수집된 `<a>` 엘리먼트 배열을 인덱스 기반으로 순차 처리
- 각 상품의 이름 추출: `li a` 내부의 텍스트 또는 이미지 alt

### STEP 4: 상품별 날짜 탐색

#### 상품 진입
- `element.click()` 또는 `.trigger("click")` 방식으로 클릭 이벤트 발생
- 상세 페이지(달력 포함) 로딩 완료 대기

#### 달력 탐색 로직

```javascript
// 현재 표시 월 확인
const currentYearMonth = $("div.calendar_title").text(); // "2025.05" 형태

// 날짜 셀 수집
const dateCells = $("table.calendar_table tbody.calendar_body tr.calendar_week td");

dateCells.each((i, td) => {
  const dayNum = $(td).find("span.num").text();         // "10", "17" 등
  const statusText = $(td).find("span.text").text();   // "매진" 또는 기타
  const isSoldOut = statusText === "매진";
  const isAvailable = !isSoldOut && dayNum !== "";
});
```

#### 달력 월 이동
- 대상 날짜가 현재 표시 월과 다를 경우 이전/다음 월 이동 버튼 클릭
- **다음 월 버튼 셀렉터**: `button.calendar_next` 또는 `[class*="next"]` (실제 셀렉터 확인 필요)
- 최대 탐색 범위: 현재 월로부터 +6개월 이내

#### 날짜 매칭 전략
```
targetDates = ['2025-05-10', '2025-05-17', '2025-06-01']

for each date in targetDates:
  1. 달력에서 해당 년월로 이동
  2. 해당 일(day) 셀 탐색
  3. 매진 여부 확인
  4. 매진 아님 → 해당 td 클릭 → 예약 진행
  5. 매진 → 다음 날짜 시도
```

### STEP 5: 예약 요청 실행

```javascript
// 다음 버튼 클릭
$("button[data-click-code='nextbuttonview.request']").trigger("click");
await sleep(1500);

// 동의하고 결제하기 버튼 클릭
$("button[data-click-code='submitbutton.submit']").trigger("click");
```

- 각 버튼 클릭 후 다음 화면 로딩 대기
- 버튼이 없거나 비활성화 상태인 경우 로그 기록 후 스킵

---

## DOM 유틸리티 명세 (dom_helper.js)

```javascript
// 엘리먼트 등장 대기 (폴링 방식)
async function waitForElement(selector, timeout = 10000, interval = 300) { ... }

// ms 단위 대기
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 안전한 클릭 (엘리먼트 존재 확인 후 클릭)
function safeClick(selector) { ... }

// iframe 내부 document 접근
function getIframeDocument(iframeSelector) { ... }

// 텍스트 포함 엘리먼트 탐색 (jQuery-like)
function findByText(selector, text) { ... }
```

---

## 날짜 유틸리티 명세 (date_helper.js)

```javascript
// 요일 선택 → 날짜 배열 생성
// dayOfWeeks: [0=일, 1=월, ..., 6=토], weeksAhead: 탐색 주 수
function generateDatesByDayOfWeek(dayOfWeeks, weeksAhead) { ... }

// 특정 날짜 배열 정렬 (과거 날짜 제거)
function filterFutureDates(dates) { ... }

// "yyyy.mm" + day 숫자 → "yyyy-mm-dd" 변환
function parseCalendarDate(yearMonth, day) { ... }

// 달력 이동 횟수 계산 (현재 월 기준)
function getMonthDiff(currentYearMonth, targetDate) { ... }
```

---

## 메시지 통신 명세

### Popup → Background

```javascript
// 예약 시작
chrome.runtime.sendMessage({
  action: 'START_RESERVATION',
  serviceId: 'jungnang_camping',
  targetDates: ['2025-05-10', '2025-05-17']
});

// 예약 중단
chrome.runtime.sendMessage({
  action: 'STOP_RESERVATION'
});
```

### Background → Content Script

```javascript
chrome.tabs.sendMessage(tabId, {
  action: 'RUN_SERVICE',
  serviceId: 'jungnang_camping',
  targetDates: ['2025-05-10', '2025-05-17']
});
```

### Content Script → Popup (로그 전송)

```javascript
chrome.runtime.sendMessage({
  action: 'LOG',
  level: 'success' | 'info' | 'error' | 'warn',
  message: '글램핑 A - 2025-05-17 예약 가능. 예약 진행 중...'
});
```

### 로그 레벨 정의

| 레벨 | 아이콘 | 설명 |
|------|--------|------|
| success | ✅ | 성공적인 작업 완료 |
| info | 🔍 | 탐색/진행 중 상태 |
| error | ❌ | 실패, 매진, 오류 |
| warn | ⚠️ | 경고 (재시도 가능) |
| loading | ⏳ | 로딩/대기 중 |

---

## 상태 관리 (chrome.storage.local)

```javascript
{
  "isRunning": false,           // 현재 실행 중 여부
  "currentServiceId": null,     // 실행 중인 서비스 ID
  "lastRunResult": {            // 마지막 실행 결과
    "serviceId": "jungnang_camping",
    "timestamp": "2025-05-08T10:30:00",
    "targetDates": ["2025-05-10"],
    "results": [
      { "product": "글램핑 A", "date": "2025-05-10", "status": "sold_out" },
      { "product": "글램핑 B", "date": "2025-05-17", "status": "reserved" }
    ]
  }
}
```

---

## 중랑가족 캠핑장 서비스 상세 (jungnang_camping.js)

### 서비스 설정

```javascript
class JungnangCampingService extends BaseReservationService {
  constructor() {
    super({
      serviceId: 'jungnang_camping',
      serviceName: '중랑가족 캠핑장',
      entryUrl: 'https://map.naver.com/p/entry/place/13466661?c=13.86,0,0,0,dh'
    });
  }
}
```

### 실행 순서 (run 메서드)

```
1. entryUrl 페이지 로딩 완료 확인
2. "예약" 버튼 탐색 및 클릭 → waitForElement
3. button.button_more 존재 시 클릭 → sleep(800)
4. 상품 목록 수집: div.section_home.type_booking div ul li a
5. 상품 수만큼 반복:
   a. 상품[i] 클릭
   b. 달력 로딩 대기: waitForElement("div.calendar_title")
   c. targetDates 순회:
      - 달력 월 이동 (필요 시)
      - span.num / span.text 로 날짜 상태 확인
      - 예약 가능 시: 해당 td 클릭 → 다음 버튼 → 결제 버튼
      - 성공 시 해당 날짜를 targetDates에서 제거
   d. 뒤로가기 또는 상품 목록 재진입
6. 모든 날짜 처리 완료 or 상품 소진 시 종료
```

### 주의 사항 및 예외 처리

- **iframe 구조**: 네이버 지도는 `<iframe>` 내부에 예약 UI가 로드될 수 있음. iframe 접근 시 `contentDocument` 참조 필요
- **동적 로딩**: 모든 DOM 접근은 `waitForElement`로 로딩 완료 후 진행
- **타임아웃 처리**: 10초 내 엘리먼트 미등장 시 해당 단계 스킵 및 로그 기록
- **뒤로가기**: 상품 상세에서 목록으로 돌아올 때 `history.back()` 또는 목록 링크 재클릭
- **상품 목록 재수집**: 뒤로가기 후 DOM이 재렌더링되므로 상품 목록을 인덱스 기반으로 재탐색

---

## 에러 핸들링 정책

| 상황 | 처리 방법 |
|------|-----------|
| 예약 버튼 미발견 (10초 초과) | 로그 기록 후 실행 중단 |
| 상품 목록 비어있음 | 로그 기록 후 실행 중단 |
| 달력 로딩 실패 | 해당 상품 스킵, 다음 상품 시도 |
| 날짜 전부 매진 | 모든 상품/날짜 처리 후 "예약 가능 날짜 없음" 로그 |
| 다음/결제 버튼 미발견 | 로그 기록 후 다음 날짜/상품으로 스킵 |
| 네트워크 오류 | 최대 3회 재시도, 실패 시 중단 |

---

## 향후 서비스 확장 방법 (가이드)

새로운 예약 서비스(예: 서울숲 캠핑장)를 추가하려면:

### 1. 서비스 파일 생성
```
content/services/seoul_forest_camping.js
```
```javascript
class SeoulForestCampingService extends BaseReservationService {
  constructor() {
    super({
      serviceId: 'seoul_forest',
      serviceName: '서울숲 캠핑장',
      entryUrl: 'https://map.naver.com/p/entry/place/XXXXXXX'
    });
  }

  async run(targetDates, logCallback) {
    // 서비스별 예약 자동화 구현
  }
}
```

### 2. 레지스트리 등록 (content_main.js)
```javascript
const SERVICE_REGISTRY = {
  jungnang_camping: new JungnangCampingService(),
  seoul_forest: new SeoulForestCampingService(), // 추가
};
```

### 3. 팝업 탭 추가 (popup.html)
```html
<div class="tab-item" data-service-id="seoul_forest">서울숲 캠핑장</div>
```

### 4. manifest.json 업데이트
```json
"js": [
  "content/services/seoul_forest_camping.js"
]
```

---

## 개발 환경 및 로드 방법

1. Chrome 브라우저 → `chrome://extensions/` 접속
2. "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. `naver-reservation-macro/` 디렉토리 선택
5. 팝업 아이콘 클릭하여 Extension 실행

---

## 코드 작성 시 주의사항

- jQuery 사용 금지 (Content Script에서 별도 로드 불가). Vanilla JS `document.querySelector`, `querySelectorAll` 사용
- `trigger("click")` 대신 `element.dispatchEvent(new MouseEvent('click', { bubbles: true }))` 사용
- 네이버 지도의 CSP(Content Security Policy) 정책으로 인해 외부 스크립트 주입 불가
- MV3에서는 `chrome.scripting.executeScript`로 Content Script에 함수 주입 가능
- 모든 async 함수는 try-catch로 감싸고 에러를 logCallback으로 전송

---

## 테스트 체크리스트

- [ ] 날짜 직접 입력 후 예약 시작 동작 확인
- [ ] 요일 선택 후 날짜 배열 자동 생성 확인
- [ ] 네이버 지도 예약 페이지 정상 진입 확인
- [ ] 더보기 버튼 클릭 후 상품 전체 표시 확인
- [ ] 각 상품 상세 페이지 진입 및 달력 로딩 확인
- [ ] 매진 날짜 정확히 감지하는지 확인
- [ ] 예약 가능 날짜 클릭 및 다음 버튼 동작 확인
- [ ] 로그 패널에 실시간 상태 출력 확인
- [ ] 실행 중 중단 버튼 동작 확인
- [ ] 다음 서비스 탭 추가 시 기존 기능 영향 없음 확인