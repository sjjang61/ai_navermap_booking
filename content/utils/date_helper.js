// 날짜 유틸리티

/**
 * 요일 선택 → 날짜 배열 생성
 * @param {number[]} dayOfWeeks - [0=일, 1=월, ..., 6=토]
 * @param {number} weeksAhead - 탐색 주 수
 * @returns {string[]} - 'yyyy-mm-dd' 형식 날짜 배열 (오름차순 정렬)
 */
function generateDatesByDayOfWeek(dayOfWeeks, weeksAhead) {
  const results = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + weeksAhead * 7);

  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1); // 오늘 이후부터

  while (cursor <= endDate) {
    if (dayOfWeeks.includes(cursor.getDay())) {
      results.push(formatDate(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return results;
}

/**
 * Date 객체 → 'yyyy-mm-dd' 문자열 변환
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 특정 날짜 배열에서 과거 날짜 제거 (오늘 포함)
 * @param {string[]} dates - 'yyyy-mm-dd' 형식
 * @returns {string[]}
 */
function filterFutureDates(dates) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return dates
    .filter(dateStr => {
      const d = new Date(dateStr);
      return d > today;
    })
    .sort();
}

/**
 * "yyyy.mm" + day 숫자 → "yyyy-mm-dd" 변환
 * @param {string} yearMonth - "2025.05" 형태
 * @param {string|number} day - "10" 또는 10
 * @returns {string} - "2025-05-10"
 */
function parseCalendarDate(yearMonth, day) {
  const [yyyy, mm] = yearMonth.split('.');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 달력 이동 횟수 계산 (현재 표시 월 기준)
 * @param {string} currentYearMonth - "2025.05" 형태
 * @param {string} targetDate - "2025-07-10" 형태
 * @returns {number} - 양수: 앞으로, 음수: 뒤로
 */
function getMonthDiff(currentYearMonth, targetDate) {
  const [curYear, curMonth] = currentYearMonth.split('.').map(Number);
  const target = new Date(targetDate);
  const targetYear = target.getFullYear();
  const targetMonth = target.getMonth() + 1;

  return (targetYear - curYear) * 12 + (targetMonth - curMonth);
}
