// 팝업 로직: 날짜 입력, 탭 전환, 실행 제어

// ─── 상태 ─────────────────────────────────────────────────────────
let activeServiceId = 'jungnang_camping';
let selectedDates = [];       // 특정 날짜 모드
let isRunning = false;

// 팝업은 항상 독립 창으로만 표시된다 (manifest의 default_popup 제거됨).

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
const titleFilterInput = document.getElementById('titleFilter');
const btnResetFilter = document.getElementById('btnResetFilter');
const maxProductsInput = document.getElementById('maxProducts');
const directionRadios = document.querySelectorAll('input[name="searchDirection"]');
const timeslotSection = document.getElementById('timeslot-section');
const timeslotGrid = document.getElementById('timeslotGrid');
const btnTimeSelectAll = document.getElementById('btnTimeSelectAll');
const btnTimeClear = document.getElementById('btnTimeClear');
const monthFilterCheckbox = document.getElementById('monthFilterCheckbox');

// ─── 탭 전환 ──────────────────────────────────────────────────────
tabItems.forEach(tab => {
  tab.addEventListener('click', () => {
    tabItems.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeServiceId = tab.dataset.serviceId;
    loadFilterForService(activeServiceId);
    loadMonthFilterForService(activeServiceId);
    renderTimeslotSection(activeServiceId);
  });
});

// ─── 제목 필터: 서비스별 저장/로드 ────────────────────────────────
function getDefaultFilter(serviceId) {
  return (typeof SERVICES_CONFIG !== 'undefined' && SERVICES_CONFIG[serviceId]?.defaultTitleFilter) || '';
}

async function loadFilterForService(serviceId) {
  try {
    const { serviceFilters = {} } = await chrome.storage.local.get('serviceFilters');
    const saved = serviceFilters[serviceId];
    titleFilterInput.value = (saved !== undefined) ? saved : getDefaultFilter(serviceId);
    titleFilterInput.placeholder = getDefaultFilter(serviceId) || '비우면 모든 상품 탐색';
  } catch (_) {
    titleFilterInput.value = getDefaultFilter(serviceId);
  }
}

// input 이벤트마다 저장 (debounce 없이 가볍게)
titleFilterInput.addEventListener('input', async () => {
  try {
    const { serviceFilters = {} } = await chrome.storage.local.get('serviceFilters');
    serviceFilters[activeServiceId] = titleFilterInput.value;
    await chrome.storage.local.set({ serviceFilters });
  } catch (_) {}
});

btnResetFilter.addEventListener('click', async () => {
  const def = getDefaultFilter(activeServiceId);
  titleFilterInput.value = def;
  try {
    const { serviceFilters = {} } = await chrome.storage.local.get('serviceFilters');
    serviceFilters[activeServiceId] = def;
    await chrome.storage.local.set({ serviceFilters });
  } catch (_) {}
});

// ─── 월간 필터링: 서비스별 저장/로드 ──────────────────────────────
async function loadMonthFilterForService(serviceId) {
  try {
    const { serviceMonthFilters = {} } = await chrome.storage.local.get('serviceMonthFilters');
    monthFilterCheckbox.checked = !!serviceMonthFilters[serviceId];
  } catch (_) {
    monthFilterCheckbox.checked = false;
  }
}

monthFilterCheckbox.addEventListener('change', async () => {
  try {
    const { serviceMonthFilters = {} } = await chrome.storage.local.get('serviceMonthFilters');
    serviceMonthFilters[activeServiceId] = monthFilterCheckbox.checked;
    await chrome.storage.local.set({ serviceMonthFilters });
  } catch (_) {}
});

// ─── 탐색 상품 수: 저장/로드 ──────────────────────────────────────
async function loadMaxProducts() {
  try {
    const { maxProducts = 0 } = await chrome.storage.local.get('maxProducts');
    maxProductsInput.value = String(maxProducts);
  } catch (_) {
    maxProductsInput.value = '0';
  }
}

maxProductsInput.addEventListener('input', async () => {
  const n = parseInt(maxProductsInput.value, 10);
  const value = Number.isFinite(n) && n >= 0 ? n : 0;
  try {
    await chrome.storage.local.set({ maxProducts: value });
  } catch (_) {}
});

// ─── 탐색 방향: 저장/로드 ─────────────────────────────────────────
function getSelectedDirection() {
  const checked = Array.from(directionRadios).find(r => r.checked);
  return checked ? checked.value : 'forward';
}

async function loadSearchDirection() {
  try {
    const { searchDirection = 'forward' } = await chrome.storage.local.get('searchDirection');
    directionRadios.forEach(r => { r.checked = (r.value === searchDirection); });
  } catch (_) {
    directionRadios.forEach(r => { r.checked = (r.value === 'forward'); });
  }
}

directionRadios.forEach(r => {
  r.addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ searchDirection: getSelectedDirection() });
    } catch (_) {}
  });
});

