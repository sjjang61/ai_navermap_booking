// 네이버 예약 v5/v10 공통 자동화 베이스 클래스
// 모든 m.booking.naver.com 기반 서비스(중랑가족 캠핑장, 양재 테니스장 등)는
// 이 클래스를 상속하고 constructor에서 자신의 SERVICES_CONFIG entry만 super로 넘기면 된다.
//
// 페이지 구조 가정 (네이버 예약 m.booking.naver.com 공통):
//   - 상품 목록: <li class="HomeBookingList__booking_item__XXXX">
//   - 캘린더:    <div class="calendar_title"> + <table class="calendar_table">
//   - 다음 버튼: button[data-click-code="nextbuttonview.request"]
//   - 종료:      URL이 /items/{id}/request 도달

class NaverBookingService extends BaseReservationService {
  async run(opts, logCallback) {
    this.reset();
    const log = (level, msg) => this.log(logCallback, level, msg);
    const { targetDates = [], titleFilter = '', maxProducts = 0, searchDirection = 'forward', timeSlots = [], monthFilter = false } = opts || {};

    try {
      // /request 페이지 도달 시 — 예약 확인/결제 단계 진입 성공. 결제는 사용자 수동 진행.
      if (isOnRequestPage()) {
        log('success', `[RUN] /request 페이지 도달 (${location.href}) — 매크로 종료, 결제는 수동으로 진행하세요.`);
        await this._finish(log);
        return;
      }

      // 페이지 이동 시 content script가 재로드되므로 한 번의 run() 호출은
      // 한 phase만 실행하고 다음 phase는 storage 기반으로 재개된다.
      const state = await this._loadOrInitState(targetDates, titleFilter, maxProducts, searchDirection, timeSlots, monthFilter, log);
      log('info', `[RUN] phase=${state.phase}, productIndex=${state.productIndex}, 남은 날짜=${state.targetDates.join(', ')}, filter="${state.titleFilter || '(없음)'}", monthFilter=${state.monthFilter}, maxProducts=${state.maxProducts || 0}, direction=${state.searchDirection}, timeSlots=[${(state.timeSlots || []).join(',')}], URL=${location.href}`);

      if (state.phase === 'list') {
        await this._listPhase(state, log);
      } else if (state.phase === 'detail') {
        await this._detailPhase(state, log);
      } else {
        log('error', `[RUN] 알 수 없는 phase: ${state.phase}`);
        await this._finish(log);
      }
    } catch (err) {
      log('error', `[RUN] 실행 중 오류: ${err.message}\n${err.stack || ''}`);
      await this._finish(log);
    }
  }

  // ─── 상태 머신 ────────────────────────────────────────────────────

  async _loadOrInitState(targetDates, titleFilter, maxProducts, searchDirection, timeSlots, monthFilter, log) {
    const stored = await chrome.storage.local.get('macroState');
    let state = stored.macroState;

    if (!state || state.serviceId !== this.serviceId) {
      state = {
        serviceId: this.serviceId,
        targetDates: [...targetDates],
        titleFilter: titleFilter || '',
        monthFilter: !!monthFilter,
        maxProducts: Number.isFinite(maxProducts) && maxProducts >= 0 ? maxProducts : 0,
        searchDirection: searchDirection === 'backward' ? 'backward' : 'forward',
        timeSlots: Array.isArray(timeSlots) ? [...timeSlots].sort((a, b) => a - b) : [],
        productIndex: 0,
        phase: 'list',
        currentProductName: null,
        createdAt: Date.now(),
      };
      await chrome.storage.local.set({ macroState: state, isRunning: true });
      log('info', `[INIT] 새 macroState 생성 (targetDates=${state.targetDates.join(', ')}, filter="${state.titleFilter}", monthFilter=${state.monthFilter}, maxProducts=${state.maxProducts}, direction=${state.searchDirection}, timeSlots=[${state.timeSlots.join(',')}])`);
    } else {
      // 폴백: 구버전 state 보강
      if (!state.searchDirection) state.searchDirection = 'forward';
      if (!Array.isArray(state.timeSlots)) state.timeSlots = [];
      if (typeof state.monthFilter !== 'boolean') state.monthFilter = false;
      log('info', `[INIT] 기존 macroState 재개 (filter="${state.titleFilter || ''}", monthFilter=${state.monthFilter}, maxProducts=${state.maxProducts || 0}, direction=${state.searchDirection}, timeSlots=[${state.timeSlots.join(',')}])`);
    }
    return state;
  }

  async _saveState(state) {
    await chrome.storage.local.set({ macroState: state, isRunning: true });
  }

  async _finish(log) {
    log('info', '[종료] macroState 정리, isRunning=false');
    await chrome.storage.local.set({ isRunning: false, macroState: null });
    chrome.runtime.sendMessage({ action: 'SERVICE_DONE', serviceId: this.serviceId }).catch(() => {});
  }

