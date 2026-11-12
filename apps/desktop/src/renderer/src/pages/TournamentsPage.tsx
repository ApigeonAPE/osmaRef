import { useEffect, useMemo, useState } from 'react';
import {
  TOURNAMENT_MODES,
  WinConditionSchema,
  matchTeamIds,
  validateTournamentReferences,
  type ImportPreview,
  type Match,
  type MatchType,
  type RemoteTournamentSummary,
  type RulesetId,
  type Stage,
  type StageGroup,
  type Team,
  type Tournament,
  type TournamentMode,
  type WinCondition,
} from '@osmaref/contracts';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Field, Modal, Section, formatDateTime } from '../ui';
import { IdInput } from '../components/IdInput';
import { Toast } from '../components/Toast';

const RULESET_LABELS = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

export function TournamentsPage() {
  const model = useModel();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Tournament | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [remoteList, setRemoteList] = useState<RemoteTournamentSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [memberInput, setMemberInput] = useState<Record<number, string>>({});

  useEffect(() => {
    if (dirty) return;
    const target = model.tournaments.find((entry) => entry.id === selectedId) ?? model.tournaments[0];
    if (!target) {
      setDraft(null);
      return;
    }
    if (selectedId !== target.id) setSelectedId(target.id);
    setDraft(structuredClone(target));
    setActiveStageId((previous) =>
      previous && target.stages.some((stage) => stage.id === previous)
        ? previous
        : target.stages[0]?.id ?? null,
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
          message: errorText(cause),
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
    setActiveStageId(null);
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

  const removeTournament = async () => {
    if (!draft) return;
    if (!window.confirm(t('Delete "{name}"? This cannot be undone.', { name: draft.name }))) return;
    setBusy(true);
    try {
      await window.osmaRef.tournaments.remove(draft.id);
      await model.refreshTournaments();
      setDirty(false);
      setSelectedId(null);
      setDraft(null);
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
      setImportPreview(null);
      setDirty(false);
      setSelectedId(saved.id);
      setDraft(structuredClone(saved));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportTournament = async () => {
    if (!draft) return;
    setError(null);
    setNotice(null);
    try {
      const path = await window.osmaRef.tournaments.exportFile(draft.id);
      if (path) setNotice(t('exported to {path}', { path }));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const activeStage =
    draft?.stages.find((stage) => stage.id === activeStageId) ?? draft?.stages[0] ?? null;

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
      {lookupError ? <Toast message={lookupError} onClose={() => setLookupError(null)} /> : null}
      {notice ? <Toast kind="success" message={notice} onClose={() => setNotice(null)} /> : null}

      <div className="split">
        <aside className="list-panel">
          <div className="list-head">
            <strong>{t('{count} tournament(s)', { count: model.tournaments.length })}</strong>
            <button type="button" className="ghost small" onClick={() => void createTournament()}>
              {t('+ New')}
            </button>
          </div>
          <div className="tournament-list">
            {model.tournaments.length === 0 ? (
              <p className="muted small">
                {t('Create a tournament or import an existing configuration.')}
              </p>
            ) : null}
            {model.tournaments.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`tournament-item${entry.id === selectedId ? ' active' : ''}`}
                onClick={() => select(entry.id)}
              >
                <span className="list-name">{entry.name}</span>
                <span className="muted small">
                  {entry.abbreviation} · {t('{count} team(s)', { count: entry.teams.length })}
                </span>
              </button>
            ))}
          </div>
          {draft ? (
            <div className="row-actions">
              <button type="button" className="ghost small danger" onClick={() => void removeTournament()}>
                {t('Delete tournament')}
              </button>
            </div>
          ) : null}
        </aside>

        <div className="editor-panel">
          {!draft ? (
            <Section title={t('No tournament selected')}>
              <p className="muted">{t('Create one to start configuring teams and stages.')}</p>
            </Section>
          ) : (
            <>
              <Section title={t('Basics')}>
                <div className="form-grid">
                  <Field label={t('Name')}>
                    <input
                      value={draft.name}
                      onChange={(event) => edit((next) => (next.name = event.target.value))}
                    />
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
                  <Field label={t('Mode')}>
                    <select
                      value={draft.mode}
                      onChange={(event) =>
                        edit((next) => (next.mode = event.target.value as TournamentMode))
                      }
                    >
                      {TOURNAMENT_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {modeLabel(mode)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Team Size')}>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      value={draft.teamSize}
                      onChange={(event) =>
                        edit(
                          (next) =>
                            (next.teamSize = Math.max(
                              1,
                              Math.min(16, Number(event.target.value) || 1),
                            )),
                        )
                      }
                    />
                  </Field>
                  <Field label={t('Ruleset')}>
                    <span className="muted small">
                      {draft.mode === 'osu'
                        ? t('Native beatmap mode')
                        : draft.mode === 'multi'
                          ? t('Per-beatmap mode')
                          : modeLabel(draft.mode)}
                    </span>
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
                    {issues.slice(0, 8).map((issue, index) => (
                      <li key={index}>
                        {issue.path.join('.')}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <TeamsEditor
                draft={draft}
                edit={edit}
                memberInput={memberInput}
                setMemberInput={setMemberInput}
                pendingIds={pendingIds}
                resolveName={resolveName}
              />

              <StagesEditor
                draft={draft}
                edit={edit}
                activeStage={activeStage}
                onSelectStage={setActiveStageId}
              />

              <AutomationEditor draft={draft} edit={edit} />
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
            <strong>{importPreview.tournament.name}</strong> · revision{' '}
            {importPreview.tournament.revision} ·{' '}
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
          {remoteList.length === 0 ? (
            <p className="muted">{t('The server has no published tournaments.')}</p>
          ) : null}
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
              <button
                type="button"
                className="ghost small"
                onClick={() => void previewRemote(remote.id)}
              >
                {t('Preview')}
              </button>
            </div>
          ))}
        </Modal>
      ) : null}
    </div>
  );
}

function TeamsEditor({
  draft,
  edit,
  memberInput,
  setMemberInput,
  pendingIds,
  resolveName,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  memberInput: Record<number, string>;
  setMemberInput: (value: Record<number, string>) => void;
  pendingIds: Set<number>;
  resolveName: (id: number, apply: (username: string) => void) => Promise<void>;
}) {
  const { t } = useI18n();

  const addTeam = () => {
    const nextId = draft.teams.reduce((max, team) => Math.max(max, team.id), -1) + 1;
    edit((next) =>
      next.teams.push({
        id: nextId,
        name: `Team ${nextId + 1}`,
        captainUserId: null,
        members: [],
        seed: null,
      }),
    );
  };

  const addMember = async (team: Team) => {
    const raw = (memberInput[team.id] ?? '').trim();
    if (!raw) return;
    const userId = Number(raw.replace(/^#/, ''));
    if (!Number.isInteger(userId) || userId <= 0) return;
    let username = '';
    await resolveName(userId, (name) => {
      username = name;
    });
    edit((next) => {
      const target = next.teams.find((entry) => entry.id === team.id);
      if (!target || target.members.some((member) => member.userId === userId)) return;
      target.members.push({ userId, username });
    });
    setMemberInput({ ...memberInput, [team.id]: '' });
  };

  return (
    <Section
      title={t('Teams and roster')}
      actions={
        <button type="button" className="ghost small" onClick={addTeam}>
          {t('+ Team')}
        </button>
      }
    >
      {draft.teams.length === 0 ? <p className="muted small">{t('No teams yet.')}</p> : null}
      <div className="team-editor-list">
        {draft.teams.map((team) => (
          <div className="team-editor" key={team.id}>
            <div className="team-editor-head">
              <input
                className="team-name-input"
                value={team.name}
                onChange={(event) =>
                  edit((next) => {
                    const target = next.teams.find((entry) => entry.id === team.id);
                    if (target) target.name = event.target.value;
                  })
                }
              />
              <label className="inline-field">
                {t('Seed')}
                <input
                  type="number"
                  min={0}
                  value={team.seed ?? ''}
                  onChange={(event) =>
                    edit((next) => {
                      const target = next.teams.find((entry) => entry.id === team.id);
                      if (!target) return;
                      const value = event.target.value.trim();
                      target.seed = value === '' ? null : Math.max(0, Math.floor(Number(value)));
                    })
                  }
                />
              </label>
              <label className="inline-field">
                {t('Captain')}
                <select
                  value={team.captainUserId ?? ''}
                  onChange={(event) =>
                    edit((next) => {
                      const target = next.teams.find((entry) => entry.id === team.id);
                      if (!target) return;
                      target.captainUserId = event.target.value ? Number(event.target.value) : null;
                    })
                  }
                >
                  <option value="">—</option>
                  {team.members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.username || `#${member.userId}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost small danger"
                onClick={() => edit((next) => (next.teams = next.teams.filter((entry) => entry.id !== team.id)))}
              >
                ×
              </button>
            </div>
            <div className="member-chips">
              {team.members.map((member) => (
                <span className="member-chip" key={member.userId}>
                  {member.username || `#${member.userId}`}
                  <button
                    type="button"
                    className="member-remove"
                    onClick={() =>
                      edit((next) => {
                        const target = next.teams.find((entry) => entry.id === team.id);
                        if (!target) return;
                        target.members = target.members.filter(
                          (entry) => entry.userId !== member.userId,
                        );
                        if (target.captainUserId === member.userId) target.captainUserId = null;
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <IdInput
                kind="user"
                allowUsername
                className="compact-input"
                value={memberInput[team.id] ?? ''}
                onChange={(value) => setMemberInput({ ...memberInput, [team.id]: value })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void addMember(team);
                }}
                placeholder={t('user id')}
              />
              <button
                type="button"
                className="ghost small"
                disabled={pendingIds.size > 0 || !(memberInput[team.id] ?? '').trim()}
                onClick={() => void addMember(team)}
              >
                {t('+ player')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function StagesEditor({
  draft,
  edit,
  activeStage,
  onSelectStage,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  activeStage: Stage | null;
  onSelectStage: (id: string | null) => void;
}) {
  const { t } = useI18n();

  const addStage = () => {
    const id = `stage_${Date.now().toString(36)}`;
    edit((next) => {
      const order = next.stages.length;
      next.stages.push({
        id,
        name: `Stage ${order + 1}`,
        order,
        type: 'knockout',
        groups: [],
        bestOf: 9,
        slots: [],
        flow: {
          id: `flow_${id}`,
          name: `Stage ${order + 1} flow`,
          steps: [
            { id: `step_ban_${id}`, kind: 'ban', count: 1 },
            { id: `step_pick_${id}`, kind: 'pick', count: 10 },
          ],
          triggers: [],
        },
        scoringScheme: {
          id: `score_${id}`,
          name: 'Score V2',
          winCondition: 'score_v2',
          aggregation: 'sum',
          modMultipliers: {},
        },
        matches: [],
      });
    });
    onSelectStage(id);
  };

  const stageIndex = activeStage
    ? draft.stages.findIndex((stage) => stage.id === activeStage.id)
    : -1;

  return (
    <Section
      title={t('Stages')}
      actions={
        <button type="button" className="ghost small" onClick={addStage}>
          {t('+ Stage')}
        </button>
      }
    >
      {draft.stages.length === 0 ? (
        <p className="muted small">{t('No stages yet.')}</p>
      ) : (
        <div className="session-tabs">
          {draft.stages.map((stage) => (
            <button
              key={stage.id}
              type="button"
              className={`tab${stage.id === activeStage?.id ? ' active' : ''}`}
              onClick={() => onSelectStage(stage.id)}
            >
              {stage.name}
            </button>
          ))}
        </div>
      )}

      {activeStage && stageIndex >= 0 ? (
        <>
          <div className="form-grid">
            <Field label={t('Stage name')}>
              <input
                value={activeStage.name}
                onChange={(event) =>
                  edit((next) => {
                    next.stages[stageIndex]!.name = event.target.value;
                  })
                }
              />
            </Field>
            <Field label={t('Stage type')}>
              <select
                value={activeStage.type}
                onChange={(event) =>
                  edit((next) => {
                    next.stages[stageIndex]!.type = event.target.value as 'group' | 'knockout';
                  })
                }
              >
                <option value="group">{t('Group stage')}</option>
                <option value="knockout">{t('Knockout')}</option>
              </select>
            </Field>
            <Field label={t('best of')}>
              <input
                type="number"
                min={1}
                max={31}
                step={2}
                value={activeStage.bestOf}
                onChange={(event) =>
                  edit((next) => {
                    next.stages[stageIndex]!.bestOf = Math.max(
                      1,
                      Math.min(31, Number(event.target.value) || 1),
                    );
                  })
                }
              />
            </Field>
          </div>

          <div className="row-actions">
            <button
              type="button"
              className="ghost small danger"
              onClick={() => {
                edit((next) => {
                  next.stages = next.stages.filter((stage) => stage.id !== activeStage.id);
                });
                onSelectStage(null);
              }}
            >
              {t('Delete stage')}
            </button>
          </div>

          {activeStage.type === 'group' ? (
            <GroupsEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          ) : null}

          <PoolEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          <FlowEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          <ScoringEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          <MatchesEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
        </>
      ) : null}
    </Section>
  );
}

function GroupsEditor({
  draft,
  edit,
  stage,
  stageIndex,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();

  const addGroup = () => {
    const id = `group_${Date.now().toString(36)}`;
    edit((next) =>
      next.stages[stageIndex]!.groups.push({ id, name: `Group ${stage.groups.length + 1}`, teamIds: [] }),
    );
  };

  const toggleTeam = (group: StageGroup, teamId: number) => {
    edit((next) => {
      const target = next.stages[stageIndex]!.groups.find((entry) => entry.id === group.id);
      if (!target) return;
      target.teamIds = target.teamIds.includes(teamId)
        ? target.teamIds.filter((id) => id !== teamId)
        : [...target.teamIds, teamId];
    });
  };

  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Groups')}</strong>
        <button type="button" className="ghost small" onClick={addGroup}>
          {t('+ Group')}
        </button>
      </div>
      {stage.groups.length === 0 ? <p className="muted small">{t('No groups yet.')}</p> : null}
      {stage.groups.map((group) => (
        <div className="group-editor" key={group.id}>
          <div className="row">
            <input
              value={group.name}
              onChange={(event) =>
                edit((next) => {
                  const target = next.stages[stageIndex]!.groups.find(
                    (entry) => entry.id === group.id,
                  );
                  if (target) target.name = event.target.value;
                })
              }
            />
            <button
              type="button"
              className="ghost small danger"
              onClick={() =>
                edit((next) => {
                  next.stages[stageIndex]!.groups = next.stages[stageIndex]!.groups.filter(
                    (entry) => entry.id !== group.id,
                  );
                })
              }
            >
              ×
            </button>
          </div>
          <div className="member-chips">
            {draft.teams.map((team) => (
              <button
                key={team.id}
                type="button"
                className={`team-toggle${group.teamIds.includes(team.id) ? ' active' : ''}`}
                onClick={() => toggleTeam(group, team.id)}
              >
                {team.name}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PoolEditor({
  draft,
  edit,
  stage,
  stageIndex,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();

  const addSlot = () => {
    const id = `slot_${Date.now().toString(36)}`;
    edit((next) => {
      const target = next.stages[stageIndex]!;
      const nextIndex = target.slots.length + 1;
      target.slots.push({
        id,
        label: `NM${nextIndex}`,
        category: 'NM',
        beatmapId: 1,
        rulesetId: null,
        requiredMods: [],
        allowedMods: [],
        freestyle: false,
        winCondition: null,
        winConditionWinner: null,
      });
    });
  };

  const patchSlot = (index: number, mutator: (slot: Stage['slots'][number]) => void) => {
    edit((next) => mutator(next.stages[stageIndex]!.slots[index]!));
  };

  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Mappool')}</strong>
        <button type="button" className="ghost small" onClick={addSlot}>
          {t('+ Slot')}
        </button>
      </div>
      {stage.slots.length === 0 ? (
        <p className="muted small">{t('Create a mappool to add beatmaps.')}</p>
      ) : (
        <div className="slot-editor-list">
          {stage.slots.map((slot, index) => (
            <div className="slot-editor" key={slot.id}>
              <input
                value={slot.label}
                maxLength={12}
                onChange={(event) => patchSlot(index, (target) => (target.label = event.target.value))}
              />
              <input
                value={slot.category}
                maxLength={8}
                onChange={(event) =>
                  patchSlot(index, (target) => (target.category = event.target.value.toUpperCase()))
                }
              />
              <input
                type="number"
                min={1}
                value={slot.beatmapId}
                onChange={(event) =>
                  patchSlot(index, (target) => (target.beatmapId = Math.max(1, Number(event.target.value) || 1)))
                }
              />
              <select
                value={slot.rulesetId ?? ''}
                onChange={(event) =>
                  patchSlot(
                    index,
                    (target) =>
                      (target.rulesetId = event.target.value
                        ? (Number(event.target.value) as RulesetId)
                        : null),
                  )
                }
              >
                <option value="">{t('Native')}</option>
                {RULESET_LABELS.map((label, rulesetId) => (
                  <option key={rulesetId} value={rulesetId}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost small danger"
                onClick={() =>
                  edit((next) => {
                    next.stages[stageIndex]!.slots.splice(index, 1);
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FlowEditor({
  draft,
  edit,
  stage,
  stageIndex,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();

  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Pick/Ban flow')}</strong>
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) => {
              const target = next.stages[stageIndex]!.flow;
              target.steps.push({ id: `step_${Date.now()}`, kind: 'pick', count: 1 });
            })
          }
        >
          {t('+ step')}
        </button>
      </div>
      {stage.flow.steps.map((step, index) => (
        <div className="row" key={step.id}>
          <select
            value={step.kind}
            onChange={(event) =>
              edit((next) => {
                next.stages[stageIndex]!.flow.steps[index]!.kind = event.target.value as
                  | 'protect'
                  | 'ban'
                  | 'pick';
              })
            }
          >
            <option value="protect">{t('protect')}</option>
            <option value="ban">{t('ban')}</option>
            <option value="pick">{t('pick')}</option>
          </select>
          <input
            type="number"
            min={1}
            max={10}
            value={step.count}
            onChange={(event) =>
              edit((next) => {
                next.stages[stageIndex]!.flow.steps[index]!.count = Math.max(
                  1,
                  Math.min(10, Number(event.target.value) || 1),
                );
              })
            }
          />
          <button
            type="button"
            className="ghost small danger"
            onClick={() =>
              edit((next) => {
                next.stages[stageIndex]!.flow.steps.splice(index, 1);
              })
            }
          >
            ×
          </button>
        </div>
      ))}

      <div className="flow-triggers">
        <div className="row">
          <span className="muted small">{t('Score triggers')}</span>
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              edit((next) => {
                next.stages[stageIndex]!.flow.triggers.push({
                  id: `trigger_${Date.now()}`,
                  team: 'team_one',
                  threshold: 1,
                  action: 'pick',
                  count: 1,
                  repeatEvery: null,
                });
              })
            }
          >
            {t('+ Rule')}
          </button>
        </div>
        {stage.flow.triggers.map((trigger, index) => (
          <div className="row" key={trigger.id}>
            <select
              value={trigger.team}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.team = event.target.value as
                    | 'team_one'
                    | 'team_two';
                })
              }
            >
              <option value="team_one">{t('red team')}</option>
              <option value="team_two">{t('blue team')}</option>
            </select>
            <input
              type="number"
              min={1}
              max={31}
              value={trigger.threshold}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.threshold = Math.max(
                    1,
                    Math.min(31, Number(event.target.value) || 1),
                  );
                })
              }
            />
            <select
              value={trigger.action}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.action = event.target.value as
                    | 'ban'
                    | 'protect'
                    | 'pick';
                })
              }
            >
              <option value="protect">{t('protect')}</option>
              <option value="ban">{t('ban')}</option>
              <option value="pick">{t('pick')}</option>
            </select>
            <button
              type="button"
              className="ghost small danger"
              onClick={() =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers.splice(index, 1);
                })
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

function ScoringEditor({
  edit,
  stage,
  stageIndex,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();

  return (
    <div className="flow-card">
      <strong>{t('Scoring')}</strong>
      <div className="form-grid">
        <Field label={t('Win condition')}>
          <select
            value={stage.scoringScheme.winCondition}
            onChange={(event) =>
              edit((next) => {
                next.stages[stageIndex]!.scoringScheme.winCondition = event.target.value as WinCondition;
              })
            }
          >
            {WinConditionSchema.options.map((condition) => (
              <option key={condition} value={condition}>
                {t(condition)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

function MatchesEditor({
  draft,
  edit,
  stage,
  stageIndex,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();

  const addMatch = (type: 'lobby' | 'match') => {
    const id = `match_${Date.now().toString(36)}`;
    edit((next) => {
      const target = next.stages[stageIndex]!;
      const base = {
        id,
        name: type === 'lobby' ? 'Lobby' : 'Match',
        groupId: target.groups[0]?.id ?? null,
        refereeIds: [],
        transport: 'irc' as const,
        scheduledAt: new Date().toISOString(),
        result: { scoreRed: 0, scoreBlue: 0 },
        roomNameTemplate: '{tournament}: ({team_one}) vs ({team_two})',
        initialBeatmapId: target.slots[0]?.beatmapId ?? null,
        notes: undefined,
      };
      if (type === 'lobby') {
        target.matches.push({
          ...base,
          type: 'lobby',
          teamIds: next.teams.slice(0, 3).map((team) => team.id),
          roomMode: 'head_to_head',
        });
      } else {
        target.matches.push({
          ...base,
          type: 'match',
          teamRedId: next.teams[0]?.id ?? 0,
          teamBlueId: next.teams[1]?.id ?? 0,
          roomMode: 'team_versus',
        });
      }
    });
  };

  const patchMatch = (index: number, mutator: (match: Match) => void) => {
    edit((next) => mutator(next.stages[stageIndex]!.matches[index]!));
  };

  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Matches')}</strong>
        <button type="button" className="ghost small" onClick={() => addMatch('match')}>
          {t('+ Match')}
        </button>
        <button type="button" className="ghost small" onClick={() => addMatch('lobby')}>
          {t('+ Lobby')}
        </button>
      </div>
      {stage.matches.length === 0 ? (
        <p className="muted small">{t('Add a match to open a room from the workbench.')}</p>
      ) : null}
      <div className="match-editor-list">
        {stage.matches.map((match, index) => (
          <div className="match-editor" key={match.id}>
            <div className="row">
              <span className={`pill ${match.type}`}>{match.type === 'match' ? t('Match') : t('Lobby')}</span>
              <input
                value={match.name}
                onChange={(event) => patchMatch(index, (target) => (target.name = event.target.value))}
              />
              <select
                value={match.groupId ?? ''}
                onChange={(event) =>
                  patchMatch(index, (target) => (target.groupId = event.target.value || null))
                }
              >
                <option value="">—</option>
                {stage.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost small danger"
                onClick={() =>
                  edit((next) => {
                    next.stages[stageIndex]!.matches.splice(index, 1);
                  })
                }
              >
                ×
              </button>
            </div>

            <div className="form-grid">
              {match.type === 'match' ? (
                <>
                  <Field label={t('Red team')}>
                    <select
                      value={match.teamRedId}
                      onChange={(event) =>
                        patchMatch(
                          index,
                          (target) => target.type === 'match' && (target.teamRedId = Number(event.target.value)),
                        )
                      }
                    >
                      {draft.teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Blue team')}>
                    <select
                      value={match.teamBlueId}
                      onChange={(event) =>
                        patchMatch(
                          index,
                          (target) => target.type === 'match' && (target.teamBlueId = Number(event.target.value)),
                        )
                      }
                    >
                      {draft.teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : (
                <Field label={t('Teams')} wide>
                  <div className="member-chips">
                    {draft.teams.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        className={`team-toggle${matchTeamIds(match).includes(team.id) ? ' active' : ''}`}
                        onClick={() =>
                          patchMatch(index, (target) => {
                            if (target.type !== 'lobby') return;
                            target.teamIds = target.teamIds.includes(team.id)
                              ? target.teamIds.filter((id) => id !== team.id)
                              : [...target.teamIds, team.id];
                          })
                        }
                      >
                        {team.name}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              <Field label={t('Time (UTC)')}>
                <input
                  type="datetime-local"
                  value={toUtcInput(match.scheduledAt)}
                  onChange={(event) =>
                    patchMatch(index, (target) => {
                      const date = new Date(`${event.target.value}:00.000Z`);
                      target.scheduledAt = Number.isNaN(date.getTime())
                        ? target.scheduledAt
                        : date.toISOString();
                    })
                  }
                />
              </Field>
              <Field label={t('Room mode')}>
                <select
                  value={match.roomMode}
                  onChange={(event) =>
                    patchMatch(index, (target) => (target.roomMode = event.target.value as MatchType))
                  }
                >
                  <option value="team_versus">{t('Team VS')}</option>
                  <option value="head_to_head">{t('Head to head')}</option>
                </select>
              </Field>
              <Field label={t('Transport')}>
                <select
                  value={match.transport}
                  onChange={(event) =>
                    patchMatch(
                      index,
                      (target) => (target.transport = event.target.value as 'irc' | 'referee_hub'),
                    )
                  }
                >
                  <option value="irc">IRC</option>
                  <option value="referee_hub">Referee Hub</option>
                </select>
              </Field>
              <Field label={t('Referees (user ids)')}>
                <input
                  value={match.refereeIds.join(', ')}
                  onChange={(event) =>
                    patchMatch(index, (target) => {
                      target.refereeIds = event.target.value
                        .split(/[\s,]+/)
                        .map((value) => Number(value))
                        .filter((value) => Number.isInteger(value) && value > 0);
                    })
                  }
                />
              </Field>
              <Field label={t('initial beatmap')}>
                <input
                  type="number"
                  min={0}
                  value={match.initialBeatmapId ?? ''}
                  onChange={(event) =>
                    patchMatch(index, (target) => {
                      const value = event.target.value.trim();
                      target.initialBeatmapId = value === '' ? null : Math.max(1, Number(value));
                    })
                  }
                />
              </Field>
              {match.type === 'match' ? (
                <>
                  <Field label={t('Red score')}>
                    <input
                      type="number"
                      min={0}
                      value={match.result.scoreRed}
                      onChange={(event) =>
                        patchMatch(index, (target) => {
                          target.result.scoreRed = Math.max(0, Math.floor(Number(event.target.value) || 0));
                        })
                      }
                    />
                  </Field>
                  <Field label={t('Blue score')}>
                    <input
                      type="number"
                      min={0}
                      value={match.result.scoreBlue}
                      onChange={(event) =>
                        patchMatch(index, (target) => {
                          target.result.scoreBlue = Math.max(0, Math.floor(Number(event.target.value) || 0));
                        })
                      }
                    />
                  </Field>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomationEditor({
  draft,
  edit,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flow-card">
      <div className="row">
        <strong>{t('Message triggers')}</strong>
        <button
          type="button"
          className="ghost small"
          onClick={() =>
            edit((next) =>
              next.automation.push({
                id: `rule_${Date.now()}`,
                name: 'Rule',
                trigger: 'beatmap_completed',
                slotLabel: null,
                actions: [{ type: 'chat', template: '{{ team_one }} {{ score_one }} - {{ score_two }} {{ team_two }} ({{ slot }})' }],
                enabled: true,
              }),
            )
          }
        >
          {t('+ Rule')}
        </button>
      </div>
      {draft.automation.length === 0 ? (
        <p className="muted small">{t('No message triggers yet.')}</p>
      ) : null}
      {draft.automation.map((rule, index) => (
        <div className="row" key={rule.id}>
          <input
            value={rule.name}
            onChange={(event) =>
              edit((next) => {
                next.automation[index]!.name = event.target.value;
              })
            }
          />
          <select
            value={rule.trigger}
            onChange={(event) =>
              edit((next) => {
                next.automation[index]!.trigger = event.target.value as typeof rule.trigger;
              })
            }
          >
            <option value="match_created">{t('match created')}</option>
            <option value="beatmap_started">{t('beatmap started')}</option>
            <option value="beatmap_completed">{t('beatmap completed')}</option>
            <option value="match_finished">{t('match finished')}</option>
            <option value="action_applied">{t('action applied')}</option>
          </select>
          <button
            type="button"
            className="ghost small danger"
            onClick={() => edit((next) => next.automation.splice(index, 1))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function modeLabel(mode: TournamentMode): string {
  if (mode === 'multi') return 'Multi';
  if (mode === 'osu') return 'osu!';
  return RULESET_LABELS[mode === 'taiko' ? 1 : mode === 'catch' ? 2 : 3] ?? mode;
}

function toUtcInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
