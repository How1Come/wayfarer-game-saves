import { useEffect, useState } from 'react';
import { Copy, FolderOpen, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { SaveSide, SharedGroup, State } from './types';

type Run = (task: () => Promise<unknown>, message: string, success?: string) => Promise<boolean | undefined>;
const when = (value: number) => new Date(value).toLocaleString();
const sideName = (side: SaveSide) => side === 'local' ? 'This PC' : 'External drive';
const normalizedPath = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const pathsOverlap = (first: string, second: string) => {
  const a = normalizedPath(first), b = normalizedPath(second);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const joinPath = (base: string, relative: string) => `${base.replace(/[\\/]+$/, '')}${base.includes('\\') ? '\\' : '/'}${relative.replaceAll('/', base.includes('\\') ? '\\' : '/')}`;

export default function SharedSaves({ state, busy, run }: { state: State; busy: boolean; run: Run }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const choices = state.games.flatMap(game => game.mappings.filter(mapping => mapping.confirmed && !mapping.error && mapping.status !== 'error').map(mapping => ({ key: `${game.id}:${mapping.id}`, game, mapping })));
  const create = async () => {
    const selected = [first, second].map(key => choices.find(choice => choice.key === key));
    if (selected.some(choice => !choice)) return;
    if (await run(() => window.vault.linkEditions({ name, members: selected.map(choice => ({ gameId: choice!.game.id, mappingId: choice!.mapping.id, label: `${choice!.game.name} · ${choice!.game.relativeInstallPath} · ${choice!.mapping.root}/${choice!.mapping.relativePath}` })) }), 'Linking edition locations…', 'Editions linked. Original saves are unchanged.')) { setCreating(false); setName(''); setFirst(''); setSecond(''); }
  };
  return <section className="standard-page shared-page">
    <div className="page-heading"><div><span className="eyebrow">ONE ADVENTURE, DIFFERENT EDITIONS</span><h1>Shared saves<span>.</span></h1><p>Keep a separate copy for Steam and standalone editions.</p></div><div className="shared-actions"><button className="button button-secondary" disabled={busy} onClick={() => run(() => window.vault.refresh(), 'Comparing edition saves…', 'Save locations refreshed.')}><RefreshCw size={16} />Refresh</button><button className="button button-primary" disabled={busy} onClick={() => setCreating(!creating)}><Plus size={16} />Link editions</button></div></div>
    <div className="history-note"><ShieldCheck size={22} /><div><strong>Your originals stay protected.</strong><p>Linking and capturing never replace saves. Wayfarer cannot convert formats or prove game compatibility. Test an exact copy in a separate profile or test installation before enabling replacement for that target. If you cannot test safely, keep the copies separate.</p></div></div>
    {creating && <form className="shared-card shared-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <h2>Link two edition save locations</h2><p>First add or correct games and save paths in your library. Each edition can use a different AppData path; you can also link two locations of one game.</p>
      <label className="form-label" htmlFor="group-name">Group name</label><input id="group-name" className="form-input" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="My adventure" />
      <div className="shared-columns">{[{ id: 'first', label: 'First edition', value: first, change: setFirst }, { id: 'second', label: 'Second edition', value: second, change: setSecond }].map(field => <div key={field.id}><label className="form-label" htmlFor={`edition-${field.id}`}>{field.label}</label><select id={`edition-${field.id}`} className="form-select" value={field.value} onChange={event => field.change(event.target.value)} required><option value="">Choose a confirmed save location</option>{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.game.name} · {choice.game.relativeInstallPath} · {choice.mapping.root}/{choice.mapping.relativePath}</option>)}</select></div>)}</div>
      {choices.length < 2 && <p className="field-help">Add at least two confirmed save locations in the game library.</p>}
      <div className="shared-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button className="button button-primary" disabled={busy || !name.trim() || !first || !second || first === second}>Create group</button></div>
    </form>}
    {!state.sharedGroups.length && !creating && <div className="empty-state"><Copy size={32} /><h3>A shared copy, with a careful first step</h3><p>Link edition locations, capture a copy, then test it. Identical save paths already refer to the same files and need no conversion.</p></div>}
    {state.sharedGroups.map(group => <Group key={group.id} group={group} state={state} busy={busy} run={run} />)}
  </section>;
}

