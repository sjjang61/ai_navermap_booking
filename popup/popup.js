// 팝업 로직: 날짜 입력, 탭 전환, 실행 제어

// ─── 상태 ─────────────────────────────────────────────────────────
let activeServiceId = 'jungnang_camping';
let selectedDates = [];       // 특정 날짜 모드
let isRunning = false;

// 독립 창 모드 여부 (URL 파라미터 ?mode=window 로 판별)
const IS_WINDOW_MODE = new URLSearchParams(location.search).get('mode') === 'window';

// ─── DOM 참조 ─────────────────────────────────────────────────────
const tabItems = document.querySelectorAll('.tab-item');
const modeRadios = document.querySelectorAll('input[name="dateMode"]');
const panelSpecific = document.getElementById('panel-specific');
const panelWeekday = document.getElementById('panel-weekday');
const datePicker = document.getElementById('datePicker');
const btnAddDate = document.getElementById('btnAddDate');
const dateTagList = document.getElementById('dateTagList');
const weeksAheadInput = document.getElementById('weeksAhead');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const logPanel = document.getElementById('logPanel');
const btnPopout = document.getElementById('btnPopout');

// ─── 탭 전환 ──────────────────────────────────────────────────────
tabItems.forEach(tab => {
  tab.addEventListener('click', () => {
    tabItems.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeServiceId = tab.dataset.serviceId;
  });
});

// ─── 날짜 선택 모드 전환 ──────────────────────────────────────────
modeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    if (radio.value === 'specific') {
      panelSpecific.classList.remove('hidden');
      panelWeekday.classList.add('hidden');
    } else {
      panelSpecific.classList.add('hidden');
      panelWeekday.classList.remove('hidden');
    }
  });
});

// ─── 특정 날짜 추가 ───────────────────────────────────────────────
btnAddDate.addEventListener('click', () => {
  const val = datePicker.value;
  if (!val) return;
  if (selectedDates.includes(val)) {
    addLog('warn', `이미 추가된 날짜입니다: ${val}`);
    return;
  }

  // 과거 날짜 방지
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const selected = new Date(val);
  if (selected <= today) {
    addLog('warn', '오늘 이후 날짜를 선택해 주세요.');
    return;
  }

  selectedDates.push(val);
  selectedDates.sort();
  renderDateTags();
  datePicker.value = '';
});

datePicker.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnAddDate.click();
});

function renderDateTags() {
  dateTagList.innerHTML = '';
  selectedDates.forEach(date => {
    const tag = document.createElement('span');
    tag.className = 'date-tag';
    tag.innerHTML = `${date}<button class="date-tag-remove" data-date="${date}" title="삭제">×</button>`;
    dateTagList.appendChild(tag);
  });
}

dateTagList.addEventListener('click', e => {
  const removeBtn = e.target.closest('.date-tag-remove');
  if (removeBtn) {
    const date = removeBtn.dataset.date;
    selectedDates = selectedDates.filter(d => d !== date);
    renderDateTags();
  }
});

// ─── 예약 시작 ────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const targetDates = collectTargetDates();

  if (targetDates.length === 0) {
    addLog('warn', '예약 대상 날짜를 선택해 주세요.');
    return;
  }

  setRunningState(true);
  addLog('loading', `예약 시작: ${targetDates.join(', ')}`);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'START_RESERVATION',
      serviceId: activeServiceId,
      targetDates
    });

    if (!response || !response.success) {
      addLog('error', `시작 실패: ${response?.error || '알 수 없는 오류'}`);
      setRunningState(false);
    }
  } catch (err) {
    addLog('error', `오류: ${err.message}`);
    setRunningState(false);
  }
});

// ─── 예약 중단 ────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ action: 'STOP_RESERVATION' });
    addLog('warn', '예약이 중단되었습니다.');
  } catch (err) {
    addLog('error', `중단 오류: ${err.message}`);
  }
  setRunningState(false);
});

// ─── 대상 날짜 수집 ───────────────────────────────────────────────
function collectTargetDates() {
  const mode = document.querySelector('input[name="dateMode"]:checked').value;

  if (mode === 'specific') {
    return [...selectedDates];
  }

  // 요일 반복 모드
  const checkedDays = Array.from(
    document.querySelectorAll('.weekday-checkboxes input[type="checkbox"]:checked')
  ).map(cb => parseInt(cb.value));

  const weeksAhead = parseInt(weeksAheadInput.value) || 4;

  if (checkedDays.length === 0) return [];

  return generateDatesByDayOfWeek(checkedDays, weeksAhead);
}

// ─── 요일 → 날짜 배열 생성 (popup 내 인라인 구현) ─────────────────
function generateDatesByDayOfWeek(dayOfWeeks, weeksAhead) {
  const results = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + weeksAhead * 7);

  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);

  while (cursor <= endDate) {
    if (dayOfWeeks.includes(cursor.getDay())) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getDate()).padStart(2, '0');
      results.push(`${yyyy}-${mm}-${dd}`);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return results;
}

// ─── 실행 상태 UI 전환 ────────────────────────────────────────────
function setRunningState(running) {
  isRunning = running;
  btnStart.classList.toggle('hidden', running);
  btnStop.classList.toggle('hidden', !running);
}

// ─── 로그 추가 ────────────────────────────────────────────────────
const LOG_ICONS = {
  success: '✅',
  info: '🔍',
  error: '❌',
  warn: '⚠️',
  loading: '⏳'
};

function addLog(level, message) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;

  const icon = document.createElement('span');
  icon.className = 'log-icon';
  icon.textContent = LOG_ICONS[level] || '•';

  const text = document.createElement('span');
  text.textContent = message;

  entry.appendChild(icon);
  entry.appendChild(text);
  logPanel.appendChild(entry);

  // 자동 스크롤
  logPanel.scrollTop = logPanel.scrollHeight;
}

// ─── Background → Popup 메시지 수신 ──────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'LOG') {
    addLog(message.level, message.message);
  }

  if (message.action === 'SERVICE_DONE') {
    setRunningState(false);
    addLog('success', '예약 자동화 완료.');
  }

  if (message.action === 'SERVICE_ERROR') {
    setRunningState(false);
    addLog('error', `오류로 종료: ${message.error || ''}`);
  }
});

// ─── 독립 창 토글 ─────────────────────────────────────────────────
if (IS_WINDOW_MODE) {
  // 독립 창: 버튼 숨김, body에 클래스 추가
  btnPopout.classList.add('hidden');
  document.body.classList.add('is-window');
} else {
  // 팝업: 클릭 시 독립 창 오픈
  btnPopout.addEventListener('click', () => {
    const url = chrome.runtime.getURL('popup/popup.html') + '?mode=window';
    chrome.windows.create({
      url,
      type: 'popup',
      width: 400,
      height: 600
    });
    window.close();
  });
}

// ─── 초기화: 스토리지에서 실행 상태 복원 ─────────────────────────
(async function init() {
  try {
    const { isRunning: running } = await chrome.storage.local.get('isRunning');
    if (running) setRunningState(true);
  } catch (_) {}

  // 오늘 날짜를 date input min값으로 설정
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  datePicker.min = `${yyyy}-${mm}-${dd}`;
})();
