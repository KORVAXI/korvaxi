import { getStore } from "@netlify/blobs";
import { createHandler } from "../../lib/handler.mjs";

export default async (req) => {
  const store = getStore({ name: "pulse-for-two", consistency: "strong" });
  return createHandler({ store, passcode: process.env.APP_PASSCODE })(req);
};

export const config = { path: "/api/*" };
