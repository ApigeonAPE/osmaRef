import { useEffect, useMemo, useState } from 'react';
import {
  AUTOMATION_TRIGGERS,
  BUILTIN_WIN_BY_RULE_ID,
  PLATFORM_TEAM_MODES,
  PLATFORM_WIN_CONDITIONS,
  TOURNAMENT_MODES,
  composeSlotLabel,
  normalizeRoomMode,
  slotLabelSequence,
  type Platform,
  type RoomWinCondition,
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
  type ValidationIssue,
  type WinByRule,
} from '@osmaref/contracts';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Field, Modal, Section, formatDateTime } from '../ui';
import { IdInput } from '../components/IdInput';
import { ModSelector } from '../components/ModSelector';
import { Toast } from '../components/Toast';

const RULESET_LABELS = ['osu!', 'osu!taiko', 'osu!catch', 'osu!mania'];

type WorkspaceView = 'basics' | 'teams' | 'stages' | 'automation';
type StageView = 'groups' | 'mappool' | 'flow' | 'winby' | 'matches';

const WORKSPACE_VIEWS: { id: WorkspaceView; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'teams', label: 'Teams' },
  { id: 'stages', label: 'Stages' },
  { id: 'automation', label: 'Message triggers' },
];

function isPoolPlaceholderIssue(issue: ValidationIssue): boolean {
  const [root, stageIndex, collection, , field] = issue.path;
  if (root !== 'stages' || typeof stageIndex !== 'number' || collection !== 'slots') return false;
  if (field === 'label') return issue.message === 'slot label is empty';
  if (field === 'category') return issue.message === 'slot category is empty';
  if (field === 'beatmapId') return issue.message === 'beatmap id must be a positive number';
  return false;
}

function slotModLabel(slot: Stage['slots'][number]): string {
  if (slot.freestyle) return 'Freestyle';
  const required = slot.requiredMods.join(' ');
  const allowed = slot.allowedMods.length > 0 ? `(${slot.allowedMods.join(' ')})` : '';
  return [required, allowed].filter(Boolean).join(' ');
}

