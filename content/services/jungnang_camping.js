// 중랑가족 캠핑장 예약 자동화 구현체
// 메타데이터(serviceId, serviceName, entryUrl)는 shared/services_config.js에서 관리

class JungnangCampingService extends BaseReservationService {
  constructor() {
    super(SERVICES_CONFIG.jungnang_camping);
  }

  async run(opts, logCallback) {
    this.reset();
    const log = (level, msg) => this.log(logCallback, level, msg);
    const { targetDates = [], titleFilter = '', maxProducts = 0, searchDirection = 'forward' } = opts || {};

    try {
      // /request 페이지 도달 시 — 예약 확인/결제 단계 진입 성공. 결제는 사용자 수동 진행.
      if (isOnRequestPage()) {
        log('success', `[RUN] /request 페이지 도달 (${location.href}) — 매크로 종료, 결제는 수동으로 진행하세요.`);
        await this._finish(log);
        return;
      }

      // 페이지 이동 시 content script가 재로드되므로 한 번의 run() 호출은
      // 한 phase만 실행하고 다음 phase는 storage 기반으로 재개된다.
      const state = await this._loadOrInitState(targetDates, titleFilter, maxProducts, searchDirection, log);
      log('info', `[RUN] phase=${state.phase}, productIndex=${state.productIndex}, 남은 날짜=${state.targetDates.join(', ')}, filter="${state.titleFilter || '(없음)'}", maxProducts=${state.maxProducts || 0} (0=전체), direction=${state.searchDirection}, URL=${location.href}`);

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

  async _loadOrInitState(targetDates, titleFilter, maxProducts, searchDirection, log) {
    const stored = await chrome.storage.local.get('macroState');
    let state = stored.macroState;

    if (!state || state.serviceId !== this.serviceId) {
      state = {
        serviceId: this.serviceId,
        targetDates: [...targetDates],
        titleFilter: titleFilter || '',
        maxProducts: Number.isFinite(maxProducts) && maxProducts >= 0 ? maxProducts : 0,
        searchDirection: searchDirection === 'backward' ? 'backward' : 'forward',
        productIndex: 0,
        phase: 'list',
        currentProductName: null,
        createdAt: Date.now(),
      };
      await chrome.storage.local.set({ macroState: state, isRunning: true });
      log('info', `[INIT] 새 macroState 생성 (targetDates=${state.targetDates.join(', ')}, filter="${state.titleFilter}", maxProducts=${state.maxProducts}, direction=${state.searchDirection})`);
    } else {
      // 기존 state에 searchDirection이 없을 수도 있으므로 폴백
      if (!state.searchDirection) state.searchDirection = 'forward';
      log('info', `[INIT] 기존 macroState 재개 (filter="${state.titleFilter || ''}", maxProducts=${state.maxProducts || 0}, direction=${state.searchDirection})`);
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
    if (location.href.includes('/items/')) {
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

    // 상품 목록은 lazy 로딩되므로 스크롤로 트리거 + 3초간 폴링
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

    const annotated = products.map((el, originalIdx) => ({ el, originalIdx, name: this._getProductName(el) }));
    let matchedAll = filter ? annotated.filter(p => filter.test(p.name)) : annotated;

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
      await sleep(400);

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

    // 캘린더 로딩 대기 (최대 12초)
    let calTitle = null;
    for (let i = 0; i < 24; i++) {
      if (this._stopped) return await this._finish(log);
      calTitle = document.querySelector('div.calendar_title');
      if (calTitle && /\d{4}\.\d{1,2}/.test(calTitle.textContent)) break;
      await sleep(500);
    }

    if (!calTitle || !/\d{4}\.\d{1,2}/.test(calTitle.textContent)) {
      log('error', `[detailPhase] 12초 후에도 캘린더 미발견 — 다음 상품으로`);
      const nextState = { ...state, phase: 'list', productIndex: state.productIndex + 1, currentProductName: null };
      await this._saveState(nextState);
      location.href = this.entryUrl;
      return;
    }

    log('success', `[detailPhase] 캘린더 발견 — title="${calTitle.textContent.trim().match(/\d{4}\.\d{1,2}/)[0]}"`);
    await sleep(300);

    let remainingDates = [...state.targetDates];

    for (let i = remainingDates.length - 1; i >= 0; i--) {
      if (this._stopped) return await this._finish(log);
      const targetDate = remainingDates[i];
      const reserved = await this._checkAndReserveDate(productName, targetDate, log);
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

    // readyState가 loading이면 DOMContentLoaded 대기
    if (document.readyState === 'loading') {
      log('info', '[STEP1] DOM 로딩 중 — DOMContentLoaded 대기');
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    // 상품 컨테이너 대기 (최대 15초, 500ms 폴링)
    const waitSelector = [
      'div.section_home',
      'ul.list_bizitem',
      'div.booking_list',
      'div.wrap_item',
      '[class*="section_home"]',
      '[class*="list_biz"]',
    ].join(', ');

    try {
      const el = await waitForElement(waitSelector, 15000, 500);
      log('success', `[STEP1] 페이지 로딩 완료 — <${el.tagName.toLowerCase()} class="${el.className}">`);
    } catch (e) {
      log('warn', '[STEP1] 15초 대기 후에도 상품 컨테이너 미발견. 현재 DOM 상태 출력:');
      const allClasses = [...new Set(
        Array.from(document.querySelectorAll('[class]'))
          .flatMap(el => String(el.className).trim().split(/\s+/))
          .filter(c => c.length > 3)
      )].slice(0, 50);
      log('warn', `[STEP1] 페이지 클래스 목록: ${allClasses.join(', ')}`);
      log('warn', '[STEP1] 계속 진행합니다.');
    }
  }

  // ─── STEP 2: 더보기 버튼 ──────────────────────────────────────────

  async _step2_clickMoreButton(log) {
    log('info', '[STEP2] 시작 — 더보기 버튼 탐색');
    await sleep(500);
    const moreBtn = document.querySelector('button.button_more');
    if (moreBtn) {
      log('info', '[STEP2] 더보기 버튼 발견 → 클릭');
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(800);
      log('info', '[STEP2] 더보기 버튼 클릭 완료');
    } else {
      log('info', '[STEP2] 더보기 버튼 없음 — 전체 상품 이미 표시됨');
    }
  }

  // ─── STEP 3: 상품 목록 수집 ───────────────────────────────────────

  async _step3_collectProducts(log) {
    log('info', '[STEP3] 시작 — 상품 목록 수집');
    await sleep(300);
    const { elements, usedSelector } = this._getProductElements();
    const count = elements.length;

    if (count === 0) {
      // 상품 링크(<a>) 전체 탐색으로 힌트 제공
      const allLinks = Array.from(document.querySelectorAll('a')).map(
        a => `href="${a.getAttribute('href') || ''}" class="${String(a.className).slice(0, 30)}" text="${a.textContent.trim().slice(0, 15)}"`
      ).slice(0, 10);
      log('error', `[STEP3] 상품 목록 탐색 실패. 페이지 내 <a> 링크: [${allLinks.join(' | ')}]`);

      const allLists = Array.from(document.querySelectorAll('ul, ol, li')).map(
        el => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 30)}">`
      ).slice(0, 10);
      log('error', `[STEP3] 페이지 내 목록 요소: [${allLists.join(', ')}]`);
      return 0;
    }

    log('info', `[STEP3] 상품 ${count}개 발견 (셀렉터: "${usedSelector}")`);
    elements.forEach((el, i) => {
      log('info', `[STEP3] 상품[${i}]: "${this._getProductName(el)}" class="${String(el.className).slice(0, 40)}"`);
    });
    return count;
  }

  // 상품 목록은 IntersectionObserver / scroll 이벤트 기반 lazy 로딩.
  // 단순 window.scrollTo만으로는 내부 스크롤 컨테이너를 거드리지 못할 수 있으므로
  // 마지막 상품에 scrollIntoView를 호출하여 모든 ancestor scroll container를 자동 처리한다.
  async _waitForFullProductList(log, maxWaitMs = 8000, pollIntervalMs = 600) {
    let prevCount = this._getProductElements().elements.length;
    log('info', `[listPhase] 초기 상품 수: ${prevCount} — lazy 로딩 트리거 시작 (최대 ${maxWaitMs}ms)`);

    const start = Date.now();
    let stableTicks = 0;
    let tickIdx = 0;

    while (Date.now() - start < maxWaitMs) {
      if (this._stopped) break;
      tickIdx++;

      const { elements: current } = this._getProductElements();

      // (1) 가장 마지막 상품을 viewport로 끌어옴 → IntersectionObserver 발동
      //     scrollIntoView는 ancestor scroll container를 모두 자동으로 스크롤해줌
      if (current.length > 0) {
        try {
          current[current.length - 1].scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
        } catch (_) {}
      }

      // (2) window 자체도 끝까지 스크롤 (페이지 스크롤 기반 lazy load 대응)
      const scrollH = Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0);
      window.scrollTo(0, scrollH);

      // (3) scroll 이벤트 강제 dispatch (이벤트 리스너 기반 lazy load 대응)
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
        log('info', `[listPhase] [tick ${tickIdx}] 변화 없음 (현재 ${prevCount}개, 연속 ${stableTicks}회)`);
        // 3회(~1.8s) 연속 변화 없으면 안정화로 간주하고 조기 종료
        if (stableTicks >= 3) {
          log('info', `[listPhase] 상품 수 안정화 → ${prevCount}개 (조기 종료)`);
          break;
        }
      }
    }

    // 이후 클릭 좌표/뷰포트에 영향 없도록 상단으로 복귀
    window.scrollTo(0, 0);
    await sleep(300);
    return prevCount;
  }

  _getProductElements() {
    // <li> 단위로 수집 — 이름 추출과 클릭 대상 탐색 모두 <li> 기준으로 처리
    //
    // 페이지가 카테고리/섹션별로 분리되어 있을 수 있으므로
    // 가장 먼저 booking_item 클래스를 직접 잡는 방식을 시도한다.
    // (HomeBookingList__booking_item__XXXX 처럼 CSS Module 해시가 붙어있어도 매칭됨)
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

  // 페이지 구조 진단 로그 — 상품이 예상보다 적게 잡힐 때 호출하여
  // 카테고리/탭/섹션/오토캠핑 텍스트 위치를 조사한다.
  _surveyPage(log) {
    log('info', `[survey] URL: ${location.href}`);
    log('info', `[survey] title: "${document.title}"`);

    // 각 셀렉터별 매칭 카운트
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

    // "오토캠핑" 텍스트가 들어간 leaf 요소 위치
    const camp = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && el.textContent && el.textContent.includes('오토캠핑'));
    log('info', `[survey] "오토캠핑" 포함 leaf 요소: ${camp.length}개`);
    camp.slice(0, 8).forEach((el, i) => {
      log('info', `[survey]   캠핑[${i}] <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 50)}"> "${el.textContent.trim().slice(0, 40)}"`);
    });

    // 탭/카테고리 후보
    const tabsLike = Array.from(document.querySelectorAll('[class*="tab"], [class*="Tab"], [class*="category"], [class*="Category"]'))
      .slice(0, 10)
      .map(el => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}" "${el.textContent.trim().slice(0, 20)}">`);
    log('info', `[survey] tab/category 후보: [${tabsLike.join(' | ') || '없음'}]`);

    // 섹션/헤딩
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [class*="section_title"], [class*="SectionTitle"]'))
      .slice(0, 10)
      .map(el => `<${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 30)}">`);
    log('info', `[survey] 헤딩/섹션: [${headings.join(' | ') || '없음'}]`);
  }

  // ─── 날짜 탐색 + 예약 시도 ────────────────────────────────────────

  async _checkAndReserveDate(productName, targetDate, log, calTitleSelector = 'div.calendar_title') {
    try {
      const cellSelector = 'table.calendar_table tbody.calendar_body tr.calendar_week td';

      // 1. 달력 타이틀에서 yyyy.mm 추출 (타이틀 내부에 prev/next 버튼 포함)
      const currentYearMonth = this._readCalendarYearMonth(calTitleSelector);
      if (!currentYearMonth) {
        const titleEl = document.querySelector(calTitleSelector);
        log('error', `[날짜탐색] 달력 타이틀 파싱 실패 — text="${titleEl ? titleEl.textContent.trim() : '(없음)'}"`);
        return false;
      }

      const monthDiff = getMonthDiff(currentYearMonth, targetDate);
      log('info', `[날짜탐색] "${productName}" ${targetDate} | 달력: "${currentYearMonth}" | monthDiff: ${monthDiff}`);

      // 2. 달력 월 이동
      if (monthDiff !== 0) {
        const moved = await this._navigateCalendar(monthDiff, targetDate, log);
        if (!moved) {
          log('warn', `[날짜탐색] "${productName}" ${targetDate}: 달력 이동 실패. 스킵.`);
          return false;
        }
        await sleep(500);
        const afterYM = this._readCalendarYearMonth(calTitleSelector);
        log('info', `[날짜탐색] 달력 이동 후 타이틀: "${afterYM || '(없음)'}"`);
      }

      // 3. 날짜 셀 수집
      const dateCells = Array.from(document.querySelectorAll(cellSelector));
      log('info', `[날짜탐색] 달력 셀 수: ${dateCells.length}`);
      if (dateCells.length === 0) {
        log('warn', `[날짜탐색] 달력 셀 0개 — DOM 구조 변경 가능성`);
        return false;
      }

      // 4. 본 달 1일의 인덱스 찾기
      //    네이버 달력은 이전/다음 달 잔여일도 같은 숫자(예: 27)로 표시하므로,
      //    숫자 매칭만으로는 이전 달 27일을 본 달 27일로 오인할 수 있다.
      //    첫 번째로 등장하는 "1"이 본 달 1일이며, 그 인덱스로부터 (day-1) offset이 본 달 day의 위치다.
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

      // 인덱스 매핑이 맞는지 셀의 숫자로 한 번 더 검증 (오늘 셀은 "오늘"로 표시되므로 예외 허용)
      const cellNumText = btn.querySelector('span.num')?.textContent.trim() ?? '';
      if (cellNumText !== String(targetDay) && cellNumText !== '오늘') {
        log('warn', `[날짜탐색] 인덱스 검증 불일치: targetDay=${targetDay}, cellNum="${cellNumText}". 그래도 진행.`);
      }

      // 5. 예약 가능 여부 판단
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
      await sleep(1000);

      return await this._step5_submitReservation(productName, targetDate, log);

    } catch (err) {
      log('error', `[날짜탐색] "${productName}" ${targetDate} 오류: ${err.message}`);
      return false;
    }
  }

  // 달력 타이틀에서 yyyy.mm 추출 (타이틀 div 안에 prev/next 버튼·SVG가 포함되어 있어 정규식 사용)
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
      await sleep(600);
    }

    return true;
  }

  // ─── STEP 5: 예약 제출 ────────────────────────────────────────────
  //  - "다음" 버튼 클릭으로 /request 페이지(예약 확인) 진입까지만 자동화한다.
  //  - 결제는 사용자가 직접 진행하므로 결제 버튼은 절대 클릭하지 않는다.

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

      // /request URL 도달까지 대기 (최대 8초). 도달 즉시 성공 처리.
      for (let i = 0; i < 16; i++) {
        await sleep(500);
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

    // 3순위: 전체 텍스트에서 첫 의미 있는 부분
    const fullText = productEl.textContent.replace(/\s+/g, ' ').trim();
    return fullText.slice(0, 20) || `상품[${productEl.closest('li')?.dataset?.index || '?'}]`;
  }
}
