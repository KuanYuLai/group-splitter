import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownLeft, ArrowRight, Check, ChevronRight, CircleDollarSign, CreditCard, Layers, LogOut, Pencil, Plus, Receipt, Trash2, Users, X } from 'lucide-react';
import type { User, Group, GroupDetail, Expense, ExpenseInput, RepaymentInput, LoginInput, LoginResult, RegisterInput } from '../../shared/types';
import './style.css';
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const displayDate = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
async function api<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  const response = await fetch('/api' + path, { method, credentials: 'include', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? 'Request failed'); }
  return response.status === 204 ? undefined as T : response.json();
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) { return <span className={`avatar color-${index % 4}`}>{name.slice(0, 1).toUpperCase()}</span>; }
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Keep the sheet within the visible area while Safari's keyboard is open.
    const viewport = window.visualViewport;
    const resize = () => {
      if (!viewport) return;
      dialog.style.setProperty('--keyboard-height', `${Math.max(0, viewport.height - 16)}px`);
      dialog.style.setProperty('--keyboard-bottom', `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      document.body.style.overflow = overflow;
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      dialog.close();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); close(); }}><div className="modal-title"><h2 id="dialog-title">{title}</h2><button type="button" className="icon" onClick={close} aria-label="Close dialog"><X size={20}/></button></div>{children}</dialog>;
}
function App() {
  const [user, setUser] = useState<User | null>(null), [ready, setReady] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]), [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<GroupDetail | null>(null), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'group' | 'rename' | 'participant' | 'expense' | 'repayment' | null>(null);
  const [editing, setEditing] = useState<Expense | null>(null), [tab, setTab] = useState<'expenses' | 'members' | 'repayments' | 'balances'>('expenses');
  const [loginEmail, setLoginEmail] = useState('');
  const [registrationRequired, setRegistrationRequired] = useState(false);
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const sequence = useRef(0);
  const saveKey = useRef<string | null>(null);
  const performing = useRef(false);
  useEffect(() => { api<User>('/auth/me').then(setUser).catch(e => { if (e.message !== 'Please sign in') setError(e.message); }).finally(() => setReady(true)); }, []);
  useEffect(() => {
    if (!user || modal || busy) return;
    let active = true;
    const sync = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const items = await api<Group[]>('/groups');
        if (!active) return;
        setGroups(items);
        setSelected(current => items.some(g => g.id === current) ? current : items[0]?.id ?? '');
        if (selected && items.some(g => g.id === selected)) {
          const next = await api<GroupDetail>('/groups/' + selected);
          if (active) setDetail(next);
        }
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 15000);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [user?.id, selected, modal, busy]);
  useEffect(() => { const seq = ++sequence.current; setDetail(null); if (!selected) return; setLoading(true); api<GroupDetail>('/groups/' + selected).then(d => { if (sequence.current === seq) setDetail(d); }).catch(e => { if (sequence.current === seq) setError(e.message); }).finally(() => { if (sequence.current === seq) setLoading(false); }); }, [selected]);
  const refresh = async () => { const d = await api<GroupDetail>('/groups/' + selected); setDetail(d); };
  const perform = async (action: () => Promise<void>) => { if (performing.current) return; performing.current = true; setBusy(true); setError(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { performing.current = false; setBusy(false); } };
  const close = () => { if (!performing.current) { saveKey.current = null; setModal(null); setError(''); } };
  const openExpense = (expense: Expense | null = null) => { setEditing(expense); setSplitIds(expense?.participantIds ?? detail?.participants.map(p => p.id) ?? []); setModal('expense'); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const value = (key: string) => String(data.get(key) ?? '');
    void perform(async () => {
      if (!user) {
        if (registrationRequired) {
          const input: RegisterInput = { email: loginEmail, nickname: value('nickname') };
          setUser(await api<User>('/auth/register', 'POST', input));
          setRegistrationRequired(false);
        } else {
          const input: LoginInput = { email: loginEmail };
          const result = await api<LoginResult>('/auth/login', 'POST', input);
          if ('registrationRequired' in result) setRegistrationRequired(true);
          else setUser(result);
        }
        return;
      }
      if (modal === 'group') { const group = await api<Group>('/groups', 'POST', { name: value('name') }); setGroups(g => [group, ...g]); setSelected(group.id); }
      if (modal === 'rename') { const group = await api<Group>('/groups/' + selected, 'PATCH', { name: value('name') }); setGroups(gs => gs.map(g => g.id === selected ? group : g)); await refresh(); }
      if (modal === 'participant') { await api('/groups/' + selected + '/participants', 'POST', { email: value('email') }); await refresh(); setTab('members'); }
      if (modal === 'expense' || modal === 'repayment') {
        if (!/^\d+(\.\d{1,2})?$/.test(value('amount'))) throw new Error('Enter an amount with up to two decimal places.');
        const amount = Math.round(Number(value('amount')) * 100);
        if (modal === 'expense') {
          if (!splitIds.length) throw new Error('Select at least one participant.');
          const input: ExpenseInput = { description: value('description'), amount, date: value('date'), payerId: value('payerId'), participantIds: splitIds };
          await api('/groups/' + selected + '/expenses' + (editing ? '/' + editing.id : ''), editing ? 'PUT' : 'POST', input, editing ? undefined : (saveKey.current ??= crypto.randomUUID()));
        } else { const input: RepaymentInput = { fromId: value('fromId'), toId: value('toId'), amount, date: value('date') }; await api('/groups/' + selected + '/repayments', 'POST', input, saveKey.current ??= crypto.randomUUID()); }
        // A failed read must not invite the user to submit a successful write again.
        saveKey.current = null;
        setModal(null);
        try { await refresh(); } catch { setError('Saved successfully, but balances could not refresh. They will refresh when the connection returns.'); }
        return;
      }
      setModal(null);
    });
  };
  const remove = (kind: string, id: string) => { if (window.confirm('Delete this ' + kind.slice(0, -1) + '? This updates the group balances.')) void perform(async () => { await api(`/groups/${selected}/${kind}/${id}`, 'DELETE'); await refresh(); }); };
  const person = (id: string) => detail?.participants.find(p => p.id === id)?.name ?? 'Participant';
  const isOwner = detail?.group.ownerId === user?.id;
  const myParticipant = detail?.participants.find(p => p.userId === user?.id);
  const total = detail?.expenses.reduce((sum, e) => sum + e.amount, 0) ?? 0;
  if (!ready) return <div className="boot">Loading Kolo…</div>;
  if (!user) return <div className="login-layout"><section className="login-story"><a className="brand"><span className="brand-icon"><Layers/></span>kolo<span className="brand-dot">.</span></a><div><div className="eyebrow">GOOD TIMES. SHARED FAIRLY.</div><h1>More memories.<br/>Less math.</h1><p>Trips, dinners, and everything in between.<br/>Keep the shared costs simple.</p><div className="illustration"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="illustration-card"><span className="small-icon"><Receipt/></span><span>Weekend together<small>Split fairly, enjoy fully</small></span><span className="check-bubble"><Check size={20}/></span></div><span className="float-avatar one">J</span><span className="float-avatar two">A</span><span className="float-avatar three">M</span></div></div><small>A little clarity for the things you share.</small></section><main className="login-form"><div className="eyebrow">LET’S GET STARTED</div><h2>Your people.<br/>Your shared expenses.</h2><p>{registrationRequired ? "You’re new here. Choose a nickname to create your account." : "Enter your email to log in or get started."}</p><form onSubmit={submit}><label>Email address<input name="email" type="email" inputMode="email" autoCapitalize="none" placeholder="you@example.com" required maxLength={254} autoComplete="email" value={loginEmail} disabled={busy} onChange={e => { setLoginEmail(e.target.value); setRegistrationRequired(false); setError(''); }}/></label>{registrationRequired && <><p role="status" className="muted">No account found. Add your nickname to register.</p><label>Nickname<input autoFocus name="nickname" placeholder="What should we call you?" maxLength={80} required autoComplete="nickname" disabled={busy}/></label><button type="button" className="text-button" disabled={busy} onClick={() => { setRegistrationRequired(false); setError(''); }}>Back to Login</button></>}{error && <p className="error" role="alert">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? (registrationRequired ? 'Registering…' : 'Logging in…') : (registrationRequired ? 'Register' : 'Login')}<ArrowRight size={18}/></button></form><p className="prototype">Prototype sign-in: email ownership is not verified. Use test details.</p></main></div>;
  return <div className="app-shell"><aside className="sidebar"><a className="brand"><span className="brand-icon"><Layers/></span>kolo<span className="brand-dot">.</span></a><div className="workspace-label">YOUR WORKSPACE</div><div className="sidebar-heading"><span>Your groups</span><button className="icon" aria-label="Create group" onClick={() => setModal('group')}><Plus size={18}/></button></div><label className="mobile-group-picker">Your groups<select aria-label="Choose group" value={selected} onChange={e => { setSelected(e.target.value); setTab('expenses'); }}>{!groups.length && <option value="">No groups yet</option>}{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><nav aria-label="Groups">{groups.map((g, i) => <button key={g.id} className={'group-nav ' + (selected === g.id ? 'active' : '')} onClick={() => { setSelected(g.id); setTab('expenses'); setError(''); }}><span className={'group-symbol color-' + i % 4}><Users size={18}/></span><span>{g.name}</span>{selected === g.id && <ChevronRight size={16}/>}</button>)}</nav><button className="new-group" onClick={() => setModal('group')}><Plus size={17}/> Create a group</button><div className="sidebar-tip"><span>Better together.</span><p>Keep track of the little things,<br/>so you can enjoy the big ones.</p><div className="tip-dots"><i/><i/><i/></div></div><div className="profile"><Avatar name={user.nickname}/><div><strong>{user.nickname}</strong><small>{user.email}</small></div><button className="icon" disabled={busy} aria-label="Sign out" onClick={() => void perform(async () => { await api('/auth/logout', 'POST'); setUser(null); setGroups([]); setSelected(''); setDetail(null); })}><LogOut size={18}/></button></div></aside><main className="main"><header className="topbar"><span>Workspace <ChevronRight size={14}/> <strong>{detail?.group.name ?? 'Your groups'}</strong></span><span className="currency">USD <span>·</span> US Dollar</span></header>{error && !modal && <div className="error banner" role="alert">{error}</div>}{loading ? <div className="empty">Loading your group…</div> : !detail ? <section className="welcome"><span className="large-icon"><Users size={32}/></span><div className="eyebrow">ROOM FOR EVERYONE</div><h1>Good things start with a group.</h1><p>Create a space for your next trip, housemates, or dinner crew.</p><button className="primary" onClick={() => setModal('group')}><Plus size={18}/> Create your first group</button></section> : <><section className="page-heading"><div><div className="eyebrow">SHARED MOMENTS, SIMPLE MATH</div><h1>{detail.group.name}{isOwner && <button className="icon" aria-label="Rename group" onClick={() => setModal('rename')}><Pencil size={17}/></button>}</h1><p><Users size={15}/> {detail.participants.length} members <span>·</span> Made for sharing</p></div><button className="primary" onClick={() => openExpense()}><Plus size={18}/> Add expense</button></section><section className="stats"><article><span className="stat-icon"><CreditCard size={21}/></span><div><span>Total group spending</span><strong>{money(total)}</strong><small>Across {detail.expenses.length} shared expenses</small></div></article><article><span className="stat-icon lilac"><Users size={21}/></span><div><span>In this together</span><div className="avatar-stack">{detail.participants.slice(0, 5).map((p, i) => <Avatar key={p.id} name={p.name} index={i}/>)}</div><small>{detail.participants.length} people sharing the cost</small></div></article></section><div className={"content-grid tab-" + tab}><section className="panel ledger"><div className="tabs" role="tablist" aria-label="Group information">{(['expenses', 'balances', 'members', 'repayments'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={(tab === t ? 'selected ' : '') + (t === 'balances' ? 'balance-tab' : '')} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}{t !== 'balances' && <span>{t === 'expenses' ? detail.expenses.length : t === 'members' ? detail.participants.length : detail.repayments.length}</span>}</button>)}</div>{tab === 'expenses' && <><div className="section-heading"><h2>Shared expenses</h2><span>Most recent first</span></div>{!detail.expenses.length ? <div className="empty"><Receipt size={32}/><h3>A fresh start</h3><p>Add your first expense. We’ll handle the split.</p><button className="text-button" onClick={() => openExpense()}>Add an expense <ArrowRight size={15}/></button></div> : detail.expenses.map(e => <article className="expense-row" key={e.id}><span className="expense-icon"><Receipt size={21}/></span><div className="row-main"><strong>{e.description}</strong><small>{person(e.payerId)} paid <span>·</span> Split {e.participantIds.length} ways</small></div><div className="row-amount"><strong>{money(e.amount)}</strong><small>{displayDate(e.date)}</small></div><div className="row-actions"><button className="icon" aria-label={'Edit ' + e.description} onClick={() => openExpense(e)}><Pencil size={15}/></button><button className="icon" disabled={busy} aria-label={'Delete ' + e.description} onClick={() => remove('expenses', e.id)}><Trash2 size={15}/></button></div></article>)}</>}{tab === 'members' && <><div className="section-heading"><h2>The people</h2>{isOwner && <button className="text-button" onClick={() => setModal('participant')}><Plus size={16}/> Add member</button>}</div>{detail.participants.map((p, i) => <article className="expense-row" key={p.id}><Avatar name={p.name} index={i}/><div className="row-main"><strong>{p.name}</strong><small>{p.email ?? 'Legacy participant · no linked account'}</small></div>{isOwner && p.userId !== detail.group.ownerId && <button className="icon" disabled={busy} aria-label={'Remove ' + p.name} onClick={() => remove('participants', p.id)}><Trash2 size={16}/></button>}</article>)}</>}{tab === 'repayments' && <><div className="section-heading"><h2>Settling up</h2><button className="text-button" onClick={() => setModal('repayment')} disabled={detail.participants.length < 2}><Plus size={16}/> Record payment</button></div>{!detail.repayments.length && <div className="empty"><CircleDollarSign size={32}/><h3>No repayments yet</h3><p>Record a payment after someone pays you back.</p></div>}{detail.repayments.map(r => <article className="expense-row" key={r.id}><span className="expense-icon"><ArrowDownLeft size={21}/></span><div className="row-main"><strong>{person(r.fromId)} → {person(r.toId)}</strong><small>{displayDate(r.date)}</small></div><strong>{money(r.amount)}</strong><button className="icon" disabled={busy} aria-label="Delete repayment" onClick={() => remove('repayments', r.id)}><Trash2 size={16}/></button></article>)}</>}</section><aside className="right-column"><section className="panel balances"><div className="section-heading"><h2>Group balances</h2><span className="small-icon"><CircleDollarSign size={19}/></span></div><p className="muted">A little give, a little get.</p>{detail.balances.map((b, i) => <div className="balance-row" key={b.participantId}><Avatar name={person(b.participantId)} index={i}/><span>{person(b.participantId)}</span><div className={b.amount > 0 ? 'positive' : b.amount < 0 ? 'negative' : 'muted'}><strong>{money(Math.abs(b.amount))}</strong><small>{b.amount > 0 ? 'gets back' : b.amount < 0 ? 'owes' : 'settled up'}</small></div></div>)}</section><section className="settle-panel"><span className="small-icon"><Check size={19}/></span><h2>Make it even</h2><p>{detail.transfers.length ? 'The simplest way to settle this group.' : 'All square. That’s a good feeling.'}</p>{detail.transfers.map((t, i) => <div className="transfer" key={i}><span>{person(t.fromId)} <ArrowRight size={13}/> {person(t.toId)}</span><strong>{money(t.amount)}</strong></div>)}<button className="secondary wide" disabled={detail.participants.length < 2} onClick={() => setModal('repayment')}>Record a repayment <ArrowRight size={16}/></button><small>Just a record. No money moves here.</small></section></aside></div><footer>Less calculating. More living.<span>Made to be shared <span className="footer-flower">✳</span></span></footer></> }</main>{modal && <Modal title={{ group: 'Create a group', rename: 'Rename group', participant: 'Add a member', expense: editing ? 'Edit expense' : 'Add an expense', repayment: 'Record a repayment' }[modal]} close={close}><form onSubmit={submit}>{(modal === 'group' || modal === 'rename') && <label>Group name<input autoFocus name="name" required maxLength={80} defaultValue={modal === 'rename' ? detail?.group.name : ''} placeholder="e.g. Summer in Lisbon"/></label>}{modal === 'participant' && <><label>Email address<input autoFocus name="email" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" required maxLength={254} placeholder="friend@example.com"/></label><p className="muted">They must have signed in to Kolo before. Once added, this group appears in their account.</p></>}{modal === 'expense' && <><label>Description<input autoFocus name="description" required maxLength={80} placeholder="What was it for?" defaultValue={editing?.description}/></label><div className="form-pair"><label>Amount (USD)<input name="amount" inputMode="decimal" type="number" min="0.01" max="1000000" step="0.01" placeholder="0.00" required defaultValue={editing ? (editing.amount / 100).toFixed(2) : ''}/></label><label>Date<input name="date" type="date" required defaultValue={editing?.date ?? today()}/></label></div><label>Paid by<select name="payerId" defaultValue={editing?.payerId ?? myParticipant?.id}>{detail?.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><fieldset><legend>Split equally between</legend>{detail?.participants.map(p => <label className="checkbox" key={p.id}><input type="checkbox" checked={splitIds.includes(p.id)} onChange={e => setSplitIds(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))}/>{p.name}</label>)}</fieldset></>}{modal === 'repayment' && <><p className="muted">Record money that has already been paid back.</p><label>From<select name="fromId" defaultValue={detail?.transfers[0]?.fromId}>{detail?.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>To<select name="toId" defaultValue={detail?.transfers[0]?.toId ?? detail?.participants[1]?.id}>{detail?.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="form-pair"><label>Amount (USD)<input name="amount" inputMode="decimal" type="number" min="0.01" max="1000000" step="0.01" required defaultValue={detail?.transfers[0] ? (detail.transfers[0].amount / 100).toFixed(2) : ''}/></label><label>Date<input name="date" type="date" required defaultValue={today()}/></label></div></>}{error && <p className="error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : modal === 'expense' ? 'Save expense' : modal === 'repayment' ? 'Record repayment' : modal === 'participant' ? 'Add member' : 'Save'}</button></div></form></Modal>}</div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
