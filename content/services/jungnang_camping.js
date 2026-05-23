// 중랑가족 캠핑장 — NaverBookingService를 그대로 상속
// 메타데이터(serviceId, serviceName, entryUrl, defaultTitleFilter)는
// shared/services_config.js에서 관리한다.

class JungnangCampingService extends NaverBookingService {
  constructor() {
    super(SERVICES_CONFIG.jungnang_camping);
  }
}
