import type {
  Balance,
  Expense,
  Participant,
  Repayment,
  Transfer,
} from "../../shared/types.js";
export interface ExpenseWithShares extends Expense {
  shares: { participantId: string; amount: number }[];
}
export function split(amount: number, ids: string[]) {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !ids.length ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Invalid split");
  return ids.map((id, i) => ({
    id,
    amount: Math.floor(amount / ids.length) + (i < amount % ids.length ? 1 : 0),
  }));
}
export function calculate(
  participants: Participant[],
  expenses: ExpenseWithShares[],
  repayments: Repayment[],
) {
  const totals = new Map(participants.map((p) => [p.id, 0]));
  const add = (id: string, amount: number) =>
    totals.set(id, (totals.get(id) ?? 0) + amount);
  for (const e of expenses) {
    add(e.payerId, e.amount);
    for (const s of e.shares) add(s.participantId, -s.amount);
  }
  for (const r of repayments) {
    add(r.fromId, r.amount);
    add(r.toId, -r.amount);
  }
  const balances: Balance[] = [...totals].map(([participantId, amount]) => ({
    participantId,
    amount,
  }));
  const debtors = balances.filter((b) => b.amount < 0).map((b) => ({ ...b }));
  const creditors = balances.filter((b) => b.amount > 0).map((b) => ({ ...b }));
  const transfers: Transfer[] = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(-debtors[i].amount, creditors[j].amount);
    transfers.push({
      fromId: debtors[i].participantId,
      toId: creditors[j].participantId,
      amount,
    });
    debtors[i].amount += amount;
    creditors[j].amount -= amount;
    if (!debtors[i].amount) i++;
    if (!creditors[j].amount) j++;
  }
  return { balances, transfers };
}
