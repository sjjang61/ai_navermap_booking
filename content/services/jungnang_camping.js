// 중랑가족 캠핑장 예약 자동화 구현체
// 진입 URL: https://m.booking.naver.com/booking/5/bizes/387475
// (네이버 지도의 "예약" 버튼 href가 이 도메인으로 직접 연결됨)

class JungnangCampingService extends BaseReservationService {
  constructor() {
    super({
      serviceId: 'jungnang_camping',
      serviceName: '중랑가족 캠핑장',
      entryUrl: 'https://m.booking.naver.com/booking/5/bizes/387475?theme=place&service-target=map-pc&lang=ko&area=bmp&map-search=1'
    });
  }

  async run(targetDates, logCallback) {
    this.reset();
    const log = (level, msg) => this.log(logCallback, level, msg);

    try {
      let remainingDates = [...targetDates];

      log('loading', '예약 페이지 로딩 대기 중...');
      await this._step1_waitForPage(log);
      if (this._stopped) return;

      await this._step2_clickMoreButton(log);
      if (this._stopped) return;

      const productCount = await this._step3_collectProducts(log);
      if (this._stopped) return;
      if (productCount === 0) {
        log('error', '상품 목록이 비어있습니다. 실행을 중단합니다.');
        return;
      }

      for (let i = 0; i < productCount; i++) {
        if (this._stopped) break;
        if (remainingDates.length === 0) {
          log('success', '모든 대상 날짜 예약 완료!');
          break;
        }
        remainingDates = await this._step4_processProduct(i, remainingDates, log);
      }

      if (remainingDates.length > 0) {
        log('warn', `예약 가능한 날짜를 찾지 못했습니다: ${remainingDates.join(', ')}`);
      } else {
        log('success', '모든 예약 처리가 완료되었습니다.');
      }

    } catch (err) {
      log('error', `실행 중 오류 발생: ${err.message}`);
    }
  }

  // ─── STEP 1: 페이지 로딩 대기 ─────────────────────────────────────

  async _step1_waitForPage(log) {
    log('info', `[STEP1] 현재 URL: ${location.href}`);
    try {
      const selector = 'div.section_home, ul.list_bizitem, div.booking_list, div.wrap_item';
      await waitForElement(selector, 15000, 400);
      log('success', '[STEP1] 예약 페이지 진입 완료');
    } catch (e) {
      await sleep(2000);
      log('warn', `[STEP1] 페이지 로딩 대기 타임아웃. 현재 URL: ${location.href} — 계속 진행합니다.`);
    }
  }

  // ─── STEP 2: 더보기 버튼 ──────────────────────────────────────────

  async _step2_clickMoreButton(log) {
    await sleep(500);
    const moreBtn = document.querySelector('button.button_more');
    if (moreBtn) {
      log('info', '[STEP2] 더보기 버튼 클릭');
      moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(800);
    } else {
      log('info', '[STEP2] 더보기 버튼 없음 — 전체 상품 이미 표시됨');
    }
  }

  // ─── STEP 3: 상품 목록 수집 ───────────────────────────────────────

  async _step3_collectProducts(log) {
    await sleep(300);
    const { elements, usedSelector } = this._getProductElements();
    const count = elements.length;

    if (count === 0) {
      // 매칭된 셀렉터가 없을 때 실제 DOM 힌트 출력
      const bodySnippet = document.body.innerHTML.slice(0, 300).replace(/\s+/g, ' ');
      log('error', `[STEP3] 상품 목록 탐색 실패. body 앞부분: ${bodySnippet}`);
      return 0;
    }

    log('info', `[STEP3] 상품 ${count}개 발견 (셀렉터: "${usedSelector}")`);
    elements.forEach((el, i) => {
      log('info', `[STEP3] 상품[${i}]: ${this._getProductName(el)}`);
    });
    return count;
  }

