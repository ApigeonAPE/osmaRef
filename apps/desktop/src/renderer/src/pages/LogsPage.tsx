import { useEffect, useMemo, useState } from 'react';
import {
  sessionEventCategory,
  type SessionEvent,
  type SessionEventCategory,
} from '@osmaref/contracts';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Empty, formatDateTime } from '../ui';
import { Toast } from '../components/Toast';

type CategoryFilter = 'all' | SessionEventCategory;

const CATEGORY_FILTERS: CategoryFilter[] = ['all', 'operation', 'chat', 'game'];

export function LogsPage() {
  const model = useModel();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    model.lobbyLogs[0]?.sessionId ?? null,
  );
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selectedId && model.lobbyLogs.some((entry) => entry.sessionId === selectedId)) return;
    setSelectedId(model.lobbyLogs[0]?.sessionId ?? null);
  }, [model.lobbyLogs, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    setEvents([]);
    let cancelled = false;
    void (async () => {
      try {
        const next = await window.osmaRef.sessions.getEvents(selectedId);
        if (!cancelled) setEvents(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    return window.osmaRef.app.onEvent((event) => {
      if (event.type !== 'session_event' || event.event.sessionId !== selectedId) return;
      setEvents((previous) =>
        previous.some((entry) => entry.id === event.event.id)
          ? previous
          : [...previous, event.event].sort((left, right) => left.at.localeCompare(right.at)),
      );
      if (!model.lobbyLogs.some((entry) => entry.sessionId === event.event.sessionId)) {
        void model.refreshLobbyLogs();
      }
    });
  }, [selectedId, model.lobbyLogs, model.refreshLobbyLogs]);

  const selected = model.lobbyLogs.find((entry) => entry.sessionId === selectedId) ?? null;

  const counts = useMemo(() => {
    const result: Record<CategoryFilter, number> = {
      all: events.length,
      operation: 0,
      chat: 0,
      game: 0,
    };
    for (const event of events) result[sessionEventCategory(event.type)] += 1;
    return result;
  }, [events]);

  const visible = useMemo(
    () =>
      events.filter(
        (event) => category === 'all' || sessionEventCategory(event.type) === category,
      ),
    [events, category],
  );

  const exportLog = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = await window.osmaRef.sessions.exportLog(selectedId);
      if (path) setNotice(t('exported logs to {path}', { path }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteLog = async () => {
    if (!selectedId) return;
    const name = selected?.matchName ?? selectedId;
    if (
      !window.confirm(
        t(
          'Delete the room log for "{name}"? This cannot be undone. If the room is still active, new events are recorded in a fresh log.',
          { name },
        ),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await window.osmaRef.sessions.deleteLog(selectedId);
      setEvents([]);
      setSelectedId(null);
      await model.refreshLobbyLogs();
      setNotice(t('Room log deleted.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (model.lobbyLogs.length === 0) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>{t('Lobby logs')}</h1>
        </header>
        <Empty
          title={t('No room logs yet')}
          body={t('Open a room; its operations, chat and match events are recorded here.')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Lobby logs')}</h1>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="ghost"
            disabled={!selectedId || busy}
            onClick={() => void exportLog()}
          >
            {t('Export room log')}
          </button>
          <button
            type="button"
            className="ghost danger"
            disabled={!selectedId || busy}
            onClick={() => void deleteLog()}
          >
            {t('Delete room log')}
          </button>
        </div>
      </header>

      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}
      {notice ? <Toast kind="success" message={notice} onClose={() => setNotice(null)} /> : null}

      <div className="audit-layout">
        <aside className="session-list">
          {model.lobbyLogs.map((entry) => (
            <button
              key={entry.sessionId}
              type="button"
              className={`session-item${entry.sessionId === selectedId ? ' active' : ''}`}
              onClick={() => {
                setCategory('all');
                setSelectedId(entry.sessionId);
              }}
            >
              <strong>{entry.matchName}</strong>
              <span className="muted small">
                {t(entry.status)} · {entry.transport} · {t('{count} entries', { count: entry.entryCount })}
              </span>
            </button>
          ))}
        </aside>

        <div className="audit-body">
          {selected ? (
            <div className="card">
              <header className="card-head">
                <div>
                  <h2>{selected.matchName}</h2>
                  <p className="muted small">
                    {t('room {room} · {transport} · best of {bestOf}', {
                      room: selected.roomId ?? '—',
                      transport: selected.transport,
                      bestOf: selected.bestOf,
                    })}
                  </p>
                </div>
                <span className={`pill ${selected.status}`}>{t(selected.status)}</span>
              </header>

              <div className="log-filters">
                {CATEGORY_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`tab${category === filter ? ' active' : ''}`}
                    onClick={() => setCategory(filter)}
                  >
                    {filter === 'all' ? t('All') : t(categoryLabel(filter))}
                    <span className="muted small"> · {counts[filter]}</span>
                  </button>
                ))}
              </div>

              <div className="timeline">
                {visible.length === 0 ? <p className="muted">{t('No log entries.')}</p> : null}
                {visible.map((event) => {
                  const eventCategory = sessionEventCategory(event.type);
                  return (
                    <div key={event.id} className="timeline-row">
                      <span className={`log-category log-category-${eventCategory}`}>
                        {t(categoryLabel(eventCategory))}
                      </span>
                      <span className={`timeline-type ${event.type}`}>{event.type}</span>
                      <span>{event.summary}</span>
                      <span className="muted small">{formatDateTime(event.at)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <Empty
              title={t('Select a room')}
              body={t('Choose a room on the left to inspect its log.')}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function categoryLabel(category: SessionEventCategory): string {
  switch (category) {
    case 'chat':
      return 'Chat';
    case 'game':
      return 'Game';
    default:
      return 'Operation';
  }
}