  // ─── listPhase: 상품 목록에서 다음 상품 진입 ──────────────────────

  async _listPhase(state, log) {
    log('info', `[listPhase] 시작 — 상품[${state.productIndex}] 진입 준비`);

    // 상세 페이지에 떨어진 상태로 listPhase가 호출되면 목록 URL로 이동
    if (location.href.includes('/items/') && /\/items\/\d+/.test(location.pathname)) {
      log('info', `[listPhase] 현재 상세 페이지 — 목록 URL로 이동: ${this.entryUrl}`);
      location.href = this.entryUrl;
      return;
    }

    if (state.targetDates.length === 0) {
      log('success', '[listPhase] 남은 대상 날짜 없음 — 종료');
      return await this._finish(log);
    }

    await this._step1_waitForPage(log);
    if (this._stopped) return await this._finish(log);
    await this._step2_clickMoreButton(log);
    if (this._stopped) return await this._finish(log);

    // 상품 목록은 lazy 로딩되므로 스크롤로 트리거 + 폴링
    await this._waitForFullProductList(log);
    if (this._stopped) return await this._finish(log);

    const { elements: products, usedSelector } = this._getProductElements();
    log('info', `[listPhase] 최종 상품 ${products.length}개 (셀렉터: "${usedSelector}")`);

    // 전체 상품 이름 디버그 출력 — 필터 미스매칭 원인(이름 추출 실패 vs lazy 로드 누락) 판별용
    products.forEach((el, i) => {
      const name = this._getProductName(el);
      log('info', `[listPhase] 전체[${i}] "${name}"`);
    });

    // 상품이 비정상적으로 적게 잡히면 페이지 구조 진단 로그 출력
    if (products.length < 5) {
      log('warn', `[listPhase] 상품 ${products.length}개만 잡힘 — 페이지 구조 진단 시작`);
      this._surveyPage(log);
    }

    if (products.length === 0) {
      log('error', '[listPhase] 상품 0개 — 종료');
      return await this._finish(log);
    }

    // 제목 필터링 — state.titleFilter (사용자가 UI에서 입력한 정규식 문자열)
    // 비어 있으면 필터링 없이 전체 상품을 대상으로 함
    const filterStr = state.titleFilter || '';
    let filter = null;
    if (filterStr) {
      try {
        filter = new RegExp(filterStr);
      } catch (e) {
        log('error', `[listPhase] 제목 필터 정규식 오류 ("${filterStr}"): ${e.message} — 필터 없이 진행`);
      }
    }

    // 월간 필터 — 활성화 시 targetDates의 월(예: "6월")이 제목에 포함되어야 함 (여러 월이면 OR)
    let monthTokens = [];
    if (state.monthFilter && state.targetDates.length > 0) {
      monthTokens = [...new Set(state.targetDates.map(d => `${parseInt(d.split('-')[1], 10)}월`))];
      log('info', `[listPhase] 월간 필터 활성: 제목에 "${monthTokens.join('" 또는 "')}" 포함 필요`);
    }
    const passesMonth = (name) => monthTokens.length === 0 || monthTokens.some(m => name.includes(m));

    const annotated = products.map((el, originalIdx) => ({ el, originalIdx, name: this._getProductName(el) }));
    let matchedAll = annotated.filter(p => {
      if (filter && !filter.test(p.name)) return false;
      if (!passesMonth(p.name)) return false;
      return true;
    });

    // 탐색 방향 — 'backward'면 매칭 리스트를 뒤집어서 마지막 상품부터 처리
    const direction = state.searchDirection === 'backward' ? 'backward' : 'forward';
    if (direction === 'backward') {
      matchedAll = [...matchedAll].reverse();
    }

    // 탐색 상품 수 한도 — 0이면 전체, N이면 앞(방향 적용 후)에서 N개만
    const cap = state.maxProducts && state.maxProducts > 0 ? state.maxProducts : 0;
    const matched = cap > 0 ? matchedAll.slice(0, cap) : matchedAll;

    log('info', `[listPhase] 필터(${filter ? filter.toString() : '없음'}) 매칭: ${matchedAll.length}/${products.length}개, 방향=${direction}, 탐색 한도 ${cap === 0 ? '전체' : cap} → ${matched.length}개 처리`);
    matched.forEach((p, i) => log('info', `[listPhase]   매칭[${i}] (원본 ${p.originalIdx}) "${p.name}"`));

    if (matched.length === 0) {
      log('error', '[listPhase] 필터/한도 조건에 맞는 상품 없음 — 종료');
      return await this._finish(log);
    }
    if (state.productIndex >= matched.length) {
      log('warn', `[listPhase] 탐색 한도(${matched.length}개) 도달. 남은 날짜: ${state.targetDates.join(', ')}`);
      return await this._finish(log);
    }

    const liEl = matched[state.productIndex].el;
    const productName = matched[state.productIndex].name;
    log('info', `[listPhase] 매칭[${state.productIndex}/${matched.length - 1}] "${productName}" 진입 시도`);

    // 클릭 전에 phase=detail로 미리 저장 → 페이지 이동 후 자동 재개 시 detailPhase로 진입
    const detailState = { ...state, phase: 'detail', currentProductName: productName };
    await this._saveState(detailState);
    log('info', `[listPhase] macroState 업데이트 → phase=detail`);

    // 실제 href가 있으면 가장 안전 (페이지 이동 보장)
    const realHrefAnchor = Array.from(liEl.querySelectorAll('a')).find(a => {
      const h = a.getAttribute('href') || '';
      return h && h !== '#';
    });

    if (realHrefAnchor) {
      const href = realHrefAnchor.getAttribute('href');
      const targetUrl = href.startsWith('http') ? href : `https://m.booking.naver.com${href}`;
      log('info', `[listPhase] 실제 href 발견 → location.href 이동: ${targetUrl}`);
      location.href = targetUrl;
      return;
    }

    // href="#" → 후보 요소들에 dispatchEvent 순차 시도
    const candidates = [liEl, ...Array.from(liEl.querySelectorAll('a, div, img'))];
    log('info', `[listPhase] 후보 ${candidates.length}개에 dispatchEvent 순차 시도`);
    const urlBefore = location.href;

    for (let i = 0; i < candidates.length; i++) {
      if (this._stopped) return await this._finish(log);
      const el = candidates[i];
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(200);

      if (location.href !== urlBefore) {
        log('success', `[listPhase] 후보[${i}] 클릭 후 URL 변경 — 페이지 이동 발생 (재개 대기)`);
        return;
      }
      if (document.querySelector('div.calendar_title')) {
        log('success', `[listPhase] 후보[${i}] 클릭 후 SPA 라우팅으로 달력 등장 — detailPhase 직접 진행`);
        return await this._detailPhase(detailState, log);
      }
    }

    // 모든 후보 클릭 실패 → 다음 상품으로
    log('error', `[listPhase] 후보 ${candidates.length}개 모두 실패 — 상품[${state.productIndex}] 스킵, 다음 상품으로`);
    const skipState = { ...state, phase: 'list', productIndex: state.productIndex + 1, currentProductName: null };
    await this._saveState(skipState);
    location.href = this.entryUrl;
  }