  _getProductElements() {
    const selectors = [
      'div.section_home.type_booking div ul li a',
      'ul.list_bizitem li a',
      'div.booking_list ul li a',
      'div.wrap_item ul li a',
      'li.item_bizitem a'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) return { elements: Array.from(els), usedSelector: sel };
    }
    return { elements: [], usedSelector: null };
  }

  // ─── STEP 4: 상품별 처리 ──────────────────────────────────────────

  async _step4_processProduct(productIndex, remainingDates, log) {
    const { elements: products } = this._getProductElements();
    if (productIndex >= products.length) {
      log('warn', `[STEP4] 상품 인덱스 ${productIndex} 접근 불가 (총 ${products.length}개). 스킵.`);
      return remainingDates;
    }

    const product = products[productIndex];
    const productName = this._getProductName(product);
    log('info', `[STEP4] 상품[${productIndex}] "${productName}" 클릭 → 상세 페이지 진입`);

    product.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // 달력 로딩 대기 — 실패 시 현재 DOM 상태 출력
    try {
      await waitForElement('div.calendar_title', 10000, 300);
    } catch (e) {
      const snippet = document.body.innerHTML.slice(0, 400).replace(/\s+/g, ' ');
      log('error', `[STEP4] "${productName}" 달력 로딩 실패. 현재 URL: ${location.href}`);
      log('error', `[STEP4] DOM 힌트: ${snippet}`);
      await this._goBackToProductList(log);
      return remainingDates;
    }

    await sleep(500);

    // 달력 타이틀 실제값 출력
    const titleEl = document.querySelector('div.calendar_title');
    const calendarTitle = titleEl ? titleEl.textContent.trim() : '(없음)';
    log('info', `[STEP4] "${productName}" 달력 로딩 완료. 달력 타이틀: "${calendarTitle}"`);

    for (let i = remainingDates.length - 1; i >= 0; i--) {
      if (this._stopped) break;
      const targetDate = remainingDates[i];
      const reserved = await this._checkAndReserveDate(productName, targetDate, log);
      if (reserved) {
        remainingDates = remainingDates.filter((_, idx) => idx !== i);
        await this._goBackToProductList(log);
        return remainingDates;
      }
    }

    await this._goBackToProductList(log);
    return remainingDates;
  }

  // ─── 날짜 탐색 + 예약 시도 ────────────────────────────────────────

  async _checkAndReserveDate(productName, targetDate, log) {
    try {
      // 달력 타이틀 확인
      const titleEl = document.querySelector('div.calendar_title');
      if (!titleEl) {
        log('error', `[날짜탐색] div.calendar_title 없음 — 셀렉터 불일치 가능성`);
        return false;
      }

      const currentYearMonth = titleEl.textContent.trim();
      const monthDiff = getMonthDiff(currentYearMonth, targetDate);
      log('info', `[날짜탐색] "${productName}" ${targetDate} | 달력: "${currentYearMonth}" | monthDiff: ${monthDiff}`);

      // 달력 월 이동
      if (monthDiff !== 0) {
        const moved = await this._navigateCalendar(monthDiff, targetDate, log);
        if (!moved) {
          log('warn', `[날짜탐색] "${productName}" ${targetDate}: 달력 이동 실패. 스킵.`);
          return false;
        }
        await sleep(500);

        // 이동 후 타이틀 재확인
        const afterTitle = document.querySelector('div.calendar_title');
        log('info', `[날짜탐색] 달력 이동 후 타이틀: "${afterTitle ? afterTitle.textContent.trim() : '(없음)'}"`);
      }

      // 날짜 셀 수집
      const dateCells = document.querySelectorAll(
        'table.calendar_table tbody.calendar_body tr.calendar_week td'
      );
      log('info', `[날짜탐색] 달력 셀 수: ${dateCells.length} (셀렉터: table.calendar_table ...)`);

      if (dateCells.length === 0) {
        // 셀렉터가 틀렸을 가능성 — 달력 관련 DOM 힌트 출력
        const calEl = document.querySelector('table, [class*="calendar"]');
        log('warn', `[날짜탐색] 달력 셀 0개. 달력 관련 요소: ${calEl ? calEl.className : '없음'}`);
      }

      const targetDay = String(parseInt(targetDate.split('-')[2]));
      const calYM = document.querySelector('div.calendar_title')?.textContent.trim() ?? '';

      let foundCell = false;
      for (const td of dateCells) {
        const numEl = td.querySelector('span.num');
        const textEl = td.querySelector('span.text');
        if (!numEl) continue;

        const dayNum = numEl.textContent.trim();
        if (dayNum !== targetDay) continue;

        foundCell = true;
        const cellDate = parseCalendarDate(calYM, dayNum);
        const statusText = textEl ? textEl.textContent.trim() : '';
        log('info', `[날짜탐색] 날짜 셀 발견: dayNum="${dayNum}", cellDate="${cellDate}", status="${statusText}", td.class="${td.className}"`);

        if (cellDate !== targetDate) {
          log('warn', `[날짜탐색] cellDate(${cellDate}) ≠ targetDate(${targetDate}) — 월 불일치, 스킵`);
          continue;
        }

        if (statusText === '매진') {
          log('error', `[날짜탐색] "${productName}" ${targetDate} 매진`);
          return false;
        }

        log('success', `[날짜탐색] "${productName}" ${targetDate} 예약 가능 → 날짜 셀 클릭`);
        td.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(1000);

        return await this._step5_submitReservation(productName, targetDate, log);
      }

      if (!foundCell) {
        log('warn', `[날짜탐색] "${productName}" ${targetDate}: day="${targetDay}"인 셀 없음. 달력: "${calYM}"`);
      }
      return false;

    } catch (err) {
      log('error', `[날짜탐색] "${productName}" ${targetDate} 오류: ${err.message}`);
      return false;
    }
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

    const nextSelectors = 'button.calendar_next, [class*="btn_next"], [aria-label="다음 달"], [aria-label="다음달"]';
    const prevSelectors = 'button.calendar_prev, [class*="btn_prev"], [aria-label="이전 달"], [aria-label="이전달"]';

    for (let i = 0; i < steps; i++) {
      const selectorStr = direction === 'next' ? nextSelectors : prevSelectors;
      const btn = document.querySelector(selectorStr);

      if (!btn) {
        // 버튼 못 찾으면 실제 존재하는 button 목록 출력
        const allBtns = Array.from(document.querySelectorAll('button')).map(
          b => `"${b.className}" aria="${b.getAttribute('aria-label') || ''}"`.slice(0, 60)
        );
        log('error', `[달력이동] 이동 버튼(${direction}) 없음. 페이지의 button 목록: [${allBtns.slice(0, 6).join(' | ')}]`);
        return false;
      }

      log('info', `[달력이동] 버튼 클릭: class="${btn.className}", aria="${btn.getAttribute('aria-label') || ''}"`);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(600);
    }

    return true;
  }

  // ─── STEP 5: 예약 제출 ────────────────────────────────────────────

  async _step5_submitReservation(productName, targetDate, log) {
    log('info', `[STEP5] "${productName}" ${targetDate} — 날짜 클릭 후 다음 버튼 탐색 시작`);
    try {
      // 다음 버튼 — waitForElement로 등장 대기 후 탐색
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
        log('info', `[STEP5] 다음 버튼 미발견 (셀렉터: "${sel}")`);
      }

      if (!nextBtn) {
        // 모든 button 목록 출력
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

      nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      log('info', `[STEP5] 다음 버튼 클릭 완료. 결제 화면 대기 중 (1.5s)...`);
      await sleep(1500);

      // 결제 버튼 탐색
      const submitSelectors = [
        "button[data-click-code='submitbutton.submit']",
        'button.btn_submit',
        "button[class*='btn_submit']"
      ];

      let submitBtn = null;
      for (const sel of submitSelectors) {
        submitBtn = document.querySelector(sel);
        if (submitBtn) {
          log('info', `[STEP5] 결제 버튼 발견 (셀렉터: "${sel}"), disabled: ${submitBtn.disabled}`);
          break;
        }
        log('info', `[STEP5] 결제 버튼 미발견 (셀렉터: "${sel}")`);
      }

      if (!submitBtn) {
        const allBtns = Array.from(document.querySelectorAll('button')).map(
          b => `"${b.textContent.trim().slice(0,10)}" class="${b.className.slice(0,30)}" data="${b.dataset.clickCode || ''}"`
        );
        log('error', `[STEP5] 결제 버튼 없음. 현재 button 목록: [${allBtns.slice(0, 8).join(' | ')}]`);
        return false;
      }

      if (submitBtn.disabled) {
        log('warn', `[STEP5] 결제 버튼이 disabled 상태.`);
        return false;
      }

      submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(2000);

      log('success', `[STEP5] "${productName}" ${targetDate} 예약 요청 완료!`);
      return true;

    } catch (err) {
      log('error', `[STEP5] "${productName}" ${targetDate} 결제 처리 중 오류: ${err.message}`);
      return false;
    }
  }

  // ─── 목록으로 복귀 ────────────────────────────────────────────────

  async _goBackToProductList(log) {
    log('info', '[복귀] 상품 목록으로 복귀 중...');
    try {
      history.back();
      await sleep(1500);
      await waitForElement(
        'div.section_home.type_booking, ul.list_bizitem, div.booking_list',
        8000, 300
      );
      await sleep(300);
      log('info', '[복귀] 상품 목록 복귀 완료');
    } catch (e) {
      log('warn', `[복귀] 목록 복귀 대기 실패 (${e.message}). 계속 진행.`);
      await sleep(1000);
    }
  }

  // ─── 상품 이름 추출 ───────────────────────────────────────────────

  _getProductName(productEl) {
    const img = productEl.querySelector('img');
    if (img && img.alt) return img.alt;
    const textEl = productEl.querySelector('.name, .title, strong, em, span');
    if (textEl) return textEl.textContent.trim();
    return productEl.textContent.trim().slice(0, 20) || '상품';
  }
}
