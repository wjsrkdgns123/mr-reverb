// 후원·문의 링크 — 송출기 메인 화면과 후원 페이지가 함께 씁니다.
// 비워 두면 해당 버튼이 숨겨집니다.
window.MR_LINKS = {
  toonation: 'https://toon.at/donate/kanghoon',   // 투네이션 후원 페이지 주소 (예: https://toon.at/donate/아이디) — 기본 후원 수단
  toss: '',        // 토스 익명 송금 링크 (예: https://toss.me/아이디)
  kakaopay: '',    // 카카오페이 송금 링크 (예: https://qr.kakaopay.com/...)
  bmc: '',         // Buy Me a Coffee 주소
  bank: '',        // 계좌 — 통장 묶기 사기 위험이 있어 비워 두는 걸 권장
  contact: '',     // 문의용 주소 (오픈채팅·디스코드·이메일 mailto: 등)
};

// 위에서부터 순서대로 표시. 첫 번째 항목이 후원 페이지에서 가장 크게 보인다.
window.MR_DONATE_ITEMS = [
  ['toonation', '💜 투네이션으로 후원하기'],
  ['toss', '💙 토스로 후원'],
  ['kakaopay', '💛 카카오페이로 후원'],
  ['bmc', '☕ Buy Me a Coffee'],
];
