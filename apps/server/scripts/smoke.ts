/**
 * One tiny call with MODEL_EXTRACT to prove the key, price table, spend gate, and runs logging work.
 * Worst-case cost is a fraction of a cent.
 */
import { bootstrapOrExit } from "../src/bootstrap";
import { SpendCapError } from "../src/llm/spend-gate";

const ctx = bootstrapOrExit();

try {
  const { message, costUsd } = await ctx.llm.call(
    { callType: "smoke" },
    {
      model: ctx.env.MODEL_EXTRACT,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    },
  );
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const u = message.usage;
  console.log(`model:        ${ctx.env.MODEL_EXTRACT}`);
  console.log(`reply:        ${JSON.stringify(text)} (stop_reason: ${message.stop_reason})`);
  console.log(
    `tokens:       input ${u.input_tokens}, output ${u.output_tokens}, ` +
      `cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}`,
  );
  console.log(`cost:         $${costUsd.toFixed(6)}`);
  console.log(`month total:  $${(await ctx.gate.spentThisMonthUsd()).toFixed(6)} of $${ctx.gate.capUsd.toFixed(2)} cap`);
} catch (err) {
  if (err instanceof SpendCapError) {
    console.error(`[smoke] ${err.message}`);
  } else {
    console.error(`[smoke] API call failed: ${(err as Error).message}`);
  }
  process.exit(1);
}
