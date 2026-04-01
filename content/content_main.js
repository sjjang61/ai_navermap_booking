// 공통 진입점: 메시지 수신 → 서비스 라우팅

const SERVICE_REGISTRY = {
  jungnang_camping: new JungnangCampingService(),
  // 신규 서비스 추가 시 여기에 등록
  // seoul_forest: new SeoulForestCampingService(),
};

// 현재 실행 중인 서비스 인스턴스
let _activeService = null;

/**
 * Content Script → Popup 로그 전송
 * @param {'success'|'info'|'error'|'warn'|'loading'} level
 * @param {string} message
 */
function sendLog(level, message) {
  chrome.runtime.sendMessage({
    action: 'LOG',
    level,
    message
  }).catch(() => {
    // 팝업이 닫혀 있으면 sendMessage가 실패할 수 있음 — 무시
  });
}

/**
 * 메시지 수신 핸들러
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'RUN_SERVICE') {
    const { serviceId, targetDates } = message;
    const service = SERVICE_REGISTRY[serviceId];

    if (!service) {
      sendLog('error', `알 수 없는 서비스 ID: ${serviceId}`);
      sendResponse({ success: false, error: `Unknown serviceId: ${serviceId}` });
      return true;
    }

    // 이미 실행 중인 서비스 중단
    if (_activeService) {
      _activeService.stop();
    }

    _activeService = service;

    const logCallback = (level, msg) => sendLog(level, msg);

    service.run(targetDates, logCallback)
      .then(() => {
        _activeService = null;
        chrome.runtime.sendMessage({ action: 'SERVICE_DONE', serviceId }).catch(() => {});
      })
      .catch(err => {
        _activeService = null;
        sendLog('error', `서비스 실행 오류: ${err.message}`);
        chrome.runtime.sendMessage({ action: 'SERVICE_ERROR', serviceId, error: err.message }).catch(() => {});
      });

    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'STOP_SERVICE') {
    if (_activeService) {
      _activeService.stop();
      _activeService = null;
      sendLog('warn', '예약 자동화가 중단되었습니다.');
    }
    sendResponse({ success: true });
    return true;
  }

  // PING: content script 로드 여부 확인용
  if (message.action === 'PING') {
    sendResponse({ success: true, loaded: true });
    return true;
  }
});
