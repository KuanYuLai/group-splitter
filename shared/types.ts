export interface User { id: string; email: string; nickname: string }
export interface Group { id: string; name: string; createdAt: string; ownerId: string }
export interface Participant { id: string; groupId: string; name: string; userId: string | null; email: string | null }
export interface Expense { id: string; groupId: string; description: string; date: string; amount: number; payerId: string; participantIds: string[] }
export interface Repayment { id: string; groupId: string; fromId: string; toId: string; amount: number; date: string }
export interface Balance { participantId: string; amount: number }
export interface Transfer { fromId: string; toId: string; amount: number }
export interface GroupDetail { group: Group; participants: Participant[]; expenses: Expense[]; repayments: Repayment[]; balances: Balance[]; transfers: Transfer[] }
export interface LoginInput { email: string }
export interface RegisterInput extends LoginInput { nickname: string }
export type LoginResult = User | { registrationRequired: true };
export interface ExpenseInput { description: string; date: string; amount: number; payerId: string; participantIds: string[] }
export interface RepaymentInput { fromId: string; toId: string; amount: number; date: string }
