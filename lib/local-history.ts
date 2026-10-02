/**
 * Conversation history persisted in the browser's localStorage.
 *
 * Why this exists: the app normally keeps chats in Postgres, but a local
 * development run (see `lib/dev-bypass.ts`) holds them in server memory, which
 * is wiped on every dev-server restart / hot reload. Mirroring the active
 * conversation into localStorage means a page refresh — or a server restart —
 * never loses what you were just talking about, and the sidebar can list those
 * conversations again.
 *
 * Design notes:
 *   - One JSON document under a single versioned key. Conversations are text,
 *     so the size is manageable, and a single document keeps writes atomic.
 *   - Writes are debounced (streaming appends a token at a time) and flushed on
 *     `pagehide` / tab hide so nothing is lost when the tab goes away.
 *   - React reads the sidebar list through `useSyncExternalStore`, so the
 *     snapshot identity only changes when something the sidebar actually shows
 *     changes (a chat is added/removed/renamed). Appending a token to the
 *     active conversation does not re-render the sidebar.
 *   - Every entry point is SSR-safe: on the server the store reports empty.
 */

import type { ChatMessage } from "./types";

const STORAGE_KEY = "chatbot.local-history.v1";
const SCHEMA_VERSION = 1;
const WRITE_DEBOUNCE_MS = 400;
/** Oldest conversations are dropped first if the browser quota is exhausted. */
const MAX_CHATS = 50;
const MAX_TITLE_LENGTH = 60;
const FALLBACK_TITLE = "New chat";

export type LocalChatVisibility = "private" | "public";

export type LocalChat = {
  createdAt: string;
  id: string;
  messages: ChatMessage[];
  title: string;
  updatedAt: string;
  visibility: LocalChatVisibility;
};

/** The subset of a conversation the sidebar renders. */
export type LocalChatSummary = {
  createdAt: string;
  id: string;
  title: string;
  visibility: LocalChatVisibility;
};

type StoreDocument = {
  chats: Record<string, LocalChat>;
  version: number;
};

const SERVER_SNAPSHOT: LocalChatSummary[] = [];

let document_: StoreDocument | null = null;
let summarySnapshot: LocalChatSummary[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;

const listeners = new Set<() => void>();

function hasStorage() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return Boolean(window.localStorage);
  } catch {
    // Accessing localStorage throws in some privacy configurations.
    return false;
  }
}

function isLocalChat(value: unknown): value is LocalChat {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LocalChat>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    Array.isArray(candidate.messages)
  );
}

function parseDocument(raw: string | null): StoreDocument {
  if (!raw) {
    return { chats: {}, version: SCHEMA_VERSION };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoreDocument>;

    if (parsed?.version !== SCHEMA_VERSION || !parsed.chats) {
      return { chats: {}, version: SCHEMA_VERSION };
    }

    // Drop anything that does not look like a stored conversation rather than
    // letting a corrupt entry break the whole sidebar.
    const chats: Record<string, LocalChat> = {};

    for (const [id, value] of Object.entries(parsed.chats)) {
      if (isLocalChat(value) && value.id === id) {
        chats[id] = {
          ...value,
          // Tolerate a record written by an older or partial version: several
          // code paths sort by `updatedAt`, and the sidebar renders `visibility`.
          updatedAt:
            typeof value.updatedAt === "string"
              ? value.updatedAt
              : value.createdAt,
          visibility: value.visibility === "public" ? "public" : "private",
        };
      }
    }

    return { chats, version: SCHEMA_VERSION };
  } catch {
    return { chats: {}, version: SCHEMA_VERSION };
  }
}

function getDocument(): StoreDocument {
  if (document_) {
    return document_;
  }

  if (!hasStorage()) {
    // No browser storage (SSR, privacy mode): work on a throwaway document.
    return { chats: {}, version: SCHEMA_VERSION };
  }

  try {
    document_ = parseDocument(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be present but blocked (private mode, blocked third-party
    // storage): degrade to an in-memory-only document instead of throwing
    // during a React render.
    document_ = { chats: {}, version: SCHEMA_VERSION };
  }
  rebuildSummariesIfChanged();

  return document_;
}

function flushNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }

  if (!(document_ && hasStorage())) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document_));
  } catch {
    // Almost always a quota error: keep the most recent conversations only.
    const survivors = Object.values(document_.chats)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, Math.floor(MAX_CHATS / 2)));

    document_ = {
      chats: Object.fromEntries(survivors.map((chat) => [chat.id, chat])),
      version: SCHEMA_VERSION,
    };
    rebuildSummariesIfChanged();

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document_));
      console.warn(
        "[local-history] localStorage quota reached; dropped older conversations."
      );
    } catch {
      console.warn(
        "[local-history] could not persist history to localStorage."
      );
    }
  }
}