function BeatmapIdField({
  beatmapId,
  invalid,
  onChange,
}: {
  beatmapId: number;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [localInvalid, setLocalInvalid] = useState(false);

  useEffect(() => {
    if (beatmapId <= 0) {
      setLocalInvalid(false);
      return;
    }
    let cancelled = false;
    setLocalInvalid(false);
    const timer = window.setTimeout(() => {
      void window.osmaRef.osu
        .lookupBeatmaps([beatmapId])
        .then((result) => {
          if (!cancelled) {
            setLocalInvalid(!result.beatmaps.some((beatmap) => beatmap.id === beatmapId));
          }
        })
        .catch(() => {
          if (!cancelled) setLocalInvalid(true);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [beatmapId]);

  return (
    <IdInput
      kind="beatmap"
      value={beatmapId > 0 ? String(beatmapId) : ''}
      placeholder={t('Beatmap id')}
      aria-invalid={beatmapId <= 0 || localInvalid || invalid}
      onChange={onChange}
    />
  );
}

export function TournamentsPage() {
  const model = useModel();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Tournament | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('basics');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [remoteList, setRemoteList] = useState<RemoteTournamentSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [memberInput, setMemberInput] = useState<Record<number, string>>({});
  const [invalidBeatmapIds, setInvalidBeatmapIds] = useState<Set<number>>(new Set());
  const [mappoolRequest, setMappoolRequest] = useState(0);

  useEffect(() => {
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    if (dirty) return;
    const target = model.tournaments.find((entry) => entry.id === selectedId);
    if (!target) {
      setSelectedId(null);
      setDraft(null);
      return;
    }
    setDraft(structuredClone(target));
    setActiveStageId((previous) =>
      previous && target.stages.some((stage) => stage.id === previous)
        ? previous
        : target.stages[0]?.id ?? null,
    );
  }, [model.tournaments, selectedId, dirty]);

  const issues = useMemo(() => (draft ? validateTournamentReferences(draft) : []), [draft]);
  const visibleIssues = issues.filter((issue) => !isPoolPlaceholderIssue(issue));

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
    setWorkspaceView('basics');
    setInvalidBeatmapIds(new Set());
  };

  const closeDetail = () => {
    if (dirty && !window.confirm(t('Discard unsaved changes?'))) return;
    setDirty(false);
    setSelectedId(null);
    setDraft(null);
    setActiveStageId(null);
    setWorkspaceView('basics');
    setInvalidBeatmapIds(new Set());
  };

  const clearInvalidBeatmaps = () => {
    setInvalidBeatmapIds((previous) => (previous.size > 0 ? new Set() : previous));
  };

  const save = async () => {
    if (!draft) return;
    const unnamedStage = draft.stages.find((stage) => !stage.name.trim());
    if (unnamedStage) {
      setError(t('Stage name is required'));
      setActiveStageId(unnamedStage.id);
      setWorkspaceView('stages');
      return;
    }
    const incompleteStage = draft.stages.find((stage) =>
      stage.slots.some(
        (slot) => !slot.category.trim() || !slotLabelSequence(slot.label) || slot.beatmapId <= 0,
      ),
    );
    if (incompleteStage) {
      setActiveStageId(incompleteStage.id);
      setWorkspaceView('stages');
      setMappoolRequest((value) => value + 1);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setInvalidBeatmapIds(new Set());
    try {
      const beatmapIds = Array.from(
        new Set(draft.stages.flatMap((stage) => stage.slots.map((slot) => slot.beatmapId))),
      );
      if (beatmapIds.length > 0) {
        const result = await window.osmaRef.osu.lookupBeatmaps(beatmapIds);
        const found = new Set(result.beatmaps.map((beatmap) => beatmap.id));
        const invalid = new Set(beatmapIds.filter((id) => !found.has(id)));
        setInvalidBeatmapIds(invalid);
        if (invalid.size > 0) {
          const stage = draft.stages.find((entry) =>
            entry.slots.some((slot) => invalid.has(slot.beatmapId)),
          );
          if (stage) {
            setActiveStageId(stage.id);
            setWorkspaceView('stages');
            setMappoolRequest((value) => value + 1);
          }
          return;
        }
      }
      const saved = await model.saveTournament(structuredClone(draft));
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
      setActiveStageId(null);
      setWorkspaceView('basics');
      setInvalidBeatmapIds(new Set());
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
      setActiveStageId(null);
      setWorkspaceView('basics');
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
      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}
      {lookupError ? <Toast message={lookupError} onClose={() => setLookupError(null)} /> : null}
      {notice ? <Toast kind="success" message={notice} onClose={() => setNotice(null)} /> : null}

      {selectedId !== null && draft ? (
        <>
          <header className="page-head">
            <div className="detail-head">
              <button type="button" className="ghost small" onClick={closeDetail}>
                ← {t('Back')}
              </button>
              <h1>{draft.name}</h1>
            </div>
            <div className="row-actions">
              <button type="button" className="ghost" onClick={() => void exportTournament()}>
                {t('Export')}
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => void removeTournament()}
              >
                {t('Delete tournament')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!draft || busy}
                onClick={() => void save()}
              >
                {busy ? t('saving…') : dirty ? t('Save changes') : t('Saved')}
              </button>
            </div>
          </header>

          <div className="editor-panel">
            {!draft ? (
              <Section title={t('No tournament selected')} />
            ) : (
              <>
                {visibleIssues.length > 0 ? (
                  <div className="banner warn">
                    <strong>{t('Configuration issues')}</strong>
                    <ul>
                      {visibleIssues.slice(0, 8).map((issue, index) => (
                        <li key={index}>
                          {issue.path.join('.')}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="workspace-grid">
                  <nav className="workspace-nav">
                    {WORKSPACE_VIEWS.map((view) => (
                      <button
                        key={view.id}
                        type="button"
                        className={`workspace-nav-item${workspaceView === view.id ? ' active' : ''}`}
                        onClick={() => setWorkspaceView(view.id)}
                      >
                        {t(view.label)}
                      </button>
                    ))}
                  </nav>

                  <div className="workspace-body">
                    {workspaceView === 'basics' ? (
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
                          <Field label={t('Platform')}>
                            <select
                              value={draft.platform}
                              onChange={(event) =>
                                edit((next) => {
                                  const platform = event.target.value as Platform;
                                  next.platform = platform;
                                  for (const stage of next.stages) {
                                    for (const match of stage.matches) {
                                      match.roomMode = normalizeRoomMode(platform, match.roomMode);
                                    }
                                  }
                                })
                              }
                            >
                              <option value="stable">stable</option>
                              <option value="lazer">lazer</option>
                            </select>
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
                          {t('id {id}, rev {revision}, updated {date}', {
                            id: draft.id,
                            revision: draft.revision,
                            date: formatDateTime(draft.updatedAt),
                          })}
                        </p>
                      </Section>
                    ) : null}

                    {workspaceView === 'teams' ? (
                      <TeamsEditor
                        draft={draft}
                        edit={edit}
                        memberInput={memberInput}
                        setMemberInput={setMemberInput}
                        pendingIds={pendingIds}
                        resolveName={resolveName}
                      />
                    ) : null}

                    {workspaceView === 'stages' ? (
                      <StagesEditor
                        draft={draft}
                        edit={edit}
                        activeStage={activeStage}
                        onSelectStage={setActiveStageId}
                        mappoolRequest={mappoolRequest}
                        invalidBeatmapIds={invalidBeatmapIds}
                        onBeatmapEdited={clearInvalidBeatmaps}
                      />
                    ) : null}

                    {workspaceView === 'automation' ? (
                      <AutomationEditor draft={draft} edit={edit} />
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>{t('Tournaments')}</h1>
            </div>
          </header>

          <div className="management-layout">
            <aside className="management-sidebar">
              <div className="management-group">
                <span className="management-group-title">{t('Browse')}</span>
                <button type="button" className="management-item active">
                  <span>{t('Local tournaments')}</span>
                  <span className="management-count">{model.tournaments.length}</span>
                </button>
              </div>
              <div className="management-group">
                <span className="management-group-title">{t('Operation')}</span>
                <button
                  type="button"
                  className="management-item"
                  onClick={() => setImportOpen(true)}
                >
                  {t('Import')}
                </button>
                <button
                  type="button"
                  className="management-item"
                  disabled={busy}
                  onClick={() => void createTournament()}
                >
                  {t('+ New')}
                </button>
              </div>
            </aside>

            <section className="management-content">
              <div className="management-content-head">
                <h2>{t('Local tournaments')}</h2>
              </div>
              <div className="tournament-list">
                {model.tournaments.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="tournament-item"
                    onClick={() => select(entry.id)}
                  >
                    <span className="list-name">{entry.name}</span>
                    <span className="muted small">
                      {entry.abbreviation}, {t('{count} team(s)', { count: entry.teams.length })}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {importOpen ? (
        <Modal title={t('Import')} onClose={() => setImportOpen(false)}>
          <div className="import-options">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setImportOpen(false);
                void importFromFile();
              }}
            >
              {t('Import file')}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setImportOpen(false);
                void importFromBracket();
              }}
            >
              {t('Import bracket.json')}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setImportOpen(false);
                void importFromServer();
              }}
            >
              {t('Import from server')}
            </button>
          </div>
        </Modal>
      ) : null}

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
            <strong>{importPreview.tournament.name}</strong>, revision{' '}
            {importPreview.tournament.revision},{' '}
            {importPreview.provider === 'http' ? t('from server') : t('from file')}
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
                  {remote.id}, {t('rev {revision}, {date}', {
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
  mappoolRequest,
  invalidBeatmapIds,
  onBeatmapEdited,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  activeStage: Stage | null;
  onSelectStage: (id: string | null) => void;
  mappoolRequest: number;
  invalidBeatmapIds: Set<number>;
  onBeatmapEdited: () => void;
}) {
  const { t } = useI18n();
  const [stageView, setStageView] = useState<StageView>('mappool');

  useEffect(() => {
    setStageView('mappool');
  }, [mappoolRequest]);

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
        bans: 1,
        protects: 0,
        winCondition: 'score_v2',
        winByRuleId: BUILTIN_WIN_BY_RULE_ID,
        slots: [],
        flow: {
          id: `flow_${id}`,
          name: `Stage ${order + 1} flow`,
          phases: [
            {
              id: `phase_ban_${id}`,
              action: 'ban',
              countPerTeam: 1,
              useStageCount: true,
              phaseOrder: 'alternate',
            },
            {
              id: `phase_pick_${id}`,
              action: 'pick',
              countPerTeam: null,
              useStageCount: false,
              phaseOrder: 'alternate',
            },
          ],
          triggers: [],
        },
        matches: [],
      });
    });
    onSelectStage(id);
    setStageView('mappool');
  };

  const stageIndex = activeStage
    ? draft.stages.findIndex((stage) => stage.id === activeStage.id)
    : -1;
  const resolvedStageView: StageView =
    activeStage?.type !== 'group' && stageView === 'groups' ? 'mappool' : stageView;

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
                onChange={(event) => {
                  const type = event.target.value as 'group' | 'knockout';
                  edit((next) => {
                    next.stages[stageIndex]!.type = type;
                  });
                  if (type !== 'group') setStageView('mappool');
                }}
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
            {draft.platform === 'stable' ? (
              <Field label={t('Win condition')}>
                <select
                  value={activeStage.winCondition}
                  onChange={(event) =>
                    edit((next) => {
                      next.stages[stageIndex]!.winCondition = event.target.value as RoomWinCondition;
                    })
                  }
                >
                  {PLATFORM_WIN_CONDITIONS.stable.map((condition) => (
                    <option key={condition} value={condition}>
                      {winConditionLabel(condition)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label={t('Bans per team')}>
              <input
                type="number"
                min={0}
                max={10}
                value={activeStage.bans}
                onChange={(event) =>
                  edit((next) => {
                    next.stages[stageIndex]!.bans = Math.max(
                      0,
                      Math.min(10, Number(event.target.value) || 0),
                    );
                  })
                }
              />
            </Field>
            <Field label={t('Protects per team')}>
              <input
                type="number"
                min={0}
                max={10}
                value={activeStage.protects}
                onChange={(event) =>
                  edit((next) => {
                    next.stages[stageIndex]!.protects = Math.max(
                      0,
                      Math.min(10, Number(event.target.value) || 0),
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

          <div className="stage-view-tabs">
            {activeStage.type === 'group' ? (
              <button
                type="button"
                className={`tab${resolvedStageView === 'groups' ? ' active' : ''}`}
                onClick={() => setStageView('groups')}
              >
                {t('Groups')}
              </button>
            ) : null}
            <button
              type="button"
              className={`tab${resolvedStageView === 'mappool' ? ' active' : ''}`}
              onClick={() => setStageView('mappool')}
            >
              {t('Mappool')}
            </button>
            <button
              type="button"
              className={`tab${resolvedStageView === 'flow' ? ' active' : ''}`}
              onClick={() => setStageView('flow')}
            >
              {t('Pick/Ban flow')}
            </button>
            <button
              type="button"
              className={`tab${resolvedStageView === 'winby' ? ' active' : ''}`}
              onClick={() => setStageView('winby')}
            >
              {t('Win-by')}
            </button>
            <button
              type="button"
              className={`tab${resolvedStageView === 'matches' ? ' active' : ''}`}
              onClick={() => setStageView('matches')}
            >
              {t('Matches')}
            </button>
          </div>

          {resolvedStageView === 'groups' && activeStage.type === 'group' ? (
            <GroupsEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          ) : null}
          {resolvedStageView === 'mappool' ? (
            <PoolEditor
              draft={draft}
              edit={edit}
              stage={activeStage}
              stageIndex={stageIndex}
              invalidBeatmapIds={invalidBeatmapIds}
              onBeatmapEdited={onBeatmapEdited}
            />
          ) : null}
          {resolvedStageView === 'flow' ? (
            <FlowEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          ) : null}
          {resolvedStageView === 'winby' ? (
            <WinByEditor edit={edit} stage={activeStage} stageIndex={stageIndex} />
          ) : null}
          {resolvedStageView === 'matches' ? (
            <MatchesEditor draft={draft} edit={edit} stage={activeStage} stageIndex={stageIndex} />
          ) : null}
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
      <div className="panel-head">
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
  invalidBeatmapIds,
  onBeatmapEdited,
}: {
  draft: Tournament;
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
  invalidBeatmapIds: Set<number>;
  onBeatmapEdited: () => void;
}) {
  const { t } = useI18n();
  const [modSlotId, setModSlotId] = useState<string | null>(null);
  const modSlot = stage.slots.find((slot) => slot.id === modSlotId) ?? null;

  const addSlot = () => {
    const id = `slot_${Date.now().toString(36)}`;
    edit((next) => {
      next.stages[stageIndex]!.slots.push({
        id,
        label: '',
        category: '',
        beatmapId: 0,
        rulesetId: null,
        requiredMods: [],
        allowedMods: [],
        freestyle: false,
      });
    });
  };

  const patchSlot = (index: number, mutator: (slot: Stage['slots'][number]) => void) => {
    edit((next) => mutator(next.stages[stageIndex]!.slots[index]!));
  };

  const setSlotCategory = (index: number, raw: string) => {
    const category = raw.toUpperCase();
    patchSlot(index, (target) => {
      target.category = category;
      target.label = composeSlotLabel(category, slotLabelSequence(target.label));
    });
  };

  const setSlotSequence = (index: number, raw: string) => {
    const sequence = raw.replace(/\D/g, '');
    patchSlot(index, (target) => {
      target.label = composeSlotLabel(target.category, sequence);
    });
  };

  const patchSlotById = (id: string, mutator: (slot: Stage['slots'][number]) => void) => {
    edit((next) => {
      const slot = next.stages[stageIndex]!.slots.find((entry) => entry.id === id);
      if (slot) mutator(slot);
    });
  };

  return (
    <div className="flow-card">
      <div className="panel-head">
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
                value={slot.category}
                maxLength={8}
                placeholder={t('Type')}
                aria-invalid={!slot.category.trim()}
                onChange={(event) => setSlotCategory(index, event.target.value)}
              />
              <input
                value={slotLabelSequence(slot.label)}
                inputMode="numeric"
                maxLength={4}
                placeholder={t('Number')}
                aria-invalid={!slotLabelSequence(slot.label)}
                onChange={(event) => setSlotSequence(index, event.target.value)}
              />
              <BeatmapIdField
                beatmapId={slot.beatmapId}
                invalid={invalidBeatmapIds.has(slot.beatmapId)}
                onChange={(value) => {
                  onBeatmapEdited();
                  patchSlot(index, (target) => (target.beatmapId = Number(value) || 0));
                }}
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
                className="ghost small slot-mods"
                onClick={() => setModSlotId(slot.id)}
              >
                {slotModLabel(slot) || t('Mods')}
              </button>
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
      {modSlot ? (
        <Modal title={t('Mods')} onClose={() => setModSlotId(null)}>
          <ModSelector
            required={modSlot.requiredMods}
            allowed={modSlot.allowedMods}
            freestyle={modSlot.freestyle}
            platform={draft.platform}
            onChange={(mods) =>
              patchSlotById(modSlot.id, (target) => {
                target.requiredMods = mods.required;
                target.allowedMods = mods.allowed;
                target.freestyle = mods.freestyle;
              })
            }
          />
        </Modal>
      ) : null}
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
  const autoPicks = Math.ceil(stage.bestOf / 2);

  const addPhase = (action: 'protect' | 'ban' | 'pick') => {
    edit((next) => {
      const target = next.stages[stageIndex]!;
      if (action === 'ban') target.bans = Math.max(1, target.bans);
      if (action === 'protect') target.protects = Math.max(1, target.protects);
      target.flow.phases.push({
        id: `phase_${Date.now().toString(36)}`,
        action,
        countPerTeam: action === 'pick' ? null : 1,
        useStageCount: false,
        phaseOrder: 'alternate',
      });
    });
  };

  return (
    <div className="flow-card">
      <div className="panel-head">
        <button type="button" className="ghost small" onClick={() => addPhase('ban')}>
          {t('+ Ban phase')}
        </button>
        <button type="button" className="ghost small" onClick={() => addPhase('protect')}>
          {t('+ Protect phase')}
        </button>
        <button type="button" className="ghost small" onClick={() => addPhase('pick')}>
          {t('+ Pick phase')}
        </button>
      </div>
      {stage.flow.phases.map((phase, phaseIndex) => (
        <div className="row" key={phase.id}>
          <select
            value={phase.action}
            onChange={(event) =>
              edit((next) => {
                const target = next.stages[stageIndex]!.flow.phases[phaseIndex]!;
                const action = event.target.value as 'protect' | 'ban' | 'pick';
                target.action = action;
                if (action === 'pick') {
                  target.countPerTeam = null;
                  target.useStageCount = false;
                } else if (target.countPerTeam === null) {
                  target.countPerTeam = 1;
                }
              })
            }
          >
            <option value="protect">{t('protect')}</option>
            <option value="ban">{t('ban')}</option>
            <option value="pick">{t('pick')}</option>
          </select>

          {phase.action === 'pick' ? (
            <span className="pill">{autoPicks}×</span>
          ) : (
            <>
              <label className="inline-field">
                <input
                  type="checkbox"
                  checked={phase.useStageCount}
                  onChange={(event) =>
                    edit((next) => {
                      next.stages[stageIndex]!.flow.phases[phaseIndex]!.useStageCount =
                        event.target.checked;
                    })
                  }
                />
                {t('Stage count')}
              </label>
              {!phase.useStageCount ? (
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={phase.countPerTeam ?? 1}
                  onChange={(event) =>
                    edit((next) => {
                      next.stages[stageIndex]!.flow.phases[phaseIndex]!.countPerTeam = Math.max(
                        1,
                        Math.min(10, Number(event.target.value) || 1),
                      );
                    })
                  }
                />
              ) : null}
            </>
          )}

          <select
            value={phase.phaseOrder}
            onChange={(event) =>
              edit((next) => {
                next.stages[stageIndex]!.flow.phases[phaseIndex]!.phaseOrder = event.target
                  .value as 'alternate' | 'sequential';
              })
            }
          >
            <option value="alternate">{t('Alternate')}</option>
            <option value="sequential">{t('Sequential')}</option>
          </select>

          <button
            type="button"
            className="ghost small danger"
            onClick={() =>
              edit((next) => {
                next.stages[stageIndex]!.flow.phases.splice(phaseIndex, 1);
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
                  subject: 'team_one',
                  threshold: 1,
                  repeatEvery: null,
                  grantTo: 'opponent',
                  action: 'pick',
                  count: 1,
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
              value={trigger.subject}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.subject = event.target.value as
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
              value={trigger.grantTo}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.grantTo = event.target.value as
                    | 'subject'
                    | 'opponent';
                })
              }
            >
              <option value="opponent">{t('Opponent')}</option>
              <option value="subject">{t('Subject')}</option>
            </select>
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
            <input
              type="number"
              min={1}
              max={10}
              value={trigger.count}
              onChange={(event) =>
                edit((next) => {
                  next.stages[stageIndex]!.flow.triggers[index]!.count = Math.max(
                    1,
                    Math.min(10, Number(event.target.value) || 1),
                  );
                })
              }
            />
            <input
              type="number"
              min={1}
              max={31}
              placeholder={t('repeat')}
              value={trigger.repeatEvery ?? ''}
              onChange={(event) =>
                edit((next) => {
                  const value = event.target.value.trim();
                  next.stages[stageIndex]!.flow.triggers[index]!.repeatEvery =
                    value === '' ? null : Math.max(1, Math.min(31, Number(value) || 1));
                })
              }
            />
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
function WinByEditor({
  edit,
  stage,
  stageIndex,
}: {
  edit: (mutator: (tournament: Tournament) => void) => void;
  stage: Stage;
  stageIndex: number;
}) {
  const { t } = useI18n();
  const [rules, setRules] = useState<WinByRule[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.osmaRef.winby
      .list()
      .then((entries) => {
        if (alive) setRules(entries);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const importRule = async (): Promise<void> => {
    try {
      const rule = await window.osmaRef.winby.importFile();
      if (!rule) return;
      setRules(await window.osmaRef.winby.list());
      edit((next) => {
        next.stages[stageIndex]!.winByRuleId = rule.id;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flow-card">
      <div className="form-grid">
        <Field label={t('Win-by rule')}>
          <select
            value={stage.winByRuleId}
            onChange={(event) =>
              edit((next) => {
                next.stages[stageIndex]!.winByRuleId = event.target.value;
              })
            }
          >
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name}
              </option>
            ))}
            {rules.some((rule) => rule.id === stage.winByRuleId) ? null : (
              <option value={stage.winByRuleId}>{stage.winByRuleId}</option>
            )}
          </select>
        </Field>
      </div>
      <div className="row-actions">
        <button type="button" className="ghost small" onClick={() => void importRule()}>
          {t('Import')}
        </button>
      </div>
      {error ? <p className="errorText">{error}</p> : null}
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addMatch = (type: 'lobby' | 'match') => {
    if (type === 'lobby' && draft.teams.length === 0) return;
    if (type === 'match' && draft.teams.length < 2) return;
    const id = `match_${Date.now().toString(36)}`;
    edit((next) => {
      const target = next.stages[stageIndex]!;
      const base = {
        id,
        groupId: target.groups[0]?.id ?? null,
        refereeIds: [],
        scheduledAt: new Date().toISOString(),
        result: { scoreRed: 0, scoreBlue: 0 },
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
          teamRedId: next.teams[0]!.id,
          teamBlueId: next.teams[1]!.id,
          roomMode: 'team_versus',
        });
      }
    });
  };

  const patchMatch = (index: number, mutator: (match: Match) => void) => {
    edit((next) => mutator(next.stages[stageIndex]!.matches[index]!));
  };

  const teamName = (teamId: number) =>
    draft.teams.find((team) => team.id === teamId)?.name ?? `Team ${teamId}`;

  return (
    <div className="flow-card">
      <div className="panel-head">
        <button
          type="button"
          className="ghost small"
          disabled={draft.teams.length < 2}
          onClick={() => addMatch('match')}
        >
          {t('+ Match')}
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={draft.teams.length === 0}
          onClick={() => addMatch('lobby')}
        >
          {t('+ Lobby')}
        </button>
      </div>
      <div className="match-editor-list">
        {stage.matches.map((match, index) => {
          const open = expanded.has(match.id);
          const left = match.type === 'match' ? teamName(match.teamRedId) : t('Lobby');
          const right =
            match.type === 'match'
              ? teamName(match.teamBlueId)
              : t('{count} team(s)', { count: match.teamIds.length });
          return (
            <div className="match-editor" key={match.id}>
              <div className="match-summary-row">
                <button
                  type="button"
                  className="ghost small match-expand"
                  aria-expanded={open}
                  onClick={() => toggle(match.id)}
                >
                  {open ? '▾' : '▸'}
                </button>
                <span className="match-number">#{index + 1}</span>
                <span className="match-team red">{left}</span>
                <span className="match-score">
                  {match.type === 'match'
                    ? `${match.result.scoreRed} : ${match.result.scoreBlue}`
                    : '0 : 0'}
                </span>
                <span className="match-team blue">{right}</span>
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

              {open ? (
                <>
                  <div className="form-grid">
                    <Field label={t('Group')}>
                      <select
                        value={match.groupId ?? ''}
                        onChange={(event) =>
                          patchMatch(index, (target) => {
                            target.groupId = event.target.value || null;
                          })
                        }
                      >
                        <option value="">—</option>
                        {stage.groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                    </Field>

                    {match.type === 'match' ? (
                      <>
                        <Field label={t('Red team')}>
                          <select
                            value={match.teamRedId}
                            onChange={(event) =>
                              patchMatch(index, (target) => {
                                if (target.type === 'match') {
                                  target.teamRedId = Number(event.target.value);
                                }
                              })
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
                              patchMatch(index, (target) => {
                                if (target.type === 'match') {
                                  target.teamBlueId = Number(event.target.value);
                                }
                              })
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
                              className={`team-toggle${
                                match.teamIds.includes(team.id) ? ' active' : ''
                              }`}
                              onClick={() =>
                                patchMatch(index, (target) => {
                                  if (target.type !== 'lobby') return;
                                  if (target.teamIds.includes(team.id)) {
                                    if (target.teamIds.length <= 1) return;
                                    target.teamIds = target.teamIds.filter((id) => id !== team.id);
                                  } else {
                                    target.teamIds = [...target.teamIds, team.id];
                                  }
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
                            if (!Number.isNaN(date.getTime())) {
                              target.scheduledAt = date.toISOString();
                            }
                          })
                        }
                      />
                    </Field>
                    <Field label={t('Room mode')}>
                      <select
                        value={match.roomMode}
                        onChange={(event) =>
                          patchMatch(
                            index,
                            (target) => (target.roomMode = event.target.value as MatchType),
                          )
                        }
                      >
                        {PLATFORM_TEAM_MODES[draft.platform].map((mode) => (
                          <option key={mode} value={mode}>
                            {teamModeLabel(mode)}
                          </option>
                        ))}
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
                    {match.type === 'match' ? (
                      <>
                        <Field label={t('Red score')}>
                          <input
                            type="number"
                            min={0}
                            value={match.result.scoreRed}
                            onChange={(event) =>
                              patchMatch(index, (target) => {
                                target.result.scoreRed = Math.max(
                                  0,
                                  Math.floor(Number(event.target.value) || 0),
                                );
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
                                target.result.scoreBlue = Math.max(
                                  0,
                                  Math.floor(Number(event.target.value) || 0),
                                );
                              })
                            }
                          />
                        </Field>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
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
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="flow-card">
      <div className="panel-head automation-head">
        <button
          type="button"
          className="ghost small help-button"
          title={t('Help')}
          aria-label={t('Help')}
          onClick={() => setHelpOpen(true)}
        >
          ?
        </button>
      </div>

      {AUTOMATION_TRIGGERS.map((trigger) => (
        <div className="automation-group" key={trigger}>
          <div className="row automation-group-head">
            <span className="automation-timing">{t(automationTriggerLabel(trigger))}</span>
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                edit((next) => {
                  next.automation[trigger].push('');
                })
              }
            >
              {t('+ Message')}
            </button>
          </div>
          {draft.automation[trigger].map((message, index) => (
            <div className="row" key={`${trigger}-${index}`}>
              <input
                value={message}
                onChange={(event) =>
                  edit((next) => {
                    next.automation[trigger][index] = event.target.value;
                  })
                }
              />
              <button
                type="button"
                className="ghost small danger"
                onClick={() =>
                  edit((next) => {
                    next.automation[trigger].splice(index, 1);
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}

      {helpOpen ? (
        <Modal title={t('Referenceable strings')} onClose={() => setHelpOpen(false)}>
          <ul className="reference-list">
            {TEMPLATE_VARIABLES.map((entry) => (
              <li key={entry.key}>
                <code>{`{{${entry.key}}}`}</code>
                <span>{t(entry.description)}</span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

const TEMPLATE_VARIABLES = [
  { key: 'tournament', description: 'Tournament name' },
  { key: 'stage', description: 'Stage name' },
  { key: 'match', description: 'Match name' },
  { key: 'team_red', description: 'Red team name' },
  { key: 'team_blue', description: 'Blue team name' },
  { key: 'score_red', description: 'Red team score' },
  { key: 'score_blue', description: 'Blue team score' },
  { key: 'beatmap', description: 'Beatmap title and difficulty' },
  { key: 'beatmap_id', description: 'Current beatmap id' },
  { key: 'action_team', description: 'Team performing the current action' },
  { key: 'action', description: 'Current action' },
  { key: 'action_next', description: 'Next action' },
  { key: 'next_team', description: 'Team performing the next action' },
  { key: 'mapscore_red', description: 'Red team map score' },
  { key: 'mapscore_blue', description: 'Blue team map score' },
  { key: 'slot', description: 'Current mappool slot' },
  { key: 'winner', description: 'Beatmap winner' },
] as const;

function automationTriggerLabel(trigger: (typeof AUTOMATION_TRIGGERS)[number]): string {
  switch (trigger) {
    case 'match_created':
      return 'match created';
    case 'beatmap_started':
      return 'beatmap started';
    case 'beatmap_completed':
      return 'beatmap completed';
    case 'score_updated':
      return 'score updated';
    case 'match_finished':
      return 'match finished';
    case 'action_applied':
      return 'action applied';
  }
}
function teamModeLabel(mode: MatchType): string {
  switch (mode) {
    case 'head_to_head':
      return 'Head to Head';
    case 'tag_coop':
      return 'Tag Coop';
    case 'team_versus':
      return 'Team VS';
    case 'tag_team_versus':
      return 'Tag Team VS';
  }
}

function winConditionLabel(condition: RoomWinCondition): string {
  switch (condition) {
    case 'score':
      return 'Score';
    case 'score_v2':
      return 'Score V2';
    case 'accuracy':
      return 'Accuracy';
    case 'combo':
      return 'Combo';
  }
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