// ─── 시간대 선택: 서비스별 동적 렌더링 + 저장/로드 ────────────────
function getTimeslotConfig(serviceId) {
  return (typeof SERVICES_CONFIG !== 'undefined' && SERVICES_CONFIG[serviceId]?.timeSlots) || null;
}

function formatHourLabel(hour) {
  return `${String(hour % 24).padStart(2, '0')}:00`;
}

async function renderTimeslotSection(serviceId) {
  const cfg = getTimeslotConfig(serviceId);
  if (!cfg) {
    timeslotSection.classList.add('hidden');
    timeslotGrid.innerHTML = '';
    return;
  }
  timeslotSection.classList.remove('hidden');

  // 저장된 선택 불러오기
  let selected = [];
  try {
    const { serviceTimeSlots = {} } = await chrome.storage.local.get('serviceTimeSlots');
    selected = Array.isArray(serviceTimeSlots[serviceId]) ? serviceTimeSlots[serviceId] : [];
  } catch (_) {}

  // 체크박스 chip 렌더
  timeslotGrid.innerHTML = '';
  for (let h = cfg.hourStart; h <= cfg.hourEnd; h++) {
    const isChecked = selected.includes(h);
    const label = document.createElement('label');
    label.className = 'timeslot-chip' + (isChecked ? ' checked' : '');
    label.innerHTML = `<input type="checkbox" value="${h}" ${isChecked ? 'checked' : ''}><span>${formatHourLabel(h)}</span>`;
    timeslotGrid.appendChild(label);
  }

  // 체크 변경 → 저장 + chip 시각 토글
  timeslotGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      cb.closest('.timeslot-chip').classList.toggle('checked', cb.checked);
      await saveTimeslots(serviceId);
    });
  });
}

function getSelectedTimeslots() {
  return Array.from(timeslotGrid.querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => parseInt(cb.value, 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
}

async function saveTimeslots(serviceId) {
  try {
    const { serviceTimeSlots = {} } = await chrome.storage.local.get('serviceTimeSlots');
    serviceTimeSlots[serviceId] = getSelectedTimeslots();
    await chrome.storage.local.set({ serviceTimeSlots });
  } catch (_) {}
}

btnTimeSelectAll.addEventListener('click', async () => {
  timeslotGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = true;
    cb.closest('.timeslot-chip').classList.add('checked');
  });
  await saveTimeslots(activeServiceId);
});

btnTimeClear.addEventListener('click', async () => {
  timeslotGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
    cb.closest('.timeslot-chip').classList.remove('checked');
  });
  await saveTimeslots(activeServiceId);
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

  // 제목 필터 유효성 검사 (비어 있으면 필터 없음)
  const titleFilter = titleFilterInput.value.trim();
  if (titleFilter) {
    try {
      new RegExp(titleFilter);
    } catch (e) {
      addLog('error', `제목 필터 정규식 오류: ${e.message}`);
      return;
    }
  }

  const maxProductsRaw = parseInt(maxProductsInput.value, 10);
  const maxProducts = Number.isFinite(maxProductsRaw) && maxProductsRaw >= 0 ? maxProductsRaw : 0;
  const searchDirection = getSelectedDirection();
  const timeSlots = getTimeslotConfig(activeServiceId) ? getSelectedTimeslots() : [];
  const monthFilter = monthFilterCheckbox.checked;

  // 시간대 기반 서비스에서 시간대가 하나도 선택되지 않았으면 경고
  if (getTimeslotConfig(activeServiceId) && timeSlots.length === 0) {
    addLog('warn', '예약 시간대를 1개 이상 선택해 주세요.');
    return;
  }

  setRunningState(true);
  const timeSummary = timeSlots.length > 0 ? ` | 시간대: ${timeSlots.map(h => String(h).padStart(2, '0') + ':00').join(', ')}` : '';
  const monthSummary = monthFilter ? ' | 월간필터 ON' : '';
  addLog('loading', `예약 시작: ${targetDates.join(', ')}${titleFilter ? ` | 필터: ${titleFilter}` : ' | 필터 없음'}${monthSummary} | 탐색 상품 수: ${maxProducts === 0 ? '전체' : maxProducts} | 방향: ${searchDirection === 'backward' ? '후방' : '전방'}${timeSummary}`);

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'START_RESERVATION',
      serviceId: activeServiceId,
      targetDates,
      titleFilter,
      maxProducts,
      searchDirection,
      timeSlots,
      monthFilter
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

// ─── 팝업은 항상 독립 창 모드 (manifest default_popup 제거됨) ───────
document.body.classList.add('is-window');

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

  // 활성 서비스의 제목 필터 + 월간 필터 + 탐색 상품 수 + 탐색 방향 + 시간대 로드
  await loadFilterForService(activeServiceId);
  await loadMonthFilterForService(activeServiceId);
  await loadMaxProducts();
  await loadSearchDirection();
  await renderTimeslotSection(activeServiceId);
})();
