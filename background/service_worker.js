// Background Service Worker

// 서비스 메타데이터 단일 소스 로드 (content script와 공유)
// importScripts는 MV3 classic service worker에서 동기적으로 동작한다.
importScripts('../shared/services_config.js');

const NAVER_MAP_URL = 'https://map.naver.com/';

// ─── Service Worker Keepalive ─────────────────────────────────────────────────
// MV3 service worker는 idle 상태에서 Chrome에 의해 종료됨 (약 30초)
// 예약 실행 중에는 chrome.alarms로 주기적으로 wake up 유지
let _keepaliveInterval = null;

function startKeepalive() {
  // 20초마다 alarm으로 service worker를 깨워둠
  chrome.alarms.create('keepalive', { periodInMinutes: 1/3 }); // 20초마다
}

function stopKeepalive() {
  chrome.alarms.clear('keepalive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // service worker가 살아있다는 것을 확인하는 동작
    chrome.storage.local.get('isRunning').then(({ isRunning }) => {
      if (!isRunning) stopKeepalive();
    });
  }
});

// ─── Action 클릭 → 독립 팝업 창 오픈 ──────────────────────────────────────────
// manifest에 default_popup이 없으므로 이 핸들러가 발화한다.
// 기존 팝업 창이 있으면 포커스, 없으면 새로 띄운다.
chrome.action.onClicked.addListener(async () => {
  const popupUrl = chrome.runtime.getURL('popup/popup.html');

  const existingTabs = await chrome.tabs.query({ url: popupUrl + '*' });
  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return;
    } catch (_) {
      // 기존 창이 사라졌으면 아래에서 새로 연다
    }
  }

  await chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    width: 400,
    height: 640,
  });
});

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
  const { serviceId, targetDates, titleFilter, maxProducts, searchDirection } = message;

  // 이전 실행의 macroState 잔여물 제거 (자동 재개 오작동 방지)
  // 상태 저장 + service worker keepalive 시작
  await chrome.storage.local.set({
    isRunning: true,
    currentServiceId: serviceId,
    macroState: null
  });
  startKeepalive();

  // 네이버 지도 탭 탐색 또는 새로 열기
  const tabId = await getOrOpenNaverMapTab(serviceId);

  if (!tabId) {
    await chrome.storage.local.set({ isRunning: false, currentServiceId: null });
    return { success: false, error: '탭을 열 수 없습니다.' };
  }

  // 탭 URL 갱신 후 페이지 로드가 완전히 끝날 때까지 대기
  await waitForTabComplete(tabId);

  // Content Script가 로드될 때까지 대기 후 메시지 전송
  await waitForContentScript(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'RUN_SERVICE',
      serviceId,
      targetDates,
      titleFilter,
      maxProducts,
      searchDirection
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

  stopKeepalive();
  // 자동 재개를 막기 위해 macroState도 함께 정리
  await chrome.storage.local.set({ isRunning: false, currentServiceId: null, macroState: null });
  return { success: true };
}

/**
 * 서비스 완료/오류 처리
 */
async function handleServiceFinished(message) {
  stopKeepalive();
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
  // 서비스별 예약 페이지 URL — shared/services_config.js의 SERVICES_CONFIG에서 조회
  const entryUrl = SERVICES_CONFIG[serviceId]?.entryUrl;
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
 * 탭 페이지 로드 완료 대기 (chrome.tabs.onUpdated)
 * URL 갱신 직후 이전 content script가 살아있는 동안 PING이 응답하는 문제 방지
 * @param {number} tabId
 * @param {number} timeout - ms
 */
async function waitForTabComplete(tabId, timeout = 15000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') {
    // 이미 complete 상태라면 URL 갱신이 막 시작됐을 수 있으므로 잠깐 대기
    await new Promise(r => setTimeout(r, 1000));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // 타임아웃이어도 계속 진행
    }, timeout);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
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