function scheduleWrite() {
  if (!hasStorage()) {
    return;
  }

  if (!listenersAttached) {
    listenersAttached = true;
    // Flush before the tab is closed or backgrounded so the last tokens survive.
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushNow();
      }
    });
  }

  if (writeTimer) {
    return;
  }

  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushNow();
  }, WRITE_DEBOUNCE_MS);
}

function sameSummary(left: LocalChatSummary, right: LocalChatSummary) {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.visibility === right.visibility
  );
}

function rebuildSummariesIfChanged() {
  const chats = Object.values(getDocument().chats);
  const next = chats
    .map((chat) => ({
      createdAt: chat.createdAt,
      id: chat.id,
      title: chat.title,
      visibility: chat.visibility,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const unchanged =
    next.length === summarySnapshot.length &&
    next.every((summary, index) =>
      sameSummary(summary, summarySnapshot[index])
    );

  if (unchanged) {
    return;
  }

  summarySnapshot = next;

  for (const listener of listeners) {
    listener();
  }
}

/** First user message, collapsed to one line — used as the sidebar label. */
export function deriveChatTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = (firstUserMessage?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return FALLBACK_TITLE;
  }

  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
    : text;
}

/**
 * Union two message lists by id, preferring `primary` for shared ids.
 *
 * When one list is just a shorter copy of the other (its ids all appear in the
 * same order), the longer list is returned untouched, so a stale copy can never
 * reorder the thread — a naive "append what is missing" turns `m1,m3` +
 * `m1,m2,m3` into `m1,m3,m2`.
 */
export function mergeMessages(
  primary: ChatMessage[],
  fallback: ChatMessage[]
): ChatMessage[] {
  if (fallback.length === 0) {
    return primary;
  }

  if (primary.length === 0) {
    return fallback;
  }

  if (primary.length < fallback.length && isSubsequenceOf(primary, fallback)) {
    return fallback;
  }

  if (fallback.length < primary.length && isSubsequenceOf(fallback, primary)) {
    return primary;
  }

  const seen = new Set(primary.map((message) => message.id));
  const extra = fallback.filter((message) => !seen.has(message.id));

  return extra.length === 0 ? primary : [...primary, ...extra];
}

/** True when every id of `candidate` appears in `other`, in the same order. */
function isSubsequenceOf(
  candidate: ChatMessage[],
  other: ChatMessage[]
): boolean {
  let index = 0;

  for (const message of other) {
    if (index === candidate.length) {
      break;
    }

    if (message.id === candidate[index].id) {
      index += 1;
    }
  }

  return index === candidate.length;
}

export function getLocalChat(id: string): LocalChat | undefined {
  return getDocument().chats[id];
}

export function getLocalChatsSnapshot(): LocalChatSummary[] {
  // Reading through getDocument() also performs the lazy load on first call.
  getDocument();

  return summarySnapshot;
}

export function getServerLocalChatsSnapshot(): LocalChatSummary[] {
  return SERVER_SNAPSHOT;
}

export function subscribeLocalChats(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mirror the active conversation into localStorage.
 *
 * Called on every streamed token, so it must stay cheap: the in-memory record
 * is updated in place and the actual write is debounced.
 */
export function saveLocalChatMessages({
  id,
  messages,
  title,
  visibility = "private",
}: {
  id: string;
  messages: ChatMessage[];
  title?: string;
  visibility?: LocalChatVisibility;
}): void {
  if (messages.length === 0) {
    return;
  }

  const store = getDocument();
  const now = new Date().toISOString();
  const existing = store.chats[id];
  const nextTitle = title ?? existing?.title ?? deriveChatTitle(messages);
  const nextVisibility = visibility ?? existing?.visibility ?? "private";

  // Shallow copy so later callers cannot mutate what the store holds.
  store.chats[id] = {
    createdAt: existing?.createdAt ?? now,
    id,
    messages: messages.slice(),
    title: nextTitle,
    updatedAt: now,
    visibility: nextVisibility,
  };

  // Evict first, then refresh the sidebar snapshot, so an evicted conversation
  // can never linger as a row that opens nothing.
  evictOldestBeyondLimit();
  rebuildSummariesIfChanged();
  scheduleWrite();
}

function evictOldestBeyondLimit() {
  const store = getDocument();
  const ids = Object.keys(store.chats);

  if (ids.length <= MAX_CHATS) {
    return;
  }

  const oldestFirst = Object.values(store.chats).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );

  for (const chat of oldestFirst.slice(0, ids.length - MAX_CHATS)) {
    delete store.chats[chat.id];
  }
}

export function deleteLocalChat(id: string): void {
  const store = getDocument();

  if (!(id in store.chats)) {
    return;
  }

  delete store.chats[id];
  rebuildSummariesIfChanged();
  scheduleWrite();
}

export function clearLocalChats(): void {
  document_ = { chats: {}, version: SCHEMA_VERSION };
  rebuildSummariesIfChanged();
  flushNow();
}

/** Test/utility helper: writes pending changes immediately. */
export function flushLocalHistory(): void {
  flushNow();
}
