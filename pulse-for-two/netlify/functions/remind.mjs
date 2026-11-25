// Every 15 minutes: send a "Time to eat!" notification to anyone whose meal
// timer has run out (between 7am and 10pm in their own time zone).
import { getStore } from "@netlify/blobs";
import { runReminders } from "../../lib/handler.mjs";

export default async () => {
  const store = getStore({ name: "pulse-for-two", consistency: "strong" });
  const sent = await runReminders(store, key => Netlify.env.get(key));
  console.log("reminders", JSON.stringify(sent));
};

export const config = { schedule: "*/15 * * * *" };
