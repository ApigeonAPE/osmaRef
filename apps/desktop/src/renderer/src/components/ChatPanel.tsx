import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, MappoolSlot } from '@osmaref/contracts';
import { buildSlotMatcher } from '../chat-slots';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { useSettings } from '../settings';
import { formatTime } from '../ui';

export function ChatPanel({
  sessionId,
  transport,
  slots,
  onSelectSlot,
  slotHint,
}: {
  sessionId: string;
  transport: 'irc' | 'referee_hub';
  slots?: MappoolSlot[];
  onSelectSlot?: (slot: MappoolSlot) => void;
  slotHint?: (slot: MappoolSlot) => string;
}) {
  const model = useModel();
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const inputHistoryIndex = useRef(-1);
  const inputDraft = useRef('');
  const { settings } = useSettings();
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const splitText = useMemo(() => buildSlotMatcher(slots ?? []), [slots]);
  // IRC sessions chat over Bancho; hub sessions chat over the osu!web API.
  const chatConnected =
    model.state?.connections.find(
      (entry) => entry.kind === (transport === 'irc' ? 'irc' : 'chat'),
    )?.status === 'connected';

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    void (async () => {
      try {
        const loaded = await window.osmaRef.chat.history(sessionId, 100);
        if (!cancelled) setHistory(loaded);
      } catch {
        // History is best effort; live messages still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, chatConnected, transport]);

  const messages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const message of history) byId.set(message.id, message);
    for (const message of model.messages) {
      if (message.sessionId === sessionId) byId.set(message.id, message);
    }
    const all = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
    // Pair each server copy with at most one optimistic local echo, so two
    // identical lines sent in a row keep both local copies until echoed.
    const serverSelf = all.filter((message) => message.self && !message.id.startsWith('local:'));
    const paired = new Set<string>();
    const used = new Set<string>();
    for (const message of all) {
      if (!message.id.startsWith('local:')) continue;
      const at = Date.parse(message.at);
      const match = serverSelf.find(
        (other) =>
          !used.has(other.id) &&
          other.text === message.text &&
          Math.abs(Date.parse(other.at) - at) < 30_000,
      );
      if (!match) continue;
      used.add(match.id);
      paired.add(message.id);
    }
    return all.filter((message) => !paired.has(message.id)).slice(-200);
  }, [history, model.messages, sessionId]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [sessionId]);

  useEffect(() => {
    inputHistoryIndex.current = -1;
    inputDraft.current = '';
    try {
      const raw = window.localStorage.getItem(`osmaRef.chat.input.${sessionId}`);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      setInputHistory(
        Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === 'string').slice(-50)
          : [],
      );
    } catch {
      setInputHistory([]);
    }
  }, [sessionId]);

  useEffect(() => {
    const element = listRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await model.sendChat(sessionId, value);
      const next = [...inputHistory, value].slice(-50);
      setInputHistory(next);
      inputHistoryIndex.current = -1;
      inputDraft.current = '';
      try {
        window.localStorage.setItem(
          `osmaRef.chat.input.${sessionId}`,
          JSON.stringify(next),
        );
      } catch {
        // Input history is best effort.
      }
      setText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const walkHistory = (direction: 1 | -1) => {
    if (inputHistory.length === 0) return;
    if (direction === 1) {
      if (inputHistoryIndex.current === -1) {
        inputDraft.current = text;
      }
      const next = Math.min(inputHistory.length - 1, inputHistoryIndex.current + 1);
      inputHistoryIndex.current = next;
      setText(inputHistory[inputHistory.length - 1 - next]!);
      return;
    }
    if (inputHistoryIndex.current === -1) return;
    const next = inputHistoryIndex.current - 1;
    inputHistoryIndex.current = next;
    setText(next < 0 ? inputDraft.current : inputHistory[inputHistory.length - 1 - next]!);
  };

  return (
    <section className="chat card">
      <div
        className="chat-log"
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {messages.length === 0 ? <p className="muted small pad">{t('No messages yet.')}</p> : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`chat-line${message.system ? ' system' : ''}${
              message.username === 'BanchoBot' ? ' bot' : ''
            }${message.self ? ' self' : ''}`}
            style={{
              fontFamily: settings.chatFontFamily,
              fontSize: `${settings.chatFontSize}px`,
              lineHeight: settings.chatLineHeight,
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span className="chat-time">{formatTime(message.at)}</span>{' '}
              <span className="chat-author">
                &lt;{message.system ? 'osmaRef' : message.username}&gt;:
              </span>{' '}
              <span className="chat-text">
                {message.action ? (
                  <ActionText text={message.text} />
                ) : message.system || !onSelectSlot ? (
                  message.text
                ) : (
                  splitText(message.text).map((part, index) =>
                    part.type === 'slot' ? (
                      <button
                        key={index}
                        type="button"
                        className="chat-slot"
                        title={slotHint?.(part.slot)}
                        onClick={() => onSelectSlot(part.slot)}
                      >
                        {part.text}
                      </button>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )
                )}
              </span>
            </span>
          </div>
        ))}
      </div>

      {error ? <div className="banner error small">{error}</div> : null}

      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            inputHistoryIndex.current = -1;
            inputDraft.current = event.target.value;
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' && inputHistory.length > 0) {
              event.preventDefault();
              walkHistory(1);
            } else if (event.key === 'ArrowDown' && inputHistory.length > 0) {
              event.preventDefault();
              walkHistory(-1);
            }
          }}
          aria-label={t('Message')}
          disabled={sending}
        />
        <button
          type="submit"
          className="primary chat-send"
          disabled={sending || text.trim().length === 0}
          aria-label={t('Send')}
          title={t('Send')}
        >
          <span className="chat-send-icon" aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}

function ActionText({ text }: { text: string }) {
  const match = /^(.+?)\s+\[(https?:\/\/\S+)\s+(.+)\]\s*(.*)$/i.exec(text);
  if (!match) return <em>{text}</em>;
  const [, verb, url, title, suffix] = match;
  return (
    <>
      <em>{verb}</em> [
      <a
        href={url}
        className="chat-link"
        onClick={(event) => {
          event.preventDefault();
          void window.osmaRef.app.openExternal(url!);
        }}
      >
        {title}
      </a>
      ]
      {suffix?.trim() ? ` ${suffix.trim()}` : ''}
    </>
  );
}