  // ─── detailPhase: 상세 페이지에서 캘린더 처리 ─────────────────────

  async _detailPhase(state, log) {
    const productName = state.currentProductName || `상품[${state.productIndex}]`;
    log('info', `[detailPhase] 시작 — "${productName}" 캘린더 처리`);

    if (!location.href.includes('/items/')) {
      log('warn', `[detailPhase] 상세 페이지 아님 (${location.href}) → 목록으로 복귀`);
      const backState = { ...state, phase: 'list' };
      await this._saveState(backState);
      location.href = this.entryUrl;
      return;
    }

    // 캘린더 로딩 대기 (최대 12초, 200ms 폴링 → 빠른 감지)
    let calTitle = null;
    for (let i = 0; i < 60; i++) {
      if (this._stopped) return await this._finish(log);
      calTitle = document.querySelector('div.calendar_title');
      if (calTitle && /\d{4}\.\d{1,2}/.test(calTitle.textContent)) break;
      await sleep(200);
    }

    if (!calTitle || !/\d{4}\.\d{1,2}/.test(calTitle.textContent)) {
      log('error', `[detailPhase] 12초 후에도 캘린더 미발견 — 다음 상품으로`);
      const nextState = { ...state, phase: 'list', productIndex: state.productIndex + 1, currentProductName: null };
      await this._saveState(nextState);
      location.href = this.entryUrl;
      return;
    }

    log('success', `[detailPhase] 캘린더 발견 — title="${calTitle.textContent.trim().match(/\d{4}\.\d{1,2}/)[0]}"`);
    await sleep(150);

    let remainingDates = [...state.targetDates];

    for (let i = remainingDates.length - 1; i >= 0; i--) {
      if (this._stopped) return await this._finish(log);
      const targetDate = remainingDates[i];
      const reserved = await this._checkAndReserveDate(productName, targetDate, log, 'div.calendar_title', state.timeSlots);
      if (reserved) {
        log('success', `[detailPhase] ${targetDate} 예약 요청 완료 — 종료`);
        await this._finish(log);
        return;
      }
    }

    log('info', `[detailPhase] 이 상품으로 예약 가능 날짜 없음 → 다음 상품으로 이동`);
    const nextState = {
      ...state,
      phase: 'list',
      productIndex: state.productIndex + 1,
      targetDates: remainingDates,
      currentProductName: null,
    };
    await this._saveState(nextState);
    location.href = this.entryUrl;
  }

