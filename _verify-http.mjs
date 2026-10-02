/** TEMPORARY verification script. Safe to delete. */
const base = "http://localhost:3000";

const models = await fetch(`${base}/api/models`);
const capabilities = await models.json();

console.log("model ids served:", Object.keys(capabilities));
console.log("payload:", JSON.stringify(capabilities).slice(0, 500));

const chat = await fetch(`${base}/api/chat`, {
  body: JSON.stringify({
    id: "11111111-2222-4333-8444-666666666666",
    message: {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
      parts: [{ text: "hello there", type: "text" }],
      role: "user",
    },
    selectedChatModel: "deepseek/deepseek-v3.2",
    selectedVisibilityType: "private",
  }),
  headers: { "content-type": "application/json" },
  method: "POST",
});

console.log("chat status:", chat.status, chat.headers.get("content-type"));

const text = await chat.text();

console.log("stream bytes:", text.length);
console.log("stream head:", text.slice(0, 600).replace(/\n/g, "\\n"));
