// Evaluated in the page, using only rendered labels, amounts and controls. A state-only sketch
// can pass the interaction check, but supplies no evidence that it debits the right amount.
export async function refundArithmetic() {
  const money = /\s*[:=]?\s*[$£€]?\s*(-?[\d,]+(?:\.\d+)?)\s*(cents?\b|¢)?/i;
  const cents = match => match ? Math.round(Number(match[1].replaceAll(",", "")) * (match[2] ? 1 : 100)) : undefined;
  const amountAfter = label => cents(document.body.innerText.match(new RegExp(`(?:${label})${money.source}`, "i")));
  const total = amountAfter("order total|total order amount|order amount|\\btotal");
  const paid = () => amountAfter("total refunded|already refunded|refunded so far");
  const balance = () => amountAfter("remaining(?: refundable)?(?: balance| amount)?|available to refund|refundable balance")
    ?? (total - paid());
  const usable = el => !el.matches(":disabled,[aria-disabled=true]") && el.getClientRects().length;
  const controls = () => [...document.querySelectorAll('button,input[type=button],input[type=submit],[role=button]')].filter(usable);
  const label = el => el.innerText || el.value || el.getAttribute("aria-label") || "";
  const start = balance();
  if (!Number.isSafeInteger(start) || start <= 1) return "no measurable order balance";
  const order = total ?? start + (paid() ?? 0);
  if (start + (paid() ?? 0) !== order) return "opening balance does not match the order total";
  let remaining = start, debits = 0;
  // Two different installments distinguish accumulation from a preset decrement or a reset.
  // With fixed-amount buttons, read the displayed installment instead of inventing one.
  for (let installment = 0; installment < 16; installment++) {
    const exhausted = remaining === 0;
    let amount = installment === 0 ? Math.max(1, Math.floor(start / 3 / 100) * 100 || Math.floor(start / 3)) : remaining || start;
    let approved = false, supplied = false;
    const tried = new Set();
    for (let step = 0; step < 8; step++) {
      const field = [...document.querySelectorAll('input[type=number],input[inputmode=decimal]')].find(usable);
      if (field) {
        supplied = true;
        field.value = String(amount / 100);
        for (const type of ["input", "change"]) field.dispatchEvent(new Event(type, { bubbles: true }));
      }
      const buttons = controls();
      const click = [/\bapprove\b/i, /mark.*refund|issue refund|complete refund|^refund$/i, /\brequest\b|\bsubmit\b/i]
        .map(pattern => buttons.find(el => pattern.test(label(el)) && !tried.has(el))).find(Boolean);
      if (!click) break;
      if (/\bapprove\b/i.test(label(click))) {
        approved = true;
        if (!supplied) {
          const fixed = cents(label(click).match(/[$£€]\s*(\d+(?:\.\d+)?)/) ?? label(click).match(/(\d+)\s*(cents?|¢)/i));
          if (fixed > 0) { amount = fixed; supplied = true; }
        }
      }
      const before = document.body.innerHTML;
      click.click();
      await new Promise(done => setTimeout(done, 20));
      const after = balance(), refunded = paid();
      if (refunded !== undefined && (refunded < 0 || refunded > order - after)) return "refunded amount exceeds the debit";
      if (after !== remaining) {
        if (!approved || !supplied || exhausted || after < 0 || after !== remaining - amount) return "balance does not match the approved amount";
        remaining = after;
        debits++;
        break;
      }
      if (before === document.body.innerHTML) tried.add(click);
    }
    if (exhausted) return debits >= 2 && (paid() ?? order) === order ? null : "successive refunds did not reach the order total";
    if (debits !== installment + 1) return "approval did not debit the balance";
  }
  return "could not exhaust the balance";
}