  // ─── STEP 1: 페이지 로딩 대기 ─────────────────────────────────────

  async _step1_waitForPage(log) {
    log('info', `[STEP1] 시작 — URL: ${location.href}`);
    log('info', `[STEP1] readyState: ${document.readyState}, title: "${document.title}"`);

    if (document.readyState === 'loading') {
      log('info', '[STEP1] DOM 로딩 중 — DOMContentLoaded 대기');
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    const waitSelector = [
      'div.section_home',
      'ul.list_bizitem',
      'div.booking_list',
      'div.wrap_item',
      '[class*="section_home"]',
      '[class*="list_biz"]',
      '[class*="HomeBookingList"]',
      '[class*="BookingList"]',
    ].join(', ');

    try {
      const el = await waitForElement(waitSelector, 15000, 500);
      log('success', `[STEP1] 페이지 로딩 완료 — <${el.tagName.toLowerCase()} class="${el.className}">`);
    } catch (e) {
      log('warn', '[STEP1] 15초 대기 후에도 상품 컨테이너 미발견. 계속 진행합니다.');
    }
  }

  // ─── STEP 2: 더보기 버튼 ──────────────────────────────────────────

  async _step2_clickMoreButton(log) {
    log('info', '[STEP2] 시작 — 더보기 버튼 탐색');
    await sleep(200);
    const moreBtn = document.querySelector('button.button_more');
    if (moreBtn) {
      log('info', '[STEP2] 더보기 버튼 발견 → 클릭');
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(400);
    } else {
      log('info', '[STEP2] 더보기 버튼 없음 — 전체 상품 이미 표시됨');
    }
  }

  // 상품 목록은 IntersectionObserver / scroll 이벤트 기반 lazy 로딩.
  // 단순 window.scrollTo만으로는 내부 스크롤 컨테이너를 거드리지 못할 수 있으므로
  // 마지막 상품에 scrollIntoView를 호출하여 모든 ancestor scroll container를 자동 처리한다.
  async _waitForFullProductList(log, maxWaitMs = 6000, pollIntervalMs = 300) {
    let prevCount = this._getProductElements().elements.length;
    log('info', `[listPhase] 초기 상품 수: ${prevCount} — lazy 로딩 트리거 시작 (최대 ${maxWaitMs}ms)`);

    const start = Date.now();
    let stableTicks = 0;
    let tickIdx = 0;

    while (Date.now() - start < maxWaitMs) {
      if (this._stopped) break;
      tickIdx++;

      const { elements: current } = this._getProductElements();

      if (current.length > 0) {
        try {
          current[current.length - 1].scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
        } catch (_) {}
      }

      const scrollH = Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0);
      window.scrollTo(0, scrollH);

      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));

      await sleep(pollIntervalMs);