function Group({ group, state, busy, run }: { group: SharedGroup; state: State; busy: boolean; run: Run }) {
  const [sourceId, setSourceId] = useState(group.members[0]?.id || '');
  const [sourceSide, setSourceSide] = useState<SaveSide>('local');
  const [candidateId, setCandidateId] = useState(group.candidates[0]?.id || '');
  const [targetId, setTargetId] = useState(group.members[1]?.id || '');
  const [targetSide, setTargetSide] = useState<SaveSide>('local');
  const [tested, setTested] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { setTested(false); setConfirmReplace(false); }, [candidateId, targetId, targetSide]);
  const latestCandidateId = group.candidates[0]?.id || '';
  useEffect(() => { setCandidateId(latestCandidateId); }, [latestCandidateId]);
  const resolve = (id: string) => {
    const member = group.members.find(item => item.id === id);
    const game = state.games.find(item => item.id === member?.gameId);
    const mapping = game?.mappings.find(item => item.id === member?.mappingId);
    return { member, mapping, available: !!mapping && mapping.confirmed && !mapping.error && mapping.status !== 'error' };
  };
  const source = resolve(sourceId), target = resolve(targetId);
  const candidate = group.candidates.find(item => item.id === candidateId);
  const verified = !!candidate && group.verifications.some(item => item.candidateId === candidateId && item.memberId === targetId && item.side === targetSide && item.fingerprint === candidate.fingerprint);
  const targetPath = targetSide === 'local' ? target.mapping?.localPath : target.mapping?.externalPath;
  const original = candidate ? resolve(candidate.sourceMemberId).mapping : undefined;
  const originalPath = candidate?.sourceRoot && ['Local', 'LocalLow', 'Roaming'].includes(candidate.sourceRoot) && candidate.sourceRelativePath
    ? joinPath(candidate.sourceSide === 'local' ? state.localRoots[candidate.sourceRoot] : joinPath(state.config.externalRoot, candidate.sourceRoot), candidate.sourceRelativePath)
    : candidate?.sourceSide === 'local' ? original?.localPath : original?.externalPath;
  const sameLocation = !!originalPath && !!targetPath && pathsOverlap(originalPath, targetPath);
  const captured = sourceSide === 'local' ? source.mapping?.local : source.mapping?.external;
  const targetSnapshot = targetSide === 'local' ? target.mapping?.local : target.mapping?.external;
  const selection = { groupId: group.id, candidateId, memberId: targetId, side: targetSide };
  const memberOptions = group.members.map(member => <option key={member.id} value={member.id}>{member.label}{resolve(member.id).available ? '' : ' (unavailable)'}</option>);
  return <article className="shared-card">
    <div className="shared-heading"><div><span className="eyebrow">LINKED EDITIONS</span><h2>{group.name}</h2></div><button className="icon-button" aria-label={`Remove ${group.name} group`} disabled={busy} onClick={() => setConfirmRemove(!confirmRemove)}><Trash2 size={16} /></button></div>
    {confirmRemove && <div className="shared-confirm"><p>Remove this group from the list? Original saves and captured files stay on disk.</p><button className="button button-secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep group</button><button className="button button-danger" disabled={busy} onClick={() => run(() => window.vault.removeSharedGroup({ groupId: group.id }), 'Removing group…')}>Remove group</button></div>}
    <div className="shared-originals">{group.members.map(member => { const current = resolve(member.id); return <div key={member.id}><strong>{member.label}</strong><code>{current.mapping?.localPath || 'Location unavailable. Restore its mapping in the library.'}</code>{current.mapping && <code>{current.mapping.externalPath}</code>}</div>; })}</div>
    <div className="shared-columns">
      <section className="shared-step"><span className="eyebrow">01 · CAPTURE</span><h3>Create a separate copy</h3><label className="form-label" htmlFor={`source-${group.id}`}>Source edition</label><select id={`source-${group.id}`} className="form-select" value={sourceId} onChange={event => setSourceId(event.target.value)}>{memberOptions}</select><label className="form-label" htmlFor={`source-side-${group.id}`}>Copy from</label><select id={`source-side-${group.id}`} className="form-select" value={sourceSide} onChange={event => setSourceSide(event.target.value as SaveSide)}><option value="local">This PC</option><option value="external">External drive</option></select><p className="field-help">{captured?.files ? `${captured.files} files · Updated ${captured.newest ? when(captured.newest) : '—'}` : 'No files at this source.'}</p><button className="button button-secondary" disabled={busy || !source.available || !captured?.files} onClick={() => run(() => window.vault.captureShared({ groupId: group.id, memberId: sourceId, side: sourceSide, expectedToken: source.mapping!.token }), 'Capturing a separate copy…', 'Shared copy created. Originals are unchanged.')}><Copy size={16} />Capture copy</button></section>
      <section className="shared-step"><span className="eyebrow">02 · TEST & APPLY</span><h3>Check the target edition</h3><label className="form-label" htmlFor={`candidate-${group.id}`}>Captured copy</label><select id={`candidate-${group.id}`} className="form-select" value={candidateId} onChange={event => setCandidateId(event.target.value)}><option value="">Capture a copy first</option>{group.candidates.map(item => <option key={item.id} value={item.id}>{when(item.at)} · {group.members.find(member => member.id === item.sourceMemberId)?.label} · {sideName(item.sourceSide)} · {item.files} files</option>)}</select>
      {candidate && <code className="shared-target-path">Copy {candidate.id.slice(0, 8)} · SHA-256 {candidate.fingerprint.slice(0, 16)}…</code>}
      <button className="text-button shared-open" disabled={busy || !candidate} onClick={() => run(() => window.vault.openShared({ groupId: group.id, candidateId }), 'Opening the captured copy…')}><FolderOpen size={15} />Open copy for testing</button>
      <label className="form-label" htmlFor={`target-${group.id}`}>Target edition</label><select id={`target-${group.id}`} className="form-select" value={targetId} onChange={event => setTargetId(event.target.value)}>{memberOptions}</select><label className="form-label" htmlFor={`target-side-${group.id}`}>Target location</label><select id={`target-side-${group.id}`} className="form-select" value={targetSide} onChange={event => setTargetSide(event.target.value as SaveSide)}><option value="local">This PC</option><option value="external">External drive</option></select><code className="shared-target-path">{targetPath || 'Target unavailable'}</code>
      <p className="field-help">Copy the payload into a separate test profile or installation using the target edition’s expected save folder; for a single file, rename only the test copy to its expected filename. Keep the captured payload unchanged. Load the test copy in the selected edition and check your progress. Wayfarer does not run this test for you.</p>
      {candidate && <div className="shared-comparison"><div><span>CAPTURED COPY</span><strong>{candidate.newest ? when(candidate.newest) : 'No updated time'}</strong><small>{candidate.files} files · Captured {when(candidate.at)}</small></div><div><span>TARGET AT LAST REFRESH · {sideName(targetSide).toUpperCase()}</span><strong>{!targetSnapshot ? 'Location unavailable' : targetSnapshot.newest ? when(targetSnapshot.newest) : targetSnapshot.exists ? 'No updated time' : 'No saves yet'}</strong><small>{targetSnapshot ? `${targetSnapshot.files} files` : 'Restore its mapping in the library'}</small></div></div>}
      {sameLocation && <p className="inline-error">This target is the same as, or overlaps, the captured source location. Choose an independent target to protect the source.</p>}
      <label className="check-line"><input type="checkbox" checked={tested} disabled={busy || !candidate || !target.available || sameLocation} onChange={event => setTested(event.target.checked)} /><span>I successfully loaded this exact copy in the target edition using a separate test profile or copy.</span></label>
      <button className="button button-secondary" disabled={busy || !tested || !candidate || !target.available || sameLocation} onClick={async () => { if (await run(() => window.vault.verifyShared({ ...selection, tested }), 'Checking the tested copy and target…', 'Test confirmation recorded for this copy and target.')) setTested(false); }}><ShieldCheck size={16} />Record successful test</button>
      <div className={`shared-verified ${verified ? 'is-verified' : ''}`}>{verified ? 'Test confirmed by you for this session. File changes are checked again before applying.' : 'Compatibility unverified · Original save protected'}</div>
      {!confirmReplace ? <button className="button button-primary" disabled={busy || !verified || !target.available || sameLocation} onClick={() => setConfirmReplace(true)}>Review replacement</button> : <div className="shared-confirm"><strong>Replace this target with the tested copy?</strong><code>{targetPath}</code><p>Close the game. The entire mapped file or folder will be replaced after its original is backed up on your drive. Other editions and the captured copy stay unchanged.</p><div className="shared-actions"><button className="button button-secondary" disabled={busy} onClick={() => setConfirmReplace(false)}>Cancel</button><button className="button button-primary" disabled={busy || !verified || !target.available || sameLocation} onClick={async () => { if (await run(() => window.vault.applyShared(selection), 'Backing up and applying the tested copy…', 'Tested copy applied. Previous save backed up.')) setConfirmReplace(false); }}>Back up & replace target</button></div></div>}
      </section>
    </div>
  </article>;
}
