/**
 * Builds the `ticket` object the Assessment Form print template expects from
 * a server Violation payload (generate-ticket / confirm-payment response).
 *
 * Every payment value comes from the PERSISTED Assessment record — there is
 * deliberately NO fallback that shows the penalty as "Amount Paid". If a
 * historical paid record has no stored amount_paid, it stays null and the
 * official form prints the blank Amount Paid line instead of a fabricated
 * figure. Received by is the Treasury Personnel recorded at Confirm Payment
 * (event-time name); blank when none was chosen (Treasury signs by hand).
 */
export function buildReceiptTicket(t = {}) {
  const a = t.assessment || {}
  return {
    ...t,
    full_name: t.violator_name || '',
    or_number: a.or_number || '',
    amount_paid: a.amount_paid ?? null,
    date_paid: a.date_paid || '',
    received_by: a.received_by || '',
    // Assessor comes ONLY from the persisted Assessment's event-time name.
    // No live fallback: t.assessed_by is the current account (and, on legacy
    // paid rows, was overwritten by the payment confirmer), so an assessor
    // that cannot be proven prints blank instead of a guess.
    assessed_by: a.assessed_by_name || '',
    payment_status: t.payment_status || (t.status === 'paid' ? 'Paid' : 'Unpaid'),
  }
}