      const newCount = this._getProductElements().elements.length;
      if (newCount !== prevCount) {
        log('info', `[listPhase] [tick ${tickIdx}] 상품 추가 로드됨: ${prevCount} → ${newCount}`);
        prevCount = newCount;
        stableTicks = 0;
      } else {
        stableTicks++;
        // 4회(~1.2s) 연속 변화 없으면 안정화로 간주 (300ms × 4)
        if (stableTicks >= 4) {
          log('info', `[listPhase] 상품 수 안정화 → ${prevCount}개 (${tickIdx} tick에서 조기 종료)`);
          break;
        }
      }
    }

    window.scrollTo(0, 0);
    await sleep(100);
    return prevCount;
  }

  _getProductElements() {
    const listItemSelectors = [
      '[class*="HomeBookingList__booking_item"]',
      '[class*="BookingList__booking_item"]',
      '[class*="booking_item"]',
      '[class*="HomeBookingList"] ul li',
      '[class*="BookingList"] ul li',
      'div.section_home.type_booking div ul li',
      'ul.list_bizitem li',
      'div.booking_list ul li',
      'div.wrap_item ul li',
      'li.item_bizitem',
    ];

    for (const liSel of listItemSelectors) {
      const lis = document.querySelectorAll(liSel);
      if (lis.length > 0) {
        return { elements: Array.from(lis), usedSelector: liSel };
      }
    }
    return { elements: [], usedSelector: null };
  }

  _surveyPage(log) {
    log('info', `[survey] URL: ${location.href}`);
    log('info', `[survey] title: "${document.title}"`);

    const probes = [
      '[class*="HomeBookingList__booking_item"]',
      '[class*="BookingList__booking_item"]',
      '[class*="booking_item"]',
      '[class*="HomeBookingList"]',
      '[class*="BookingList"]',
      'ul li',
      'a[href*="/items/"]',
    ];
    probes.forEach(sel => {
      log('info', `[survey] "${sel}" → ${document.querySelectorAll(sel).length}개`);
    });

    const tabsLike = Array.from(document.querySelectorAll('[class*="tab"], [class*="Tab"], [class*="category"], [class*="Category"]'))
      .slice(0, 10)
      .map(el => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}" "${el.textContent.trim().slice(0, 20)}">`);
    log('info', `[survey] tab/category 후보: [${tabsLike.join(' | ') || '없음'}]`);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [class*="section_title"], [class*="SectionTitle"]'))
      .slice(0, 10)
      .map(el => `<${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}">`);
    log('info', `[survey] 헤딩/섹션: [${headings.join(' | ') || '없음'}]`);
  }

  // ─── 날짜 탐색 + 예약 시도 ────────────────────────────────────────

  async _checkAndReserveDate(productName, targetDate, log, calTitleSelector = 'div.calendar_title', timeSlots = null) {
    try {
      const currentYearMonth = this._readCalendarYearMonth(calTitleSelector);
      if (!currentYearMonth) {
        const titleEl = document.querySelector(calTitleSelector);
        log('error', `[날짜탐색] 달력 타이틀 파싱 실패 — text="${titleEl ? titleEl.textContent.trim() : '(없음)'}"`);
        return false;
      }

      const monthDiff = getMonthDiff(currentYearMonth, targetDate);
      log('info', `[날짜탐색] "${productName}" ${targetDate} | 달력: "${currentYearMonth}" | monthDiff: ${monthDiff}`);

      if (monthDiff !== 0) {
        const moved = await this._navigateCalendar(monthDiff, targetDate, log);
        if (!moved) {
          log('warn', `[날짜탐색] "${productName}" ${targetDate}: 달력 이동 실패. 스킵.`);
          return false;
        }
        await sleep(250);
        const afterYM = this._readCalendarYearMonth(calTitleSelector);
        log('info', `[날짜탐색] 달력 이동 후 타이틀: "${afterYM || '(없음)'}"`);
      }

      // 셀 셀렉터 다중 폴백 — 캠핑장과 테니스장의 캘린더 DOM 미세 차이 대응
      const cellSelectors = [
        'table.calendar_table tbody.calendar_body tr.calendar_week td',
        'table.calendar_table tbody td',
        '[class*="calendar_table"] [class*="calendar_body"] td',
        '[class*="calendar_table"] tbody td',
        'table[class*="calendar"] tbody td',
        '[class*="Calendar"] table tbody td',
        '[class*="calendar"] table tbody td',
      ];

      let dateCells = [];
      let usedCellSel = '';
      for (const sel of cellSelectors) {
        const cells = document.querySelectorAll(sel);
        if (cells.length > 0) {
          dateCells = Array.from(cells);
          usedCellSel = sel;
          break;
        }
      }

      log('info', `[날짜탐색] 달력 셀 수: ${dateCells.length} (셀렉터: "${usedCellSel || '없음'}")`);

      if (dateCells.length === 0) {
        log('warn', `[날짜탐색] 달력 셀 0개 — 페이지 구조 진단:`);
        this._surveyCalendar(log);
        return false;
      }

      // 본 달 1일의 인덱스 찾기 — 이전/다음 달 잔여일의 같은 숫자(예: 27)와 혼동하지 않기 위함
      let firstOfMonthIdx = -1;
      for (let i = 0; i < dateCells.length; i++) {
        const numEl = dateCells[i].querySelector('span.num');
        if (numEl && numEl.textContent.trim() === '1') {
          firstOfMonthIdx = i;
          break;
        }
      }
      if (firstOfMonthIdx === -1) {
        log('error', `[날짜탐색] 본 달 1일 셀을 찾지 못함`);
        return false;
      }

      const targetDay = parseInt(targetDate.split('-')[2], 10);
      const targetIdx = firstOfMonthIdx + (targetDay - 1);

      if (targetIdx >= dateCells.length) {
        log('error', `[날짜탐색] "${productName}" ${targetDate}: targetIdx(${targetIdx}) >= 셀 수(${dateCells.length}) — 달력 행 부족`);
        return false;
      }

      const targetTd = dateCells[targetIdx];
      const btn = targetTd.querySelector('button.calendar_date');
      if (!btn) {
        log('error', `[날짜탐색] ${targetDate} 셀 내 <button.calendar_date> 없음. td HTML: ${targetTd.outerHTML.slice(0, 200)}`);
        return false;
      }

      const cellNumText = btn.querySelector('span.num')?.textContent.trim() ?? '';
      if (cellNumText !== String(targetDay) && cellNumText !== '오늘') {
        log('warn', `[날짜탐색] 인덱스 검증 불일치: targetDay=${targetDay}, cellNum="${cellNumText}". 그래도 진행.`);
      }

      const statusText = btn.querySelector('span.text')?.textContent.trim() || '';
      const ariaDisabled = btn.getAttribute('aria-disabled') === 'true';
      const isUnselectable = btn.classList.contains('unselectable');
      const isDisabled = btn.disabled || ariaDisabled || isUnselectable;

      log('info', `[날짜탐색] ${targetDate} 셀: cellNum="${cellNumText}", status="${statusText}", disabled=${btn.disabled}, ariaDisabled=${ariaDisabled}, unselectable=${isUnselectable}`);

      if (isDisabled) {
        const reason = statusText || (btn.classList.contains('dayoff') ? '휴무일' : 'disabled');
        log('error', `[날짜탐색] "${productName}" ${targetDate} 예약 불가 (${reason})`);
        return false;
      }

      log('success', `[날짜탐색] "${productName}" ${targetDate} 예약 가능 (${statusText || 'OK'}) → 버튼 클릭`);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(400);

      // 시간대 선택이 필요한 서비스(예: 테니스장)면 우선순위 순으로 시간대 클릭 시도
      if (Array.isArray(timeSlots) && timeSlots.length > 0) {
        const picked = await this._selectTimeSlot(timeSlots, log);
        if (!picked) {
          log('warn', `[날짜탐색] "${productName}" ${targetDate}: 사용 가능한 시간대가 없음 — 다음 날짜로`);
          return false;
        }
      }

      return await this._step5_submitReservation(productName, targetDate, log);

    } catch (err) {
      log('error', `[날짜탐색] "${productName}" ${targetDate} 오류: ${err.message}`);
      return false;
    }
  }

  // ─── 시간대 선택 (테니스장 등) ────────────────────────────────────
  // 네이버 예약 시간 슬롯 DOM:
  //   ul.time_list > li.time_item (.disabled / .selected) > span.time_text + button.btn_time
  //   span.time_text 내부에 .ampm("오전"/"오후")이 처음 등장하면 그 이후 li들은 같은 모드
  // 사용자가 popup에서 선택한 시간(24h)을 낮은 시각부터 순회하며 첫 가용 슬롯의 button.btn_time을 클릭한다.
  async _selectTimeSlot(targetHours, log) {
    log('info', `[시간대] 선택 시도: [${targetHours.map(h => String(h).padStart(2, '0') + ':00').join(', ')}]`);

    // 날짜 클릭 후 시간 슬라이더가 렌더링될 때까지 대기 (최대 5초, 200ms 폴링)
    let slots = [];
    for (let i = 0; i < 25; i++) {
      slots = this._collectTimeSlots();
      if (slots.length > 0) break;
      await sleep(200);
    }

    if (slots.length === 0) {
      log('warn', `[시간대] ul.time_list 또는 li.time_item을 찾지 못함 — 페이지 구조 진단:`);
      this._surveyTimeSlots(log);
      return false;
    }

    log('info', `[시간대] 슬롯 ${slots.length}개 발견`);
    slots.forEach((s, i) => {
      const hh = String(s.hour).padStart(2, '0');
      log('info', `[시간대]   [${i}] "${s.rawText}" (${s.ampm}) → ${hh}:00 disabled=${s.disabled}${s.selected ? ' selected' : ''}`);
    });

    // 우선순위 순(낮은 시각 → 높은 시각)으로 가용 슬롯 탐색
    for (const hour of targetHours) {
      const slot = slots.find(s => s.hour === hour);
      if (!slot) {
        log('info', `[시간대] ${String(hour).padStart(2, '0')}:00 슬롯이 페이지에 없음`);
        continue;
      }
      if (slot.disabled) {
        log('warn', `[시간대] ${String(hour).padStart(2, '0')}:00 disabled (예약 불가)`);
        continue;
      }

      const btn = slot.li.querySelector('button.btn_time');
      const clickTarget = btn || slot.li;
      log('success', `[시간대] ${String(hour).padStart(2, '0')}:00 클릭 (${btn ? 'button.btn_time' : 'li.time_item'})`);
      clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(300);
      return true;
    }

    log('error', `[시간대] 선택한 모든 시간대 사용 불가`);
    return false;
  }

  // ul.time_list 내부의 li.time_item을 수집하고 각 슬롯의 24h 시각·상태를 파싱
  //
  // 슬롯 텍스트 포맷 (네이버 예약):
  //   "오전 6시", "오후 12시", "오후 1시" — 각 li가 자체 ampm을 가질 수 있고
  //                                      또는 그룹의 첫 li에서만 ampm이 등장할 수도 있음.
  // 파싱 우선순위:
  //   1) li 내부 .ampm 엘리먼트 텍스트("오전"/"오후")
  //   2) li 전체 textContent의 "오전"/"오후" 키워드
  //   3) 둘 다 없으면 직전 li의 ampm을 그대로 유지 (carry-over)
  _collectTimeSlots() {
    let lis = Array.from(document.querySelectorAll('ul.time_list li.time_item'));
    if (lis.length === 0) {
      lis = Array.from(document.querySelectorAll('[class*="time_list"] [class*="time_item"]'));
    }
    if (lis.length === 0) return [];

    const slots = [];
    let ampm = 'am'; // 첫 슬롯 이전 기본값 (오전부터 시작한다는 일반 패턴 가정)

    for (const li of lis) {
      const liText = (li.textContent || '').replace(/\s+/g, '');

      // (1) .ampm 엘리먼트 우선
      const ampmEl = li.querySelector('.ampm');
      if (ampmEl) {
        const t = ampmEl.textContent.trim();
        if (t === '오전') ampm = 'am';
        else if (t === '오후') ampm = 'pm';
      }
      // (2) 텍스트 키워드 폴백
      else if (liText.includes('오전')) {
        ampm = 'am';
      } else if (liText.includes('오후')) {
        ampm = 'pm';
      }
      // (3) carry-over: ampm 변경 없이 직전 값 유지

      // 숫자+시 추출 — "오전6시", "오후12시", "7시" 모두 첫 매칭이 시간
      const timeTextEl = li.querySelector('.time_text');
      const text = (timeTextEl?.textContent || liText || '').trim();
      const m = text.match(/(\d{1,2})\s*시/);
      if (!m) continue;

      let hour = parseInt(m[1], 10);
      if (ampm === 'am') {
        if (hour === 12) hour = 0; // 오전 12시 = 자정
      } else {
        if (hour !== 12) hour += 12; // 오후 1~11시 → 13~23시 (오후 12시는 정오 그대로)
      }

      const disabled = li.classList.contains('disabled') || li.classList.contains('unselectable');
      const selected = li.classList.contains('selected');
      slots.push({ li, hour, ampm, disabled, selected, rawText: text });
    }

    return slots;
  }

  // 시간 슬롯을 못 찾았을 때 진단용
  _surveyTimeSlots(log) {
    const candidates = Array.from(document.querySelectorAll('[class*="time_list"], [class*="time_item"], [class*="calendar_time"], [class*="time_area"]'))
      .slice(0, 10)
      .map(el => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 60)}">`);
    log('info', `[시간대-survey] time_* 관련 요소: [${candidates.join(' | ') || '없음'}]`);

    const lis = Array.from(document.querySelectorAll('ul li'));
    log('info', `[시간대-survey] 전체 ul li: ${lis.length}개`);
  }

  // 달력 셀을 못 찾았을 때 진단용 — table/td/calendar 관련 요소를 광범위하게 출력
  _surveyCalendar(log) {
    const tables = Array.from(document.querySelectorAll('table'));
    log('info', `[달력-survey] <table> 개수: ${tables.length}`);
    tables.slice(0, 5).forEach((t, i) => {
      const tdCount = t.querySelectorAll('td').length;
      const tbodyCount = t.querySelectorAll('tbody').length;
      log('info', `[달력-survey]   table[${i}] class="${String(t.className).slice(0, 60)}" td=${tdCount} tbody=${tbodyCount}`);
    });

    const calClasses = Array.from(document.querySelectorAll('[class*="alendar"]'))
      .slice(0, 12)
      .map(el => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 50)}">`);
    log('info', `[달력-survey] "alendar" 포함 요소(상위 12): ${calClasses.join(' | ') || '없음'}`);

    // 캘린더 타이틀과 같은 부모 트리에 어떤 형제가 있는지
    const titleEl = document.querySelector('div.calendar_title');
    if (titleEl) {
      const parent = titleEl.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).map(
          ch => `<${ch.tagName.toLowerCase()} class="${String(ch.className).slice(0, 50)}">`
        );
        log('info', `[달력-survey] calendar_title 부모(<${parent.tagName.toLowerCase()} class="${String(parent.className).slice(0, 40)}">) 자식: ${siblings.join(' | ')}`);
      }
    }

    const totalTd = document.querySelectorAll('td').length;
    log('info', `[달력-survey] 전체 <td>: ${totalTd}개`);

    // 페이지에 iframe이 있는지 — 캘린더가 iframe 내부일 가능성
    const iframes = document.querySelectorAll('iframe');
    if (iframes.length > 0) {
      log('warn', `[달력-survey] iframe ${iframes.length}개 감지됨 — 캘린더가 iframe 내부일 수 있음`);
      iframes.forEach((f, i) => {
        log('warn', `[달력-survey]   iframe[${i}] src="${f.src.slice(0, 80)}"`);
      });
    }
  }

  _readCalendarYearMonth(calTitleSelector) {
    const titleEl = document.querySelector(calTitleSelector);
    if (!titleEl) return null;
    const m = titleEl.textContent.match(/(\d{4})\.(\d{1,2})/);
    if (!m) return null;
    return `${m[1]}.${m[2].padStart(2, '0')}`;
  }

  // ─── 달력 월 이동 ─────────────────────────────────────────────────

  async _navigateCalendar(monthDiff, targetDate, log) {
    if (Math.abs(monthDiff) > 6) {
      log('warn', `[달력이동] ${targetDate}: 탐색 범위(6개월) 초과. 스킵.`);
      return false;
    }

    const direction = monthDiff > 0 ? 'next' : 'prev';
    const steps = Math.abs(monthDiff);
    log('info', `[달력이동] 방향: ${direction}, ${steps}번 이동`);

    const btnSelector = direction === 'next'
      ? 'div.calendar_title button.btn_next'
      : 'div.calendar_title button.btn_prev';

    for (let i = 0; i < steps; i++) {
      const btn = document.querySelector(btnSelector);
      if (!btn) {
        log('error', `[달력이동] ${direction} 버튼 없음 (셀렉터: "${btnSelector}")`);
        return false;
      }
      if (btn.disabled || btn.classList.contains('disabled')) {
        log('error', `[달력이동] ${direction} 버튼이 disabled — 더 이상 이동할 수 없습니다`);
        return false;
      }

      log('info', `[달력이동] 버튼 클릭(${i + 1}/${steps}): class="${btn.className}"`);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(300);
    }

    return true;
  }

  // ─── STEP 5: 예약 요청 (다음 버튼 → /request 도달까지) ────────────
  // 결제 버튼은 절대 클릭하지 않는다 (사용자 수동 진행).

  async _step5_submitReservation(productName, targetDate, log) {
    log('info', `[STEP5] "${productName}" ${targetDate} — 다음 버튼 탐색 시작`);
    try {
      const nextSelectors = [
        "button[data-click-code='nextbuttonview.request']",
        'button.btn_next',
        "button[class*='btn_next']"
      ];

      let nextBtn = null;
      for (const sel of nextSelectors) {
        nextBtn = document.querySelector(sel);
        if (nextBtn) {
          log('info', `[STEP5] 다음 버튼 발견 (셀렉터: "${sel}"), disabled: ${nextBtn.disabled}`);
          break;
        }
      }

      if (!nextBtn) {
        const allBtns = Array.from(document.querySelectorAll('button')).map(
          b => `"${b.textContent.trim().slice(0,10)}" class="${b.className.slice(0,30)}" data="${b.dataset.clickCode || ''}"`
        );
        log('error', `[STEP5] 다음 버튼 없음. 현재 button 목록: [${allBtns.slice(0, 8).join(' | ')}]`);
        return false;
      }

      if (nextBtn.disabled) {
        log('warn', `[STEP5] 다음 버튼이 disabled 상태. 날짜 선택이 반영되지 않았을 수 있음.`);
        return false;
      }

      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      log('info', `[STEP5] 다음 버튼 클릭 완료 → /request 페이지 이동 대기`);

      for (let i = 0; i < 40; i++) {
        await sleep(200);
        if (isOnRequestPage()) {
          log('success', `[STEP5] /request 페이지 도달 — "${productName}" ${targetDate} 예약 요청 완료. 결제는 수동으로 진행해 주세요.`);
          return true;
        }
      }

      log('warn', `[STEP5] 8초 후에도 /request 페이지 미도달 (현재: ${location.pathname}). 예약이 정상 진행됐는지 확인 필요.`);
      return false;

    } catch (err) {
      log('error', `[STEP5] "${productName}" ${targetDate} 결제 처리 중 오류: ${err.message}`);
      return false;
    }
  }

  // ─── 상품 이름 추출 ───────────────────────────────────────────────

  _getProductName(productEl) {
    // 1순위: img alt — "{이름} 대표사진" 포맷에서 "대표사진" 접미사 제거
    const img = productEl.querySelector('img');
    if (img && img.alt) {
      return img.alt.replace(/\s*대표사진\s*$/, '').trim();
    }

    // 2순위: 텍스트 노드에서 숫자%·숫자원 패턴을 제외한 의미 있는 문자열
    const allText = Array.from(productEl.querySelectorAll('*'))
      .map(el => el.childNodes)
      .reduce((acc, nodes) => {
        nodes.forEach(n => { if (n.nodeType === 3) acc.push(n.textContent.trim()); });
        return acc;
      }, [])
      .filter(t => t.length > 1 && !/^\d+[%원,]/.test(t) && !/^[\d,]+$/.test(t));

    if (allText.length > 0) return allText[0].slice(0, 30);

    const fullText = productEl.textContent.replace(/\s+/g, ' ').trim();
    return fullText.slice(0, 20) || `상품[${productEl.closest('li')?.dataset?.index || '?'}]`;
  }
}
