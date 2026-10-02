/** TEMPORARY probe. Safe to delete. */
process.env.DEV_BYPASS_DB = "1";

const queries = await import("./lib/db/queries.ts");

await queries.createUser("probe4@example.com", "password123");

const userId = (await queries.getUser("probe4@example.com"))[0].id;
const chatId = "11111111-1111-4111-8111-111111111111";

await queries.saveChat({
  id: chatId,
  title: "Chat",
  userId,
  visibility: "private",
});

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

console.log(
  "count 1h:",
  await queries.getMessageCountByUserId({ differenceInHours: 1, id: userId })
);
console.log(
  "count 100y:",
  await queries.getMessageCountByUserId({
    differenceInHours: 24 * 365 * 100,
    id: userId,
  })
);

await queries.deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp: new Date("2019-01-01T00:00:00.000Z"),
});

console.log(
  "after delete:",
  (await queries.getMessagesByChatId({ id: chatId })).length
);
