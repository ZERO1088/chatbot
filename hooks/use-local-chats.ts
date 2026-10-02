"use client";

import { useSyncExternalStore } from "react";
import {
  getLocalChatsSnapshot,
  getServerLocalChatsSnapshot,
  subscribeLocalChats,
} from "@/lib/local-history";

/**
 * Sidebar-facing view of the localStorage conversation history.
 *
 * `useSyncExternalStore` keeps the server render and the first client render
 * identical (both empty) and then swaps in the stored conversations, so there
 * is no hydration mismatch.
 */
export function useLocalChatHistory() {
  return useSyncExternalStore(
    subscribeLocalChats,
    getLocalChatsSnapshot,
    getServerLocalChatsSnapshot
  );
}
