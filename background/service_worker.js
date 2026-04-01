// Background Service Worker

const NAVER_MAP_URL = 'https://map.naver.com/';

/**
 * 메시지 수신 핸들러 (Popup → Background)
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RESERVATION') {
    handleStartReservation(message).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // 비동기 응답을 위해 true 반환
  }

  if (message.action === 'STOP_RESERVATION') {
    handleStopReservation().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // Content Script에서 오는 로그 → Popup으로 포워딩
  if (message.action === 'LOG') {
    forwardLogToPopup(message);
    return false;
  }

  // Content Script 실행 완료/오류
  if (message.action === 'SERVICE_DONE' || message.action === 'SERVICE_ERROR') {
    handleServiceFinished(message);
    return false;
  }
});

/**
 * 예약 시작 처리
 */
async function handleStartReservation(message) {
  const { serviceId, targetDates } = message;

  // 상태 저장
  await chrome.storage.local.set({
    isRunning: true,
    currentServiceId: serviceId
  });

  // 네이버 지도 탭 탐색 또는 새로 열기
  const tabId = await getOrOpenNaverMapTab(serviceId);

  if (!tabId) {
    await chrome.storage.local.set({ isRunning: false, currentServiceId: null });
    return { success: false, error: '탭을 열 수 없습니다.' };
  }

  // Content Script가 로드될 때까지 대기 후 메시지 전송
  await waitForContentScript(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'RUN_SERVICE',
      serviceId,
      targetDates
    });
  } catch (err) {
    await chrome.storage.local.set({ isRunning: false, currentServiceId: null });
    return { success: false, error: `Content Script 메시지 전송 실패: ${err.message}` };
  }

  return { success: true, tabId };
}

/**
 * 예약 중단 처리
 */
async function handleStopReservation() {
  const { currentServiceId } = await chrome.storage.local.get('currentServiceId');

  // 현재 열려 있는 예약 탭 탐색
  const tabs = await chrome.tabs.query({ url: 'https://m.booking.naver.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'STOP_SERVICE' });
    } catch (_) {}
  }

  await chrome.storage.local.set({ isRunning: false, currentServiceId: null });
  return { success: true };
}

/**
 * 서비스 완료/오류 처리
 */
async function handleServiceFinished(message) {
  const timestamp = new Date().toISOString();
  const existing = await chrome.storage.local.get('lastRunResult');

  await chrome.storage.local.set({
    isRunning: false,
    currentServiceId: null,
    lastRunResult: {
      serviceId: message.serviceId,
      timestamp,
      status: message.action === 'SERVICE_DONE' ? 'done' : 'error',
      error: message.error || null,
      ...(existing.lastRunResult || {})
    }
  });
}

/**
 * 로그 메시지를 Popup으로 포워딩
 * (Content Script → Background → Popup)
 */
function forwardLogToPopup(message) {
  // Popup이 열려 있으면 전달
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup이 닫혀 있으면 무시
  });
}

/**
 * 예약 페이지 탭 가져오기 (없으면 새로 열기)
 * 네이버 지도의 "예약" 버튼은 m.booking.naver.com으로 이동하므로 직접 진입
 * @param {string} serviceId
 * @returns {Promise<number|null>} tabId
 */
async function getOrOpenNaverMapTab(serviceId) {
  // 서비스별 실제 예약 페이지 URL (네이버 예약 도메인)
  const SERVICE_URLS = {
    jungnang_camping: 'https://m.booking.naver.com/booking/5/bizes/387475?theme=place&service-target=map-pc&lang=ko&area=bmp&map-search=1'
  };

  const entryUrl = SERVICE_URLS[serviceId];
  if (!entryUrl) return null;

  // 기존 예약 탭 탐색 (map.naver.com 또는 m.booking.naver.com)
  const existingTabs = await chrome.tabs.query({ url: 'https://m.booking.naver.com/*' });

  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    await chrome.tabs.update(tab.id, { active: true, url: entryUrl });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab.id;
  }

  // 새 탭 열기
  const newTab = await chrome.tabs.create({ url: entryUrl, active: true });
  return newTab.id;
}

/**
 * Content Script 로드 대기 (PING 방식)
 * @param {number} tabId
 * @param {number} timeout - ms
 */
async function waitForContentScript(tabId, timeout = 15000) {
  const start = Date.now();
  const interval = 500;

  while (Date.now() - start < timeout) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      if (response && response.loaded) return;
    } catch (_) {}

    await new Promise(r => setTimeout(r, interval));
  }

  throw new Error('Content Script 로드 타임아웃');
}
