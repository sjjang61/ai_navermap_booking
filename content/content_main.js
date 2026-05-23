// 공통 진입점: 메시지 수신 → 서비스 라우팅

const SERVICE_REGISTRY = {
  jungnang_camping: new JungnangCampingService(),
  yangjae_tennis: new YangjaeTennisService(),
  // 신규 서비스 추가 시 여기에 등록
};

// 현재 실행 중인 서비스 인스턴스
let _activeService = null;
let _isRunning = false; // 중복 실행 방지 플래그

/**
 * Content Script → Popup 로그 전송
 * - chrome.runtime.sendMessage가 실패해도 console.log로 항상 출력
 * @param {'success'|'info'|'error'|'warn'|'loading'} level
 * @param {string} message
 */
function sendLog(level, message) {
  // DevTools Console에 항상 출력 (service worker 종료 여부 무관)
  const prefix = { success: '✅', info: '🔍', error: '❌', warn: '⚠️', loading: '⏳' }[level] || '•';
  console.log(`[예약매크로] ${prefix} ${message}`);

  // Popup으로 전달 시도
  chrome.runtime.sendMessage({ action: 'LOG', level, message })
    .catch(() => {
      // service worker가 죽어있으면 무시 — console.log로 이미 기록됨
    });
}

/**
 * 서비스 실행 (시작 또는 페이지 이동 후 재개)
 * @param {string} serviceId
 * @param {{ targetDates: string[], titleFilter?: string }} opts
 * @param {string} source - 로그용 ("시작" | "자동재개")
 */
async function runService(serviceId, opts, source) {
  if (_isRunning) {
    sendLog('warn', `[중복무시] 이미 실행 중 — ${source} 무시 (serviceId: ${serviceId})`);
    return;
  }
  const service = SERVICE_REGISTRY[serviceId];
  if (!service) {
    sendLog('error', `알 수 없는 서비스 ID: ${serviceId}`);
    return;
  }

  _isRunning = true;
  _activeService = service;
  sendLog('info', `[${source}] serviceId=${serviceId}, URL=${location.href}, filter="${opts.titleFilter || '(없음)'}", maxProducts=${opts.maxProducts ?? 0}, direction=${opts.searchDirection || 'forward'}`);

  try {
    await service.run(opts, (level, msg) => sendLog(level, msg));
  } catch (err) {
    sendLog('error', `서비스 실행 오류: ${err.message}`);
  } finally {
    _isRunning = false;
    _activeService = null;
  }
}

/**
 * 메시지 수신 핸들러
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'RUN_SERVICE') {
    runService(message.serviceId, {
      targetDates: message.targetDates,
      titleFilter: message.titleFilter,
      maxProducts: message.maxProducts,
      searchDirection: message.searchDirection,
      timeSlots: message.timeSlots,
      monthFilter: message.monthFilter,
    }, '시작');
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'STOP_SERVICE') {
    if (_activeService) {
      _activeService.stop();
      _activeService = null;
    }
    // 자동 재개를 막기 위해 macroState도 정리
    chrome.storage.local.set({ isRunning: false, macroState: null })
      .then(() => sendLog('warn', '예약 자동화가 중단되었습니다.'))
      .catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  // PING: content script 로드 여부 확인용
  if (message.action === 'PING') {
    sendResponse({ success: true, loaded: true });
    return true;
  }
});

/**
 * 페이지 로드 시 자동 재개
 * 매크로가 진행 중이면 storage의 macroState를 보고 다음 phase로 자동 진입.
 * (페이지 이동으로 content script가 새로 로드되어도 매크로가 끊기지 않게)
 */
(async () => {
  // DOM/storage 안정화 잠시 대기
  await sleep(100);
  try {
    const { macroState, isRunning } = await chrome.storage.local.get(['macroState', 'isRunning']);
    if (!isRunning || !macroState) return;
    if (!SERVICE_REGISTRY[macroState.serviceId]) {
      sendLog('warn', `[자동재개] 알 수 없는 서비스: ${macroState.serviceId}`);
      return;
    }

    // /request 페이지 도달 시 — 예약 확인/결제 단계 진입 완료. 매크로 상태만 정리하고 재개 안 함.
    if (isOnRequestPage()) {
      sendLog('success', `[자동재개] /request 페이지 도달 감지 → 매크로 종료. 결제는 사용자가 수동으로 진행하세요.`);
      await chrome.storage.local.set({ isRunning: false, macroState: null });
      chrome.runtime.sendMessage({ action: 'SERVICE_DONE', serviceId: macroState.serviceId }).catch(() => {});
      return;
    }

    sendLog('info', `[자동재개] phase=${macroState.phase}, productIndex=${macroState.productIndex}, 남은날짜=${macroState.targetDates.join(', ')}`);
    await runService(macroState.serviceId, {
      targetDates: macroState.targetDates,
      titleFilter: macroState.titleFilter,
      maxProducts: macroState.maxProducts,
      searchDirection: macroState.searchDirection,
      timeSlots: macroState.timeSlots,
      monthFilter: macroState.monthFilter,
    }, '자동재개');
  } catch (e) {
    sendLog('error', `[자동재개] 오류: ${e.message}`);
  }
})();
