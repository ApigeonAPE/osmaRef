import { useEffect, useMemo, useState } from 'react';
import {
  WinConditionSchema,
  validateTournamentReferences,
  type AutomationRule,
  type AutomationTrigger,
  type ImportPreview,
  type MappoolCategory,
  type Match,
  type RemoteTournamentSummary,
  type Round,
  type Team,
  type Tournament,
  type WinCondition,
} from '@osmaref/contracts';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Field, Modal, Section, formatDateTime } from '../ui';
import { IdInput } from '../components/IdInput';
import { Toast } from '../components/Toast';

const CATEGORY_SUGGESTIONS = ['NM', 'HD', 'HR', 'DT', 'FM', 'TB', 'RC', 'LN', 'SV', 'HB'];

export function TournamentsPage() {
  const model = useModel();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Tournament | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [remoteList, setRemoteList] = useState<RemoteTournamentSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    if (dirty) return;
    const target = model.tournaments.find((entry) => entry.id === selectedId) ?? model.tournaments[0];
    if (!target) {
      setDraft(null);
      return;
    }
    if (selectedId !== target.id) setSelectedId(target.id);
    setDraft(structuredClone(target));
    setActiveRoundId((previous) =>
      previous && target.rounds.some((round) => round.id === previous)
        ? previous
        : target.rounds[0]?.id ?? null,
    );
  }, [model.tournaments, selectedId, dirty]);

  const issues = useMemo(() => (draft ? validateTournamentReferences(draft) : []), [draft]);

  const edit = (mutator: (tournament: Tournament) => void) => {
    setDraft((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      mutator(next);
      return next;
    });
    setDirty(true);
  };

  const resolveName = async (id: number, apply: (username: string) => void) => {
    if (!Number.isInteger(id) || id <= 0) return;
    setPendingIds((previous) => new Set(previous).add(id));
    setLookupError(null);
    try {
      const user = await window.osmaRef.osu.lookupUser(id);
      apply(user.username);
    } catch (cause) {
      setLookupError(
        t('user lookup failed for #{id}: {message}', {
          id,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      setPendingIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const select = (id: string) => {
    if (dirty && !window.confirm(t('Discard unsaved changes?'))) return;
    setDirty(false);
    setSelectedId(id);
    setActiveRoundId(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await model.saveTournament(draft);
      setDraft(structuredClone(saved));
      setDirty(false);
      setNotice(t('saved as revision {revision}', { revision: saved.revision }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const createTournament = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await window.osmaRef.tournaments.create('New tournament');
      await model.refreshTournaments();
      setDirty(false);
      setSelectedId(created.id);
      setDraft(structuredClone(created));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const importFromFile = async () => {
    setError(null);
    try {
      const preview = await window.osmaRef.tournaments.importFile();
      if (preview) setImportPreview(preview);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const importFromBracket = async () => {
    setError(null);
    try {
      const preview = await window.osmaRef.tournaments.importBracket();
      if (preview) setImportPreview(preview);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const importFromServer = async () => {
    setError(null);
    try {
      setRemoteList(await window.osmaRef.tournaments.listRemote());
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const previewRemote = async (id: string) => {
    setError(null);
    try {
      setImportPreview(await window.osmaRef.tournaments.previewRemote(id));
      setRemoteList(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const applyImport = async () => {
    if (!importPreview) return;
    setBusy(true);
    try {
      const saved = await window.osmaRef.tournaments.applyImport(importPreview);
      await model.refreshTournaments();
      setDirty(false);
      setSelectedId(saved.id);
      setDraft(structuredClone(saved));
      setImportPreview(null);
      setNotice(t('imported "{name}" (revision {revision})', { name: saved.name, revision: saved.revision }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportTournament = async () => {
    if (!draft) return;
    try {
      const path = await window.osmaRef.tournaments.exportFile(draft.id);
      if (path) setNotice(t('exported to {path}', { path }));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const removeTournament = async () => {
    if (!draft) return;
    if (!window.confirm(t('Delete "{name}"? This cannot be undone.', { name: draft.name }))) return;
    try {
      await window.osmaRef.tournaments.remove(draft.id);
      setDirty(false);
      setSelectedId(null);
      await model.refreshTournaments();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const activeRound = draft?.rounds.find((round) => round.id === activeRoundId) ?? draft?.rounds[0] ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Tournaments')}</h1>
        </div>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => void importFromFile()}>
            {t('Import file')}
          </button>
          <button
            type="button"
            className="ghost"
            title={t('Convert an osu! tournament client bracket.json into a tournament.')}
            onClick={() => void importFromBracket()}
          >
            {t('Import bracket.json')}
          </button>
          <button type="button" className="ghost" onClick={() => void importFromServer()}>
            {t('Import from server')}
          </button>
          <button type="button" className="ghost" disabled={!draft} onClick={() => void exportTournament()}>
            {t('Export')}
          </button>
          <button type="button" className="primary" disabled={!draft || busy} onClick={() => void save()}>
            {busy ? t('saving…') : dirty ? t('Save changes') : t('Saved')}
          </button>
        </div>
      </header>

      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}
      {lookupError ? (
        <Toast message={lookupError} onClose={() => setLookupError(null)} />
      ) : null}
      {notice ? (
        <Toast kind="success" message={notice} onClose={() => setNotice(null)} />
      ) : null}

      <div className="split">
        <aside className="list-panel">
          <div className="list-head">
            <strong>{t('{count} tournament(s)', { count: model.tournaments.length })}</strong>
            <button type="button" className="ghost small" onClick={() => void createTournament()}>
              {t('+ New')}
            </button>
          </div>
          {model.tournaments.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`list-item${entry.id === selectedId ? ' active' : ''}`}
              onClick={() => select(entry.id)}
            >
              <strong>{entry.name}</strong>
              <span className="muted small">
                {entry.abbreviation} · {t('{count} rounds', { count: entry.rounds.length })} · rev{' '}
                {entry.revision}
              </span>
            </button>
          ))}
          {model.tournaments.length === 0 ? (
            <p className="muted small pad">{t('Create a tournament or import an existing configuration.')}</p>
          ) : null}
        </aside>

        <div className="editor">
          {!draft ? (
            <div className="empty">
              <strong>{t('No tournament selected')}</strong>
              <p className="muted">{t('Create one to start configuring teams, rounds and matches.')}</p>
            </div>
          ) : (
            <>
              <Section
                title={t('Basics')}
                actions={
                  <button type="button" className="ghost small danger" onClick={() => void removeTournament()}>
                    {t('Delete')}
                  </button>
                }
              >
                <div className="form-grid">
                  <Field label={t('Name')}>
                    <input value={draft.name} onChange={(event) => edit((next) => (next.name = event.target.value))} />
                  </Field>
                  <Field label={t('Abbreviation')}>
                    <input
                      value={draft.abbreviation}
                      maxLength={10}
                      onChange={(event) =>
                        edit(
                          (next) =>
                            (next.abbreviation = event.target.value.toUpperCase().slice(0, 10)),
                        )
                      }
                    />
                  </Field>
                  <Field label={t('Ruleset')}>
                    <select
                      value={draft.rulesetId}
                      onChange={(event) =>
                        edit((next) => (next.rulesetId = Number(event.target.value) as 0 | 1 | 2 | 3))
                      }
                    >
                      <option value={0}>osu!</option>
                      <option value={1}>osu!taiko</option>
                      <option value={2}>osu!catch</option>
                      <option value={3}>osu!mania</option>
                    </select>
                  </Field>
                  <Field label={t('Default match type')}>
                    <select
                      value={draft.defaultMatchType}
                      onChange={(event) =>
                        edit(
                          (next) => (next.defaultMatchType = event.target.value as 'head_to_head' | 'team_versus'),
                        )
                      }
                    >
                      <option value="team_versus">{t('Team VS')}</option>
                      <option value="head_to_head">{t('Head to head')}</option>
                    </select>
                  </Field>
                </div>
                <p className="muted small">
                  {t('id {id} · revision {revision} · updated {date}', {
                    id: draft.id,
                    revision: draft.revision,
                    date: formatDateTime(draft.updatedAt),
                  })}
                </p>
              </Section>

              {issues.length > 0 ? (
                <div className="banner warn">
                  <strong>{t('Configuration issues')}</strong>
                  <ul>
                    {issues.slice(0, 12).map((issue, index) => (
                      <li key={`${issue.path.join('.')}-${index}`}>
                        {issue.path.join('.')}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <TeamsSection
                draft={draft}
                edit={edit}
                resolveName={resolveName}
                pendingIds={pendingIds}
                lookupError={lookupError}
              />

              <RoundsSection
                draft={draft}
                edit={edit}
                activeRound={activeRound}
                onSelectRound={setActiveRoundId}
              />

              <ScoringSection draft={draft} edit={edit} />
              <MatchesSection draft={draft} edit={edit} />
              <AutomationSection draft={draft} edit={edit} />
            </>
          )}
        </div>
      </div>

      {importPreview ? (
        <Modal
          title={t('Import preview')}
          onClose={() => setImportPreview(null)}
          footer={
            <>
              <button type="button" className="ghost" onClick={() => setImportPreview(null)}>
                {t('Cancel')}
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void applyImport()}>
                {t('Import as new tournament')}
              </button>
            </>
          }
        >
          <p>
            <strong>{importPreview.tournament.name}</strong> · revision {importPreview.tournament.revision} ·{' '}
            {importPreview.provider === 'http' ? t('from server') : t('from file')}
          </p>
          <p className="muted small">
            {t(
              'Each import creates a new tournament with its own id; existing local tournaments are never modified.',
            )}
          </p>
          {importPreview.notes.length > 0 ? (
            <div className="banner info">
              <strong>{t('Conversion notes')}</strong>
              <ul>
                {importPreview.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {importPreview.issues.length > 0 ? (
            <div className="banner warn">
              <strong>{t('References to review')}</strong>
              <ul>
                {importPreview.issues.map((issue, index) => (
                  <li key={index}>
                    {issue.path.join('.')}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Modal>
      ) : null}

      {remoteList ? (
        <Modal title={t('Tournaments on the companion server')} onClose={() => setRemoteList(null)}>
          {remoteList.length === 0 ? <p className="muted">{t('The server has no published tournaments.')}</p> : null}
          {remoteList.map((remote) => (
            <div key={remote.id} className="remote-row">
              <div>
                <strong>{remote.name}</strong>
                <span className="muted small">
                  {remote.id} · {t('revision {revision} · {date}', {
                    revision: remote.revision,
                    date: formatDateTime(remote.updatedAt),
                  })}
                </span>
              </div>
              <button type="button" className="ghost small" onClick={() => void previewRemote(remote.id)}>
                {t('Preview')}
              </button>
            </div>
          ))}
        </Modal>
      ) : null}
    </div>
  );
}

type EditFn = (mutator: (tournament: Tournament) => void) => void;
type ResolveName = (id: number, apply: (username: string) => void) => void;

function TeamsSection({
  draft,
  edit,
  resolveName,
  pendingIds,
  lookupError,
}: {
  draft: Tournament;
  edit: EditFn;
  resolveName: ResolveName;
  pendingIds: Set<number>;
  lookupError: string | null;
}) {
  const { t } = useI18n();
  const [refereeId, setRefereeId] = useState('');

  const userName = (member: { userId: number; username: string }) => {
    if (member.username) return member.username;
    return pendingIds.has(member.userId) ? t('Resolving…') : '—';
  };

  return (
    <Section
      title={t('Teams and referees')}
      actions={
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) => {
              next.teams.push({
                id: `team_${next.teams.length + 1}_${Date.now().toString(36)}`,
                name: `Team ${next.teams.length + 1}`,
                members: [],
              });
            })
          }
        >
          {t('+ Team')}
        </button>
      }
    >
      <div className="team-grid">
        {draft.teams.map((team, teamIndex) => (
          <div className="team-card" key={team.id}>
            <div className="team-head">
              <input
                value={team.name}
                onChange={(event) => edit((next) => (next.teams[teamIndex]!.name = event.target.value))}
              />
              <button
                type="button"
                className="ghost small danger"
                onClick={() => edit((next) => next.teams.splice(teamIndex, 1))}
              >
                ×
              </button>
            </div>

            {team.members.map((member, memberIndex) => (
              <div className="member-row" key={`${team.id}-${memberIndex}`}>
                <IdInput
                  kind="user"
                  placeholder={t('user id')}
                  value={member.userId ? String(member.userId) : ''}
                  onChange={(value) => {
                    const userId = Number(value) || 0;
                    edit((next) => {
                      const target = next.teams[teamIndex]!.members[memberIndex]!;
                      target.userId = userId;
                      target.username = '';
                    });
                  }}
                  onBlur={() => {
                    const userId = member.userId;
                    if (userId <= 0) return;
                    void resolveName(userId, (username) =>
                      edit((next) => {
                        const target = next.teams[teamIndex]?.members[memberIndex];
                        if (target && target.userId === userId) target.username = username;
                      }),
                    );
                  }}
                />
                <span className="member-name" title={member.username || undefined}>
                  {userName(member)}
                </span>
                <label className="inline-field" title={t('captain')}>
                  <input
                    type="checkbox"
                    checked={member.captain}
                    onChange={(event) =>
                      edit(
                        (next) =>
                          (next.teams[teamIndex]!.members[memberIndex]!.captain = event.target.checked),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost small danger"
                  onClick={() => edit((next) => next.teams[teamIndex]!.members.splice(memberIndex, 1))}
                >
                  ×
                </button>
              </div>
            ))}

            <button
              type="button"
              className="ghost small"
              onClick={() =>
                edit((next) =>
                  next.teams[teamIndex]!.members.push({ userId: 0, username: '', captain: false }),
                )
              }
            >
              {t('+ player')}
            </button>
          </div>
        ))}
      </div>

      <div className="row-actions">
        <span className="muted small">
          {t('Referees: {names}', {
            names:
              draft.referees.map((referee) => `${referee.username || `#${referee.userId}`}`).join(', ') ||
              t('none'),
          })}
        </span>
        <IdInput
          kind="user"
          placeholder={t('user id')}
          value={refereeId}
          onChange={setRefereeId}
        />
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            const id = Number(refereeId);
            if (!Number.isInteger(id) || id <= 0) return;
            if (draft.referees.some((referee) => referee.userId === id)) {
              setRefereeId('');
              return;
            }
            edit((next) => next.referees.push({ userId: id, username: '' }));
            setRefereeId('');
            void resolveName(id, (username) =>
              edit((next) => {
                const referee = next.referees.find((entry) => entry.userId === id);
                if (referee) referee.username = username;
              }),
            );
          }}
        >
          {t('+ referee')}
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            for (const team of draft.teams) {
              for (const member of team.members) {
                if (member.userId <= 0) continue;
                const userId = member.userId;
                void resolveName(userId, (username) =>
                  edit((next) => {
                    for (const candidateTeam of next.teams) {
                      const target = candidateTeam.members.find((entry) => entry.userId === userId);
                      if (target) target.username = username;
                    }
                  }),
                );
              }
            }
          }}
        >
          {t('Refresh names')}
        </button>
      </div>
    </Section>
  );
}

function RoundsSection({
  draft,
  edit,
  activeRound,
  onSelectRound,
}: {
  draft: Tournament;
  edit: EditFn;
  activeRound: Round | null;
  onSelectRound: (id: string | null) => void;
}) {
  const { t } = useI18n();

  const addRound = () => {
    const id = `round_${Date.now().toString(36)}`;
    edit((next) => {
      const order = next.rounds.length;
      next.rounds.push({
        id,
        name: `Round ${order + 1}`,
        order,
        bestOf: 9,
        slots: [],
        flow: {
          id: `flow_${id}`,
          name: `Round ${order + 1} flow`,
          steps: [
            { id: `step_ban_${id}`, kind: 'ban', count: 1, side: 'both' },
            { id: `step_pick_${id}`, kind: 'pick', count: 10, side: 'both' },
          ],
          triggers: [],
        },
      });
    });
    onSelectRound(id);
  };

  const removeRound = () => {
    if (!activeRound) return;
    if (draft.matches.some((match) => match.roundId === activeRound.id)) {
      window.alert(t('This round is used by a match. Change or remove the match first.'));
      return;
    }
    edit((next) => {
      next.rounds = next.rounds.filter((round) => round.id !== activeRound.id);
    });
    onSelectRound(null);
  };

  const roundIndex = activeRound ? draft.rounds.findIndex((round) => round.id === activeRound.id) : -1;

  return (
    <Section
      title={t('Rounds')}
      actions={
        <>
          <button type="button" className="ghost small" onClick={addRound}>
            {t('+ Round')}
          </button>
          {activeRound ? (
            <button type="button" className="ghost small danger" onClick={removeRound}>
              {t('Delete round')}
            </button>
          ) : null}
        </>
      }
    >
      {draft.rounds.length === 0 ? (
        <p className="muted small">{t('No rounds yet. Add one to configure its mappool and flow.')}</p>
      ) : (
        <div className="session-tabs">
          {draft.rounds.map((round) => (
            <button
              key={round.id}
              type="button"
              className={`tab${round.id === activeRound?.id ? ' active' : ''}`}
              onClick={() => onSelectRound(round.id)}
            >
              {round.name}
              <span className="muted small"> · BO{round.bestOf}</span>
            </button>
          ))}
        </div>
      )}

      {activeRound && roundIndex >= 0 ? (
        <>
          <div className="form-grid">
            <Field label={t('Round name')}>
              <input
                value={activeRound.name}
                onChange={(event) =>
                  edit((next) => (next.rounds[roundIndex]!.name = event.target.value))
                }
              />
            </Field>
            <Field label={t('Best of')}>
              <input
                type="number"
                min={1}
                max={31}
                step={2}
                value={activeRound.bestOf}
                onChange={(event) =>
                  edit(
                    (next) =>
                      (next.rounds[roundIndex]!.bestOf = Math.max(
                        1,
                        Math.min(31, Number(event.target.value) || 1),
                      )),
                  )
                }
              />
            </Field>
          </div>

          <RoundPoolEditor draft={draft} edit={edit} round={activeRound} roundIndex={roundIndex} />
          <FlowEditor draft={draft} edit={edit} round={activeRound} roundIndex={roundIndex} />
        </>
      ) : null}
    </Section>
  );
}

function RoundPoolEditor({
  draft,
  edit,
  round,
  roundIndex,
}: {
  draft: Tournament;
  edit: EditFn;
  round: Round;
  roundIndex: number;
}) {
  const { t } = useI18n();

  return (
    <div className="pool-editor">
      <div className="row">
        <strong>{t('Mappool')}</strong>
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) => {
              const target = next.rounds[roundIndex]!;
              const category = 'NM';
              const used = target.slots
                .filter((slot) => slot.category === category)
                .map((slot) => Number(new RegExp(`^${category}(\\d+)$`, 'i').exec(slot.label)?.[1] ?? 0));
              const nextIndex = Math.max(0, ...used) + 1;
              target.slots.push({
                id: `slot_${Date.now().toString(36)}`,
                label: `${category}${nextIndex}`,
                category,
                beatmapId: 1,
                rulesetId: next.rulesetId,
                requiredMods: [],
                allowedMods: [],
                freestyle: false,
                winCondition: null,
                winConditionWinner: null,
              });
            })
          }
        >
          {t('+ Slot')}
        </button>
      </div>

      <div className="slot-table">
        <div className="slot-row slot-head">
          <span>{t('Label')}</span>
          <span>{t('Category')}</span>
          <span>{t('Beatmap')}</span>
          <span>{t('Ruleset')}</span>
          <span>{t('Required mods')}</span>
          <span>{t('Allowed mods')}</span>
          <span>{t('Win condition')}</span>
          <span>{t('Winner')}</span>
          <span />
        </div>
        {round.slots.map((slot, slotIndex) => (
          <div className="slot-row" key={slot.id}>
            <input
              value={slot.label}
              onChange={(event) =>
                edit((next) => (next.rounds[roundIndex]!.slots[slotIndex]!.label = event.target.value))
              }
            />
            <input
              list="mappool-categories"
              value={slot.category}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.category = event.target
                      .value as MappoolCategory),
                )
              }
            />
            <IdInput
              kind="beatmap"
              value={slot.beatmapId ? String(slot.beatmapId) : ''}
              onChange={(value) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.beatmapId = Number(value) || 0),
                )
              }
            />
            <select
              value={slot.rulesetId}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.rulesetId = Number(event.target.value) as
                      | 0
                      | 1
                      | 2
                      | 3),
                )
              }
            >
              <option value={0}>osu!</option>
              <option value={1}>taiko</option>
              <option value={2}>catch</option>
              <option value={3}>mania</option>
            </select>
            <input
              value={slot.requiredMods.join(' ')}
              placeholder="HD HR"
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.requiredMods = parseMods(
                      event.target.value,
                    )),
                )
              }
            />
            <input
              value={slot.allowedMods.join(' ')}
              placeholder="HD HR"
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.allowedMods = parseMods(
                      event.target.value,
                    )),
                )
              }
            />
            <select
              value={slot.winCondition ?? ''}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.winCondition =
                      (event.target.value || null) as WinCondition | null),
                )
              }
            >
              <option value="">{t('auto')}</option>
              {WinConditionSchema.options.map((condition) => (
                <option key={condition} value={condition}>
                  {condition}
                </option>
              ))}
            </select>
            <select
              value={slot.winConditionWinner ?? ''}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.slots[slotIndex]!.winConditionWinner =
                      (event.target.value || null) as 'highest' | 'lowest' | null),
                )
              }
            >
              <option value="">{t('auto')}</option>
              <option value="highest">{t('highest')}</option>
              <option value="lowest">{t('lowest')}</option>
            </select>
            <button
              type="button"
              className="ghost small danger"
              onClick={() =>
                edit((next) => next.rounds[roundIndex]!.slots.splice(slotIndex, 1))
              }
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <datalist id="mappool-categories">
        {CATEGORY_SUGGESTIONS.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
    </div>
  );
}

function FlowEditor({
  draft,
  edit,
  round,
  roundIndex,
}: {
  draft: Tournament;
  edit: EditFn;
  round: Round;
  roundIndex: number;
}) {
  const { t } = useI18n();
  const flow = round.flow;

  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Pick/Ban flow')}</strong>
      </div>
      {flow.steps.map((step, stepIndex) => (
        <div className="row" key={step.id}>
          <select
            value={step.kind}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.rounds[roundIndex]!.flow.steps[stepIndex]!.kind = event.target.value as
                    | 'protect'
                    | 'ban'
                    | 'pick'),
              )
            }
          >
            <option value="protect">{t('protect')}</option>
            <option value="ban">{t('ban')}</option>
            <option value="pick">{t('pick')}</option>
          </select>
          <label className="inline-field">
            {t('count')}
            <input
              type="number"
              min={1}
              max={10}
              value={step.count}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.flow.steps[stepIndex]!.count = Math.max(
                      1,
                      Math.min(10, Number(event.target.value) || 1),
                    )),
                )
              }
            />
          </label>
          <button
            type="button"
            className="ghost small danger"
            onClick={() => edit((next) => next.rounds[roundIndex]!.flow.steps.splice(stepIndex, 1))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost small"
        onClick={() =>
          edit((next) =>
            next.rounds[roundIndex]!.flow.steps.push({
              id: `step_${Date.now()}`,
              kind: 'pick',
              count: 1,
              side: 'both',
            }),
          )
        }
      >
        {t('+ step')}
      </button>

      <div className="flow-triggers">
        <div className="row">
          <span className="muted small">{t('Score triggers')}</span>
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              edit((next) =>
                next.rounds[roundIndex]!.flow.triggers.push({
                  id: `trigger_${Date.now()}`,
                  team: 'team_one',
                  threshold: 1,
                  action: 'ban',
                  count: 1,
                  repeatEvery: null,
                }),
              )
            }
          >
            {t('+ trigger')}
          </button>
        </div>
        {flow.triggers.map((trigger, triggerIndex) => (
          <div className="row" key={trigger.id}>
            <select
              value={trigger.team}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.flow.triggers[triggerIndex]!.team = event.target.value as
                      | 'team_one'
                      | 'team_two'),
                )
              }
            >
              <option value="team_one">{t('team one')}</option>
              <option value="team_two">{t('team two')}</option>
            </select>
            <label className="inline-field">
              {t('threshold')}
              <input
                type="number"
                min={1}
                max={31}
                value={trigger.threshold}
                onChange={(event) =>
                  edit(
                    (next) =>
                      (next.rounds[roundIndex]!.flow.triggers[triggerIndex]!.threshold = Math.max(
                        1,
                        Math.min(31, Number(event.target.value) || 1),
                      )),
                  )
                }
              />
            </label>
            <select
              value={trigger.action}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.rounds[roundIndex]!.flow.triggers[triggerIndex]!.action = event.target
                      .value as 'protect' | 'ban' | 'pick'),
                )
              }
            >
              <option value="protect">{t('protect')}</option>
              <option value="ban">{t('ban')}</option>
              <option value="pick">{t('pick')}</option>
            </select>
            <label className="inline-field">
              {t('count')}
              <input
                type="number"
                min={1}
                max={10}
                value={trigger.count}
                onChange={(event) =>
                  edit(
                    (next) =>
                      (next.rounds[roundIndex]!.flow.triggers[triggerIndex]!.count = Math.max(
                        1,
                        Math.min(10, Number(event.target.value) || 1),
                      )),
                  )
                }
              />
            </label>
            <label className="inline-field">
              {t('repeat every')}
              <input
                type="number"
                min={1}
                max={31}
                value={trigger.repeatEvery ?? ''}
                placeholder="—"
                onChange={(event) =>
                  edit(
                    (next) =>
                      (next.rounds[roundIndex]!.flow.triggers[triggerIndex]!.repeatEvery =
                        event.target.value === ''
                          ? null
                          : Math.max(1, Math.min(31, Number(event.target.value) || 1))),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="ghost small danger"
              onClick={() =>
                edit((next) => next.rounds[roundIndex]!.flow.triggers.splice(triggerIndex, 1))
              }
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoringSection({ draft, edit }: { draft: Tournament; edit: EditFn }) {
  const { t } = useI18n();
  return (
    <Section
      title={t('Scoring')}
      subtitle={t('Multipliers apply to score-based win conditions only.')}
      actions={
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) => {
              if (next.scoringSchemes.length >= 10) return;
              next.scoringSchemes.push({
                id: `score_${Date.now().toString(36)}`,
                name: `Scheme ${next.scoringSchemes.length + 1}`,
                winCondition: 'score_v2',
                aggregation: 'sum',
                modMultipliers: {},
              });
            })
          }
        >
          {t('+ Scheme')}
        </button>
      }
    >
      {draft.scoringSchemes.map((scheme, index) => (
        <div className="row" key={scheme.id}>
          <input
            value={scheme.name}
            onChange={(event) => edit((next) => (next.scoringSchemes[index]!.name = event.target.value))}
          />
          <select
            value={scheme.winCondition}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.scoringSchemes[index]!.winCondition = event.target.value as WinCondition),
              )
            }
          >
            {WinConditionSchema.options.map((condition) => (
              <option key={condition} value={condition}>
                {condition}
              </option>
            ))}
          </select>
          <select
            value={scheme.aggregation}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.scoringSchemes[index]!.aggregation = event.target.value as
                    | 'sum'
                    | 'average'
                    | 'max'),
              )
            }
          >
            <option value="sum">{t('sum')}</option>
            <option value="average">{t('average')}</option>
            <option value="max">{t('max')}</option>
          </select>
          <input
            placeholder="HD=1.06, HR=1.1"
            value={Object.entries(scheme.modMultipliers)
              .map(([mod, value]) => `${mod}=${value}`)
              .join(', ')}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.scoringSchemes[index]!.modMultipliers = parseMultipliers(
                    event.target.value,
                  )),
              )
            }
          />
          <button
            type="button"
            className="ghost small danger"
            onClick={() => edit((next) => next.scoringSchemes.splice(index, 1))}
          >
            ×
          </button>
        </div>
      ))}
    </Section>
  );
}

