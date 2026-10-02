/**
 * TEMPORARY verification for the DEV_BYPASS_DB work. Safe to delete.
 * Exercises lib/db/queries.ts against the in-memory store to prove the bypass
 * shim answers the same queries the real Postgres client would.
 */
process.env.DEV_BYPASS_DB = "1";

import assert from "node:assert/strict";
import test from "node:test";

const queries = await import("./lib/db/queries.ts");

test("bypass is active", async () => {
  const { isDevBypassEnabled } = await import("./lib/dev-bypass.ts");

  assert.equal(isDevBypassEnabled, true);
});

test("users: create and fetch by email", async () => {
  await queries.createUser("dev@example.com", "password123");

  const found = await queries.getUser("dev@example.com");

  assert.equal(found.length, 1);
  assert.equal(found[0].email, "dev@example.com");
  assert.ok(found[0].id);
  assert.deepEqual(await queries.getUser("missing@example.com"), []);

  const guests = await queries.createGuestUser();

  assert.equal(guests.length, 1);
  assert.match(guests[0].email, /^guest-\d+$/);
});

test("chats: save, fetch, paginate, title, visibility", async () => {
  const userId = (await queries.getUser("dev@example.com"))[0].id;

  await queries.saveChat({
    id: "11111111-1111-4111-8111-111111111111",
    title: "First chat",
    userId,
    visibility: "private",
  });
  // Distinct createdAt values, otherwise ordering is not deterministic.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await queries.saveChat({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Second chat",
    userId,
    visibility: "public",
  });

  const single = await queries.getChatById({
    id: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(single?.title, "First chat");
  assert.equal(single?.userId, userId);
  assert.equal(
    await queries.getChatById({ id: "99999999-9999-4999-8999-999999999999" }),
    null
  );

  const page = await queries.getChatsByUserId({
    endingBefore: null,
    id: userId,
    limit: 1,
    startingAfter: null,
  });

  assert.equal(page.chats.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.chats[0].id, "22222222-2222-4222-8222-222222222222");

  const all = await queries.getChatsByUserId({
    endingBefore: null,
    id: userId,
    limit: 10,
    startingAfter: null,
  });

  assert.equal(all.chats.length, 2);
  assert.equal(all.hasMore, false);

  // ordered newest-first, so startingAfter an older chat yields the newer one
  const after = await queries.getChatsByUserId({
    endingBefore: null,
    id: userId,
    limit: 10,
    startingAfter: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(after.chats.length, 1);
  assert.equal(after.chats[0].id, "22222222-2222-4222-8222-222222222222");
  assert.equal(after.hasMore, false);

  await queries.updateChatTitleById({
    chatId: "11111111-1111-4111-8111-111111111111",
    title: "Renamed",
  });
  assert.equal(
    (
      await queries.getChatById({
        id: "11111111-1111-4111-8111-111111111111",
      })
    )?.title,
    "Renamed"
  );

  await queries.updateChatVisibilityById({
    chatId: "11111111-1111-4111-8111-111111111111",
    visibility: "public",
  });
  assert.equal(
    (
      await queries.getChatById({
        id: "11111111-1111-4111-8111-111111111111",
      })
    )?.visibility,
    "public"
  );

  assert.equal(
    (
      await queries.getChatsByUserId({
        endingBefore: null,
        id: "00000000-0000-4000-8000-000000000000",
        limit: 10,
        startingAfter: null,
      })
    ).chats.length,
    0
  );
});

test("messages: save, fetch, count, delete trailing", async () => {
  const userId = (await queries.getUser("dev@example.com"))[0].id;
  const chatId = "11111111-1111-4111-8111-111111111111";

  await queries.saveMessages({
    messages: [
      {
        attachments: [],
        chatId,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        parts: [{ text: "hello", type: "text" }],
        role: "user",
      },
      {
        attachments: [],
        chatId,
        createdAt: new Date("2020-01-02T00:00:00.000Z"),
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        parts: [{ text: "hi", type: "text" }],
        role: "assistant",
      },
    ],
  });

  const stored = await queries.getMessagesByChatId({ id: chatId });

  assert.equal(stored.length, 2);
  assert.equal(stored[0].id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(stored[1].parts, [{ text: "hi", type: "text" }]);
  assert.ok(stored[0].createdAt instanceof Date);

  assert.equal(
    (
      await queries.getMessageById({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })
    ).length,
    1
  );

  // recent user messages for this user's chat
  assert.equal(
    await queries.getMessageCountByUserId({ differenceInHours: 1, id: userId }),
    0
  );
  assert.equal(
    await queries.getMessageCountByUserId({
      differenceInHours: 24 * 365 * 100,
      id: userId,
    }),
    1
  );

  await queries.updateMessage({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    parts: [{ text: "edited", type: "text" }],
  });
  assert.deepEqual(
    (
      await queries.getMessageById({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })
    )[0].parts,
    [{ text: "edited", type: "text" }]
  );

  await queries.deleteMessagesByChatIdAfterTimestamp({
    chatId,
    timestamp: new Date("2019-01-01T00:00:00.000Z"),
  });
  assert.equal((await queries.getMessagesByChatId({ id: chatId })).length, 0);
});

test("votes: insert then update", async () => {
  const chatId = "11111111-1111-4111-8111-111111111111";
  const messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  await queries.voteMessage({ chatId, messageId, type: "up" });
  let votes = await queries.getVotesByChatId({ id: chatId });

  assert.equal(votes.length, 1);
  assert.equal(votes[0].isUpvoted, true);

  await queries.voteMessage({ chatId, messageId, type: "down" });
  votes = await queries.getVotesByChatId({ id: chatId });

  assert.equal(votes.length, 1);
  assert.equal(votes[0].isUpvoted, false);
});

test("documents and suggestions", async () => {
  const userId = (await queries.getUser("dev@example.com"))[0].id;

  await queries.saveDocument({
    content: "v1",
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    kind: "text",
    title: "Doc",
    userId,
  });

  const docs = await queries.getDocumentsById({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });

  assert.equal(docs.length, 1);
  assert.equal(docs[0].content, "v1");

  const saved = await queries.updateDocumentContent({
    content: "v2",
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  });

  assert.equal(Array.isArray(saved), true);
  assert.equal(
    (
      await queries.getDocumentById({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    )?.content,
    "v2"
  );

  await queries.saveSuggestions({
    suggestions: [
      {
        createdAt: new Date(),
        description: "tweak",
        documentCreatedAt: docs[0].createdAt,
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        isResolved: false,
        originalText: "v2",
        suggestedText: "v3",
        userId,
      },
    ],
  });

  assert.equal(
    (
      await queries.getSuggestionsByDocumentId({
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    ).length,
    1
  );

  await queries.deleteDocumentsByIdAfterTimestamp({
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    timestamp: new Date("2000-01-01T00:00:00.000Z"),
  });

  assert.equal(
    (
      await queries.getDocumentsById({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    ).length,
    0
  );
  assert.equal(
    (
      await queries.getSuggestionsByDocumentId({
        documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    ).length,
    0
  );
});

test("streams and cascading chat delete", async () => {
  const userId = (await queries.getUser("dev@example.com"))[0].id;
  const chatId = "22222222-2222-4222-8222-222222222222";

  await queries.createStreamId({ chatId, streamId: "stream-1" });
  await queries.createStreamId({ chatId, streamId: "stream-2" });

  assert.deepEqual(await queries.getStreamIdsByChatId({ chatId }), [
    "stream-1",
    "stream-2",
  ]);

  const deleted = await queries.deleteChatById({ id: chatId });

  assert.equal(deleted?.id, chatId);
  assert.equal(await queries.getChatById({ id: chatId }), null);
  assert.deepEqual(await queries.getStreamIdsByChatId({ chatId }), []);

  const remaining = await queries.getChatsByUserId({
    endingBefore: null,
    id: userId,
    limit: 10,
    startingAfter: null,
  });

  assert.equal(remaining.chats.length, 1);

  const wiped = await queries.deleteAllChatsByUserId({ userId });

  assert.equal(wiped.deletedCount, 1);
  assert.equal(
    (
      await queries.getChatsByUserId({
        endingBefore: null,
        id: userId,
        limit: 10,
        startingAfter: null,
      })
    ).chats.length,
    0
  );
});
