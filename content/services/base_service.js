// 모든 예약 서비스가 상속하는 추상 베이스 클래스

class BaseReservationService {
  /**
   * @param {{ serviceId: string, serviceName: string, entryUrl: string }} config
   */
  constructor(config) {
    this.serviceId = config.serviceId;
    this.serviceName = config.serviceName;
    this.entryUrl = config.entryUrl;
    this._stopped = false;
  }

  /**
   * 예약 자동화 실행 — 서브클래스에서 반드시 구현
   * @param {string[]} targetDates - 'yyyy-mm-dd' 형식 날짜 배열
   * @param {function} logCallback - (level, message) => void
   * @returns {Promise<void>}
   */
  async run(targetDates, logCallback) {
    throw new Error(`run() must be implemented in ${this.constructor.name}`);
  }

  /**
   * 실행 중단 요청
   */
  stop() {
    this._stopped = true;
  }

  /**
   * 중단 여부 초기화
   */
  reset() {
    this._stopped = false;
  }

  /**
   * 로그 전송 헬퍼
   * @param {function} logCallback
   * @param {'success'|'info'|'error'|'warn'|'loading'} level
   * @param {string} message
   */
  log(logCallback, level, message) {
    if (typeof logCallback === 'function') {
      logCallback(level, message);
    }
  }
}