function MatchesSection({ draft, edit }: { draft: Tournament; edit: EditFn }) {
  const { t } = useI18n();
  const canAdd =
    draft.teams.length >= 2 && draft.rounds.length > 0 && draft.scoringSchemes.length > 0;

  return (
    <Section
      title={t('Matches')}
      actions={
        <button
          type="button"
          className="ghost small"
          disabled={!canAdd}
          title={canAdd ? undefined : t('Add two teams, one round and one scoring scheme first.')}
          onClick={() =>
            edit((next) => {
              const round = next.rounds[0];
              const teamOne = next.teams[0];
              const teamTwo = next.teams[1];
              const scoring = next.scoringSchemes[0];
              if (!round || !teamOne || !teamTwo || !scoring) return;
              const match: Match = {
                id: `match_${Date.now().toString(36)}`,
                name: `${teamOne.name} vs ${teamTwo.name}`,
                roundId: round.id,
                teamOneId: teamOne.id,
                teamTwoId: teamTwo.id,
                refereeIds: next.referees.map((referee) => referee.userId),
                transport: 'irc',
                scoringId: scoring.id,
                roomNameTemplate: '{tournament}: ({team_one}) vs ({team_two})',
                initialBeatmapId: round.slots[0]?.beatmapId ?? null,
                scheduledAt: null,
              };
              next.matches.push(match);
            })
          }
        >
          {t('+ Match')}
        </button>
      }
    >
      {!canAdd ? (
        <p className="muted small">{t('Add two teams, one round and one scoring scheme first.')}</p>
      ) : null}
      {draft.matches.length === 0 ? (
        <p className="muted small">{t('Add a match to open a room from the workbench.')}</p>
      ) : null}
      {draft.matches.map((match, index) => (
        <div className="match-card" key={match.id}>
          <div className="row">
            <input
              value={match.name}
              onChange={(event) => edit((next) => (next.matches[index]!.name = event.target.value))}
            />
            <select
              value={match.transport}
              onChange={(event) =>
                edit(
                  (next) =>
                    (next.matches[index]!.transport = event.target.value as
                      | 'irc'
                      | 'referee_hub'),
                )
              }
            >
              <option value="irc">{t('Bancho IRC')}</option>
              <option value="referee_hub">{t('Referee Hub')}</option>
            </select>
            <button
              type="button"
              className="ghost small danger"
              onClick={() => edit((next) => next.matches.splice(index, 1))}
            >
              ×
            </button>
          </div>
          <div className="match-grid">
            <label className="inline-field">
              {t('round')}
              <select
                value={match.roundId}
                onChange={(event) => edit((next) => (next.matches[index]!.roundId = event.target.value))}
              >
                {draft.rounds.map((round) => (
                  <option key={round.id} value={round.id}>
                    {round.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              {t('team one')}
              <select
                value={match.teamOneId}
                onChange={(event) => edit((next) => (next.matches[index]!.teamOneId = event.target.value))}
              >
                {draft.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              {t('team two')}
              <select
                value={match.teamTwoId}
                onChange={(event) => edit((next) => (next.matches[index]!.teamTwoId = event.target.value))}
              >
                {draft.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              {t('scoring')}
              <select
                value={match.scoringId}
                onChange={(event) => edit((next) => (next.matches[index]!.scoringId = event.target.value))}
              >
                {draft.scoringSchemes.map((scheme) => (
                  <option key={scheme.id} value={scheme.id}>
                    {scheme.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              {t('initial beatmap')}
              <IdInput
                kind="beatmap"
                value={match.initialBeatmapId ? String(match.initialBeatmapId) : ''}
                placeholder={t('from pool')}
                onChange={(value) =>
                  edit(
                    (next) =>
                      (next.matches[index]!.initialBeatmapId =
                        Number(value) > 0 ? Number(value) : null),
                  )
                }
              />
            </label>
          </div>
          <label className="inline-field wide">
            {t('room name template')}
            <input
              value={match.roomNameTemplate}
              onChange={(event) => edit((next) => (next.matches[index]!.roomNameTemplate = event.target.value))}
            />
          </label>
        </div>
      ))}
    </Section>
  );
}

function AutomationSection({ draft, edit }: { draft: Tournament; edit: EditFn }) {
  const { t } = useI18n();
  return (
    <Section
      title={t('Message triggers')}
      actions={
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) => {
              const rule: AutomationRule = {
                id: `rule_${Date.now().toString(36)}`,
                name: 'Result message',
                trigger: 'beatmap_completed',
                slotLabel: null,
                actions: [
                  {
                    type: 'chat',
                    template: '{{ team_one }} {{ score_one }} - {{ score_two }} {{ team_two }}',
                  },
                ],
                enabled: true,
              };
              next.automation.push(rule);
            })
          }
        >
          {t('+ Rule')}
        </button>
      }
    >
      {draft.automation.map((rule, index) => (
        <div className="row" key={rule.id}>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(event) => edit((next) => (next.automation[index]!.enabled = event.target.checked))}
          />
          <select
            value={rule.trigger}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.automation[index]!.trigger = event.target.value as AutomationTrigger),
              )
            }
          >
            <option value="match_created">{t('match created')}</option>
            <option value="beatmap_started">{t('beatmap started')}</option>
            <option value="beatmap_completed">{t('beatmap completed')}</option>
            <option value="match_finished">{t('match finished')}</option>
            <option value="action_applied">{t('action applied')}</option>
          </select>
          <input
            placeholder={t('slot filter (optional)')}
            value={rule.slotLabel ?? ''}
            onChange={(event) =>
              edit((next) => (next.automation[index]!.slotLabel = event.target.value || null))
            }
          />
          <input
            className="grow"
            value={rule.actions[0]?.type === 'chat' ? rule.actions[0].template : ''}
            onChange={(event) =>
              edit(
                (next) =>
                  (next.automation[index]!.actions = [
                    { type: 'chat', template: event.target.value },
                  ]),
              )
            }
          />
          <button
            type="button"
            className="ghost small danger"
            onClick={() => edit((next) => next.automation.splice(index, 1))}
          >
            ×
          </button>
        </div>
      ))}
    </Section>
  );
}

function parseMods(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((mod) => mod.trim().toUpperCase())
    .filter(Boolean);
}

function parseMultipliers(value: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const pair of value.split(',')) {
    const [key, raw] = pair.split('=');
    if (!key || raw === undefined) continue;
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) result[key.trim().toUpperCase()] = parsed;
  }
  return result;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}