import { useEffect, useState } from 'react';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Field, Section } from '../ui';
import { IdInput } from '../components/IdInput';
import { Toast } from '../components/Toast';

export function CreateRoomPage({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const model = useModel();
  const { t } = useI18n();
  const [mode, setMode] = useState<'configured' | 'quick'>('configured');
  const [tournamentId, setTournamentId] = useState('');
  const [matchId, setMatchId] = useState('');
  const [transport, setTransport] = useState<'irc' | 'referee_hub'>('irc');

  const [quickName, setQuickName] = useState('Quick room');
  const [quickBeatmap, setQuickBeatmap] = useState('');
  const [quickRuleset, setQuickRuleset] = useState(0);
  const [quickMatchType, setQuickMatchType] = useState<'head_to_head' | 'team_versus'>('team_versus');
  const [quickTransport, setQuickTransport] = useState<'irc' | 'referee_hub'>('referee_hub');
  const [quickMax, setQuickMax] = useState(8);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTournament = model.tournaments.find((entry) => entry.id === tournamentId) ?? null;
  const selectedMatches = selectedTournament
    ? selectedTournament.stages.flatMap((stage) =>
        stage.matches.map((match) => ({ stage, match })),
      )
    : [];

  useEffect(() => {
    if (!tournamentId && model.tournaments[0]) setTournamentId(model.tournaments[0].id);
  }, [model.tournaments, tournamentId]);

  useEffect(() => {
    const match = selectedMatches.find((entry) => entry.match.id === matchId)?.match ?? selectedMatches[0]?.match;
    if (!match) {
      setMatchId('');
      return;
    }
    if (match.id !== matchId) setMatchId(match.id);
    setTransport(match.transport);
  }, [selectedMatches, matchId]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openRoom = async () => {
    if (!tournamentId || !matchId) return;
    await run('open', async () => {
      const created = await window.osmaRef.sessions.open({ tournamentId, matchId, transport });
      await model.refreshSessions();
      onCreated(created.id);
    });
  };

  const openQuickRoom = async () => {
    const beatmapId = Number(quickBeatmap);
    const hasBeatmap = Number.isInteger(beatmapId) && beatmapId > 0;
    if (!hasBeatmap && quickTransport === 'referee_hub') {
      setError(t('The Referee Hub needs a beatmap id.'));
      return;
    }
    await run('quick', async () => {
      const created = await window.osmaRef.sessions.openQuick({
        name: quickName.trim() || 'Quick room',
        beatmapId: hasBeatmap ? beatmapId : null,
        rulesetId: quickRuleset,
        matchType: quickMatchType,
        transport: quickTransport,
        maxParticipants: quickMax,
        bestOf: 9,
      });
      await model.refreshSessions();
      onCreated(created.id);
    });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Create room')}</h1>
        </div>
      </header>

      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}

      <Section title={t('Open a room')}>
        <div className="segmented">
          <button
            type="button"
            className={`segmented-item${mode === 'configured' ? ' active' : ''}`}
            data-testid="mode-configured"
            onClick={() => setMode('configured')}
          >
            {t('Configured match')}
          </button>
          <button
            type="button"
            className={`segmented-item${mode === 'quick' ? ' active' : ''}`}
            data-testid="mode-quick"
            onClick={() => setMode('quick')}
          >
            {t('Quick room')}
          </button>
        </div>

        {mode === 'configured' ? (
          <>
            <div className="open-row" data-testid="configured-form">
              <Field label={t('Tournament')}>
                <select value={tournamentId} onChange={(event) => setTournamentId(event.target.value)}>
                  {model.tournaments.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Match')}>
                <select value={matchId} onChange={(event) => setMatchId(event.target.value)}>
                  {selectedMatches.map(({ stage, match: entry }) => (
                    <option key={entry.id} value={entry.id}>
                      {stage.name} · {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Transport')}>
                <select
                  value={transport}
                  onChange={(event) => setTransport(event.target.value as 'irc' | 'referee_hub')}
                >
                  <option value="irc">{t('Bancho IRC')}</option>
                  <option value="referee_hub">{t('Referee Hub')}</option>
                </select>
              </Field>
              <button
                type="button"
                className="primary"
                disabled={busy !== null || !tournamentId || !matchId}
                onClick={() => void openRoom()}
              >
                {busy === 'open' ? t('opening…') : t('Open room')}
              </button>
            </div>
            {model.tournaments.length === 0 ? (
              <p className="muted small">
                {t('No tournament is configured yet. Create one in Tournaments.')}
              </p>
            ) : selectedTournament && selectedMatches.length === 0 ? (
              <p className="muted small">
                {t('This tournament has no matches yet. Add one in the Tournaments page.')}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="open-row" data-testid="quick-form">
              <Field label={t('Room name')}>
                <input value={quickName} onChange={(event) => setQuickName(event.target.value)} />
              </Field>
              <Field label={t('Beatmap id')}>
                <IdInput
                  kind="beatmap"
                  value={quickBeatmap}
                  onChange={setQuickBeatmap}
                  placeholder={quickTransport === 'irc' ? t('optional') : '658127'}
                />
              </Field>
              <Field label={t('Ruleset')}>
                <select value={quickRuleset} onChange={(event) => setQuickRuleset(Number(event.target.value))}>
                  <option value={0}>osu!</option>
                  <option value={1}>osu!taiko</option>
                  <option value={2}>osu!catch</option>
                  <option value={3}>osu!mania</option>
                </select>
              </Field>
              <Field label={t('Transport')}>
                <select
                  value={quickTransport}
                  onChange={(event) => setQuickTransport(event.target.value as 'irc' | 'referee_hub')}
                >
                  <option value="irc">{t('Bancho IRC')}</option>
                  <option value="referee_hub">{t('Referee Hub')}</option>
                </select>
              </Field>
            </div>
            <div className="open-row">
              <Field label={t('Max participants')}>
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={quickMax}
                  onChange={(event) => setQuickMax(Number(event.target.value) || 0)}
                />
              </Field>
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void openQuickRoom()}
              >
                {busy === 'quick' ? t('Creating…') : t('Create quick room')}
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}