// 서비스별 메타데이터 단일 소스
// content script와 background service worker 양쪽에서 동일 파일을 로드한다.
//   - content script: manifest.json content_scripts.js 최상단에 등록
//   - background:     service_worker.js에서 importScripts()로 로드
//
// 새 서비스 추가 시 이 객체에만 entry를 추가하면 두 컨텍스트가 동시에 인식한다.

const SERVICES_CONFIG = {
  jungnang_camping: {
    serviceId: 'jungnang_camping',
    serviceName: '중랑가족 캠핑장',
    entryUrl: 'https://m.booking.naver.com/booking/5/bizes/387475/items?theme=place&service-target=map-pc&lang=ko&area=bmp&map-search=1',
    // 상품 제목 필터(정규식 문자열). 사용자가 popup UI에서 수정 가능하며 빈 값이면 필터링 안 함.
    // 기본값: "{x-x} 오토캠핑" 형식만 — 바베큐/글램핑 등은 제외
    defaultTitleFilter: '[^\\s-]+-[^\\s-]+\\s*오토캠핑',
  },

  // ── 신규 서비스 추가 예시 ────────────────────────────────────────
  // seoul_forest: {
  //   serviceId: 'seoul_forest',
  //   serviceName: '서울숲 캠핑장',
  //   entryUrl: 'https://m.booking.naver.com/booking/5/bizes/XXXXXX/items?...',
  //   defaultTitleFilter: '',
  // },
};
