import { defineSchema } from "convex/server";
import { tables } from "./generatedTables";

export default defineSchema({
  ...tables,
  user: tables.user.index("isAnonymous_updatedAt", ["isAnonymous", "updatedAt"]),
});
