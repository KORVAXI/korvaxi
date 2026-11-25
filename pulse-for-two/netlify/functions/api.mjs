import { getStore } from "@netlify/blobs";
import { createHandler } from "../../lib/handler.mjs";

const env = key => Netlify.env.get(key);

export default async (req) => {
  const store = getStore({ name: "pulse-for-two", consistency: "strong" });
  return createHandler({ store, passcode: env("APP_PASSCODE"), env })(req);
};

export const config = { path: "/api/*" };
